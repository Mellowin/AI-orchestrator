# 02 — Lifecycle of a Single Task

This document describes, strictly based on the code in `src/autopilot-one-click/` and
`src/reviewer/`, the lifecycle of **one task** inside an autonomous multitask mission:
from pinning the task's base SHA, through the candidate workspace, the coder, staging
and checks, the reviewer gate, the fix loop, acceptance, the resulting commit(s), and
the push of the mission branch.

This is a continuation of `01-one-click.md`, which covers how the mission is launched,
how the repository workspace and base branch are resolved, and how the mission branch
`mission-<run_id>` is created. Nothing in this document overrides those rules: the same
base SHA pinning, resume gates, and safety envelope apply to every task in the mission.

## Lifecycle at a glance

```text
task_base_sha
    │
    ▼
candidate workspace (isolated per-task candidate state)
    │
    ▼
coder (CoderProvider.runTask)
    │
    ▼
staging + deterministic checks (commit evidence, scope, summary checks)
    │
    ▼
reviewer gate (deterministic gate first, AI reviewer only after it passes)
    │
    ├── rejected, next_action = send_fix_to_coder ──► fix loop (CoderProvider.runFix)
    │                                                  │
    │                                                  └── re-review (bounded attempts)
    │
    ├── rejected, next_action = block_for_human ────► task status: needs_human / blocked
    │
    ▼
accepted
    │
    ▼
single commit per attempt recorded on the mission branch
(commit_sha, plus fix_commit_sha when the fix loop ran)
    │
    ▼
push of mission-<run_id> (only after acceptance; never force-push, never main)
```

## 1. Task base SHA (`task_base_sha`)

Every task is anchored to a concrete git SHA before any work begins:

- The mission-level base SHA is resolved once by `getBaseSha` (from `base_branch`,
  falling back to `origin/<base_branch>` for CI-style checkouts) and persisted in the
  mission state as `base_sha` (see `01-one-click.md`, "Base branch resolution").
- Each task additionally records its own `task_base_sha` in its persisted task state
  (`MultitaskMissionTaskState.task_base_sha`), i.e. the exact commit the task's work
  starts from. Because tasks execute sequentially on the mission branch in topological
  order (`scheduleTasks` in `scheduler.ts`), a task's base is normally the tip of
  `mission-<run_id>` after all previously accepted ancestor tasks.
- On `--resume`, the mission-level `base_sha` is compared against the re-resolved base
  branch; if the base branch moved, resume aborts fail-closed with "Resume aborted:
  base branch moved". Accepted task commits must also still be ancestors of the work
  branch (`merge-base --is-ancestor`), otherwise resume aborts.

Pinning the base SHA is what makes review evidence reproducible: the reviewer diffs the
candidate/commit against a fixed base instead of a moving branch.

## 2. Candidate workspace

The coder does not commit directly. It produces a **candidate** — a set of proposed
file contents — that is staged and inspected before any commit exists:

- `CoderProvider.runTask(input: CoderTaskInput)` returns a `CoderResult` containing
  `files: Array<{ path, content }>` plus a summary and notes. The input carries the
  task's guardrails: `allowed_files`, `denied_files`, `max_lines_changed`, the goal,
  repository context, and (on retry) the `previous_failure` reason.
- The task state records the candidate location as `candidate_path`
  (`MultitaskMissionTaskState.candidate_path`).
- For pre-commit review, the reviewer receives a `candidate_state` in its `ReviewInput`:
  the candidate's `base_sha`, a `package_hash`, and the per-file manifest
  (`path`, `bytes`, `lines`, `sha256`, `content`). When `candidate_state` is present,
  the reviewer prompt uses candidate semantics instead of post-commit semantics — the
  candidate is reviewed *before* it becomes a commit.
- The reviewer may also receive `read_only_context` (repository files with content,
  size, and hashes) so it can verify the candidate against the real implementation
  without granting any write permission.

## 3. Coder

The coder is a provider with role `coder` (`ProviderRole`), called through the
`CoderProvider` interface:

- **First attempt**: `runTask(input)` with the task goal, allowed/denied files, line
  budget, and repo context.
- **Fix attempts**: `runFix(input)` — the same interface, but the input's
  `previous_failure` field carries the reviewer's `fix_task` / blocking issues from the
  last rejection, so the fix is targeted rather than a rewrite.

Provider interruptions (quota, rate limit, credentials) are not treated as task
failures: the task transitions to `paused_provider` and the mission pauses resumably
(`MULTITASK_MISSION_PAUSED_PROVIDER`) with a printed `resume_command`. Accepted work
from earlier tasks is preserved; see `01-one-click.md`, "Resume rules".

## 4. Staging and deterministic checks

Before any AI reviewer is consulted, the candidate/commit passes through deterministic,
no-AI checks. Two layers exist:

### Commit evidence (`src/reviewer/commit-verifier.ts`)

`buildCommitEvidence` collects verifiable facts about the commit under review:

- **SHA validation**: the commit SHA must be a full 40-character hex string
  (`validateCommitSha`); an invalid SHA is a safety finding.
- **Existence**: `git rev-parse --verify <sha>^{commit}` proves the commit exists.
- **Changed files**: `git diff --name-only <base>...<sha>` (or `git show` without a
  base) yields the sorted file list used for the allowed/denied scope check.
- **Diff**: collected with hard size guards (500 KB / 5,000 lines); truncation is
  itself recorded as a safety finding ("Diff was truncated due to size limits").
- **Working tree hygiene**: `git status --porcelain` and the current branch name are
  captured so the reviewer can see uncommitted residue or a wrong branch.

### Deterministic gate and summary checks (`src/reviewer/reviewer-gate.ts`)

`runReviewerGate` runs the deterministic result **first**:

1. If deterministic checks fail (`deterministicResult.ok === false`), the task is
   rejected **without calling the AI reviewer at all** (`reviewerCalled: false`).
2. If the deterministic gate passes, `runSummaryChecks` verifies the commit against
   the task's allowed files and acceptance criteria (including dependency evidence
   from accepted ancestor tasks). A summary-check failure is also a deterministic
   rejection — again, no reviewer call.
3. Only when both pass is the reviewer provider invoked.

This ordering guarantees that scope violations, missing acceptance evidence, and
safety findings can never be "talked past" by an AI reviewer.

## 5. Reviewer

The reviewer is a provider with role `reviewer` (`ReviewerProvider.reviewCommit`),
returning a validated `ReviewerDecision`:

```text
decision:        accepted | rejected
confidence:      low | medium | high
blocking_issues:   string[]   — must be fixed before acceptance
non_blocking_issues: string[]
review_summary:  string
fix_task:        string | null — instructions fed back to the coder on rejection
next_action:     advance_to_next_task | send_fix_to_coder | block_for_human
```

The decision is schema-validated (`validateReviewerDecision`) and redacted
(`redactReviewerList` / `redactReviewerText`) before it influences the pipeline.

## 6. Fix loop

Rejection is not terminal by itself. The `next_action` field decides what happens:

- **`send_fix_to_coder`** — the fix loop: the coder is re-invoked via `runFix` with
  `previous_failure` set to the reviewer's `fix_task`/blocking issues. The new
  candidate goes through the same staging, checks, and review again. The number of
  attempts is bounded (tracked per task as `attempt` in the task state); exhausting
  the attempt budget ends the task as `failed`.
- **`block_for_human`** — the task ends as `needs_human` (or `blocked`).
  Deterministically rejected tasks with **severe safety findings** are always routed
  here instead of back to the coder. The severe list in `reviewer-gate.ts` is:
  `secret pattern detected`, `main branch violation`, `merge conflict markers in
  diff`, `invalid commit sha format`, `denied file touched`.
- **`advance_to_next_task`** — normal acceptance path (see below).

## 7. Acceptance

A task is accepted in exactly two states (`MultitaskMissionTaskState.status`):

