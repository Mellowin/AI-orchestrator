# Review, Recovery, and Resume

This document describes how a multitask mission is reviewed after all tasks finish, how the reviewer/fix loop works with real providers, how dependency evidence from accepted ancestor tasks flows into reviews, and how crash/resume reconciliation keeps accepted work safe. It builds on [01-one-click.md](01-one-click.md) (mission launch and workspace bootstrap) and [02-task-lifecycle.md](02-task-lifecycle.md) (single-task lifecycle), and is grounded in `src/autopilot-one-click/multitask/` (`runner.ts`, `final-review.ts`, `reviewer-provider.ts`, `state-manager.ts`) and `src/reviewer/`.

## The real reviewer/fix loop

There are two distinct review loops in the system: the **per-task reviewer gate** (document 02, section 5) and the **mission-level final review**. Both follow the same principle: deterministic checks are the security boundary; model output is advisory and can never override them.

### Per-task loop (recap)

For each task, `runReviewerGate` (`src/reviewer/reviewer-gate.ts`) runs in two layers:

1. **Deterministic layer, no AI call.** If deterministic checks fail, the gate returns a synthetic `rejected` decision without calling the reviewer provider. Severe safety findings — secret pattern detected, main branch violation, merge conflict markers in the diff, invalid commit SHA format, denied file touched — map to `block_for_human`; anything else maps to `send_fix_to_coder`. Summary checks (`runSummaryChecks`) additionally verify the commit against allowed files, acceptance criteria, and dependency evidence; failure here is also rejected deterministically. All text in deterministic decisions is redacted (`redactReviewerText` / `redactReviewerList`).
2. **Reviewer provider layer.** Only when deterministic checks pass is the reviewer called with the full `ReviewInput`. The raw response is schema-validated (`validateReviewerDecision`) before use.

A rejection with `send_fix_to_coder` re-enters the coder stage with a `FixContext` (attempt number, previous reviewer summary, `fix_task`, blocking issues, check failure summary). The loop is bounded by repair/retry limits; exhaustion ends the task as `failed` or `blocked`. A task accepted after fixes is recorded as `fixed_and_accepted` with both `commit_sha` and `fix_commit_sha`.

### Mission-level final review

Once `allRequiredTasksAccepted` is true (every planned task is `accepted` or `fixed_and_accepted`), the mission runs its own review through `runMissionFinalReview` (`final-review.ts`):

1. **Mandatory deterministic gap computation** (`computeMandatoryGaps`):
   - **Unauthorized files**: `collectUnauthorizedFiles` parses the integrated diff (`base_branch...work_branch`, falling back to `origin/<base>...` for CI checkouts) and checks every touched path against the union of all task `allowed_files` patterns. It handles Git's quoted paths (`core.quotePath`), creates (destination path), deletes (source path), and renames (both sides). Absolute paths or `..` traversals are automatically flagged. If the diff cannot be collected at all, review **fails closed** — an unreadable diff means the reviewer cannot authorize changes it cannot see.
   - **Acceptance gaps**: `collectAcceptanceGaps` flags every task whose status is not `accepted`/`fixed_and_accepted`, annotated with the task's expected result.
2. **Dependency evidence build** (see next section), attached to the review input.
3. **Reviewer call or deterministic fallback**:
   - With no reviewer callback (e.g. fake-mode missions), `buildDeterministicReview` decides alone: any unauthorized file or gap → `rejected`; `AUTOPILOT_GREEN` → `approved`; `AUTOPILOT_MVP_DONE_CI_NOT_OBSERVED` → `approved_with_caveats`; otherwise `needs_changes`.
   - In real mode, the reviewer model receives a structured prompt (mission goal, constraints, per-task plan with statuses, autopilot verdict/CI info, the integrated diff truncated to 8000 characters, and the dependency evidence section) and must return JSON matching the `FinalMissionReview` schema (`verdict`, `summary`, `caveats`, `unauthorized_files`, `acceptance_gaps`). The response is extracted from a fenced code block and strictly parsed; an invalid verdict or malformed JSON is a hard error.
4. **Mandatory deterministic gate over the model's answer.** Even if the model says `approved` or `approved_with_caveats`, any unauthorized file or acceptance gap downgrades the verdict to `rejected` (`buildGateRejectedReview`): *model approval is not a security boundary*. The deterministic `unauthorized_files` and `acceptance_gaps` are always written into the final review record regardless of what the model claimed.

