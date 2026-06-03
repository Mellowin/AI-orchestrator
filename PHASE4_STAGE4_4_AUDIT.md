# Stage 4.4 Push Boundary Audit Plan

**Baseline commit:** `2eeff22168489555c15a02339524dd04074684a3`

**Status:** planning/audit + actual safe push implemented

**Actual push:** implemented (local bare remote verified in tests)

---

## 1. What is Stage 4.4?

Stage 4.4 is the `real-repo-push <taskId>` command that pushes the current work branch to a remote repository.

---

## 2. Current Status

- **Stage 4.2 local apply:** implemented
- **Stage 4.3 local commit:** implemented
- **Stage 4.4 push:** actual safe push implemented

---

## 3. Scope

`real-repo-push <taskId>` pushes the current work branch to `origin` after explicit opt-in and full validation.

This commit implements actual push behavior verified against a local temporary bare repository.

---

## 4. Push Constraints

The following constraints are enforced before any `git push`:

- Require `ALLOW_REAL_REPO_PUSH=true`
- Require task exists
- Require `repo_path` exists
- Require current branch exists
- Current branch must not be `main`
- `task.work_branch` must exist and must not be `main`
- Current branch must equal `task.work_branch`
- Working tree must be clean
- Local HEAD commit must exist
- Remote `origin` must exist
- Push target is exactly `origin <currentBranch>`
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
| Missing task | Refuse safely |
| Current branch is main | Refuse safely |
| work_branch is main | Refuse safely |
| Branch mismatch | Refuse safely |
| Dirty working tree | Refuse safely |
| Untracked files | Refuse safely |
| Staged files | Refuse safely |
| No local HEAD commit | Refuse safely |
| Remote origin missing | Refuse safely |
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

## 6. Actual Push Behavior

- Command: `git push origin <currentBranch>`
- Implementation: `spawnSync('git', ['push', 'origin', currentBranch], { cwd: task.repo_path, shell: false, encoding: 'utf-8' })`
- On success: exit 0, print `Push completed`, `Push target: origin <currentBranch>`, safety messages
- On failure: exit 1, print `Git push failed`, `Manual inspection required`, safety messages

Forbidden in implementation:
- `git push --force`
- `git push --force-with-lease`
- `git push --tags`
- `git push --all`
- `git push --mirror`
- `git push --set-upstream`

---

## 7. Tests

Tests verify actual push using a local temporary bare repository as `origin`:

- Create temp working git repo
- Create temp bare remote: `git init --bare <temp>/origin.git`
- Add it as origin: `git remote add origin <temp>/origin.git`
- Create/switch to non-main work branch matching `task.work_branch`
- Create at least one local commit
- Run `real-repo-push <taskId>` with `ALLOW_REAL_REPO_PUSH=true`
- Verify that `refs/heads/<currentBranch>` exists in the local bare remote after command
- Verify that `refs/heads/main` was not created or updated
- Verify that tags were not pushed

35 CLI tests covering:
- Missing taskId, missing opt-in, missing task
- Current branch main, work_branch main, branch mismatch
- Dirty tree, untracked file, staged file
- Missing HEAD commit, missing origin remote
- Success path with bare remote verification
- Pushed branch name equals work branch
- No main push, no tags, no force/all/mirror
- No merge/checkout/pull/fetch/rebase/reset
- Branch unchanged, working tree clean
- No state write, no API keys, no stack trace
- Push failure handling
- Existing real-repo-apply and real-repo-commit behavior unchanged

---

## 8. Implementation Progress

- **`real-repo-push <taskId>` safe refusal stub** (`src/cli.ts`, `test/cli-real-repo-push.test.ts`):
  - Commit hash: `5574e2a62e986a0b17b32c89fe448a98ddc28264`
  - Without opt-in: refuses with `ALLOW_REAL_REPO_PUSH=true is required`
  - With opt-in: refused with `real-repo-push is not implemented yet`

- **`real-repo-push <taskId>` actual safe push** (`src/cli.ts`, `test/cli-real-repo-push.test.ts`):
  - Validates task, repo_path, work_branch, current branch, clean working tree, HEAD commit, origin remote
  - Performs actual `git push origin <currentBranch>` via `spawnSync` with array args and `shell: false`
  - No force, no tags, no `--all`, no `--mirror`
  - Tests verify actual push against local bare remote, never touching real GitHub remote
  - 35 CLI tests

- **`real-repo-push <taskId>` state write after push** (`src/cli.ts`, `test/cli-real-repo-push.test.ts`):
  - After successful push, writes `RunState` to `runs/{taskId}/state.json`
  - State status: `pushed`
  - State fields: task_id, branch, repo_path, pushed_remote (`origin`), pushed_ref, commit_sha, updated_at, safety_note
  - No state write on validation failure
  - No state write on push failure
  - State does not contain provider response, file contents, env values, API keys, or remote URL with credentials
  - On state write failure after successful push: prints `Push completed`, `State write failed`, `Manual inspection required`, exits non-zero; does NOT retry push
  - No merge, no checkout, no main touch
  - 62 CLI tests total (35 push + 27 state)

> **Stage 4.4 actual safe push and Stage 4.5 state write are now implemented.** `ALLOW_REAL_REPO_PUSH=true` performs a real `git push origin <currentBranch>` after validation passes, then writes state if push succeeds.

---

## 9. Safer Next Step Recommendation

- **Audit and plan Stage 4.6 merge boundary.** Define what `ALLOW_REAL_REPO_MERGE=true` would mean, what safety checks are required before any merge operation, and what the refusal stub behavior should be. Do NOT implement merge yet.
- Preserve all existing Stage 4.2 tests (34 tests in `test/cli-real-repo-apply.test.ts`).
- Preserve all existing Stage 4.3 tests (35 tests in `test/cli-real-repo-commit.test.ts`).
- Preserve all existing Stage 4.4/4.5 tests (62 tests in `test/cli-real-repo-push.test.ts`).
- Stage 4.6 must not break Stage 4.2, Stage 4.3, Stage 4.4, or Stage 4.5 behavior.

---

## 10. Sign-Off

| Checkpoint | Status |
|---|---|
| Stage 4.4 actual safe push implemented | Confirmed |
| Stage 4.4 actual push enabled | Confirmed |
| Stage 4.5 state write after push implemented | Confirmed |
| State does not leak provider/file/API-key content | Confirmed |
| Push target only `origin <currentBranch>` | Confirmed |
| No force/tags/all/mirror | Confirmed |
| No push / no merge / no checkout / no main touch on failure | Confirmed |
| Tests use local bare remote, not GitHub | Confirmed |
| Opt-in flag boundary defined | Confirmed |
| Failure boundaries defined for all cases | Confirmed |
| Required tests exist and pass | Confirmed |
