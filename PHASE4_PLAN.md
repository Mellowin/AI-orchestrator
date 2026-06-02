# Phase 4 Real Repo Apply Plan

**Status:** Stage 4.1 implemented, stages 4.2–4.4 pending  
**Branch:** `feature/mvp-skeleton`  
**Audited baseline:** `7ebfe43a765527dea7f92544ebc151f163fd694a`

---

## 1. Goal

Promote a validated sandbox result toward a real-repo workflow, but only behind **strict explicit opt-in** and **human control**.

> **Phase 4 is planning only.** This document must not enable real repo apply. No runtime code is introduced by this plan.

---

## 2. Required Opt-In Flags

All real-repo operations require explicit environment opt-ins. Defaults are deny-by-default.

| Flag | Stage | Required For |
|------|-------|--------------|
| `ALLOW_REAL_REPO_APPLY=true` | 4.2+ | Any real-repo file write |
| `ALLOW_REAL_REPO_COMMIT=true` | 4.3 | Local commit on work branch |
| `ALLOW_REAL_REPO_PUSH=true` | 4.4 | Pushing work branch to remote |

**Hard defaults:**
- No push by default.
- No merge by default.
- No `main` touch ever.

---

## 3. Proposed Stage Breakdown

### Stage 4.1 — Dry-Run Command ✅

- **CLI command:** `real-repo-apply-dry-run <taskId>` implemented in `src/cli.ts`.
- **No file writes.**
- Load task, parse provider output (`REAL_REPO_PROVIDER_RESPONSE` env), run guardrails.
- Validate safety via `validateRealRepoApplySafety` (clean tree, non-main branch, branch match, auto_commit/push/merge all false).
- Build summary via `buildRealRepoApplyDryRunSummary`.
- Print proposed target files, line deltas, guardrails verdict, safety verdict, and safety messages.
- Existing empty files correctly reported as `isNew=false` (fixed from `oldContent === ''` to `!fileExists`).
- **Does not require `ALLOW_REAL_REPO_APPLY`.**
- No provider call, no network, no API keys, no state writes, no git mutations.
- Tests: `test/cli-real-repo-apply-dry-run.test.ts` (15 tests).

### Stage 4.2 — Real Repo Apply (Non-Main Work Branch Only)

- Behind `ALLOW_REAL_REPO_APPLY=true`.
- Require **clean working tree** (`ensureClean`).
- Require **current branch is not `main`**.
- Require explicit `task.work_branch`.
- Apply files only to the checked-out work branch.
- **No commit.**
- **No push.**
- **No merge.**
- Run checks after apply.
- **Rollback** on check failure where possible (via `rollbackFileUpdates`).

### Stage 4.3 — Optional Local Commit

- Behind separate `ALLOW_REAL_REPO_COMMIT=true`.
- Commit applied changes to the local work branch only.
- **No push.**
- **No merge.**
- Commit message format: `ai-orchestrator: {task_id} attempt {N} — manual review required`.

### Stage 4.4 — Optional Push

- Behind separate `ALLOW_REAL_REPO_PUSH=true`.
- Push the work branch to remote.
- **No merge.**
- Human review required before any downstream action.

---

## 4. Hard Safety Requirements

These invariants must hold across all Stage 4.x implementations:

1. **Never checkout `main`.**
2. **Never commit on `main`.**
3. **Never push `main`.**
4. **Never merge automatically.**
5. **Never overwrite a dirty working tree.**
6. **Fail if working tree is not clean.**
7. **Fail if current branch is `main`.**
8. **Fail if `work_branch` is missing.**
9. **Fail if `work_branch` equals `main`.**
10. **Fail if file list fails guardrails (`validateFileList`).**
11. **Fail if line delta guardrails fail (`validateProposedFileLineDeltas`).**
12. **Fail if checks fail (`runChecks`).**
13. **Rollback on failure where possible.**
14. **No state write until a safe point is explicitly defined.**
15. **No provider call unless separately enabled.**
16. **No API keys required for apply-only phase.**

---

## 5. Reuse Map (Existing Building Blocks)

| Building Block | Source | Reuse in Phase 4 |
|----------------|--------|------------------|
| Parse provider JSON | `parseKimiOutputJson` | Load and validate raw output before any real-repo operation. |
| File list guardrails | `validateFileList` | Run before any write to real repo. |
| Line delta guardrails | `validateProposedFileLineDeltas` | Run before any write to real repo. |
| Apply files | `applyFileUpdates` | Target real repo path instead of sandbox path. |
| Rollback files | `rollbackFileUpdates` | Restore real repo files on check failure. |
| Run checks | `runChecks` | Execute task checks in real repo path after apply. |
| Clean tree check | `ensureClean` | Reuse from `git-manager` before any mutation. |

