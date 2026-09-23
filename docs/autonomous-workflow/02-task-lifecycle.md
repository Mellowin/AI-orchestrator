# Task Lifecycle

This document describes the lifecycle of a **single task** inside an autonomous multitask mission, from the moment its base commit is pinned to the moment its single accepted commit lands on the mission work branch. It builds on the mission-level flow described in [01-one-click.md](01-one-click.md) and is grounded in the behavior implemented in `src/autopilot-one-click/multitask/`, `src/block/`, and `src/reviewer/`.

A mission runs many of these task lifecycles in dependency order (see `scheduleTasks` in `scheduler.ts`); this document covers exactly one of them.

## Lifecycle at a glance

```text
task_base_sha
  -> candidate workspace
  -> coder (provider generates changes)
  -> staging & deterministic checks
  -> reviewer gate
  -> fix loop (repeat coder -> checks -> reviewer while fixable)
  -> acceptance (accepted | fixed_and_accepted)
  -> single commit (commit_sha, optionally fix_commit_sha)
  -> push (mission work branch)
```

The task never touches `main`, never merges, and never force-pushes. All work happens on the mission work branch `mission-<run_id>` described in document 01.

## 1. `task_base_sha` — pinning the starting point

Before a task executes, the mission pins the exact commit it builds on:

- At mission start, the multitask runner resolves the mission base SHA with `getBaseSha(repo_path, base_branch)` (`git-helpers.ts`), falling back to `origin/<base_branch>` for CI-style checkouts. This SHA is persisted in mission state as `base_sha`.
- Per task, the runner records the task's starting commit in the task state field `task_base_sha` (see `MultitaskMissionTaskState` in `types.ts`). This is the commit the candidate workspace is derived from, and it is what the task's eventual commit is expected to sit on top of.
- On `--resume`, the mission refuses to continue if `base_sha` has moved (`Resume aborted: base branch moved`) or if the plan hash changed. Accepted task commits must still be ancestors of the work branch (`isAncestor` via `git merge-base --is-ancestor`); otherwise the resume aborts rather than silently rebuilding on different history.

Pinning a SHA per task makes the lifecycle reproducible: a task is always "diff from `task_base_sha`", never "whatever the branch happened to be".

## 2. Candidate workspace

The coder's changes are produced in an isolated candidate workspace, not directly on the mission branch:

- In `github` mode the mission already runs in a cloned, isolated execution workspace (document 01, "Local repo handling and automatic repo bootstrap"). The candidate workspace for a task is a working area inside that clone where the coder's edits are applied and validated before anything is committed.
- The candidate path is tracked in the task state as `candidate_path`, so an interrupted task can be inspected or resumed.
- The workspace starts from the task's `task_base_sha`, so the candidate diff contains only this task's changes.

## 3. Coder

The coder provider receives a structured task input built by `buildCoderInputFromBlockTask` (`block-task-runner.ts`):

- `task_id`, `title`, `goal` from the plan task definition.
- `allowed_files` / `denied_files` — the guardrail scope for this task. These become `Guardrails.allow_modify` / `Guardrails.deny_modify` via `buildTaskGuardrailsFromBlockTask`, which also sets `auto_commit: false`, `auto_push: false`, `auto_merge: false`: the coder stage itself never commits or pushes.
- `max_lines_changed` — an advisory size budget for the task.
- `repo_context` — the goal, optionally prefixed with the product vision document, and on fix attempts prefixed with the fix context (see section 6).
- `previous_failure` — the check failure summary when this is a retry after failing checks.

Provider selection is mode-dependent (`resolveCoderAndReviewerProviders`): `fake` mode uses deterministic fake providers; real modes require `ALLOW_REAL_PROVIDER=true` (and `ALLOW_KIMI_REVIEWER=true` for the Kimi reviewer) plus the corresponding API key in the environment. Tokens are read from the environment only and never printed or persisted.

## 4. Staging and deterministic checks

Coder output is staged and validated **before** any reviewer is called:

- **Staging** uses `stageOnlyFiles(repoPath, files)` (`block-real-mode-git.ts`), which hard-rejects absolute paths and `..` traversal, then runs `git add -- <files>`. Only files inside the task's allow list are staged.
- **Scope enforcement** uses `assertNoUnrelatedChanges`, which parses `git status --porcelain` and fails the task if any modified path is outside the approved set. A denied-file touch is a blocking issue.
- **Task checks** come from the plan (`checks` on the task definition). String checks are parsed by `parseShellCheckString`; structured checks are validated by `validateCheck` (including `cwd` normalization) before execution (`convertBlockChecks` in `block-task-runner.ts`).

Failures at this stage are fed back into the fix loop as `checkFailureSummary`; they never reach the reviewer as-is.

## 5. Reviewer gate

The reviewer gate (`runReviewerGate` in `reviewer-gate.ts`) is two-layered:

