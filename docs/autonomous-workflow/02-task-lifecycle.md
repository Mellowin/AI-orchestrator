# Single Task Lifecycle

A *task* is the atomic unit of work in the autonomous workflow. One task takes a
known base commit, produces a candidate change in an isolated workspace, runs
checks and review, iterates through any requested fixes, and finally lands as a
single commit on the work branch. This document describes that lifecycle stage
by stage and is consistent with the `autopilot-one-click` launcher described in
[`01-one-click.md`](01-one-click.md).

> **Scope note:** This page follows one task. Multi-task mission orchestration
> (DAG scheduling, descendant skipping, mission-level final review, and mission
> rollback) builds on top of these per-task stages and is covered separately.

## Lifecycle overview

The stages for every task are:

1. `task_base_sha` — the known-good commit the task starts from.
2. `candidate workspace` — a git work branch created from that base.
3. `coder` — the provider proposes file changes inside the workspace.
4. `staging / checks` — the proposed changes are applied and verified.
5. `reviewer` — an independent reviewer examines the diff and check results.
6. `fix loop` — if the reviewer requests changes, a fix task is created and re-run.
7. `acceptance` — the reviewer gate accepts the task.
8. `single commit` — the accepted changes are committed as one commit.
9. `push` — the commit is pushed to the remote work branch when allowed.

These stages are driven by the inner runner (for example, the block-task runner
or the `autopilot-run` / `mvp-run` pipeline) that `autopilot-one-click`
invokes. The one-click wrapper itself resolves the mission and base branch, then
hands control to that inner runner.

## 1. `task_base_sha`

Every task begins from a deterministic base commit.

* In a standard single-task run, the planner writes the base SHA into the
  generated `autopilot.config.json` and the inner runner checks it out.
* In a multitask mission, `autopilot-one-click` resolves the mission-level
  `base_sha` from `mission.base_branch` (default `main`) before invoking the
  inner runner. Each task in the mission starts from that same base unless an
  earlier task in the dependency chain has already been accepted and committed,
  in which case dependent tasks build on the resulting branch state.
* In `fake` / safe mode the base SHA is synthetic (`safe-mode-no-base-<hash>`),
  so no real git repository is required.

During `--resume`, the persisted base SHA is compared to the freshly resolved
one; if they differ, the resume is aborted to prevent replaying a task plan on
an unexpected repository state.

## 2. Candidate workspace

The inner runner creates the workspace:

1. Checks out the task base SHA or the mission base branch.
2. Creates the work branch from the base commit. The branch name is generated
   by the planner/runner (for example, `mission-${run_id}` in multitask mode or
   the branch written into `autopilot.config.json` for standard runs).
3. Applies the task guardrails derived from the task definition:
   * `allow_modify` — files the coder may change.
   * `deny_modify` — files the coder must not touch.
   * `max_lines_changed` — rough upper bound on diff size.
   * `auto_commit`, `auto_push`, `auto_merge` are all `false` at the task level;
     the orchestrator decides when to commit and push.

The workspace is therefore a *candidate* branch. If the task fails or is
blocked, the branch can be cleaned up or rolled back locally without affecting the
base branch or the remote.

## 3. Coder

The coder provider receives a `CoderTaskInput` built from the task definition.

* In `github` / real modes the default provider is Kimi and requires
  `KIMI_API_KEY`.
* In `fake` / safe mode the coder is deterministic and returns canned updates so
  the rest of the pipeline can be exercised without calling a real provider.

The input includes:

* `task_id`, `title`, and `goal`.
* `allowed_files` and `denied_files`.
* `repo_context` — task goal plus optional product-vision context.
* `previous_failure` / fix context on retry attempts.

The coder returns full-file updates in a structured JSON format. The runner
writes those files into the workspace. Partial updates or responses that omit
lines are rejected by the guardrails layer.

### Fix-context injections

On a fix attempt, the coder input is augmented with:

* the previous reviewer summary,
* the explicit fix task text,
* the list of blocking issues,
* a summary of check failures,
* the original task goal.

This keeps the repair grounded in the original intent while giving the coder the
exact feedback that caused the previous iteration to fail review.

## 4. Staging / checks

After the coder writes files, the runner stages the changes and runs the
task-level checks.

* Static checks, type checks, builds, and tests are converted from the task
  definition strings into executable `{ command, args }` objects.
* Results are collected into a check summary (total tests, suites, failures,
  typecheck/build/test status).
* Check output feeds the reviewer and, in real modes, may also be correlated
  with CI observations.

If checks fail, the task does not proceed directly to acceptance. Instead the
failure summary is passed into the reviewer/fix loop.

## 5. Reviewer

A separate reviewer provider examines the staged diff plus check results.

* In real modes this is typically an OpenAI model configured through
  `OPENAI_API_KEY` (multitask mission final review) or the Kimi reviewer where
  configured.
* In `fake` / safe mode, or when no reviewer key is available, a deterministic
  reviewer applies hard gates.

The task-level reviewer produces one of the following outcomes:

| Outcome          | Meaning                                              |
|------------------|------------------------------------------------------|
| `accepted`       | Changes satisfy the task goal, checks, and guardrails. |
| `fix_required`   | Fixable issues found; a fix task should be created.  |
| `blocked`        | Irrecoverable issues or guardrail violations; human review required. |

> **Model-facing terminology:** `prompts/reviewer.md` asks the model to return
> `needs_changes` for fixable issues. The task-level runner normalizes that
> model verdict to the internal transition status `fix_required`.

The mission-level final review (see `final-review.ts`) is separate from the
per-task reviewer. It can return the mission-level verdict `rejected` when the
integrated mission diff or task results fail the deterministic gate. That
mission-level `rejected` verdict is distinct from the per-task `blocked`
outcome documented here.