**New building block needed:**

- `validateRealRepoApplySafety(task, repoStatus)` — pure helper that validates all preconditions before any write. ✅ Implemented and wired to `real-repo-apply-dry-run` CLI.
- `buildRealRepoApplyDryRunSummary(input)` — pure helper that builds normalized dry-run summary with safety messages. ✅ Implemented and wired to `real-repo-apply-dry-run` CLI.

---

## 6. Required Tests Before Implementation

The following tests must exist (and pass) before any real-repo apply stage is considered complete:

- Refuses when working tree is dirty.
- Refuses when current branch is `main`.
- Refuses when `work_branch` is `main`.
- Refuses when `ALLOW_REAL_REPO_APPLY` opt-in is missing.
- Refuses when `work_branch` is missing.
- Refuses invalid provider output (parse failure).
- Refuses guardrail violations (`validateFileList`).
- Refuses line delta violations (`validateProposedFileLineDeltas`).
- Applies only to allowed files on a non-`main` branch.
- Rollback restores files on check failure.
- No push is performed.
- No merge is performed.
- No state write unless explicitly allowed.
- No API key leak in error output.
- No stack trace leak in error output.

---

## 7. Explicit Non-Goals

The following are **out of scope** for this planning document and for the immediate next steps:

- Do **not** implement real repo apply in this task.
- Do **not** modify `src/**`.
- Do **not** modify `test/**`.
- Do **not** enable push.
- Do **not** enable merge.
- Do **not** touch `main`.
- Do **not** call a real provider.
- Do **not** require API keys.

---

## 8. Implementation Progress

### 8.1 Completed — `validateRealRepoApplySafety(task, repoStatus)`

- **Status:** ✅ Implemented and tested.
- **Location:** `src/real-repo-apply-safety.ts`
- **Tests:** `test/real-repo-apply-safety.test.ts`

A pure helper function that checks:

- Working tree is clean (`repoStatus.isClean === true`).
- Current branch is not `main` (`repoStatus.currentBranch !== 'main'`).
- `task.work_branch` exists and is not empty.
- `task.work_branch` is not `main`.
- Current branch equals `work_branch`.
- `task.guardrails.auto_commit === false`.
- `task.guardrails.auto_push === false`.
- `task.guardrails.auto_merge === false`.

Properties:
- Returns `ValidationResult` (`{ ok: boolean; reason?: string }`).
- 100% pure: no fs, no git commands, no child_process, no env reads, no network, no API keys, no state writes.
- Unit-tested in isolation (13 tests).
- **Wired to `real-repo-apply-dry-run` CLI.**
- **Real repo apply remains disabled for writes.**

### 8.2 Completed — `buildRealRepoApplyDryRunSummary(input)`

- **Status:** ✅ Implemented and tested.
- **Location:** `src/real-repo-apply-dry-run.ts`
- **Tests:** `test/real-repo-apply-dry-run.test.ts`

A pure helper function that builds a normalized dry-run summary:

- Trims `taskId`, `currentBranch`, `workBranch`, and file paths.
- Preserves file order unchanged.
- Validates inputs: rejects empty strings, rejects duplicate file paths after trimming, rejects non-finite `lineDelta` (NaN, Infinity).
- Includes safety messages: `No files were modified`, `No commit was made`, `No push was performed`, `No merge was performed`, `Real repo apply is dry-run only`.

Properties:
- 100% pure: no fs, no git commands, no child_process, no env reads, no network, no API keys, no state writes.
- Unit-tested in isolation (14 tests).
- **Wired to `real-repo-apply-dry-run` CLI.**
- **Real repo apply remains disabled for writes.**

### 8.3 Completed — `real-repo-apply-dry-run <taskId>` CLI command

- **Status:** ✅ Implemented and tested.
- **Location:** `src/cli.ts`
- **Tests:** `test/cli-real-repo-apply-dry-run.test.ts`

A read-only CLI command that:

- Loads task from `tasks.yaml`.
- Reads raw provider output from `REAL_REPO_PROVIDER_RESPONSE` env var.
- Parses via `parseKimiOutputJson`.
- Validates file list via `validateFileList`.
- Validates line deltas via `validateProposedFileLineDeltas`.
- Validates safety via `validateRealRepoApplySafety` (clean tree, non-main branch, branch match, auto_commit/push/merge all false).
- Builds summary via `buildRealRepoApplyDryRunSummary`.
- Prints task/branch/guardrails verdict/safety verdict/files/safety messages.
- Existing empty files correctly reported as `isNew=false` (fixed from `oldContent === ''` to `!fileExists`).
- **Does not require `ALLOW_REAL_REPO_APPLY`.**
- No file writes, no patch apply, no state creation, no API calls, no git mutations.