### Real reviewer providers

`buildProductionFinalReviewCallFn` (`reviewer-provider.ts`) selects the reviewer:

- **OpenAI first** (`buildOpenAIReviewCallFn`): requires `OPENAI_API_KEY` and a review model (env `OPENAI_REVIEW_MODEL`, default `gpt-4o`). The request uses `temperature: 0` and a strict JSON-schema response format, an `AbortController` timeout (default 180 s), and the shared `callProviderWithRetry` machinery with `resolveProviderRetryConfig()`.
- **Kimi fallback** (`buildKimiReviewCallFn`): if OpenAI is not configured, Kimi is tried (`KIMI_API_KEY`, `KIMI_BASE_URL` defaulting to the Moonshot API, model default `kimi-k2.6`) via `createRealProviderCall`. If the caller supplied a custom `fetchFn` for OpenAI, it is inherited by the Kimi fallback.
- If neither provider is available, the error message is passed through `redactSecrets` (stripping `sk-...` keys and `Bearer` tokens) before being thrown, so no credential can leak into reports or state.
- Both providers honor a `fakeResponse` option for tests/dry runs, which bypasses the network entirely.

A reviewer failure is classified by the runner: a missing-key / provider-unavailable error maps to `MULTITASK_MISSION_NEEDS_HUMAN`; other failures map to `MULTITASK_MISSION_EXTERNAL_BLOCKER`. In both cases the mission terminates cleanly with persisted state instead of crashing.

## Dependency evidence

Summary/review tasks must be able to *see* what their accepted ancestor tasks produced, without being able to modify it. `runMissionFinalReview` calls `buildMissionDependencyEvidence` with the plan's tasks (`id`, `allowed_files`, `depends_on`) and the current task states (`task_id`, `status`, `commit_sha`, `fix_commit_sha`) to produce a `DependencyEvidencePackage`.

Key properties:

- **Accepted-only**: evidence is built from accepted ancestor tasks. Files from failed, blocked, or pending tasks are never presented as trusted context.
- **Content-addressed**: each item carries `path`, `content_sha256`, `bytes`, and `lines`, so the reviewer can verify exactly which artifact it is looking at.
- **Bounded**: the package tracks `total_bytes` and marks truncation (`truncated`, `omitted_count`) when the payload exceeds limits, and per-item truncation is flagged as well.
- **Read-only by contract**: the review prompt includes explicit *Dependency Evidence Rules* — the files are read-only context from previously accepted tasks; the reviewer must NOT request changes to them, because each task's own scope is the only writable scope.

The same `dependency_evidence` field flows through `FinalReviewInput` (mission level) and `ReviewInput` (per-task level), and is enforced by `runSummaryChecks` at the per-task gate.

## Accepted-only history

The mission branch is curated so that its history contains only accepted work:

- **Rollback of rejected work.** After reconciling task states, the runner collects every `commit_sha` / `fix_commit_sha` belonging to tasks that ended `blocked`, `failed`, or `needs_human`, and reverts them on the work branch with `git revert --no-edit`, newest first so each revert applies cleanly. New revert commits created during this step are captured via `git log <before>..HEAD` and appended, with the originals, to `rolled_back_commits` in mission state — so a later mission-level rollback never tries to revert the same commit twice. This cleanup stays local; the human decides whether to push it.
- **Mission-level rollback.** If the integrated diff cannot be collected, or the final review verdict is not an approval, `performMissionRollback` reverts every commit in `mission_commits` (all commits the mission introduced on top of `base_sha`, including finalization-repair commits) that is not already in `rolled_back_commits`, newest first. The resulting list is persisted in `rolled_back_commits`.
- **`mission_commits` tracking.** After the autopilot run, the runner records every commit between `base_sha` and the new HEAD (verified as a descendant of `base_sha` via `isAncestor`) into `state.mission_commits`, deduplicated. Finalization-repair commits are added the same way. This set is the exact scope of any later rollback.

## Crash/resume reconciliation

All mission progress is persisted to `<output-dir>/missions/<run_id>/multitask-mission-state.json` (`state-manager.ts`):

