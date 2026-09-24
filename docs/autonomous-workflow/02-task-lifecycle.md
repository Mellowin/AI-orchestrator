# 02 — Lifecycle of a Single Task

This document describes the lifecycle of one task inside a multitask mission: from the per-task base SHA, through the candidate workspace, coder, staging/checks, reviewer, and fix loop, to acceptance, a single accepted commit, and push. It builds on `01-one-click.md` (canonical launch, branch setup, resume) and is grounded in the actual implementation in `src/autopilot-one-click/multitask/` and the inner autopilot/MVP runner it delegates to.

## Scope and relationship to the mission

- The mission owns the branch (`mission-<run_id>`), the base SHA (`base_sha`), scheduling, integrated validation, final review, PR creation, and CI observation. A task never creates the mission branch and never touches `main`.
- Task execution is delegated to the inner MVP runner (`runAutopilotRun` over the generated `autopilot.config.json`), which performs the per-task coder/checks/reviewer/fix-loop work. The multitask runner then **reconciles** the per-task results into persisted mission task states.
- Every task is confined to its `allowed_files` (writable scope). Files produced by accepted ancestor tasks are provided to reviewers as **read-only dependency evidence**, never as a writable scope.

## Task states

Per `MultitaskMissionTaskState` (`multitask/types.ts`), a task moves through:

```
pending → running → accepted | fixed_and_accepted | failed | blocked |
                    needs_human | paused_provider | paused_git_auth
```

plus `skipped` (ancestor failed/blocked/needs_human, per `markDescendantsSkipped` and the scheduler's `skip_dependency_failed` disposition) and `skipped_safe_mode` (plan-only safe mode; see `01-one-click.md`). Terminal acceptance states are `accepted` and `fixed_and_accepted`; both count as accepted for `allRequiredTasksAccepted` and for resume verification.

## Lifecycle steps

### 1. `task_base_sha` — resolve the per-task base

Before the task's coder runs, the runner resolves the commit the task starts from (`task_base_sha` on the task state). For a root task this is the mission `base_sha`; for a dependent task it is the tip of the mission branch after its accepted ancestors' commits. This pins the task to an exact starting tree so its diff is attributable to the task alone and conflicts with sibling tasks surface immediately. Resume aborts if the mission `base_sha` moved (`Resume aborted: base branch moved`).

### 2. Candidate workspace

The task's edits are staged in a **candidate workspace** (`candidate_path` on the task state) — an isolated copy/worktree layered on `task_base_sha`. The coder may only modify files matching the task's `allowed_files`; `denied_files` and path traversal are rejected. Nothing in the candidate workspace is visible on the mission branch until acceptance.

### 3. Coder

The coder (provider call, real or fake depending on mode) receives the task goal, constraints, allowed files, and read-only dependency evidence from accepted ancestors. It produces file changes inside the candidate workspace. Provider failures are classified: transient/quota/auth failures pause the mission (`paused_provider`) with a structured `provider_failure` and a resume command, without spending further quota.

### 4. Staging and checks

The candidate changes are staged and the task's `checks` (and `tests`, when declared) run against the staged tree, along with budget enforcement (`max_lines_changed`) and scope verification against `allowed_files`. A check failure does not reject the task outright; it feeds the fix loop.

### 5. Reviewer

A reviewer evaluates the staged diff against the task's acceptance criteria and expected result. Model approval is **not** a security boundary: a mandatory deterministic gate (unauthorized files, unmet acceptance) overrides a model "approved" verdict, exactly as the mission-level final review does (`buildGateRejectedReview` in `final-review.ts`).

### 6. Fix loop

If the reviewer or checks reject the staged work and attempts remain, the task re-enters the coder with the failure feedback (check output, reviewer comments). The loop repeats up to the configured attempt budget. Fixes that pass review are committed separately, producing `fix_commit_sha`; a task accepted after one or more fix iterations ends as `fixed_and_accepted` (mapped from the inner runner's `passed_with_caveats`), while a clean first pass ends as `accepted` (from `passed`). Exhaustion yields `failed` or `blocked`.

### 7. Acceptance

Acceptance is terminal for the task:

- The accepted change becomes commits on the mission branch: `commit_sha` (the task's commit) and, when the fix loop ran, `fix_commit_sha`.
- The state records `accepted_commit_sha`, `task_base_sha`, and `candidate_path` as evidence.
- Accepted states are preserved across resume (`mergeTaskStates` keeps a previously accepted task accepted), and on resume every accepted `commit_sha`/`fix_commit_sha` must still be an ancestor of `mission-<run_id>` — otherwise the run fails closed (`Resume aborted: required accepted commits are not ancestors ...`).

### 8. Single commit

Each accepted task contributes its own commit(s) on top of `task_base_sha` on the mission branch — the task does not squash into or amend other tasks' commits. The multitask runner tracks every mission-owned commit in `mission_commits` (computed as commits between `base_sha` and HEAD after the run), which later drives rollback: rejected/blocked task commits are reverted newest-first, and a rejected final review reverts all remaining mission commits locally. Rollback stays local; the human operator decides whether to push the cleaned-up branch.

### 9. Push

The task itself never pushes. Push happens only at the mission level after acceptance of all required tasks, integrated validation (plus finalization repair when classified `REPAIRABLE_REPOSITORY_FAILURE`), and final-review approval — then the mission branch is pushed and the PR created (when `allow_pr_create`). Pauses on push authorization (`paused_git_auth`) preserve all accepted local commits and resume without new AI calls once `GITHUB_TOKEN` is fixed.

## Failure and skip semantics

| Outcome | Consequence |
|---|---|
| `failed` / `blocked` / `needs_human` | Task's commits (if any) are reverted locally; all descendants are `skipped`; mission cannot reach a `DONE` verdict unless every required task is accepted. |
| `paused_provider` / `paused_git_auth` | Mission stays in `executing_tasks`; accepted tasks remain accepted, descendants remain `pending`; rerun with `--resume` after fixing the external cause. |
| `skipped_safe_mode` | Plan-only safe mode; no repository mutation was performed. |

## Invariants (must hold for every task)

1. A task only writes within its `allowed_files`; the deterministic gate, not the model, is the final scope authority.
2. An accepted task's commits are ancestors of the mission branch, verified on every resume.
3. Exactly one accepted outcome per task (`accepted` or `fixed_and_accepted`), recorded with its commit SHAs.
4. No task pushes, merges, or touches `main`; hard safety rules from `01-one-click.md` apply throughout.