Properties:
- 15 CLI tests covering success, missing env, parse failure, guardrails failure, all safety failures (dirty tree, main branch, work_branch main, branch mismatch, auto_commit/push/merge not false), no file mutation, no state write, existing empty file isNew fix.
- **Wired to CLI.**
- **Real repo apply remains disabled for writes.**

### 8.4 Completed — `real-repo-apply <taskId>` pre-write validation CLI

- **Status:** ✅ Implemented and tested.
- **Location:** `src/cli.ts`
- **Tests:** `test/cli-real-repo-apply.test.ts`

A pre-write validation flow that still refuses before any file write:

- Requires `ALLOW_REAL_REPO_APPLY=true`.
- Reads `REAL_REPO_PROVIDER_RESPONSE` env var.
- Parses via `parseKimiOutputJson`.
- Validates file list via `validateFileList`.
- Validates line deltas via `validateProposedFileLineDeltas`.
- Validates repo safety via `validateRealRepoApplySafety` (clean tree, non-main branch, branch match, auto_commit/push/merge all false).
- Builds apply plan via `buildRealRepoApplyPlan`.
- Prints plan summary: task id, current branch, work branch, files with action (`create`/`overwrite`) and `backupPath`.
- Exits non-zero with message: `real-repo-apply pre-write validation passed, but file apply is not implemented yet`.
- Prints safety messages: `No files were modified`, `No commit was made`, `No push was performed`, `No merge was performed`.
- No real repo writes, no `applyFileUpdates`, no `rollbackFileUpdates`, no provider call, no network, no API keys, no state write, no checkout/commit/push/merge/main touch.

Properties:
- 23 CLI tests covering missing opt-in, missing/empty/malformed provider response, parse failure, guardrails failure, line delta failure, dirty tree, main branch, work_branch main, branch mismatch, safety failure, valid pre-write path with plan summary, no file mutation, no state write, no commit/push/merge/checkout, no stack trace leak, no API key leak.
- **Wired to CLI.**
- **Real repo apply (write) remains disabled.**

### 8.5 Completed — `buildRealRepoApplyPlan(input)` pure helper

- **Status:** ✅ Implemented and tested.
- **Location:** `src/real-repo-apply-plan.ts`
- **Tests:** `test/real-repo-apply-plan.test.ts`

A pure helper that builds a real-repo apply plan without touching the filesystem:

- Builds `runDir`: `runs/{taskId}/attempt-{attempt}`.
- Builds `backupPath`: `runs/{taskId}/attempt-{attempt}/files-before/{path}`.
- Determines `action`: `create` or `overwrite` based on `existingPaths`.
- Validates `taskId` (non-empty string), `attempt` (positive integer).
- Validates file paths: rejects empty, duplicates after trim, absolute (`/` and `C:/...`), traversal (`..`), backslash.
- Validates `existingPaths` with same rules.
- Allows empty string `content`.
- Returns `{ok:false,reason,safetyMessages}` for validation failures without throwing.

Properties:
- 100% pure: no fs, no git commands, no child_process, no env reads, no network, no API keys, no state writes.
- 25 unit tests covering create/overwrite plans, path trimming, runDir/backupPath, empty content, all validation failures, input immutability, safety messages.
- **Not wired to CLI.**
- **Real repo apply remains disabled for writes.**

### 8.6 Next Recommended Step — Stage 4.2 Actual File Apply and Rollback

**Real file write is still not implemented.** The pre-write validation flow validates everything but stops before `applyFileUpdates`.

Next steps to complete Stage 4.2:

1. **Preserve all existing refusal tests** in `test/cli-real-repo-apply.test.ts` (23 tests). Every failure path must continue to exit non-zero with safe messages and no file mutation.
2. **Add real apply logic** behind the pre-write validation success path:
   - Call `applyFileUpdates` with real repo path and `runDir` from `buildRealRepoApplyPlan`.
   - Run `runChecks` in real repo path after apply.
   - On check failure: call `rollbackFileUpdates` to restore files.
   - On apply failure mid-batch: call `rollbackFileUpdates` for successfully written files.
3. **State remains no-write** until a safe point is explicitly defined (see audit doc).
4. **No commit, no push, no merge, no main touch** — these invariants must hold even after apply is enabled.

---

## 9. Sign-Off

| Check | Status |
|-------|--------|
| Phase 4 Stage 4.1 implemented | ✅ |
| Phase 4 pre-write validation implemented | ✅ |
| No real repo writes in Stage 4.1 | Confirmed |
| Real repo apply (write) remains disabled | Confirmed |
| Pre-write validation stops before applyFileUpdates | Confirmed |
| No push / no merge / no main touch | Confirmed |
| Opt-in flags defined | Confirmed |
