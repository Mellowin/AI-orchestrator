# Phase 4 Real Repo Apply Plan

**Status:** Stage 4.1 implemented, Stage 4.2 implemented, stages 4.3–4.4 pending  
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

### Stage 4.2 — Real Repo Apply (Non-Main Work Branch Only) ✅

- Behind `ALLOW_REAL_REPO_APPLY=true`.
- Require **clean working tree** (`ensureClean`).
- Require **current branch is not `main`**.
- Require explicit `task.work_branch`.
- Apply files only to the checked-out work branch.
- **No commit.**
- **No push.**
- **No merge.**
- **No checkout.**
- **No main touch.**
- **No provider call.**
- **No state write.**
- Run checks after apply.
- **Rollback** on check failure via `rollbackFileUpdates`.
- Apply failure is honest: prints `Apply failed` + `Manual inspection required`. If apply manifest is missing, prints `Rollback could not be attempted because apply manifest was not returned`. Does NOT claim `No files were modified` after apply-start failure.
- Human review required before commit.

### Stage 4.3 — Optional Local Commit (implemented)

- Behind separate `ALLOW_REAL_REPO_COMMIT=true`.
- `real-repo-commit <taskId>` actual local commit is implemented. Validates opt-ins, provider response, guardrails, branch safety, and approved working tree changes via read-only git inspection. Stages only approved changed paths via `git add <path>` (array args, no shell interpolation). Creates local commit via `git commit -m "ai-orchestrator: apply <taskId>" --no-gpg-sign`. Commit message uses taskId only, no provider content, no file content, no env values, no API keys. On success exits 0 after printing `Commit created` and safety messages. On `git add` failure exits non-zero with `Git add failed`, `No commit was made`. On `git commit` failure exits non-zero with `Git commit failed`, `Manual inspection required`.
- Commit applied changes to the local work branch only.
- **No push.**
- **No merge.**
- **No checkout.**
- **No main touch.**
- **No provider call.**
- **No state write.**
- **No amend.**
- **No force.**
- **No tag creation.**
- Commit message format: `ai-orchestrator: apply {task_id}`.

### Stage 4.4 — Optional Push (refusal stub implemented, actual push disabled)

- Behind separate `ALLOW_REAL_REPO_PUSH=true`.
- `real-repo-push <taskId>` safe refusal stub is implemented. With or without opt-in, it refuses safely and does not push.
- Push the work branch to remote is not implemented yet.
- **No merge.**
- **No checkout.**
- **No pull/fetch/rebase/reset.**
- **No main touch.**
- **No state write.**
- **No provider call.**
- **No force operations.**
- **No tag creation.**
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

### 8.4 Completed — `real-repo-apply <taskId>` local file apply CLI

- **Status:** ✅ Implemented and tested.
- **Location:** `src/cli.ts`
- **Tests:** `test/cli-real-repo-apply.test.ts`

Local file apply behind `ALLOW_REAL_REPO_APPLY=true`:

- Requires `ALLOW_REAL_REPO_APPLY=true`.
- Reads `REAL_REPO_PROVIDER_RESPONSE` env var.
- Parses via `parseKimiOutputJson`.
- Validates file list via `validateFileList`.
- Validates line deltas via `validateProposedFileLineDeltas`.
- Validates repo safety via `validateRealRepoApplySafety` (clean tree, non-main branch, branch match, auto_commit/push/merge all false).
- Builds apply plan via `buildRealRepoApplyPlan`.
- Calls `applyFileUpdates` with real repo path and `runDir` from plan.
- Runs `runChecks` in real repo path after apply.
- On check failure: calls `rollbackFileUpdates` to restore files.
- On apply failure: prints `Apply failed`, `Manual inspection required`, and `Rollback could not be attempted because apply manifest was not returned`. Does NOT claim `No files were modified`.
- On success: prints `real-repo-apply completed local file apply`, lists applied file paths, and safety messages (`No commit was made`, `No push was performed`, `No merge was performed`, `Human review required before commit`).
- No provider call, no network, no API keys, no state write, no checkout/commit/push/merge/main touch.

