# 03 — Reviewer/Fix Loop, Dependency Evidence, and Crash/Resume Reconciliation

This document describes how the autonomous multitask workflow reviews work,
recovers from rejection, and reconciles persisted state after a crash or
pause. It builds on [01 — One-Click Launch](01-one-click.md) (bootstrap,
branching, one-time configuration) and [02 — Task Lifecycle](02-task-lifecycle.md)
(per-task states and scheduling). The behavior is implemented by
`src/reviewer/reviewer-gate.ts`, `src/reviewer/deterministic-review-checks.ts`,
`src/reviewer-evidence.ts`, `src/committed-task-reviewer-gate.ts`,
`src/autopilot-one-click/multitask/final-review.ts`,
`src/autopilot-one-click/multitask/reviewer-provider.ts`, and the state
handling in `src/autopilot-one-click/multitask/runner.ts` +
`state-manager.ts`.

## The reviewer gate is deterministic-first, never model-first

Every review — per-task and mission-level — runs deterministic checks before
any model is consulted, and the model can never override a deterministic
failure.

### Per-task gate (`runReviewerGate`)

1. **Deterministic checks run first** (`runDeterministicReviewChecks`):
   the commit SHA must be a full 40-char hex string, the changed-file list
   must be non-empty, every changed file must match `allowed_files` and no
   `denied_files` pattern, typecheck/build/test results must look like a
   pass, the working tree must be clean, the branch must not be `main`, the
   diff must contain no secret patterns (`sk-`, `Bearer`, `*_API_KEY`,
   `.env`) and no merge-conflict markers.
2. **If deterministic checks fail, the model is never called.** The gate
   returns a deterministic rejection with redacted blocking issues. The
   `next_action` is `block_for_human` for severe safety findings (secret
   pattern, main-branch violation, conflict markers, invalid SHA, denied
   file touched) and `send_fix_to_coder` otherwise.
3. **Only after deterministic checks pass** (plus summary checks against the
   recorded criteria) is the reviewer provider called, and its decision is
   schema-validated before use.

`max_lines_changed` is deliberately advisory: it is reported to the reviewer
but is not a deterministic gate, because the planner's estimate is not a
safety boundary.

### Mission-level gate (`runMissionFinalReview`)

The mission final review applies the same fail-closed pattern at the
integrated level:

- `computeMandatoryGaps` derives, without any AI: the list of tasks that are
  not `accepted`/`fixed_and_accepted` (acceptance gaps) and the files in the
  integrated diff outside the effective writable scope (unauthorized files,
  via `collectUnauthorizedFiles`, which handles quoted paths, creates,
  deletes, and renames correctly).
- If the model approves but the deterministic gate found gaps or
  unauthorized files, the verdict is overridden to `rejected`
  (`buildGateRejectedReview`). Model approval is not a security boundary.
- Without a reviewer call function, the review is entirely deterministic
  (`buildDeterministicReview`): reject on gaps/unauthorized files, approve a
  green autopilot, approve-with-caveats when CI observation was disabled,
  otherwise `needs_changes`.
- A rejection or needs-changes verdict triggers a rollback of all
  mission-owned commits (`performMissionRollback`: `git revert --no-edit`,
  newest first, skipping already-rolled-back SHAs).

## The fix loop

When the per-task gate rejects with `send_fix_to_coder`, the task re-enters
execution with the review feedback (doc 02, stages 7–8). On success the task
is accepted as `fixed_and_accepted` and both `commit_sha` and
`fix_commit_sha` are recorded. When the loop is exhausted, the task ends
`failed`, `blocked`, or `needs_human`, and:

- its descendants are transitively marked `skipped`
  (`markDescendantsSkipped`), and
- its commits are reverted from the mission branch locally (newest first;
  both the reverted SHAs and the resulting revert commits are recorded in
  `rolled_back_commits` so later rollbacks do not double-revert).

The mission itself has a separate bounded repair loop for repository-level
integration failures: when integrated validation classifies the failure as
`REPAIRABLE_REPOSITORY_FAILURE` and the mission allows repair,
`runFinalizationRepair` runs up to `mission.repair.max_attempts` times, with
revalidation after each repair commit. An `EXTERNAL_BLOCKER` classification
maps to `MULTITASK_MISSION_EXTERNAL_BLOCKER` instead of burning repair
attempts.

## Dependency evidence: read-only context from accepted tasks

Downstream reviewers and coders need to *see* what accepted ancestor tasks
produced without gaining the right to change it. That context is built by
`buildMissionDependencyEvidence` and attached to the final-review input as
`dependency_evidence`:

