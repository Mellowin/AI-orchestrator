# Stage 4.3 Local Commit Boundary Audit Plan

**Status:** planning/audit + pre-commit validation implemented
**Branch:** `feature/mvp-skeleton`
**Baseline commit:** `dfae23097f4ab1fd51a90376659db6f90a6e646a`

---

## 1. Scope

Stage 4.3 may create a local git commit on the current non-main work branch.

This document is planning/audit only. No commit behavior is enabled by this commit. No runtime code changes. No test changes.

---

## 2. Current Baseline

- **Last accepted Stage 4.2 docs commit:** `7028dc658e82a310a2ebe53b647f77bcd9b31168`
- **Stage 4.2 status:**
  - `real-repo-apply` applies files locally behind `ALLOW_REAL_REPO_APPLY=true`.
  - Uses `REAL_REPO_PROVIDER_RESPONSE` only.
  - Runs checks after apply.
  - Rolls back on check failure.
  - No state write.
  - No provider call.
  - No checkout.
  - No commit.
  - No push.
  - No merge.
  - No main touch.
  - Human review required before commit.

---

## Implementation Progress

The following runtime building blocks have been implemented after this audit document was created. They do not enable actual commit behavior, but they prepare the codebase for Stage 4.3:

- **`real-repo-commit <taskId>` safe refusal stub** (`src/cli.ts`, `test/cli-real-repo-commit.test.ts`):
  - Commit hash: `de5dea2ce2e7557be493ec811ea59cb8fe4a3491`
  - Requires `ALLOW_REAL_REPO_COMMIT=true` to reach the disabled stub behavior.
  - Without opt-in: refuses with `ALLOW_REAL_REPO_COMMIT=true is required`, prints safety messages.
  - With opt-in: validates task exists via `loadTask`, then refuses with `real-repo-commit is not implemented yet`.
  - No provider call, no network, no API keys, no state write, no git add, no commit, no push, no merge, no checkout, no main touch.

- **`real-repo-commit <taskId>` pre-commit validation flow** (`src/cli.ts`, `test/cli-real-repo-commit.test.ts`):
  - Commit hash: `dfae23097f4ab1fd51a90376659db6f90a6e646a`
  - Requires `ALLOW_REAL_REPO_COMMIT=true`, then `ALLOW_REAL_REPO_APPLY=true`, then `REAL_REPO_PROVIDER_RESPONSE`.
  - Parses provider response via `parseKimiOutputJson`, validates file list via `validateFileList`.
  - Validates branch safety: current branch exists, not main, work_branch exists, not main, current branch equals work_branch.
  - Inspects working tree via read-only `git status --porcelain`.
  - Accepts only approved changed paths from parsed provider response.
  - Refuses unrelated modified/untracked/staged files.
  - Refuses when no approved working tree changes exist.
  - Prints commit message preview: `ai-orchestrator: apply <taskId>`.
  - Exits non-zero with `pre-commit validation passed, but git commit is not implemented yet`.
  - No git add, no git commit, no provider call, no network, no API keys, no state write, no push, no merge, no checkout, no main touch.
  - 31 CLI tests covering all validation paths and refusal-before-commit paths.

> **Stage 4.3 actual local commit is still not implemented.** `ALLOW_REAL_REPO_COMMIT=true` does not create a commit yet. It only runs pre-commit validation and exits before `git add` / `git commit`.

---

## 3. Stage 4.3 Goal

Optionally create a local commit after Stage 4.2 apply + checks succeed.

Hard constraints:
- Must require explicit opt-in: `ALLOW_REAL_REPO_COMMIT=true`.
- Must still require: `ALLOW_REAL_REPO_APPLY=true`.
- Must not push.
- Must not merge.
- Must not checkout `main`.
- Must not call a provider.
- Must not require API keys.
- Must not commit if checks fail.
- Must not commit if rollback happened.
- Must not commit if working tree contains unrelated changes.

---

## 4. Required Pre-Commit Checks

Before any commit is created, the following must all pass in order:

1. `ALLOW_REAL_REPO_APPLY=true` env opt-in is present.
2. `ALLOW_REAL_REPO_COMMIT=true` env opt-in is present.
3. Task exists in `tasks.yaml`.
4. `task.work_branch` exists and is non-empty.
5. `task.work_branch` is not `main`.
6. Current branch exists (not detached HEAD, not empty).
7. Current branch is not `main`.
8. Current branch equals `task.work_branch`.
9. Working tree was clean before apply (`ensureClean` passed at start).
10. Apply succeeded (`applyFileUpdates` returned a manifest).
11. Checks passed after apply (`runChecks` returned `success: true`).
12. No rollback was needed.
13. Git diff contains only files from the approved apply manifest.
14. No untracked unrelated files are present.
15. No staged unrelated files are present.
16. Commit message is generated safely from task id/title only.
17. Commit message must not include provider response content.
18. Commit message must not include API keys or env values.

If any check fails, no commit may be created.

---

## 5. Failure Boundaries

| Failure case | Files modified? | Rollback runs? | Commit runs? | State written? | Exit code | Required safe messages |
|---|---|---|---|---|---|---|
| Missing `ALLOW_REAL_REPO_COMMIT` | No | No | No | No | 1 | `No commit was made`, opt-in required |
| Missing `ALLOW_REAL_REPO_APPLY` | No | No | No | No | 1 | `No files were modified`, `No commit was made`, opt-in required |
| Dirty tree before apply | No | No | No | No | 1 | `No files were modified`, `No commit was made`, safety reason |
| Apply failure | Maybe (partial) | Yes (if manifest exists) | No | No | 1 | `Apply failed`, rollback result, `No commit was made` |
| Checks failure after successful apply | Yes (full) | Yes | No | No | 1 | `Checks failed`, rollback attempted, rollback result, `No commit was made` |
| Rollback success | No | Yes | No | No | 1 | `Rollback completed`, `No commit was made` |
| Rollback failure | Yes (partial or full) | Yes (failed) | No | No | 1 | `Rollback failed`, manual intervention required, `No commit was made` |
| Branch mismatch | No | No | No | No | 1 | `No files were modified`, `No commit was made`, branch mismatch reason |
| Current branch `main` | No | No | No | No | 1 | `No files were modified`, `No commit was made`, main branch reason |
| `task.work_branch` is `main` | No | No | No | No | 1 | `No files were modified`, `No commit was made`, work_branch reason |
| No changes after apply | No | No | No | No | 1 | `No files were modified`, `No commit was made` |
| Unrelated changes detected before commit | Yes (applied) | No | No | No | 1 | `Unrelated changes detected`, `No commit was made`, list unrelated files |
| Commit command failure | Yes (applied) | No | No | No | 1 | `Commit failed`, manual inspection required, `No push was performed` |
| Unexpected exception at any point | Best-effort no | Best-effort yes | No | No | 1 | `Unexpected error`, no state mutation, no push/merge |

### Notes on unrelated changes

- After successful apply and passing checks, the CLI must verify that the working tree contains **only** changes from the approved apply manifest.
- If untracked files, staged files, or modifications outside the manifest are detected, the CLI must refuse to commit and report the unrelated paths.
- The applied files themselves may remain modified; the human can decide whether to stage/commit manually.

---

## 6. Commit Boundaries

### Mechanism

- Use `child_process.spawnSync` / `execFileSync` with array arguments for `git commit`.
- No `git commit -am` (to avoid accidentally including unrelated changes).
- Stage only files listed in the apply manifest explicitly before commit.
- Commit message format proposal:

```
ai-orchestrator: apply <taskId>
```

- No amend.
- No force operations (`--force`, `--no-verify` only if explicitly planned later).

### Safety rules

- Local commit only.
- No push.
- No merge.
- No checkout.
- No main touch.
- No commit if checks fail.
- No commit if rollback occurs.
- No commit if safety validation fails.
- No commit if unrelated working tree changes are present.
- Commit should include only files applied by `real-repo-apply`.
- Human review should still be recommended after commit.

---

## 7. State Boundaries

### Decision: no state write in initial Stage 4.3 implementation

- **No state write in the first Stage 4.3 implementation.**
- If state write is introduced later, it must happen only after commit succeeds.
- State must not lie if commit fails.
- No state write before apply + checks + commit success.

### If state is added later

- State may only be written after all pre-commit checks pass, apply succeeds, checks succeed, and commit succeeds.
- State must include: `task_id`, `status`, `attempt`, `timestamp`, `files_modified`, `commit_hash`.
- State must not be written before pre-commit checks finish.

---

## 8. Branch Boundaries