Properties:
- 34 CLI tests covering missing opt-in, missing/empty/malformed provider response, parse failure, guardrails failure, line delta failure, dirty tree, main branch, work_branch main, branch mismatch, safety failure, success paths (overwrite existing, create new), no commit/push/merge/checkout/state, human review message, apply failure (honest, no false "no files modified", missing manifest message), check failure with rollback (overwrite restore, new file removal), no stack trace leak, no API key leak.
- **Wired to CLI.**
- **Real repo apply is enabled for local file writes only.**

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

### 8.6 Next Recommended Step — Stage 4.4 Pre-Push Validation Tests

Stage 4.2 local file apply is complete. Stage 4.3 actual local commit is implemented. Stage 4.4 safe refusal stub is implemented.

Next steps:

1. **Add pre-push validation tests** before any actual `git push` command is implemented. Test that `real-repo-push` refuses when prerequisites are not met (dirty tree, branch mismatch, missing remote, no local commit, etc.).
2. **Do NOT implement git push yet.** Keep `ALLOW_REAL_REPO_PUSH` as a planned opt-in only.
3. Keep no merge, no main touch.
4. Keep mock mode as default for tests and local development.

### 8.7 Completed — `real-repo-commit <taskId>` local commit

- **Status:** ✅ Implemented and tested.
- **Location:** `src/cli.ts`
- **Tests:** `test/cli-real-repo-commit.test.ts`

Actual local commit behind `ALLOW_REAL_REPO_COMMIT=true`:

- Requires `ALLOW_REAL_REPO_COMMIT=true`, then `ALLOW_REAL_REPO_APPLY=true`, then `REAL_REPO_PROVIDER_RESPONSE`.
- Loads task from `tasks.yaml`.
- Parses provider response via `parseKimiOutputJson`.
- Validates file list via `validateFileList`.
- Validates branch safety: current branch exists, not main, work_branch exists, not main, current branch equals work_branch.
- Inspects working tree via read-only `git status --porcelain`.
- Accepts only approved changed paths from parsed provider response.
- Refuses unrelated modified/untracked/staged files.
- Refuses when no approved working tree changes exist.
- Stages only approved changed paths via `git add <path>` (array args, no shell interpolation).
- Creates local commit via `git commit -m "ai-orchestrator: apply <taskId>" --no-gpg-sign`.
- Commit message uses taskId only, no provider content, no file content, no env values, no API keys.
- On success: prints `Commit created`, `Commit message: ...`, `No push was performed`, `No merge was performed`, `Human review required before push`, exits 0.
- On `git add` failure: prints `Git add failed`, `No commit was made`, exits non-zero.
- On `git commit` failure: prints `Git commit failed`, `Manual inspection required`, exits non-zero.
- No provider call, no network, no API keys, no state write, no push, no merge, no checkout, no main touch, no amend, no force, no tag creation.

Properties:
- 35 CLI tests covering missing opt-in, missing ALLOW_REAL_REPO_APPLY, missing/empty/malformed provider response, guardrails failure, current branch main, work_branch main, branch mismatch, no approved changes, unrelated modified/untracked/staged files, approved modified/new/staged files create local commit, exact commit message, no provider/file content in message, no API key leak, no stack trace, git log +1 on success, git log unchanged on refusal, commit contains only approved files, unrelated files not staged on refusal, working tree clean after commit, git commit failure handling, no push/merge/checkout/main touch, no state write, existing real-repo-apply behavior unchanged.
- **Wired to CLI.**
- **Actual local commit enabled.**

---

## 9. Sign-Off

| Check | Status |
|-------|--------|
| Phase 4 Stage 4.1 implemented | ✅ |
| Phase 4 Stage 4.2 implemented | ✅ |
| Phase 4 Stage 4.3 local commit implemented | ✅ |
| No real repo writes in Stage 4.1 | Confirmed |
| Real repo apply (write) enabled in Stage 4.2 | Confirmed |
| No commit / no push / no merge / no main touch in Stage 4.2 | Confirmed |
| No state write in Stage 4.2 | Confirmed |
| No provider call in Stage 4.2 | Confirmed |
| Stage 4.3 actual local commit enabled | Confirmed |
| Phase 4 Stage 4.4 refusal stub implemented | ✅ |
| Phase 4 Stage 4.4 actual push remains disabled | Confirmed |
| Opt-in flags defined | Confirmed |
