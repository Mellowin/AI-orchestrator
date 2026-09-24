# 02 — Lifecycle of a Single Task in the Autonomous Multitask Workflow

This document describes how one task moves through the autonomous multitask
workflow, from scheduling to acceptance (or failure), **as implemented** in
`src/autopilot-one-click/multitask/*` and the per-task machinery in
`src/reviewer/*` and `src/block/block-real-mode-git.ts`. It assumes the
one-click launch described in
[01-one-click.md](./01-one-click.md): the canonical invocation is
`npx tsx src/cli.ts autopilot-one-click <mission.json | "goal text">`, the
default raw-goal preset is `real-multitask` (which sets `yes` automatically),
and the same base branch / work branch / run id terminology applies.

## 1. Where the per-task lifecycle lives

The multitask mission runner (`runMultitaskMission` in
`src/autopilot-one-click/multitask/runner.ts`) is an **orchestrator**. It does
not execute tasks itself; it delegates the whole task DAG to the inner
autopilot-run / MVP runner via `runAutopilotRunFn(autopilotConfig, ...)` with
`skipPrCreation: true` and `deferRemoteFinalization: true`, then reconciles
the returned per-task results into mission state. The per-task mechanics
(staging, commit evidence, reviewer gate, fix routing) live in the inner
runner and in `src/reviewer/*` / `src/block/block-real-mode-git.ts`, which are
documented in §5.

The multitask layer contributes:

- the mission-level base SHA and work branch setup (§2),
- DAG scheduling and dependency-failure propagation (§3),
- persisted per-task state and its merge/resume semantics (§4, §6),
- rollback of rejected task commits (§7).

## 2. Before any task runs: base SHA, plan hash, work branch

`runMultitaskMission` performs this setup once per mission, before the inner
runner sees any task:

1. **Mission base SHA capture.** When repository mutation is allowed (any of
   `allow_repo_apply`, `allow_repo_commit`, `allow_repo_push`), the base SHA is
   resolved once with `getBaseSha(repoPath, base_branch)` —
   `git rev-parse <base_branch>`, falling back to `origin/<base_branch>` for
   CI checkouts that only have remote tracking refs. Failure to resolve the
   base branch fails the mission immediately. In safe mode (no mutation
   capability) there is no real base; the placeholder
   `safe-mode-no-base-<planHash>` is used instead.
2. **Plan hash.** `computePlanHash` hashes the canonicalized plan (goal, mode,
   CI/repair flags, risk level, and per-task fields with sorted file lists) to
   a 16-hex-character SHA-256 prefix. It is persisted and re-checked on resume.
3. **Work branch.** The mission work branch is `mission-<run_id>`, stored in
   state as `work_branch`. The multitask runner deliberately does **not**
   create it: creation and checkout are delegated to the inner MVP runner.
   On a fresh (non-resume) run the branch must not already exist; if it does
   the mission fails with a message to rerun with `--resume` or a different
   run id. If it exists but its merge base with the resolved base SHA is not
   the base SHA (`isBranchBasedOn`), the runner refuses to reuse it.
4. **Initial state.** A fresh mission persists `PersistedMissionState`
   (`multitask-mission-state.json` under
   `<output_dir>/missions/<run_id>/`, written atomically via temp file +
   rename) with `stage: 'planning'`, the plan hash, base SHA, work branch,
   `tasks: buildInitialTaskStates(...)` (every task `pending`), and an empty
   `mission_commits` list.
5. **Plan validation.** `validateGeneratedPlan` runs before execution; a
   failure marks the state `completed` with `last_error` and ends the mission.
6. **Safe mode.** If mutation is disabled, every task is recorded as
   `skipped_safe_mode`, the verdict is `MULTITASK_MISSION_DONE_WITH_CAVEATS`,
   and nothing touches the repository.

Per-task base (`task_base_sha`) and workspace (`candidate_path`) fields exist
in the persisted task-state schema (see §4) and are populated by the inner
runner's task results; the multitask orchestrator itself only captures the
single mission-level base SHA described above.

## 3. Scheduling: who runs, who is skipped

`src/autopilot-one-click/multitask/scheduler.ts` defines the scheduling model:

- The task DAG is validated (`validateTaskDAG`) and topologically sorted
  (`topologicalSortTasks`); an invalid DAG is a hard error.
- `scheduleTasks` assigns each task one of three dispositions:
  - `skip_already_finished` — the persisted state is `accepted` or
    `fixed_and_accepted` (this is what makes resume cheap: finished tasks are
    never re-run);
  - `skip_dependency_failed` — any entry in `depends_on` is `failed`,
    `blocked`, or `needs_human`; the task is marked `skipped` with reason
    "Dependency <id> failed, was blocked, or needs human", and the task itself
    is added to the failed set so the skip cascades down the DAG;
  - `run` — otherwise.
