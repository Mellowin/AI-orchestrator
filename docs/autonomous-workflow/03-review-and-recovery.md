# Review and Recovery

This document describes how the autonomous workflow actually evaluates changes, retries failures, records history, and resumes after interruption. It builds on the launcher overview in [`01-one-click.md`](01-one-click.md) and the single-task lifecycle in [`02-task-lifecycle.md`](02-task-lifecycle.md).

## 1. What the reviewer gate really does

The reviewer gate is not a single function; it is a pipeline:

1. Build evidence from the repository, the commit, and check results.
2. Run deterministic safety checks that can override the model.
3. Call the reviewer provider when the deterministic checks pass.
4. Parse and validate the provider's structured response.
5. Map the verdict to an internal status and next action.

Two concrete gate implementations exist in the codebase today:

- `src/reviewer-gate.ts` (`evaluateReviewerGate`) takes pre-built evidence and a raw reviewer output string. It runs safety checks, parses the output with `parseReviewerDecision`, and returns a `ReviewerGateResult`.
- `src/reviewer/reviewer-gate.ts` (`runReviewerGate`) takes a `ReviewerProvider`, a `ReviewInput`, and a deterministic result. It delegates the provider call to `reviewCommit` and validates the returned decision with `validateReviewerDecision`.

Both share the same policy: deterministic safety findings can block or reject a change before the model is consulted.

## 2. Evidence

`src/reviewer-evidence.ts` builds the evidence object sent to the reviewer and used by the deterministic gate:

- `commitExists` is verified with `git cat-file -t <sha>`.
- `changedFiles` comes from `git diff-tree --no-commit-id --name-only -r --root <sha>`.
- `diffStat` comes from `git show --stat --format= <sha>`.
- `shortCommitSha` is the first 7 characters of the full SHA.
- `safety.commitShaIsFullLength` is true when the SHA is exactly 40 hex characters.
- `safety.branchIsNotMain` is true when the branch name is not `main`.
- `safety.hasChangedFiles` is true when at least one file changed.

The evidence also carries the task goal, the check summary, the previous failure (on retries), and the run state status so the reviewer has full context.

## 3. Deterministic safety checks

Safety checks run before the model. In `src/reviewer-gate.ts` the gate blocks immediately if:

- the commit SHA is not full length,
- no changed files are detected,
- or the branch is `main`.

`src/reviewer/reviewer-gate.ts` adds a second layer. It receives a `deterministicResult` from earlier guardrails and classifies safety findings as severe when any finding includes:

- `secret pattern detected`
- `main branch violation`
- `merge conflict markers in diff`
- `invalid commit sha format`
- `denied file touched`

Severe issues produce `block_for_human`. Non-severe deterministic failures produce `send_fix_to_coder`: the task is rejected but can be retried.

All deterministic rejection decisions are redacted (`redactReviewerList`, `redactReviewerText`) before they travel downstream, so that secrets accidentally present in guardrail messages do not leak into the fix loop.

## 4. Model review and decision parsing

When deterministic checks pass, the reviewer provider is called. The model sees the diff, the changed files, the diff stat, the task goal, the check summary, and any previous failure summary. It returns a structured decision.

`src/reviewer-gate.ts` parses the raw output string with `parseReviewerDecision`. The expected verdicts are:

- `accept` → status `accepted`, next action `continue`.
- `reject` → status `fix_required`, next action `fix`.
- `block_for_human` → status `blocked`, next action `block`.

Any parse failure is treated as `blocked` with source `parser`.

`src/reviewer/reviewer-gate.ts` validates the provider object with `validateReviewerDecision` from the schema module and records `reviewerCalled: true`. This lets the orchestrator distinguish deterministic rejections (model never called) from actual model rejections. The `ReviewerGateResult` from `src/reviewer-gate.ts` also carries a `source` field with values `reviewer`, `parser`, `deterministic_safety`, or `provider`.

## 5. From reviewer outcome to task transition

`src/reviewer-task-outcome.ts` derives the task outcome from the persisted run state:

- If there is no run state, the outcome is `not_ready`.
- If the run state status is not in `{pushed, committed, approved}`, the outcome is `not_ready`.
- If there is no `reviewer_gate` record, the outcome is `legacy_success` (continue).
- If the gate status is `accepted`, the outcome is `accepted`.
- If the gate status is `fix_required`, the outcome is `fix_required`.
- If the gate status is `blocked`, the outcome is `blocked`.

`src/reviewer-task-transition.ts` then maps the outcome to an action:

| Outcome status   | Transition action |
| ---------------- | ----------------- |
| `legacy_success` | `continue`        |
| `accepted`       | `continue`        |
| `fix_required`   | `create_fix_task` |
| `blocked`        | `block_for_human` |
| `not_ready`      | `wait`            |

For `fix_required`, a fix task is created with:

- `parentTaskId` = original task id,
- `title` = `Fix reviewer issues for <original title>`,
- `goal` = the explicit fix task text or a synthesized goal from the blocking issues,
- `blockingIssues` = the blocking issues from the gate.

## 6. Fix task execution

