# Stage 4.2 Real Repo Apply Audit Plan

**Status:** Stage 4.2 implemented  
**Branch:** `feature/mvp-skeleton`  
**Baseline commit:** `026f5d4eb4cb1a7e613d28f60dba44ce08591def`

---

## 1. Scope

Stage 4.2 will be the first phase that may write to the real repo.

This document is planning/audit only. No real repo write behavior is enabled by this commit. No runtime code changes. No test changes.

---

## 2. Current Baseline

- **Last accepted Stage 4.1 docs commit:** `75ccb954ab22acedbe339ed909336a3712760cb2`
- **Stage 4.1 status:**
  - `real-repo-apply-dry-run <taskId>` CLI exists and is read-only.
  - Real repo apply is still disabled for writes.
  - No file writes, no provider call, no state write, no push, no merge, no checkout.
  - `validateRealRepoApplySafety` and `buildRealRepoApplyDryRunSummary` are implemented and wired to the dry-run CLI.
  - `isNew` detection fixed: existing empty files report `isNew=false`.

---

## Implementation Progress

The following runtime building blocks have been implemented **after** this audit document was created. They do not enable real repo writes, but they prepare the codebase for Stage 4.2:

- **`real-repo-apply <taskId>` pre-write validation CLI** (`src/cli.ts`, `test/cli-real-repo-apply.test.ts`):
  - Requires `ALLOW_REAL_REPO_APPLY=true`.
  - Reads `REAL_REPO_PROVIDER_RESPONSE` env var.
  - Parses via `parseKimiOutputJson`.
  - Validates file list via `validateFileList`.
  - Validates line deltas via `validateProposedFileLineDeltas`.
  - Validates repo safety via `validateRealRepoApplySafety` (clean tree, non-main branch, branch match, auto_commit/push/merge all false).
  - Builds apply plan via `buildRealRepoApplyPlan`.
  - Prints plan summary (task id, current branch, work branch, files with action and backupPath).
  - Still exits non-zero before any file write with message `real-repo-apply pre-write validation passed, but file apply is not implemented yet`.
  - Prints safety messages (`No files were modified`, `No commit was made`, `No push was performed`, `No merge was performed`).
  - No real repo writes, no `applyFileUpdates`, no `rollbackFileUpdates`, no provider call, no network, no API keys, no state write, no checkout/commit/push/merge/main touch.
  - 23 CLI tests covering all refusal paths and pre-write validation success path.

- **`buildRealRepoApplyPlan(input)` pure helper** (`src/real-repo-apply-plan.ts`, `test/real-repo-apply-plan.test.ts`):
  - Builds create/overwrite plan from `existingPaths` and proposed files.
  - Builds `runDir` and `backupPath` strings.
  - Validates taskId, attempt, paths, duplicates, content type, existingPaths.
  - Rejects Unix absolute paths, Windows absolute paths (`C:/temp/file.ts`), path traversal (`..`), backslash paths.
  - Allows empty string content.
  - Returns `{ok:false,reason,safetyMessages}` without throwing.
  - 100% pure: no fs, no git, no child_process, no env, no network, no API keys, no state writes.
  - **Wired to `real-repo-apply` CLI.**

> **Stage 4.2 write behavior is now enabled.** Real repo apply applies files locally to the work branch only. No commit, no push, no merge, no main touch.

### Stage 4.2 local apply — implemented

