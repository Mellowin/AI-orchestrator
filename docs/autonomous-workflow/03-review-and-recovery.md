# 03 — Reviewer/Fix Loop, Dependency Evidence, and Crash/Resume Reconciliation

This document describes how the multitask mission reviews work, feeds failures back into a fix loop, supplies accepted-task artifacts as read-only dependency evidence, keeps an accepted-only history on the mission branch, and reconciles persisted state after a crash or pause. It builds on `01-one-click.md` (launch, branch, resume) and `02-task-lifecycle.md` (per-task lifecycle) and is grounded in the actual implementation: `src/autopilot-one-click/multitask/runner.ts`, `final-review.ts`, `reviewer-provider.ts`, `state-manager.ts`, `types.ts`, and `src/reviewer/reviewer-gate.ts`, `deterministic-review-checks.ts`, `commit-verifier.ts`.

## 1. The real reviewer/fix loop

### Per-task review (inside the inner autopilot/MVP runner)

Each task's staged candidate is evaluated by a **reviewer gate** (`runReviewerGate` in `src/reviewer/reviewer-gate.ts`):

1. **Deterministic checks first** (`runDeterministicReviewChecks`): commit SHA shape, non-empty changed files, every changed file inside `allowedFiles` and outside `deniedFiles`, typecheck/build/test results looking like pass, clean working tree, not on `main`, no secret patterns (`sk-`, `Bearer`, `*_API_KEY`, `.env`), no merge-conflict markers. `max_lines_changed` is advisory only — it never blocks.
2. If deterministic checks fail, the task is rejected **without calling the model** (`reviewerCalled: false`). Severe findings (secret pattern, main-branch violation, conflict markers, invalid SHA, denied file) route to `block_for_human`; otherwise the rejection routes to `send_fix_to_coder`.
3. **Summary checks** then verify the commit evidence against allowed files, acceptance criteria, and dependency evidence; failure is again a deterministic rejection feeding the fix loop.
4. Only when both deterministic layers pass is the model reviewer called, and its raw output is schema-validated (`validateReviewerDecision`) before use.

Commit evidence is built by `buildCommitEvidence` (`commit-verifier.ts`): it validates the 40-char SHA, verifies the commit exists, collects changed files and a size-capped diff (500 KB / 5000 lines, marked `[diff truncated: ...]` when capped), plus `git status --porcelain` and the current branch.

### The fix loop

A rejection with attempts remaining sends the failure feedback (check output, reviewer comments) back to the coder; the loop repeats up to the configured attempt budget. A fix that passes becomes a **separate** commit recorded as `fix_commit_sha`. The inner runner's per-task status is mapped into mission task states by `mapMvpStatusToMissionStatus` (`runner.ts`):

- `passed` → `accepted` (clean first pass, only `commit_sha`)
- `passed_with_caveats` → `fixed_and_accepted` (one or more fix iterations, `commit_sha` + `fix_commit_sha`)
- `blocked` / `needs_human` / `failed` — non-accepted outcomes
- `paused_provider` / `paused_git_auth` — resumable external interruptions

### Mission-level final review (`final-review.ts`)

After all required tasks are accepted and integrated validation passes, `runMissionFinalReview` reviews the **integrated** result:

- The **mandatory deterministic gate** (`computeMandatoryGaps`) runs first and independently of the model: `collectUnauthorizedFiles` parses the integrated `git diff base...work` (handling quoted paths, creates, deletes, renames) and rejects any file outside the union of task `allowed_files` plus authorized maintenance files; `collectAcceptanceGaps` rejects any task that is not `accepted`/`fixed_and_accepted`.
- The model reviewer (OpenAI via `buildOpenAIReviewCallFn`, Kimi via `buildKimiReviewCallFn`, selected with fallback by `buildProductionFinalReviewCallFn` in `reviewer-provider.ts`) returns a strict JSON-schema verdict: `approved` | `approved_with_caveats` | `needs_changes` | `rejected`, with `summary`, `caveats`, `unauthorized_files`, `acceptance_gaps`. Calls go through `callProviderWithRetry`; missing credentials surface as `MULTITASK_MISSION_NEEDS_HUMAN`, other failures as `MULTITASK_MISSION_EXTERNAL_BLOCKER`.
- **Model approval is not a security boundary**: if the model approves while the deterministic gate found unauthorized files or acceptance gaps, `buildGateRejectedReview` overrides the verdict to `rejected`. Conversely the gate's findings are merged into the returned review so the model cannot hide them.
- With no reviewer callback (fake mode / tests), `deterministicFallback` approves only a green or CI-not-observed autopilot with zero gate violations.
- A non-approval verdict triggers `performMissionRollback` (see §4) and the mission ends `MULTITASK_MISSION_FAILED`.

### Authorized finalization maintenance

When integrated validation fails with classification `REPAIRABLE_REPOSITORY_FAILURE` and `allow_repair` is set, `runFinalizationRepair` runs up to `mission.repair.max_attempts` times. Only a repair whose changed files are a subset of the validator's `maintenanceFiles` **and** whose revalidation passed produces `AuthorizedMaintenanceEvidence` (persisted in state, reused verbatim on resume). `resolveAuthorizedMaintenanceFiles` fails closed: wrong classification, missing/invalid 40-hex repair SHA, empty lists, out-of-scope repair files, or failed revalidation all yield **no** maintenance allowance, so those files count as unauthorized in the final-review gate.