- **`accepted`** — the first candidate passed checks and review.
- **`fixed_and_accepted`** — the task required the fix loop but was ultimately
  accepted. (Mapped from the inner runner's `passed_with_caveats` status.)

Acceptance properties enforced by the mission runner:

- Accepted states are **sticky across resume**: `mergeTaskStates` never demotes an
  `accepted`/`fixed_and_accepted` task based on a later run's output.
- The mission can only finish successfully when **all required tasks** are accepted
  (`allRequiredTasksAccepted`). Otherwise the mission fails with "Not all required
  tasks were accepted; final mission review cannot approve".
- A failed/blocked/needs-human task cascades: all of its DAG descendants are marked
  `skipped` with the reason "Skipped because an ancestor task failed or was blocked"
  (`markDescendantsSkipped`, `getDescendants`).

## 8. Commit model: one commit per accepted attempt

Each task records its commits in the persisted task state:

- **`commit_sha`** — the commit produced for the task's accepted work.
- **`fix_commit_sha`** — the additional commit produced by the fix loop, when the task
  is `fixed_and_accepted`.
- Both land on the mission branch `mission-<run_id>` — never on the base branch.

The mission runner tracks every commit it introduces on top of `base_sha`
(`mission_commits`) so that rollback is precise:

- Commits of tasks that end `blocked`, `failed`, or `needs_human` are rolled back with
  `git revert --no-edit` (newest first) on the mission branch. These rollbacks stay
  **local** — the human operator decides whether to push the cleaned-up branch.
- A rejected mission-level final review also rolls back all mission-owned commits via
  revert commits. The workflow never rewrites history: no reset, no force-push.
- On `--resume`, every recorded `commit_sha`/`fix_commit_sha` of accepted tasks must
  still be an ancestor of the work branch; a missing commit aborts resume with
  "Resume aborted: required accepted commits are not ancestors of <branch>".

## 9. Push

Pushing is a mission-level operation, not a per-task decision:

- The only branch ever pushed is `mission-<run_id>`, via `git push origin <branch>`
  (`pushBranch`). The base branch is never pushed to, and the hard safety envelope
  from `01-one-click.md` always applies: no `github.merge`, no `git.force_push`, no
  `github.actions.rerun`, no `repo.delete_branch`.
- Push authorization is preflighted **before the first provider call**
  (`runGitWriteAuthPreflight`, see `01-one-click.md`). If `GITHUB_TOKEN` cannot push,
  the mission pauses as `MULTITASK_MISSION_PAUSED_GIT_AUTH` with zero provider calls
  consumed; after fixing the token, the printed resume command replays the push
  without new AI calls — accepted local commits are preserved.
- Push happens only for accepted work on the mission branch; the subsequent PR
  creation, mission-level final review, and CI observation are covered by the
  mission-level documents.

## Terminal task statuses

The per-task end states (`MultitaskMissionTaskResult.status`) and their meaning:

| Status | Meaning |
|---|---|
| `accepted` | Candidate passed checks and review on the first attempt. |
| `fixed_and_accepted` | Accepted after one or more fix-loop iterations; has both `commit_sha` and `fix_commit_sha`. |
| `failed` | Rejected and the fix-loop budget was exhausted, or an unrecoverable task error occurred. |
| `blocked` | Cannot proceed (e.g. guardrail conflict); descendants are skipped. |
| `needs_human` | A severe safety finding or explicit reviewer escalation requires a human. |
| `skipped` | Skipped because an ancestor task failed/was blocked/needs human. |
| `skipped_safe_mode` | Planned but not executed because repository mutation is disabled (safe mode). |
| `paused_provider` | Provider interruption; resumable via the printed `resume_command`. |
| `paused_git_auth` | Git push authorization failure; resumable without new AI calls after fixing `GITHUB_TOKEN`. |

All of these, together with `commit_sha`, `fix_commit_sha`, `task_base_sha`,
`candidate_path`, and the human-readable `reason`, are persisted in
`multitask-mission-state.json` after every stage transition, which is what makes the
whole lifecycle crash-safe and resumable.