- **`real-repo-apply <taskId>` local file apply CLI** (`src/cli.ts`, `test/cli-real-repo-apply.test.ts`):
  - Requires `ALLOW_REAL_REPO_APPLY=true`.
  - Reads `REAL_REPO_PROVIDER_RESPONSE` env var.
  - Parses via `parseKimiOutputJson`.
  - Validates file list via `validateFileList`.
  - Validates line deltas via `validateProposedFileLineDeltas`.
  - Validates repo safety via `validateRealRepoApplySafety` (clean tree, non-main branch, branch match, auto_commit/push/merge all false).
  - Builds apply plan via `buildRealRepoApplyPlan`.
  - Calls `applyFileUpdates` with real repo path and `runDir` from plan.
  - Runs `runChecks` in real repo path after apply.
  - On check failure: calls `rollbackFileUpdates` to restore overwritten files and remove newly created files.
  - On apply failure: prints `Apply failed`, `Manual inspection required`, and `Rollback could not be attempted because apply manifest was not returned`. Does NOT claim `No files were modified` after apply-start failure.
  - On success: prints `Apply: PASS`, `Checks: PASS`, and safety messages. Human review required before commit.
  - No provider call, no network, no API keys, no state write, no checkout/commit/push/merge/main touch.
  - 34 CLI tests covering all refusal paths, success paths, apply failure, check failure with rollback, no stack trace leak, no API key leak.

---

## 3. Stage 4.2 Goal

Allow applying already-validated file updates to a real non-main work branch.

Hard constraints:
- Must require explicit opt-in: `ALLOW_REAL_REPO_APPLY=true`.
- Must not commit.
- Must not push.
- Must not merge.
- Must not checkout `main`.
- Must not call a provider.
- Must not require API keys.

---

## 4. Required Pre-Write Checks

Before any file is written, the following must all pass in order:

1. `ALLOW_REAL_REPO_APPLY=true` env opt-in is present.
2. Task exists in `tasks.yaml`.
3. `task.work_branch` exists and is non-empty.
4. `task.work_branch` is not `main`.
5. Current branch exists (not detached HEAD, not empty).
6. Current branch is not `main`.
7. Current branch equals `task.work_branch`.
8. Working tree is clean (`ensureClean` passes).
9. Provider response is env-provided only (`REAL_REPO_PROVIDER_RESPONSE`).
10. `parseKimiOutputJson` passes.
11. `validateFileList` passes.
12. `validateProposedFileLineDeltas` passes.
13. `validateRealRepoApplySafety` passes.
14. Dry-run summary can be built (`buildRealRepoApplyDryRunSummary`).
15. Target file paths are validated by patch-engine (`validateUpdatePath`) before any write.

If any check fails, no file may be modified.

---

## 5. Failure Boundaries

| Failure case | Files modified? | Rollback runs? | State written? | Exit code | Required safe messages |
|---|---|---|---|---|---|
| Missing opt-in `ALLOW_REAL_REPO_APPLY` | No | No | No | 1 | `No files were modified`, opt-in required |
| Missing provider response | No | No | No | 1 | `No files were modified`, env var required |
| Parse failure (`parseKimiOutputJson`) | No | No | No | 1 | `No files were modified`, parse error |
| File guardrails failure (`validateFileList`) | No | No | No | 1 | `No files were modified`, guardrails reason |
| Line delta failure (`validateProposedFileLineDeltas`) | No | No | No | 1 | `No files were modified`, line delta reason |
| Safety failure (`validateRealRepoApplySafety`) | No | No | No | 1 | `No files were modified`, safety reason |
| Patch apply failure **before** any file write | No | No | No | 1 | `No files were modified`, apply error |
| Patch apply failure **after** partial write | Yes (partial) | Yes (attempt) | No | 1 | `Partial apply detected`, rollback attempted, rollback result |
| Check failure after successful apply | Yes (full) | Yes | No | 1 | `Checks failed`, rollback attempted, rollback result |
| Rollback failure | Yes (partial or full) | Yes (failed) | No | 1 | `Rollback failed`, manual intervention required, list affected files |
| Unexpected exception at any point | Best-effort no | Best-effort yes | No | 1 | `Unexpected error`, no state mutation, no push/merge |

### Notes on partial writes

