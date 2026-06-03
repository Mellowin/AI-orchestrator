# Stage 4.4 Push Boundary Audit Plan

**Baseline commit:** `b8375887f739b2b39e944b22f4eee34b80ce4f34`

**Status:** planning/audit + refusal stub only

**Actual push:** not implemented

---

## 1. What is Stage 4.4?

Stage 4.4 is the future optional `real-repo-push <taskId>` command that may push the current work branch to a remote repository.

This document audits the boundaries before any real push behavior is implemented.

---

## 2. Current Status

- **Stage 4.2 local apply:** implemented
- **Stage 4.3 local commit:** implemented
- **Stage 4.4 push:** refusal stub implemented, actual push disabled

---

## 3. Scope

Future Stage 4.4 may push the current work branch to remote only after explicit opt-in.

This commit only adds:
- Safe refusal stub for `real-repo-push <taskId>`
- Audit plan document

No actual push behavior is enabled.

---

## 4. Future Push Constraints

Before any `git push` is implemented, the following constraints must be enforced:

- Require `ALLOW_REAL_REPO_PUSH=true`
- Require current branch exists
- Current branch must not be `main`
- `task.work_branch` must not be `main`
- Current branch must equal `task.work_branch`
- Working tree must be clean
- Local commit must exist on work_branch
- Remote target must be explicit and safe
- No force push
- No tags
- No merge
- No checkout
- No main touch
- No provider call
- No state write unless separately planned

---

## 5. Failure Boundaries

| Failure case | Behavior |
|--------------|----------|
| Missing taskId | Refuse safely |
| Missing opt-in | Refuse safely |
| Current branch is main | Refuse safely |
| work_branch is main | Refuse safely |
| Branch mismatch | Refuse safely |
| Dirty working tree | Refuse safely |
| No local commit to push | Refuse safely |
| Remote missing | Refuse safely |
| Upstream mismatch | Refuse safely |
| Push failure | Refuse safely, no retry |
| Unexpected exception | Refuse safely, no stack trace |

For every failure:
- No push
- No merge
- No checkout
- No main touch
- No state write
- Safe message
- No stack trace
- No API key leak

---

## 6. Required Future Tests Before Real Push

Before implementing actual `git push`, the following tests must exist:

- Refuses missing opt-in
- Refuses main branch
- Refuses work_branch main
- Refuses branch mismatch
- Refuses dirty tree
- Refuses missing remote
- Refuses no local commit
- Refuses force push
- Pushes only current work branch when all checks pass
- Does not push main
- Does not push tags
- Does not merge
- Does not checkout
- Does not write state initially
- Safe failure messages
- No API key leak

---

## 7. Implementation Progress

- **`real-repo-push <taskId>` safe refusal stub** (`src/cli.ts`, `test/cli-real-repo-push.test.ts`):
  - Without opt-in: refuses with `ALLOW_REAL_REPO_PUSH=true is required`
  - With opt-in: refuses with `real-repo-push is not implemented yet` and `Stage 4.4 push behavior remains disabled`
  - No provider call, no network, no API keys, no state write, no git push, no git merge, no checkout, no main touch
  - 20 CLI tests covering missing taskId, missing opt-in, opt-in with disabled stub, no push/merge/checkout/main touch, no state write, no stack trace leak, no API key leak, existing real-repo-apply and real-repo-commit behavior unchanged

> **Stage 4.4 actual push is still not implemented.** `ALLOW_REAL_REPO_PUSH=true` does not push to remote yet.

---

## 8. Safer Next Step Recommendation

- Add `ALLOW_REAL_REPO_PUSH` pre-push validation tests before any `git push` command is implemented.
- Preserve all existing Stage 4.2 tests (34 tests in `test/cli-real-repo-apply.test.ts`).
- Preserve all existing Stage 4.3 tests (35 tests in `test/cli-real-repo-commit.test.ts`).
- Preserve all existing Stage 4.4 refusal stub tests (20 tests in `test/cli-real-repo-push.test.ts`).
- Stage 4.4 must not break Stage 4.2, Stage 4.3, or earlier behavior.

---

## 9. Sign-Off

| Checkpoint | Status |
|---|---|
| Stage 4.4 refusal stub implemented | Confirmed |
| Stage 4.4 actual push remains disabled | Confirmed |
| `ALLOW_REAL_REPO_PUSH=true` reaches disabled stub only | Confirmed |
| No push / no merge / no checkout / no main touch | Confirmed |
| Opt-in flag boundary defined | Confirmed |
| Failure boundaries defined for all cases | Confirmed |
| Required future tests listed before implementation | Confirmed |