- **Atomic writes.** `saveMissionState` writes to `multitask-mission-state.json.tmp` and `renameSync`s it over the real file, so a crash mid-write never leaves a torn state file.
- **Defensive loads.** `loadMissionState` returns `null` for missing files, invalid JSON, or structurally invalid state (missing `run_id`, `stage`, `plan_hash`, `base_sha`, `work_branch`, or non-array `tasks`) — a corrupt state behaves like a fresh start rather than crashing resume.
- **Plan hash.** `computePlanHash` is a SHA-256 (truncated to 16 hex chars) over a canonicalized plan: tasks sorted by id, each task's arrays sorted, Windows path separators normalized to `/`. This makes the hash stable across platforms and key orderings.

On `--resume`, the runner reconciles persisted state against reality before doing any new work:

1. **Identity gates.** `state.plan_hash` must equal the freshly computed plan hash (`Resume aborted: mission plan changed`), and `state.base_sha` must still resolve (`Resume aborted: base branch moved`).
2. **Terminal-result replay.** If `stage === 'completed'` with a non-success, non-pause verdict, the persisted result is returned as-is — even if the work branch no longer exists — because the recorded failure is already final.
3. **Accepted-commit ancestry gate.** For missions in `planning`/`executing_tasks`/`running`, or `completed` with a successful verdict, every persisted accepted commit must be present and be an ancestor of the work branch:
   - An `accepted` task must have `commit_sha`; a `fixed_and_accepted` task must have both `commit_sha` and `fix_commit_sha`. Missing SHAs abort: `Resume aborted: required accepted commits are missing from state`.
   - Each SHA is verified with `isAncestor` (`git merge-base --is-ancestor`) against `mission-<run_id>`. Any missing ancestor aborts: `Resume aborted: required accepted commits are not ancestors of ...`. The mission never silently rebuilds on different history.
4. **Stage-aware re-entry.** Pause verdicts keep the mission in the `executing_tasks` stage, so resume re-runs the unfinished portion instead of replaying a terminal result. When resuming past task execution (`stage` beyond `running`), the persisted `autopilot_result` is reused and the autopilot run is skipped entirely; integrated validation is skipped if `validation_outcome.ok` is already recorded; the final review is skipped if `final_review` is already persisted; the PR is reused if `state.pr` exists; and a recorded `ci_outcome` short-circuits CI re-observation.
5. **Accepted-state preservation.** `mergeTaskStates` keeps prior `accepted`/`fixed_and_accepted` entries from earlier runs (filling in commit metadata if missing) instead of overwriting them with fresh results, and `markDescendantsSkipped` marks descendants of failed/blocked tasks as `skipped` — but never demotes an accepted task.
6. **Fresh-run branch guard.** Without `--resume`, an existing `mission-<run_id>` branch fails the run rather than being reset; if it exists but is not based on the recorded base SHA, reuse is refused outright.

### Pause and resume commands

Provider outages and git-auth failures produce resumable pause verdicts (`MULTITASK_MISSION_PAUSED_PROVIDER`, `MULTITASK_MISSION_PAUSED_GIT_AUTH`) with `resume_supported: true`, a structured `provider_failure` or `git_failure`, a `next_human_action`, and a `resume_command` built by `buildResumeCommand`. Accepted work is preserved locally; after restoring credentials or quota, the printed command resumes without consuming new AI calls for already-accepted tasks (for git-auth pauses, the push retries with zero new provider calls).

## Relationship between the gates

| Gate | Where | Boundary |
|---|---|---|
| Per-task deterministic checks + summary checks | `reviewer-gate.ts`, `summary-checks.ts` | Rejects before any AI call; severe findings block for human. |
| Per-task reviewer provider | `reviewer-gate.ts` | Schema-validated; rejection feeds the bounded fix loop. |
| Mission deterministic gaps (unauthorized files, acceptance gaps) | `final-review.ts` | Always computed; overrides any model approval. |
| Mission reviewer model | `final-review.ts`, `reviewer-provider.ts` | Strict JSON schema, retry-wrapped, secrets redacted; OpenAI with Kimi fallback. |
| Resume ancestry/identity gates | `runner.ts`, `state-manager.ts` | Accepted commits must remain ancestors; plan and base must not have moved. |

Together these guarantee the invariant that ties the whole workflow together: **only reviewed, accepted, in-scope commits ever survive on the mission branch, and no crash or resume can smuggle in work that was never accepted.**