- `filterRunnableTasks` returns the `run` tasks still in `pending` state.
- `getDescendants` computes the transitive dependents of a task;
  `markDescendantsSkipped` (in the runner) marks every descendant of a
  failed/blocked/needs-human task as `skipped` with reason "Skipped because an
  ancestor task failed or was blocked", unless the descendant is already
  accepted.
- `allRequiredTasksAccepted` is the mission gate: every task in the plan must
  end `accepted` or `fixed_and_accepted`, otherwise the mission cannot be
  approved regardless of provider verdicts.

## 4. Per-task state schema

`MultitaskMissionTaskState` (in `types.ts`) is the persisted record of one
task:

| Field | Meaning |
|---|---|
| `task_id` | Plan task id. |
| `status` | `pending`, `running`, `accepted`, `fixed_and_accepted`, `failed`, `blocked`, `skipped`, `skipped_safe_mode`, `needs_human`, `paused_provider`, or `paused_git_auth`. |
| `commit_sha` | SHA of the task's accepted commit on the work branch. |
| `fix_commit_sha` | SHA of the follow-up fix commit, when the task was accepted only after a fix (`fixed_and_accepted`). |
| `accepted_commit_sha` | Declared in the schema for the final accepted commit. |
| `task_base_sha` | Declared in the schema for the per-task base SHA captured by the inner runner. |
| `candidate_path` | Declared in the schema for the per-task candidate workspace path used by the inner runner. |
| `reason` | Human-readable reason for non-accepted outcomes. |
| `attempt` | Declared in the schema for the attempt counter. |

After each inner run, `mapAutopilotResultToTaskStates` converts the inner
runner's per-task statuses into mission statuses:

| Inner MVP status | Mission task status |
|---|---|
| `passed` | `accepted` |
| `passed_with_caveats` | `fixed_and_accepted` |
| `blocked` | `blocked` |
| `skipped` | `skipped` |
| `needs_human` | `needs_human` |
| `paused_provider` | `paused_provider` |
| `paused_git_auth` | `paused_git_auth` |
| anything else | `failed` |

`mergeTaskStates` then merges the new results with the persisted state under a
sticky-acceptance rule: a task already `accepted` or `fixed_and_accepted` from
a prior run **stays accepted**; only missing `commit_sha` / `fix_commit_sha`
metadata is filled in. New non-accepted states replace the old ones.

## 5. Inside one task execution

The steps below are performed by the inner runner and the shared per-task
machinery; the multitask orchestrator observes their outcome through the
mapped statuses and commit SHAs above.

### 5.1 Staging and the single commit

`src/block/block-real-mode-git.ts` implements the real-mode git writes:

- `stageOnlyFiles(repoPath, files)` stages **only** the task's files. Absolute
  paths and `..` traversal are rejected, and an empty file list is an error.
- `assertNoUnrelatedChanges(repoPath, approvedFiles)` compares
  `git status --porcelain` against the approved file set (separator-normalized,
  rename-aware) and throws on any unrelated change.
- `commitStagedChanges(repoPath, message)` creates **one commit**
  (`git commit -m <msg> --no-gpg-sign`) and returns the new `HEAD` SHA after
  validating it is a full 40-character hex string (lowercased).
- `pushCurrentBranch(repoPath, branch)` pushes the current branch to `origin`.

### 5.2 Commit evidence

`src/reviewer/commit-verifier.ts` builds the deterministic evidence for a
task's commit:

- `validateCommitSha` requires a full 40-char hex SHA; `verifyCommitExists`
  confirms the commit exists in the repo.
- `getCommitChangedFiles` and `getCommitDiff` (against a base ref when given)
  collect the changed-file list and patch; diffs are truncated beyond
  500 KB / 5,000 lines and the truncation is recorded as a safety finding.
- `getGitStatusPorcelain` and `getCurrentBranchName` capture the working-tree
  state for the reviewer input.

### 5.3 Reviewer gate and the fix loop

`runReviewerGate` in `src/reviewer/reviewer-gate.ts` decides each task
attempt:

1. **Deterministic checks first.** If the deterministic result is not OK, the
   reviewer model is **not called**. The decision is a high-confidence
   rejection whose `next_action` is:
   - `block_for_human` for severe safety findings (secret pattern detected,
     main branch violation, merge conflict markers, invalid commit SHA format,
     denied file touched), or
   - `send_fix_to_coder` otherwise — the rejection carries a `fix_task`
     instruction, which is what drives the coder fix loop for the next attempt.
2. **Summary checks.** `runSummaryChecks` validates the commit against
   `allowed_files` and `acceptance_criteria`; failure is again a deterministic
   `send_fix_to_coder` rejection without calling the reviewer.