`src/reviewer-fix-task-runner.ts` runs a fix task through an executor. The runner:

1. Checks the run plan state. If it is `not_present`, it returns `not_ready` / `wait`.
2. If the run plan state is `invalid`, it returns `blocked` and forwards the blocking issues.
3. If it is `ready`, it clones the execution request and fix task (to avoid accidental mutation), calls the executor, and clones the result.

Executor results are mapped as follows:

- `completed` → runner status `executed`, next action `review_fix_result`.
- `blocked` → runner status `blocked`, next action `block`, blocking issues from the result.
- Any thrown error → runner status `executor_failed`, next action `block`, with the error message redacted by `redactSecrets`.

The runner does not loop internally. It executes one fix attempt and reports whether the result needs to be reviewed, blocked, or waited on.

## 7. The real fix loop policy

The actual retry policy is implemented in the multi-task orchestrator, not in the one-task runner. As documented in `docs/STAGE6_14_FIX_LOOP.md`:

- `block-run-one` performs exactly one coder → reviewer cycle and then returns.
- `block-run` (the orchestrator) calls that cycle repeatedly while `fix_attempts < max_fix_attempts`.
- Both reviewer fix requests and guardrail/check failures increment the same `fix_attempts` counter.
- When the limit is reached, the task becomes `blocked` / `failed`.

Before a retry, the fix context is redacted (`buildCoderInputFromBlockTask`):

- `reviewerSummary` → `redactReviewerText`
- `fixTask` → `redactReviewerText`
- `blockingIssues` → `redactReviewerList`
- `checkFailureSummary` → `redactReviewerText`

This prevents secrets in test failures or reviewer output from circulating in the loop.

## 8. Accepted-only history

The system only treats commits that pass the reviewer gate as mission history.

- In multitask missions, accepted task commits are appended to `mission_commits` in `PersistedMissionState`.
- Failed, blocked, or needs-human task commits are reverted locally on the mission work branch before the mission result is finalized (the orchestrator does not push these reverts).
- Each task produces at most one final accepted commit on the work branch, as described in `02-task-lifecycle.md`.

This means the remote branch, if pushed, contains only reviewed-and-accepted commits.

## 9. Crash and resume reconciliation

Two persistence layers enable safe crash recovery.

### Single-task state

`src/state-manager.ts` persists `state.json` under `<runsDir>/<taskId>/`. It stores:

- `task_id`, `status`, `current_attempt`, `branch`, `repo_path`
- timestamps `created_at`, `updated_at`
- optionally `commit_sha`, `pushed`, `reviewer_gate`, etc.

Valid statuses are: `pending`, `coding`, `patching`, `running_checks`, `reviewing`, `approved`, `rejected`, `failed_guardrails`, `failed_max_attempts`, `pushed`, `blocked`.

On load, `loadState` validates the JSON, checks the status, checks that `current_attempt` is a non-negative integer, verifies required string fields, and confirms `task_id` matches the requested task. `task_id` values are restricted to letters, digits, hyphens, and underscores.

### Multitask mission state

`src/autopilot-one-click/multitask/state-manager.ts` persists `multitask-mission-state.json` under the mission run directory:

```typescript
interface PersistedMissionState {
  version: 1;
  run_id: string;
  stage: 'planning' | 'running' | 'reviewing' | 'completed';
  plan_hash: string;
  base_sha: string;
  work_branch: string;
  pr?: { number: number; url: string };
  tasks: MultitaskMissionTaskState[];
  result?: MultitaskMissionResult;
  last_error?: string;
  rolled_back_commits?: string[];
  mission_commits?: string[];
}
```

The state is saved atomically by writing to a temporary file and renaming it into place. The plan hash is computed from a canonical JSON representation of the generated plan, including normalized paths and sorted arrays, so that equivalent plans produce identical hashes.

### Resume rules

When `--resume` is used:

1. The mission state is loaded.
2. The plan hash is recomputed from the current plan and compared to `plan_hash`; a mismatch aborts resume.
3. The base SHA is resolved from git and compared to `base_sha`; a mismatch aborts resume.
4. Terminal non-success results (`failed`, `blocked`, `needs_human`, `skipped`) are returned without re-running.
5. Already-accepted task commits are verified to be ancestors of the current work branch before their results are returned.
6. Successful results are returned only after the ancestry gate passes.

These rules ensure the system does not replay work on top of a changed repository or accept a task whose commit is no longer present.

## 10. Summary of guarantees

- **Deterministic gates first**: safety and scope checks run before the model and can block or reject regardless of model output.
- **Bounded retries**: `max_fix_attempts` limits both reviewer-driven and guardrail-driven retries.
- **No secret propagation**: redaction is applied to deterministic messages, reviewer output, and fix context before the coder prompt.
- **Accepted-only history**: only reviewer-accepted commits are tracked as mission history; failed work is reverted locally.
- **Crash-safe resume**: atomic state writes, plan-hash verification, base-SHA verification, and accepted-commit ancestry checks let the workflow resume safely after interruption.
- **No main touch, no force-push, no merge, no workflow rerun, no branch deletion**: these remain forbidden across all presets.
