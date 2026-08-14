# Autonomous Workflow 02 — Single Task Lifecycle

This document describes the lifecycle of a single task as implemented in the
multitask mission runner (`src/autopilot-one-click/multitask/runner.ts`) and the
per-task pipeline it delegates to (`autopilot-run` → `mvp-run`). It follows
`docs/autonomous-workflow/01-one-click.md`: multitask presets (`real-multitask`,
`multitask-safe`) route one-click launches into this runner instead of a plain
`autopilot-run`. Every step below is grounded in the actual code; where a step is
performed by an inner layer, that is stated explicitly.

The lifecycle of one task is:

```text
task_base_sha → candidate workspace → coder → staging/checks → reviewer
→ fix loop → acceptance → single commit → push
```

## Task states

A task's state is a `MultitaskMissionTaskState` (`multitask/types.ts`):

- `task_id`, plus optional `commit_sha`, `fix_commit_sha`, `reason`, `attempt`.
- Statuses: `pending`, `running`, `accepted`, `fixed_and_accepted`, `failed`,
  `blocked`, `skipped`, `skipped_safe_mode`, `needs_human`.

Initial states are all `pending` (`buildInitialTaskStates`). States are persisted
in `<output-dir>/missions/<run-id>/multitask-mission-state.json`
(`state-manager.ts`), written atomically (temp file + rename), so a run can be
resumed.

## Step 1 — task_base_sha

Before any task runs, the runner resolves the mission base SHA:

- `getBaseSha(repo_path, base_branch)` runs `git rev-parse <base_branch>`, falling
  back to `origin/<base_branch>` (CI checkouts often have only remote refs).
  Failure to resolve aborts the mission with `MULTITASK_MISSION_FAILED`.
- The resolved SHA is stored as `base_sha` in the persisted mission state together
  with `plan_hash` (first 16 hex chars of a SHA-256 over the canonicalized plan).
- In safe mode (no mutation capability) no real base is needed; the runner uses
  the sentinel `safe-mode-no-base-<planHash>` and every task ends as
  `skipped_safe_mode`.
- On `--resume`, a persisted state is only honored if both `plan_hash` and
  `base_sha` still match; a changed plan aborts with "Resume aborted: mission
  plan changed", a moved base with "Resume aborted: base branch moved".

This base SHA is the anchor for everything a task produces: per-task commits must
be descendants of it, and the integrated diff for final review is collected as
`base_branch..work_branch`.

## Step 2 — candidate workspace

The candidate workspace is the mission work branch:

- Branch name is deterministic: `mission-<run_id>` (`runMultitaskMission`).
- The multitask runner deliberately does **not** pre-create the branch. The inner
  MVP runner creates and checks it out from the base SHA
  (`prepareScenarioWorkBranch`); pre-creating it would make that step fail.
- On a fresh (non-resume) run, if `mission-<run_id>` already exists the runner
  refuses to reuse it: it fails with "rerun with --resume or use a different
  run-id", and additionally refuses when the branch is not based on the resolved
  base SHA (`isBranchBasedOn` compares `merge-base(workBranch, baseSha)` against
  `baseSha`).
- Scheduling order comes from the plan DAG: `scheduleTasks` validates the DAG
  (`validateTaskDAG`), topologically sorts it, and dispositions each task as
  `run`, `skip_dependency_failed`, or `skip_already_finished` (accepted tasks
  from a prior attempt are never re-run).

## Step 3 — coder

The coding step for a task is executed by the inner `autopilot-run` / `mvp-run`
pipeline, which the multitask runner invokes once for the whole mission via
`runAutopilotRunFn(autopilotConfig, ..., { resume, skipPrCreation: true })`.
Each task executes in topological order on the shared mission branch, restricted
to that task's `allowed_files` / `denied_files` guardrails from the plan.

The runner tracks what the coder produced by diffing git state: after the
autopilot run, commits between `base_sha` and the new HEAD
(`git log --format=%H base_sha..HEAD`) are recorded as `mission_commits`. These
are the only commits considered mission-owned for later rollback.

## Step 4 — staging / checks

Each task's plan entry declares `checks` and `tests`; the inner MVP runner stages
the coder's changes and runs those checks before a commit is accepted as a
candidate. The results surface in the per-task status that the multitask runner
maps back (`mapMvpStatusToMissionStatus`):

| MVP task status | Mission task status |
|---|---|
| `passed` | `accepted` |
| `passed_with_caveats` | `fixed_and_accepted` |
| `blocked` | `blocked` |
| `skipped` | `skipped` |
| `needs_human` | `needs_human` |
| anything else | `failed` |

## Step 5 — reviewer

Review is a two-stage gate (`src/reviewer/reviewer-gate.ts` plus
`commit-verifier.ts`):

