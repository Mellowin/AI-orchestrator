# Stage 18.13 — Real MVP Scenario Matrix / Multi-Task Battle Test

> This is not a coding stage. This is a real MVP battle test. If you find a bug, stop and report it first. Do not silently fix and continue.

## Goal

Run several real end-to-end MVP scenarios against a sandbox repository to expose hidden failures in multi-task behavior, resume, blocked tasks, PR creation, state handling, and follow-up flows.

This is a validation stage, not a feature stage.

## Repository

- **Orchestrator repository:** `Mellowin/AI-orchestrator`
- **Sandbox repository:** `Mellowin/ai-orchestrator-sandbox`

## Base branch

`main`

`main` must already include:

- PR #5 merged
- PR #6 merged
- main CI green after `TESTING_SUMMARY` hotfix

## Hard rules

- Do not push directly to `main`.
- Do not modify `main`.
- Do not merge any generated sandbox PRs.
- Do not run tests against production repositories.
- Do not hide failures.
- Do not edit `state.json` manually.
- Do not edit `TESTING_SUMMARY.md` unless a final evidence summary is explicitly required after all scenarios.
- Do not change product code unless a real bug is discovered and reported first.
- All real AI/provider calls must be against sandbox tasks only.
- Every scenario must produce a written report with commands, SHAs, state files, PR URLs, and final status.

## Provider

- Use real Kimi provider for the real scenarios.
- Use fake provider only for explicit comparison/control scenarios.

## Sandbox repository

Use: `Mellowin/ai-orchestrator-sandbox`

Create a fresh branch namespace for this stage, for example:

- `stage-18-13-sandbox-base`
- `ai-stage-18-13-scenario-01-golden`
- `ai-stage-18-13-scenario-02-resume`
- `ai-stage-18-13-scenario-03-blocked-stop`
- `ai-stage-18-13-scenario-04-blocked-continue`
- `ai-stage-18-13-scenario-05-post-push-follow-up`
- `ai-stage-18-13-scenario-06-stress-multitask`

## Before scenarios

1. Confirm AI-orchestrator `main` HEAD.
2. Confirm main CI is green.
3. Confirm sandbox repo is accessible.
4. Confirm working tree clean.
5. Confirm `GITHUB_TOKEN` is available only through env.
6. Confirm Kimi/provider token is available only through env.
7. Print no secrets.

### Required preflight commands

```bash
git checkout main
git pull --ff-only
git rev-parse HEAD
git status --short

npm ci
npm run typecheck
npm run build
npm test -- --chunk-timeout-ms 600000 --output-dir tmp/stage-18-13-preflight-test-logs
npm run verify:summary
npm run demo:block:fake
npm run demo:operator-golden-path
```

If preflight fails, stop.

## Scenario 01 — Golden real multi-task PR

### Purpose

Prove normal real multi-task flow from task block to draft PR.

### Sandbox task

Build a small expense/tasks API or improve existing sandbox app with 4 independent tasks:

1. Add validation for required fields.
2. Add filtering/sorting endpoint.
3. Add JSON persistence.
4. Update README with examples.

### Expected

- all tasks accepted or `fixed_and_accepted`
- no `blocked_skipped`
- final block status `completed`
- exit code 0
- draft PR created in sandbox repo
- PR has correct base/head
- remote branch has expected commits
- report has `provider_attempts`
- no manual state edits

### Required proof

- sandbox base SHA
- sandbox head SHA
- branch name
- PR URL
- number of commits
- final `state.json` summary
- provider attempts summary
- npm/test command results inside sandbox if applicable

## Scenario 02 — Resume after interruption

### Purpose

Prove resume works without stale-state lies.

### Setup

Start a 4-task real block. After task 1 or task 2 completes, intentionally stop the run using a controlled interruption method. Then rerun with `--resume`.

### Expected

- already completed task(s) are not rerun unnecessarily
- incomplete task continues
- report is hydrated correctly
- completed phases are skipped only when saved report proves ok
- final branch/PR is consistent
- no duplicate commits for completed tasks
- no manual state edits

### Required proof

- state before interruption
- state after resume
- commit list before/after
- provider call count before/after
- final PR URL or explicit reason no PR was created

## Scenario 03 — Safety blocked default stop

### Purpose

Prove unsafe task blocks correctly and does not crash.

### Sandbox task

Create a block with 3 tasks:

1. A normal harmless code/doc task.
2. An intentionally unsafe/disallowed task that deterministic safety policy should block.
3. Another harmless task that should NOT run after block when default policy is stop.

### Expected

- child run state status `blocked` loads successfully
- parent derives blocked result instead of crashing
- block final status `blocked`
- task 3 not executed
- no PR created unless policy says blocked PR is allowed, which should be reported clearly
- exit code non-zero
- no `completed_with_caveats` here; default stop must stop

### Required proof

- exact safety block reason, redacted
- `state.json` final status
- task result list
- confirmation task 3 did not run
- no namespace collision

## Scenario 04 — Safety blocked with continue/skip

### Purpose

Prove `on_blocked_task=continue` or `skip` creates `completed_with_caveats`, not clean `completed`.

### Sandbox task

Create a block with 4 tasks:

1. harmless task
2. blocked unsafe task
3. harmless task
4. README/report task

### Policy