- `applyFileUpdates` already validates every path before writing and throws on first invalid path.
- If `applyFileUpdates` fails mid-batch, `rollbackFileUpdates` must be called immediately with the files that were successfully written.
- If rollback succeeds, the repo returns to its pre-apply state.
- If rollback fails, the repo is in an inconsistent state. The CLI must report exactly which files were modified and which could not be restored, then exit with code 1. No state file may claim success.

---

## 6. Rollback Boundaries

### Mechanism

- Reuse existing `applyFileUpdates` / `rollbackFileUpdates` from `src/patch-engine.ts`.
- `applyFileUpdates` already creates backups under `runDir` (passed as second argument).
- `rollbackFileUpdates` restores overwritten files and deletes newly created files.

### Backup location

For real repo apply, backups should live under:

```
runs/{task_id}/attempt-{N}/files-before/
```

This is consistent with existing backup behavior and keeps backups scoped to the task attempt.

### Cleanup rules

- On success: backups may be retained for audit (do not auto-delete).
- On rollback success: backups are used for restoration and may be retained.
- On rollback failure: backups must be retained and their paths reported to the user.
- No cleanup must delete files outside the patch scope.

### Rollback success

- Overwritten files: restored from backup.
- Newly created files: deleted.
- Existing empty files: preserved (not deleted, not modified if not in patch).
- Working tree should be clean after rollback (same as before apply).

### Rollback failure

- If a backup file is missing or corrupt, `rollbackFileUpdates` throws.
- The CLI must catch this, report affected files, and exit with code 1.
- No state file may be written claiming a clean state.

### Avoiding scope creep

- `validateUpdatePath` (called by `applyFileUpdates`) already prevents absolute paths, path traversal (`..`), backslashes, empty paths, and duplicate paths.
- Only files explicitly listed in the provider response may be touched.
- User-created files outside the patch scope must never be deleted or modified.

### Existing empty files

- Existing empty files have `fileExists = true` and `oldContent = ''`.
- They are treated as **overwrites**, not new files.
- Backup is created (empty file backup).
- Rollback restores the empty file (writes `''` back).
- They must not be deleted on rollback.

---

## 7. State Boundaries

### Decision: minimal state writes

- **No state write until after apply + checks succeed.**
- If checks fail and rollback succeeds, no successful apply state is written.
- If rollback fails, state must not lie. Options:
  - Do not write state at all on rollback failure.
  - Or write a clearly marked failure state (e.g., `status: 'failed_rollback'`) only if explicitly required later.
- **For Stage 4.2, recommended: no state writes at all.** The CLI command is a single-shot apply. State can be added in Stage 4.3+ when commit logic is introduced.

### If state is added later

- State may only be written after all pre-write checks pass, apply succeeds, and checks succeed.
- State must include: `task_id`, `status`, `attempt`, `timestamp`, `files_modified`.
- State must not be written before pre-write checks finish.

---

## 8. Branch Boundaries

- **No checkout of `main` at any point.**
- **No create branch in Stage 4.2** unless explicitly planned later.
- Stage 4.2 must require the user to already be on `work_branch`.
- `current branch === task.work_branch` is mandatory.
- Fail if detached HEAD (`currentBranch === 'HEAD'` or empty).
- Fail if current branch is `main`.
- Fail if `task.work_branch` is `main`.
- The CLI must not switch branches. It only validates the current branch.

---

## 9. Opt-In Boundaries

- `ALLOW_REAL_REPO_APPLY` must be checked **before any file write**.
- Recommended check order: env opt-in → task load → parse → guardrails → safety → apply.
- `ALLOW_REAL_REPO_COMMIT` must not be used in Stage 4.2.
- `ALLOW_REAL_REPO_PUSH` must not be used in Stage 4.2.
- Even if `ALLOW_REAL_REPO_COMMIT` or `ALLOW_REAL_REPO_PUSH` are accidentally set, Stage 4.2 must not commit, push, or merge.
- No commit/push/merge logic may be introduced in the Stage 4.2 implementation PR.

---

## 10. Human Review Boundaries