1. **Deterministic checks first.** `buildCommitEvidence` validates the commit SHA
   (full 40-char hex), verifies the commit exists
   (`git rev-parse --verify <sha>^{commit}`), collects changed files
   (`git show --name-only` or `git diff base...sha`), the patch (capped at
   500 KB / 5000 lines, with a truncation safety finding), `git status
   --porcelain`, and the current branch. If the deterministic result is not ok,
   the reviewer LLM is **never called**: the gate returns a deterministic
   `rejected` decision.
2. **Severe findings escalate.** Findings such as "secret pattern detected",
   "main branch violation", "merge conflict markers in diff", "invalid commit sha
   format", or "denied file touched" map to `next_action: block_for_human`;
   ordinary blocking issues map to `send_fix_to_coder`.
3. **LLM review only when clean.** When deterministic checks pass, the reviewer
   provider is called and its decision is schema-validated
   (`validateReviewerDecision`).

## Step 6 — fix loop

A `send_fix_to_coder` decision routes the reviewer's `fix_task` description back
to the coder, which produces a fix on top of the task's original commit. The
task state records both SHAs: `commit_sha` (original) and `fix_commit_sha`
(fix). A task that needed a fix and then passed ends as `fixed_and_accepted`
(mapped from `passed_with_caveats`). Tasks whose fixes never satisfy the gate
end as `failed`, `blocked`, or `needs_human`.

## Step 7 — acceptance and the single commit

Acceptance is recorded per task, never partially:

- An accepted task contributes exactly its `commit_sha` (and `fix_commit_sha`
  when a fix was needed) to the mission branch. The multitask runner does not
  squash; each task's commit stays an individual commit on `mission-<run_id>`.
- `mergeTaskStates` makes acceptance sticky across resumes: a task already
  `accepted`/`fixed_and_accepted` in persisted state keeps that status, only
  filling in missing commit metadata.
- On resume, accepted commits are re-verified against the actual branch: every
  recorded `commit_sha`/`fix_commit_sha` must be an ancestor of
  `mission-<run_id>` (`git merge-base --is-ancestor`), otherwise the resume
  aborts instead of trusting stale state.
- `allRequiredTasksAccepted` requires **every** planned task to be accepted for
  the mission to be eligible for a DONE verdict.

## Step 8 — push

Push is capability-gated, matching the presets in document 01:

- `real-multitask` enables apply/commit but **not** push, and `multitask-safe`
  enables nothing — so in the multitask path the mission branch stays local.
  The orchestrator never merges, never force-pushes, never deletes branches.
- When `allow_pr_create` is set and the verdict is DONE / DONE_WITH_CAVEATS, the
  runner creates the mission PR at the end via `createMissionPr` (skipped when
  `GITHUB_TOKEN` is absent); a previously recorded PR is closed when the mission
  fails.
- The inner autopilot run is always invoked with `skipPrCreation: true` so that
  only one PR exists per mission.

## Failure handling: rollback and dependency cascade

When tasks do not reach acceptance, the branch is cleaned locally:

- **Rejected task commits** — after the autopilot run, commits of `blocked`,
  `failed`, and `needs_human` tasks are reverted on the work branch, newest
  first so each revert applies cleanly (`revertCommits`). Both the reverted SHAs
  and the new revert commits are recorded in `rolled_back_commits` so later
  rollback never double-reverts. This rollback stays local; the human operator
  decides whether to push the cleaned-up branch.
- **Dependency cascade** — `markDescendantsSkipped` marks every descendant of a
  failed/blocked/needs_human task as `skipped` (unless already accepted), with
  reason "Skipped because an ancestor task failed or was blocked".
- **Mission-level rejection** — if the mission final review rejects the
  integrated diff, or diff collection itself fails, `performMissionRollback`
  reverts all mission-owned commits not already rolled back.

## Verdicts

The mission verdict (`mapAutopilotVerdict`) combines the inner autopilot verdict,
acceptance coverage, and the mission final review:

- `MULTITASK_MISSION_DONE` — autopilot green, all tasks accepted, review approved.
- `MULTITASK_MISSION_DONE_WITH_CAVEATS` — same but review approved with caveats
  (also the safe-mode verdict).
- `MULTITASK_MISSION_FAILED` — review rejected, repair exhausted/failed, MVP
  failed, plan validation failed, or rollback itself failed.
- `MULTITASK_MISSION_NEEDS_HUMAN` — missing token/access error, or the final
  reviewer is unavailable.
- `MULTITASK_MISSION_EXTERNAL_BLOCKER` — CI timeout or reviewer failure.

Each result carries `next_human_action` (e.g., "Review the PR at <url>..." or
"A task or safety gate needs human review before continuing.") and is written to
the mission report under `<output-dir>/missions/<run-id>/`.