- Only artifacts from tasks in `accepted` / `fixed_and_accepted` states are
  included, and only files within each ancestor task's own `allowed_files`.
- Each item carries the producing `task_id`, its status, the file path, the
  content SHA-256, byte/line counts, and the content itself, with explicit
  truncation markers and a package-level size budget (omitted items are
  counted).
- The review prompt presents this as a dedicated "Dependency Evidence
  (read-only context from accepted tasks)" section with explicit rules:
  dependency files are read-only, and the reviewer must not request changes
  to them — each task's scope is the only writable scope.

Per-task review follows the same principle through `ReviewerEvidence`
(`buildReviewerEvidence` / `buildCandidateReviewerEvidence`): every fact the
reviewer judges — commit SHA, changed files, diff stat, branch name, safety
flags — comes from git commands against the actual commit, never from
unverified claims, and `dependencyEvidence` flows through the same
read-only channel.

A companion fail-closed rule applies to finalization maintenance:
`resolveAuthorizedMaintenanceFiles` grants the reviewer a maintenance-file
allowance only when the persisted evidence is complete and consistent
(`REPAIRABLE_REPOSITORY_FAILURE` classification, a valid 40-char repair
commit SHA, repair files all inside the validator's maintenance list, and
passing revalidation). Any inconsistency yields *no* allowance, so such
files are treated as unauthorized. The deterministic gate, not the model, is
the final authority for scope.

## Accepted-only history

History and resume honor only accepted work:

- `mergeTaskStates` never demotes a task already `accepted` or
  `fixed_and_accepted`; a later run can only fill in missing commit
  metadata, never reopen it.
- The scheduler dispatches only `pending` tasks; accepted tasks are skipped
  as finished, which is what makes `--resume` cheap (no re-execution, no
  provider calls).
- `mission_commits` tracks exactly the commits introduced on top of the
  mission base (`git log <baseSha>..<head>`), so unrelated base-branch
  commits are never attributed to the mission.
- Commits from `blocked`/`failed`/`needs_human` tasks are reverted out of
  the branch, so the branch history that reaches final review and the PR
  contains accepted work plus its fix commits only.

## Crash/resume reconciliation

Every stage transition is persisted atomically (`saveMissionState`: write to
`*.tmp`, then rename) to `<run_dir>/multitask-mission-state.json`. On
`--resume`, reconciliation happens in a strict order and every step fails
closed:

1. **Identity checks.** The persisted `plan_hash` (a canonical hash of the
   full task graph, including file guardrails) must match the current plan
   ("Resume aborted: mission plan changed") and the persisted `base_sha`
   must match the resolved base branch tip ("Resume aborted: base branch
   moved"). Corrupt or malformed state files load as `null` and start
   fresh rather than trusting garbage.
2. **Terminal-result replay.** A persisted terminal failure result is
   returned directly. Paused verdicts (`MULTITASK_MISSION_PAUSED_PROVIDER`,
   `MULTITASK_MISSION_PAUSED_GIT_AUTH`) are *not* terminal: the mission
   re-runs, with accepted tasks preserved and the paused task resuming.
   Rollback of blocked-task commits stays local; the human decides whether
   to push the cleaned-up branch.
3. **Ancestry gate.** For any resume that would trust prior work, every
   recorded accepted commit (`commit_sha` and `fix_commit_sha`) must exist
   in state and must be an ancestor of the work branch (`isAncestor`).
   Missing metadata or broken ancestry aborts resume with a failure — the
   mission never silently re-runs or trusts unverifiable acceptance.
4. **Stage-aware re-entry.** Persisted stage and artifacts decide what is
   skipped: a stored `autopilot_result` past the execution stages is reused
   verbatim; a stored `final_review` is not recomputed; `validation_outcome`
   and `authorized_maintenance` are reused verbatim (the maintenance
   allowance is deterministic evidence, not re-derived); a stored `ci_outcome`
   re-enters CI observation at the right stage; a created PR is reused from
   `state.pr`.
5. **Crash mid-stage.** Because state is saved before and after each
   expensive step, a crash anywhere re-enters at the last persisted stage
   with all prior accepted commits, rollbacks, and review artifacts intact.

When the mission cannot continue on its own, the result carries a concrete
`next_human_action` and, for paused verdicts, a `resume_command`
(`... --run-id <id> --resume`): restore provider access for
`PAUSED_PROVIDER`, update `GITHUB_TOKEN` for `PAUSED_GIT_AUTH` (accepted
local commits are then pushed without new AI calls), or check GitHub Actions
directly for `EXTERNAL_BLOCKER`.