3. **Reviewer call.** Only when all deterministic gates pass is the reviewer
   provider invoked, and its decision is validated against the reviewer schema.

A task that passes outright maps to `accepted`; a task accepted after a fix
commit maps to `fixed_and_accepted` (with both `commit_sha` and
`fix_commit_sha` recorded). Exhausted or blocked attempts map to the
non-accepted statuses in §4.

## 6. Commit tracking on the mission branch

After the inner run returns, the runner records mission-owned commits: if the
current `HEAD` has the mission base SHA as an ancestor, every commit in
`base_sha..HEAD` (`git log --format=%H`, newest first) is appended to
`state.mission_commits` (deduplicated). Comparing against the captured mission
base — rather than the pre-run `HEAD` — is deliberate: when the caller started
on a branch other than the base branch, the inner runner checks out the base
and creates the work branch from the base SHA, so base-branch commits must not
be attributed to the mission. Finalization-repair commits (see
document 03 territory; summarized in §8) are added to the same list.

## 7. Rollback of rejected task commits

When mutation is allowed, any task that ended `blocked`, `failed`, or
`needs_human` has its `commit_sha` and `fix_commit_sha` collected,
deduplicated, and **reverted newest-first** (`git revert --no-edit`) on the
checked-out work branch, so each revert applies cleanly on top of the previous
one. Because some git configurations create one revert commit per SHA, every
new commit produced by the revert is captured from `git log <before>..HEAD`
and appended — together with the reverted SHAs — to
`state.rolled_back_commits`, so a later mission-level rollback never tries to
revert them twice. This task-level rollback **stays local**: the human
operator decides whether to push the cleaned-up branch. A revert failure is
recorded in `state.last_error` (as `Rollback failed: ...`) without aborting
the mission at this point.

Accepted tasks are never rolled back here; mission-level rollback of **all**
mission commits happens only when the mission-level final review rejects or
diff collection fails (out of scope for this per-task document).

## 8. What happens after all tasks

Only the task-relevant gates are listed here:

- If the inner verdict is a pause (`AUTOPILOT_PAUSED_PROVIDER` /
  `AUTOPILOT_PAUSED_GIT_AUTH`), the mission pauses resumably
  (`MULTITASK_MISSION_PAUSED_PROVIDER` / `MULTITASK_MISSION_PAUSED_GIT_AUTH`),
  prints a `Resume command` from `buildResumeCommand`, keeps
  `stage: 'executing_tasks'`, and preserves accepted tasks, the paused task,
  and pending descendants exactly as-is.
- Other non-green inner verdicts map to failed/needs-human/external-blocker
  mission verdicts via `mapAutopilotFailureToMissionVerdict`.
- `allRequiredTasksAccepted` must hold; otherwise the mission fails with
  "Not all required tasks were accepted" even if the provider run was green.
- Only then do integrated validation, finalization repair, the mission-level
  final review, PR creation, and CI observation run — those operate on the
  integrated work branch, not on individual tasks.

## 9. Resume semantics for tasks

`--resume` reloads `multitask-mission-state.json` and enforces:

1. **Plan unchanged.** `state.plan_hash` must equal the freshly computed plan
   hash — otherwise "Resume aborted: mission plan changed".
2. **Base unchanged.** `state.base_sha` must equal the re-resolved base SHA —
   otherwise "Resume aborted: base branch moved".
3. **Terminal replay.** A `completed` state with a terminal **failure**
   verdict is returned as-is without re-running. Paused missions are not
   terminal and always re-enter execution. Successful terminal results are
   returned only after the ancestry gate below passes.
4. **Ancestry gate.** For every `accepted` task, `commit_sha` must exist in
   state and be an ancestor of the work branch; for every
   `fixed_and_accepted` task, both `commit_sha` and `fix_commit_sha` must.
   Missing SHAs abort with "required accepted commits are missing from
   state"; SHAs not on the branch abort with "required accepted commits are
   not ancestors of <workBranch>" (`isAncestor` =
   `git merge-base --is-ancestor`).
5. **No re-execution of finished work.** The scheduler's
   `skip_already_finished` disposition plus the sticky-acceptance merge (§4)
   guarantee accepted tasks are never re-run; only `pending`/paused work
   resumes. The fail-closed one-click rule from document 01 still applies:
   `--resume` with a raw goal and no `--run-id` is rejected.

## 10. Hard rules inherited from one-click

The per-task lifecycle never relaxes the mission-level hard rules printed at
launch: no `github.merge`, no `git.force_push`, no `github.actions.rerun`, no
`repo.delete_branch`. Task commits are ordinary commits on the mission work
branch; rejected work is removed by revert commits, never by rewriting
history; and the work branch is never `main`.