`review_policy.on_blocked_task = continue` or `skip`

### Expected

- blocked task becomes `blocked_skipped`
- later harmless tasks continue
- final status `completed_with_caveats`
- `skippedBlockedTasks > 0`
- not plain `completed`
- first caveated run exits non-zero unless explicitly designed otherwise
- `--resume` on `completed_with_caveats` becomes `completed_noop` and exits 0
- provider not rerun on `completed_with_caveats` resume

### Required proof

- initial run exit code
- final block status
- `skippedBlockedTasks` count
- resume no-op proof
- no new commits after resume no-op

## Scenario 05 — Post-push follow-up / review loop

### Purpose

Prove follow-up logic works after branch/PR exists.

### Setup

Use a sandbox branch with a small deliberate issue:

- missing README example
- failing test
- or incomplete endpoint

Run the post-push/block follow-up flow.

### Expected

- tool detects follow-up need
- creates a follow-up task
- applies fix on same sandbox branch or clearly documented follow-up branch
- tests/checks pass
- state stored under correct `runs/tasks/<task_id>` namespace
- no deletion of `runs/block/**`

### Required proof

- before/after diff
- follow-up state
- follow-up commit SHA
- tests before/after
- PR updated or linked

## Scenario 06 — Stress multi-task real run

### Purpose

Expose hidden ordering/state bugs.

### Sandbox task

Run a 6–8 task block with mixed tasks:

1. validation
2. endpoint/API
3. persistence
4. CSV or export/import
5. tests
6. README
7. small refactor
8. final consistency cleanup

### Expected

- no stale child state reuse
- each task uses separate `runs/tasks/<task_id>`
- no task_id collision
- no duplicate commits
- no provider output silently accepted if malformed
- retry/backoff data recorded if retries happen
- final PR created
- CI/checks or local checks green

### Required proof

- branch commits
- task-by-task result table
- `provider_attempts` per task
- final PR URL
- compare stats
- state consistency verification

## Scenario 07 — Negative namespace collision check

### Purpose

Specifically prove `task_id="block"` cannot delete parent block state.

Create a sandbox block with a harmless task whose `task_id` is exactly:

```text
block
```

### Expected

- parent `runs/block/**` survives
- child state goes under `runs/tasks/block/**`
- no `run.lock` deletion
- no crash
- final result is either accepted or clearly blocked for validation reasons, but not namespace crash

### Required proof

- before/after listing of `runs/block` and `runs/tasks/block`
- state paths used
- final result

## Scenario 08 — Fake-vs-real control comparison

### Purpose

Separate product bug from Kimi/provider instability.

Run one small 3-task block twice:

- A. fake provider
- B. real Kimi provider

### Expected

- fake run deterministic green
- real run either green or clearly fails because provider output/network, not orchestrator
- differences documented

### Required proof

- fake run result
- real run result
- provider attempts
- if real fails, exact failure class: `provider_error` / `parse_error` / `safety_block` / `git_error` / `test_error` / `orchestrator_bug`

## Global acceptance criteria

For the stage to be considered `FULLY_PASSED`:

1. Preflight on AI-orchestrator `main` passes.
2. At least 6 real scenarios run.
3. At least one normal golden real multi-task PR succeeds.
4. At least one resume scenario succeeds.
5. At least one blocked-stop scenario behaves correctly.
6. At least one blocked-continue scenario produces `completed_with_caveats` correctly.
7. At least one post-push/follow-up scenario succeeds.
8. At least one stress multi-task scenario succeeds.
9. No manual state edits.
10. No direct push to `main`.
11. No sandbox PRs merged.
12. All failures are classified honestly.
13. If any product bug is found, stop and report before coding a fix.
14. Final report includes all PR URLs, branches, SHAs, state summaries, and command results.

## Failure classification

Every failed scenario must be classified as exactly one of:

- `ORCHESTRATOR_BUG`
- `PROVIDER_INSTABILITY`
- `PROVIDER_BAD_OUTPUT`
- `GITHUB_API_ERROR`
- `SANDBOX_TEST_FAILURE`
- `SAFETY_POLICY_BLOCK_EXPECTED`
- `CONFIG_ERROR`
- `HUMAN_TOKEN_PERMISSION_ERROR`
- `UNKNOWN`

## Final report format

A. AI-orchestrator `main` HEAD and CI status  
B. Environment/token availability, without printing secrets  
C. Scenario matrix table:
   - scenario name
   - branch
   - provider mode
   - final status
   - exit code
   - PR URL
   - commit count
   - classification  
D. Scenario 01 details  
E. Scenario 02 details  
F. Scenario 03 details  
G. Scenario 04 details  
H. Scenario 05 details  
I. Scenario 06 details  
J. Scenario 07 details  
K. Scenario 08 details  
L. Bugs found  
M. Provider failures / retries observed  
N. State/resume findings  
O. Sandbox PRs created  
P. Commands run  
Q. Final verdict:
   `FULLY_PASSED` / `PASSED_WITH_CAVEATS` / `FAILED`

### Important

Do not mark `FULLY_PASSED` if:

- fewer than 6 real scenarios ran
- main preflight failed
- any scenario result was guessed
- any state was edited manually
- any sandbox branch/PR evidence is missing
- any product bug was found but not reported