1. **Deterministic layer (no AI call).** If deterministic checks fail, the gate returns a synthetic `rejected` decision without calling the reviewer provider. The `next_action` depends on severity:
   - Severe safety findings — secret pattern detected, main branch violation, merge conflict markers in the diff, invalid commit SHA format, denied file touched — map to `block_for_human`.
   - Other deterministic failures map to `send_fix_to_coder` (the fix loop).
   - Summary checks (`runSummaryChecks`) additionally verify the commit against allowed files, acceptance criteria, and dependency evidence; a failure here is also rejected deterministically and sent back to the coder.
   - All text in deterministic decisions is redacted (`redactReviewerText` / `redactReviewerList`) so no sensitive content leaks into reports.
2. **Reviewer provider layer.** Only when deterministic checks pass is the reviewer called with the full `ReviewInput` (repo path, commit SHA, allowed files, acceptance criteria, dependency evidence). Its raw response is validated against the reviewer schema (`validateReviewerDecision`) before use.

A reviewer decision is one of: approved (optionally with non-blocking issues), rejected with `blocking_issues` and a `fix_task` for the coder, or escalation to a human.

## 6. Fix loop

When the reviewer (or the deterministic gate) rejects with `send_fix_to_coder`, the task re-enters the coder stage with fix context instead of the original bare goal:

- `buildCoderInputFromBlockTask` is called with a `FixContext` containing the attempt number, the previous reviewer summary, the reviewer's `fix_task`, the blocking issues list, and any check failure summary — followed by the original task goal.
- The fix runs through the same staging, checks, and reviewer gate as the initial attempt. The loop is bounded by the mission's repair/retry limits; exhaustion ends the task as `failed` or `blocked` rather than looping forever.
- A task that needed a fix before acceptance is recorded with status `fixed_and_accepted` and carries both `commit_sha` (the original accepted work's lineage) and `fix_commit_sha` (the commit that resolved the review findings).

## 7. Acceptance

A task is accepted when staging, checks, and the reviewer gate all pass. Its terminal status is one of:

| Status | Meaning |
|---|---|
| `accepted` | Passed checks and review on the first submission. |
| `fixed_and_accepted` | Passed after one or more fix-loop iterations; has a `fix_commit_sha`. |
| `failed` | The task could not complete (fix loop exhausted, unrecoverable error). |
| `blocked` | An external or policy blocker prevented completion. |
| `needs_human` | A severe safety finding or explicit human gate stopped the task. |
| `skipped` | An ancestor task failed/blocked/needs-human, so this task never ran (`markDescendantsSkipped`). |
| `skipped_safe_mode` | The mission ran in a no-mutation preset; the task was planned but not executed. |
| `paused_provider` / `paused_git_auth` | A provider outage or git-auth failure paused the task; the mission is resumable. |

The mission proceeds to its integrated validation and final review only when `allRequiredTasksAccepted` is true — every planned task is `accepted` or `fixed_and_accepted`. Rejected, failed, blocked, or needs-human task commits are rolled back from the mission branch with `git revert --no-edit` (newest first), and the rollback is tracked in `rolled_back_commits` so the mission-level rollback does not double-revert. This cleanup stays local; the human operator decides whether to push it.

## 8. Single commit

An accepted task results in exactly one logical unit of work on the mission branch, recorded as `commit_sha` (plus `fix_commit_sha` when a fix loop was involved):

- The commit is created by `commitStagedChanges(repoPath, message)` with `git commit --no-gpg-sign`, and the resulting SHA is read back with `git rev-parse HEAD` and validated against the 40-hex format before being stored in task state. An invalid SHA is a hard error.
- The commit contains only the staged, allow-listed files — scope was enforced before commit, so the commit is the audited artifact the reviewer approved.
- These commit SHAs are what resume validates: on `--resume`, every persisted accepted commit must still be an ancestor of the work branch, or the mission aborts rather than re-running accepted work.

## 9. Push

Pushing is a mission-level, capability-gated operation, not something the task does on its own:

- Tasks commit locally; the task guardrails keep `auto_push: false`.
- When the mission has push capability (`allow_repo_push`, e.g. the `real-multitask` preset), the work branch `mission-<run_id>` is pushed to `origin` (`pushCurrentBranch` / `pushBranch`). The multitask runner tracks every commit the mission introduced on top of `base_sha` in `mission_commits` so a later mission-level rollback (for example after a rejected final review) can revert exactly those commits, newest first.
- A push failure caused by credentials pauses the mission resumably (`MULTITASK_MISSION_PAUSED_GIT_AUTH`) with all accepted local commits preserved; after fixing `GITHUB_TOKEN`, the printed resume command pushes without consuming new AI calls.
- Force-push, merge, and branch deletion remain hard-forbidden at all times (see document 01).

## Relation to mission state

Each lifecycle transition is reflected in the persisted mission state (`multitask-mission-state.json`), which makes the whole flow resumable:

- `task_base_sha`, `candidate_path`, `commit_sha`, `fix_commit_sha`, `status`, and `attempt` live on the per-task state entry.
- Accepted task states survive resume (`mergeTaskStates` preserves prior `accepted` / `fixed_and_accepted` entries).
- Pause verdicts keep the mission in the `executing_tasks` stage so resume re-runs only what did not finish; terminal results are replayed from state without re-executing tasks.
