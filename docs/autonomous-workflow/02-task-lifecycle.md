# 02 — Lifecycle of a Single Task in the Autonomous Multitask Workflow

This document describes how one task inside a multitask mission moves from
`pending` to `accepted` (or a terminal failure state). It builds on
[01 — One-Click Launch](01-one-click.md), which covers mission bootstrap, base
branch resolution, and mission branch creation; nothing here changes those
rules. The behavior described is implemented by the multitask mission runner
(`src/autopilot-one-click/multitask/runner.ts`, `scheduler.ts`,
`git-helpers.ts`, `state-manager.ts`, `types.ts`) together with the inner MVP
runner it delegates to, and the committed-task reviewer gate
(`src/committed-task-reviewer-gate.ts`, `src/reviewer/commit-verifier.ts`).

## Task states

Every task starts as `pending` (`buildInitialTaskStates` in `scheduler.ts`)
and ends in exactly one terminal state (`MultitaskMissionTaskState` in
`types.ts`):

| State | Meaning |
|---|---|
| `pending` | Not yet executed. |
| `running` | Currently being executed. |
| `accepted` | Reviewer approved the task on the first pass; `commit_sha` is set. |
| `fixed_and_accepted` | Reviewer requested changes; the fix loop produced a passing result. `commit_sha` and `fix_commit_sha` are set. |
| `failed` | Execution or review failed and the fix loop was exhausted. |
| `blocked` | The task could not proceed (e.g. unsatisfiable constraints). |
| `skipped` | An ancestor task failed / was blocked / needs human; the scheduler marks descendants skipped (`markDescendantsSkipped`). |
| `skipped_safe_mode` | The mission ran with repository mutation disabled (safe mode); no execution happened. |
| `needs_human` | A safety gate requires human review. |
| `paused_provider` | Provider access (credentials/quota/rate limit) was interrupted; resumable. |
| `paused_git_auth` | The git credential cannot push; resumable without new AI calls. |

## Lifecycle stages

### 1. Scheduling (DAG order)

Before any task runs, `scheduleTasks` validates the task DAG and topologically
sorts it. A task is only dispatched (`disposition: 'run'`) when:

- it is still `pending` (already `accepted` / `fixed_and_accepted` tasks are
  skipped as finished — this is what makes `--resume` cheap), and
- none of its `depends_on` entries are in a failed/blocked/needs-human state.

If a dependency failed, the task is marked `skipped` with a reason naming the
failed dependency, and its own descendants are transitively skipped.

### 2. `task_base_sha` capture

Before a task mutates anything, its starting point is pinned. The mission
resolves the overall base SHA once at startup with `getBaseSha`
(`git rev-parse <base>`, falling back to `git rev-parse origin/<base>` for
CI-style checkouts) and persists it as `base_sha` in the mission state. Each
task's own starting commit is recorded as `task_base_sha` on its task state
(see `MultitaskMissionTaskState`). Resume aborts if the persisted `base_sha`
no longer matches the resolved base branch tip ("Resume aborted: base branch
moved"), so a task never silently rebases onto a moved base.

### 3. Candidate workspace creation

The mission never executes tasks in the user's working checkout. As described
in doc 01, github mode clones the repository into an isolated mission
workspace and the mission runs on a work branch derived from the run id
(`autopilot-<runId>` in github mode). Inside that workspace, the task's
candidate changes are staged in a candidate area recorded as `candidate_path`
on the task state. The mission work branch itself is created by the inner MVP
runner from the resolved base SHA; the outer runner deliberately does *not*
pre-create it, and refuses to reuse an existing work branch that is not based
on the current base (`isBranchBasedOn`).

### 4. Coder execution

The coder (the task-level AI worker, driven by the inner MVP runner under
`runAutopilotRun`) applies the task's changes inside the candidate workspace.
The task's file guardrails from the plan (`allowed_files`, `denied_files`,
`max_lines_changed`) bound what the coder may touch; they are part of the
canonical task hash (`computePlanHash`), so changing them invalidates resume.

Provider interruptions here pause the mission (`paused_provider` /
`paused_git_auth`) instead of failing it: accepted work is preserved, the
stage stays `executing_tasks`, and a concrete resume command is printed.

### 5. Staging and checks

After the coder finishes, the task's declared `checks` / `tests` from the plan
run against the candidate. The candidate diff is collected and bounded by the
same evidence limits the commit verifier applies later (`DIFF_MAX_BYTES` /
`DIFF_MAX_LINES`, with an explicit truncation marker). A task whose checks
fail does not reach the reviewer as a success; it enters the fix loop or
fails.

### 6. Reviewer gate