- **No checkout of `main` at any point.**
- **No create branch in Stage 4.3** unless explicitly planned later.
- Stage 4.3 must require the user to already be on `work_branch`.
- `current branch === task.work_branch` is mandatory.
- Fail if detached HEAD (`currentBranch === 'HEAD'` or empty).
- Fail if current branch is `main`.
- Fail if `task.work_branch` is `main`.
- The CLI must not switch branches. It only validates the current branch.

---

## 9. Opt-In Boundaries

- `ALLOW_REAL_REPO_APPLY=true` must be checked **before any file write**.
- `ALLOW_REAL_REPO_COMMIT=true` must be checked **before any git commit**.
- Recommended check order: env opt-in → task load → parse → guardrails → safety → apply → checks → commit validation → commit.
- `ALLOW_REAL_REPO_PUSH` must not be used in Stage 4.3.
- `ALLOW_REAL_REPO_MERGE` must not be used in Stage 4.3.
- Even if `ALLOW_REAL_REPO_PUSH` or `ALLOW_REAL_REPO_MERGE` are accidentally set, Stage 4.3 must not push or merge.
- No push/merge logic may be introduced in the Stage 4.3 implementation PR.

---

## 10. Human Review Boundaries

- Human should inspect `git diff` before enabling commit.
- Human should inspect commit after creation.
- Human must push manually or wait for future Stage 4.4.
- No automatic push.
- No automatic merge.
- The commit command is intended as a "checkpoint the work branch" step, not a "finish the workflow" step.

---

## 11. Required Tests Before Implementation

The following tests must exist (and pass) before Stage 4.3 runtime code is considered complete:

1. Refuses when `ALLOW_REAL_REPO_COMMIT` opt-in is missing.
2. Refuses when `ALLOW_REAL_REPO_APPLY` opt-in is missing.
3. Refuses when working tree is dirty before apply.
4. Refuses when current branch is `main`.
5. Refuses when `task.work_branch` is `main`.
6. Refuses when current branch does not equal `task.work_branch`.
7. Refuses when unrelated changes are detected before commit.
8. Refuses when checks fail after apply.
9. Refuses when rollback happened.
10. Refuses when no changes exist after apply.
11. Commits only after successful apply + checks.
12. Commit is local only (no push).
13. Commit message is safe (no provider content, no API keys, no env values).
14. Commit includes only approved applied files.
15. Does not push.
16. Does not merge.
17. Does not checkout any branch.
18. Does not touch `main`.
19. No state write in initial Stage 4.3.
20. Safe error messages, no stack trace leak.
21. No API key leak in error output.

---

## 12. Explicit Non-Goals

The following are **out of scope** for this document and for Stage 4.3:

- Do **not** implement Stage 4.3 in this commit.
- Do **not** modify `src/**`.
- Do **not** modify `test/**`.
- Do **not** modify package files.
- Do **not** enable auto-commit.
- Do **not** enable push.
- Do **not** enable merge.
- Do **not** touch `main`.
- Do **not** call a real provider.
- Do **not** require API keys.

---

## 13. Recommended First Stage 4.3 Implementation Task

### 13.1 Pre-commit validation flow

The pre-commit validation flow is now implemented. It validates all prerequisites before any `git commit` command:

- Opt-in checks (`ALLOW_REAL_REPO_COMMIT`, `ALLOW_REAL_REPO_APPLY`).
- Provider response parsing and guardrails.
- Branch safety (current branch, work_branch).
- Working tree inspection (approved changes only, no unrelated files).

### 13.2 Safer next step recommendation

- **Implement actual local commit** only after preserving all pre-commit validation tests.
- The commit should stage only approved files, create a local commit with a safe message, and exit.
- **Do NOT implement push/merge/main touch.** Keep those as future Stage 4.4+ boundaries.
- Preserve all existing Stage 4.2 tests (34 tests in `test/cli-real-repo-apply.test.ts`).
- Stage 4.3 must not break Stage 4.2 behavior.

---

## 14. Sign-Off

| Check | Status |
|-------|--------|
| Stage 4.3 pre-commit validation implemented | Confirmed |
| Stage 4.3 actual local commit remains disabled | Confirmed |
| `ALLOW_REAL_REPO_COMMIT=true` runs validation only, no commit | Confirmed |
| No push / no merge / no main touch | Confirmed |
| Opt-in flag boundaries defined | Confirmed |
| Commit boundaries defined | Confirmed |
| State boundaries defined | Confirmed |
| Failure boundaries defined for all cases | Confirmed |
| Required tests exist and pass | Confirmed |