## 2. Dependency evidence (read-only context from accepted tasks)

`runMissionFinalReview` builds a `DependencyEvidencePackage` via `buildMissionDependencyEvidence` (`src/reviewer/dependency-evidence.ts`) from the plan's tasks and the current task states, keyed by `depends_on` edges. Only artifacts from **accepted** ancestor tasks are included, each with path, SHA-256, byte/line counts, and (possibly truncated) content.

The evidence is injected into the reviewer prompt under a dedicated section with explicit rules:

- Dependency files are **read-only context**; the reviewer must not request changes to them.
- Each task's own `allowed_files` is the only writable scope.

At the per-task level, the same evidence flows into the coder/reviewer inputs (`ReviewInput.dependency_evidence`) and is verified by summary checks. This is how a summary/integration task can be judged against real ancestor outputs without ever widening its write scope.

## 3. Accepted-only history

The mission branch is kept as a history of **accepted work only**:

- **Preservation across runs** — `mergeTaskStates` never downgrades a task that was previously `accepted`/`fixed_and_accepted`; it only fills in missing commit metadata. Re-running after a pause cannot un-accept finished work.
- **Commit tracking** — after the inner autopilot run, the runner records every commit between `base_sha` and HEAD into `state.mission_commits` (task commits, fix commits, and later finalization-repair commits).
- **Rollback of non-accepted work** — commits belonging to `failed`/`blocked`/`needs_human` tasks are reverted newest-first on the mission branch (`revertCommits`), and both the reverted SHAs and the new revert-commit SHAs are recorded in `state.rolled_back_commits` so later rollback never double-reverts. Descendants of failed/blocked tasks are marked `skipped` by `markDescendantsSkipped` and can never be silently executed.
- **Final-review rejection** — `performMissionRollback` reverts all remaining mission-owned commits (excluding already-rolled-back ones), newest first. Per AGENTS.md, rollback stays **local**; the human operator decides whether to push the cleaned-up branch.
- **Approval gate** — `allRequiredTasksAccepted` must hold before integrated validation/final review even run; otherwise the mission fails with `Not all required tasks were accepted`.

## 4. Crash/resume reconciliation

State is persisted atomically (`write` + `rename`) to `<output-dir>/missions/<run_id>/multitask-mission-state.json` at every stage transition (`state-manager.ts`). On `--resume`, `runMultitaskMission` reconciles:

1. **Identity checks (fail closed)** — `state.plan_hash` must equal `computePlanHash(plan)` (`Resume aborted: mission plan changed`) and `state.base_sha` must equal the freshly resolved base SHA (`Resume aborted: base branch moved`).
2. **Terminal-result replay** — a persisted terminal **failure** result is returned as-is without re-running; a paused mission (`MULTITASK_MISSION_PAUSED_PROVIDER` / `PAUSED_GIT_AUTH`) is **not** terminal and must re-run.
3. **Accepted-commit ancestry gate** — for any resumable or terminal-success state, every `commit_sha` (and `fix_commit_sha` for `fixed_and_accepted`) of accepted tasks must be present in state (else `Resume aborted: required accepted commits are missing from state`) and must still be an ancestor of `mission-<run_id>` via `git merge-base --is-ancestor` (else `Resume aborted: required accepted commits are not ancestors ...`). This detects rebased/squashed/deleted branches instead of trusting stale SHAs.
4. **Terminal success replay** — a completed `DONE`/`DONE_WITH_CAVEATS` result that passes the ancestry gate is returned without re-running autopilot.
5. **Stage-aware continuation** — otherwise execution resumes from the persisted stage: `state.autopilot_result` is reused when the run already finished (`shouldSkipAutopilot`), persisted `validation_outcome`, `finalization_repair_attempts`, `authorized_maintenance`, `final_review`, `pr`, and `ci_outcome` let each later phase (integrated validation → finalization repair → mission review → PR creation → CI observation) start exactly where it stopped without repeating provider calls.
6. **Pause semantics** — on provider/git-auth pause the stage stays `executing_tasks`, accepted tasks stay accepted, the paused task stays paused, descendants stay pending, and the result carries `resume_supported`, a `resume_command` (`buildResumeCommand`), structured `provider_failure`/`git_failure`, and a `next_human_action`. Fixing the external cause and rerunning with `--resume` (same `--run-id`; see `01-one-click.md`) continues without new planner calls and — for git-auth pauses — pushes preserved local commits without new AI calls.

## Invariants

1. The deterministic gate — never the model — is the final authority on scope, acceptance, and maintenance authorization.
2. Dependency evidence is read-only and comes exclusively from accepted ancestor tasks.
3. The mission branch history contains only accepted commits plus explicit, tracked reverts; every revert SHA is recorded to prevent double-rollback.
4. Every resume re-verifies plan hash, base SHA, and accepted-commit ancestry before trusting any persisted state.
5. Rollback is local; pushing, PR creation, and CI observation happen only after final-review approval, and `main` is never touched.