The task's committed candidate is reviewed through the committed-task reviewer
gate (`runCommittedTaskReviewerGate`):

1. **Deterministic evidence is built first.** `buildCommitEvidence` /
   `buildReviewerEvidence` collect, without any AI involvement: the normalized
   full 40-character commit SHA (validated and verified to exist in the repo),
   the changed-file list, the (size-guarded) diff, porcelain `git status`, the
   current branch name, the task's `allowed_files` / `denied_files` /
   `max_lines_changed` guardrails, and any safety findings (e.g. truncated
   diff).
2. **The reviewer provider judges that evidence.**
   `runReviewerGateWithProvider` sends the evidence package to the reviewer
   model with bounded parse retries (`maxParseRetries`). The reviewer verdict
   is approve / needs-changes / reject against the task goal, acceptance
   criteria, and file guardrails.

The reviewer never sees unverified claims: every artifact it judges comes from
git commands against the actual candidate commit.

### 7. Fix loop

If the reviewer requests changes, the task re-enters execution with the
review feedback: the coder produces a fix, checks re-run, and the reviewer
re-evaluates. When a fix pass succeeds, the task is accepted as
`fixed_and_accepted` and the fix's commit is recorded as `fix_commit_sha`
alongside the original `commit_sha`. If the loop is exhausted without
approval, the task ends `failed` (or `blocked` / `needs_human` when the
blocker is external or a safety gate).

### 8. Acceptance

A task is accepted exactly when the reviewer gate approves — either on the
first pass (`accepted`) or after the fix loop (`fixed_and_accepted`).
Acceptance records the commit metadata on the task state (`commit_sha`,
`fix_commit_sha`, `accepted_commit_sha`), and the merged mission state
preserves accepted statuses across resumes (`mergeTaskStates` never demotes an
accepted task).

### 9. Single commit

Each accepted task lands on the mission work branch as its own commit (plus,
when the fix loop ran, its fix commit). The mission runner tracks every commit
introduced on top of the mission base in `mission_commits` — computed from
`git log <baseSha>..<head>` so unrelated base-branch commits are never
included. On resume, the ancestry gate
(`verifyAcceptedCommitsAreAncestors` / `isAncestor`) verifies every recorded
accepted commit is still an ancestor of the work branch; if any is missing or
not an ancestor, resume aborts fail-closed instead of re-running work.

### 10. Push

Pushing is mission-scoped, not per-task. Accepted task commits accumulate on
the mission work branch locally; the branch is pushed with a plain
`git push origin <branch>` (`pushBranch`) as part of mission finalization and
PR creation — never a force push (`git.force_push` is a forbidden capability,
see doc 01). Rollback of rejected/blocked/failed task commits (via
`git revert --no-edit`, newest first, recorded in `rolled_back_commits`) stays
local; the human operator decides whether to push the cleaned-up branch. If
the git credential cannot push, the mission pauses as
`MULTITASK_MISSION_PAUSED_GIT_AUTH` and resume pushes the preserved local
commits without new AI calls.

## Mission-level gates around the per-task lifecycle

The per-task lifecycle above is wrapped by mission-level gates in
`runMultitaskMission`, which a single task never bypasses:

- **All-required-accepted gate** (`allRequiredTasksAccepted`): mission review
  only runs when every planned task is `accepted` or `fixed_and_accepted`.
- **Integrated validation**: after all tasks are accepted, repository-wide
  validation runs (`integrated_validation` stage), with a bounded
  finalization-repair loop (`finalization_repair`, `max_attempts` from the
  mission's repair config) for `REPAIRABLE_REPOSITORY_FAILURE`
  classifications; successful in-scope repairs produce persisted
  `authorized_maintenance` evidence reused verbatim on resume.
- **Mission final review** (`mission_review`): a reviewer judges the
  integrated diff between base and work branch plus all task states. Rejection
  or needs-changes triggers a rollback of mission-owned commits (revert
  newest-first, excluding already-rolled-back SHAs).
- **PR creation and CI observation** (`creating_pr`, `awaiting_ci`,
  `ci_repair`): see doc 01 for the outer flow; these stages are persisted in
  mission state so resume re-enters at the right point.

## State persistence and resume

Every stage transition saves the mission state atomically
(`saveMissionState`: write to `*.tmp` then rename) to
`<run_dir>/multitask-mission-state.json`. The persisted record includes the
plan hash, base SHA, work branch, per-task states with commit SHAs, mission
commits, rolled-back commits, validation outcome, final review, and PR info.
Resume validates plan-hash integrity and base-SHA identity before continuing
and never re-executes accepted tasks.