- Stage 4.2 may apply files locally only.
- Human must inspect `git diff` after apply.
- Human must commit manually or wait for later Stage 4.3.
- No automatic commit.
- No automatic push.
- No automatic merge.
- The apply command is intended as a "prepare the work branch" step, not a "finish the workflow" step.

---

## 11. Required Tests Before Implementation

The following tests must exist (and pass) before Stage 4.2 runtime code is considered complete:

1. Refuses when `ALLOW_REAL_REPO_APPLY` opt-in is missing.
2. Refuses when working tree is dirty.
3. Refuses when current branch is `main`.
4. Refuses when `task.work_branch` is `main`.
5. Refuses when current branch does not equal `task.work_branch`.
6. Refuses when current branch is missing or detached HEAD.
7. Refuses when provider response env var is missing.
8. Refuses on parse failure (`parseKimiOutputJson`).
9. Refuses on file guardrails violation (`validateFileList`).
10. Refuses on line delta violation (`validateProposedFileLineDeltas`).
11. Refuses on safety validation failure (`validateRealRepoApplySafety`).
12. Applies valid patch to real temp repo work branch (success path).
13. Does not commit after apply.
14. Does not push after apply.
15. Does not merge after apply.
16. Does not checkout any branch.
17. Rollback restores overwritten file on check failure.
18. Rollback removes newly created file on check failure.
19. Rollback preserves existing empty file correctly.
20. No state write before safe point (no `runs/{taskId}/state.json` created on failure).
21. No provider call, no network, no API keys.
22. Safe error messages, no stack trace leak, no API key leak.

---

## 12. Explicit Non-Goals

The following are **out of scope** for this document and for Stage 4.2:

- Do **not** implement real repo apply in this commit.
- Do **not** modify `src/**`.
- Do **not** modify `test/**`.
- Do **not** modify `TESTING_SUMMARY.md`.
- Do **not** modify `PHASE4_PLAN.md`.
- Do **not** modify package files.
- Do **not** enable commit.
- Do **not** enable push.
- Do **not** enable merge.
- Do **not** touch `main`.
- Do **not** call a real provider.

---

## 13. Next Pending Boundaries

### 13.1 Stage 4.3 commit boundary

Stage 4.2 local apply is complete. The next pending boundary is Stage 4.3:

1. **Document/plan Stage 4.3 commit boundary** — define when and how `ALLOW_REAL_REPO_COMMIT=true` would create a local commit on the work branch.
2. **Add explicit state-write decision** before any auto-commit work. State may only be written after apply + checks succeed and only if explicitly required.
3. **Do NOT implement auto-commit yet.** Keep `ALLOW_REAL_REPO_COMMIT` as a planned opt-in only.
4. Keep no push, no merge, no main touch.
5. Keep mock mode as default for tests and local development.

### 13.2 Recommended implementation order

1. Add the apply/rollback logic behind the existing pre-write validation success path in `src/cli.ts`.
2. Add tests for the new success path (apply to real repo, checks pass) and failure path (apply succeeds but checks fail → rollback).
3. Verify all 23 existing refusal tests still pass.
4. Verify no state file is written on failure.
5. Verify no commit/push/merge/checkout/main touch occurs in any path.

---

## 14. Sign-Off

| Check | Status |
|-------|--------|
| Stage 4.2 local apply implemented | Confirmed |
| Failed checks trigger rollback | Confirmed |
| Apply failure without manifest reports manual inspection required | Confirmed |
| No false "No files were modified" after apply-start failure | Confirmed |
| No state write | Confirmed |
| No commit / no push / no merge / no main touch | Confirmed |
| Human review before commit | Confirmed |
| Opt-in flag boundaries defined | Confirmed |
| Rollback boundaries defined | Confirmed |
| State boundaries defined | Confirmed |
| Failure boundaries defined for all cases | Confirmed |
| Required tests exist and pass | Confirmed |