In the multitask path, the mission-level final review adds a mandatory
*deterministic gate*: it rejects approval if the integrated diff touches files
outside the union of task `allowed_files` or if any required task is not
accepted. Model approval is not a security boundary.

## 6. Fix loop

When the task-level reviewer outcome is `fix_required` (the model-facing
prompt at `prompts/reviewer.md` asks for `needs_changes`), the runner derives a
transition:

1. A fix task is created, linked to the original `parentTaskId`.
2. The fix task inherits the blocking issues and receives a title such as
   `Fix reviewer issues for <original task title>`.
3. The attempt counter is incremented.
4. The fix task goes back through the coder → checks → reviewer pipeline with
   the augmented fix context.
5. If the fix is accepted, the original task is marked as `fixed_and_accepted`.
   If the fix is blocked or the maximum number of attempts is exhausted, the
   task transitions to `blocked` or `failed`.

Maximum repair attempts are configured by the preset (for example, `2` for
`real-repair` and `real-multitask`). Once the limit is reached the task stops
retrying and records the failure.

## 7. Acceptance

A task is *accepted* when the reviewer gate status is `accepted`:

* For standard single-task runs the run state records `reviewer_gate.status === 'accepted'`.
* For multitask missions the task state becomes `accepted` (first-pass) or
  `fixed_and_accepted` (after a successful fix loop).

Acceptance means the changes:

* satisfy the task goal and acceptance criteria,
* pass the configured checks,
* stay within `allowed_files` and `denied_files`,
* respect `max_lines_changed`,
* and do not violate the forbidden operations list (no merge, force-push,
  workflow rerun, or branch deletion).

If the task cannot be accepted — for example, it repeatedly fails checks, the
reviewer blocks it, or it needs a human decision — the state becomes `blocked`,
`failed`, `needs_human`, or `skipped` (for descendants of a failed ancestor).

## 8. Single commit

Once accepted, the task changes are committed as **one** commit.

* The commit SHA is recorded in the task state (`commit_sha`, and
  `fix_commit_sha` if a fix iteration produced the final accepted change).
* In multitask missions, accepted task commits are tracked in the mission state
  as `mission_commits` so the mission-level final review and rollback logic can
  identify which commits belong to the mission.
* `failed`, `blocked`, or `needs_human` task commits are reverted locally on the
  mission work branch before the mission result is finalized. The orchestrator
  does not push these reverts; the human operator decides whether to push the
  cleaned-up branch.

The single-commit rule keeps the history atomic and reviewable: one task, one
commit.

## 9. Push

The final stage is pushing the accepted commit to the remote work branch.

* Push only happens when the mission capabilities allow repository mutation
  (`allow_repo_commit` / `allow_repo_push`) and the preset enables it.
* `real-pr` and `real-repair` can push so a PR can be opened or updated.
* `real-multitask` commits locally by default but does **not** push or create a
  PR unless `allow_pr_create` is explicitly enabled (consistent with
  `01-one-click.md`).
* Safe / `fake` modes never push.
* Force-push is always forbidden across all presets.

After a successful push, the run state records `pushed: true` and the task is
considered completed. If the workflow is configured to open a PR, the PR number
and URL are stored in the mission state.

## State transitions summary

```text
pending
  │
  ▼
running ──► coder ──► checks ──► reviewer
  │                                │
  │                         accepted
  │                                │
  │                                ▼
  │                         single commit
  │                                │
  │                                ▼
  │                              push
  │
  └─ fix_required ──► create fix task ──► running (fix attempt)
         ▲                                    │
         └────────────────────────────────────┘ (until accepted / blocked / max attempts)
```

Terminal states:

| State                 | Meaning |
|-----------------------|---------|
| `accepted`            | First-pass success, committed. |
| `fixed_and_accepted`  | Success after one or more fix iterations. |
| `failed`              | Checks or repair exhausted; no acceptable result. |
| `blocked`             | Reviewer or deterministic gate blocked the task. |
| `needs_human`         | Human decision required before continuing. |
| `skipped`             | Not executed because an ancestor dependency failed. |

## Resume and persistence

For multitask missions, each task transition is persisted in
`<run_dir>/multitask-mission-state.json`. On resume:

* The plan hash and base SHA are verified.
* Already-accepted task commits are checked to be ancestors of the work branch.
* Terminal non-success results can be returned without re-running.
* Successful results are returned only after the ancestry gate passes.

This lets long-running missions resume safely after interruption without
re-executing accepted work.

## Relation to `autopilot-one-click`

`autopilot-one-click` sits above this lifecycle:

* It resolves the mission, base branch, run ID, and capabilities preset.
* It generates the plan and the `autopilot.config.json` that the inner runner
  consumes.
* It delegates branch creation, task execution, review, commit, and push to the
  inner runner.
* It writes the final `one-click-report.md` / `one-click-report.json` after the
  task or mission completes.

The lifecycle documented here is what the inner runner actually executes for
*each* task that `autopilot-one-click` schedules.

## Safety invariants

These invariants hold at every lifecycle stage:

* The base SHA is known and verified before work begins.
* The workspace is isolated on a work branch; the base branch is never mutated
  directly.
* File-scope guardrails (`allow_modify`, `deny_modify`) are enforced before any
  file write and again by deterministic diff scanning.
* A task produces at most one final accepted commit on the work branch.
* Unaccepted work is reverted locally before the result is finalized.
* Force-push, merge, workflow rerun, and branch deletion are always forbidden.
* Tokens are read from the environment and are never persisted into reports.
