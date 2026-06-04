# Phase 4 Real Repo Apply Plan

**Status:** Stage 4.1 implemented, Stage 4.2 implemented, Stage 4.3 implemented, Stage 4.4 implemented, Stage 4.5 implemented, Stage 5.0 implemented  
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
| `ALLOW_REAL_REPO_APPLY=true` + `ALLOW_REAL_REPO_COMMIT=true` + `ALLOW_REAL_REPO_PUSH=true` | 5.0 | One-command unified run (apply → commit → push) |
| `ALLOW_REAL_PROVIDER=true` + above three | 5.1 | One-command unified run with real AI provider |

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

### Stage 4.4 — Optional Push (implemented)

- Behind separate `ALLOW_REAL_REPO_PUSH=true`.
- `real-repo-push <taskId>` actual safe push is implemented. Validates task, repo_path, work_branch, current branch, clean working tree, HEAD commit, origin remote. Performs `git push origin <currentBranch>` via `spawnSync` with array args and `shell: false`. No force, no tags, no `--all`, no `--mirror`.
- On success prints `Push completed` and safety messages, exits 0.
- On push failure prints `Git push failed` + `Manual inspection required`, exits non-zero.
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

### 8.6 Completed — `real-repo-run <taskId>` unified workflow (Stage 5.0)

- **Status:** ✅ Implemented and tested.
- **Location:** `src/cli.ts`
- **Tests:** `test/cli-real-repo-run.test.ts`

One-command unified workflow behind all three opt-ins:

- Requires `ALLOW_REAL_REPO_APPLY=true`, `ALLOW_REAL_REPO_COMMIT=true`, `ALLOW_REAL_REPO_PUSH=true`, and `REAL_REPO_PROVIDER_RESPONSE`.
- Parses provider response via `parseKimiOutputJson`.
- Validates file list via `validateFileList`.
- Validates line deltas via `validateProposedFileLineDeltas`.
- Validates repo safety via `validateRealRepoApplySafety`.
- Builds apply plan via `buildRealRepoApplyPlan`.
- Applies validated file updates via `applyFileUpdates`.
- Runs checks via `runChecks`.
- Rolls back on check failure via `rollbackFileUpdates`.
- Validates working tree contains only approved changes before commit.
- Refuses unrelated modified/untracked/staged files with rollback.
- Stages approved files via `git add <path>`.
- Commits via `git commit -m "ai-orchestrator: apply <taskId>" --no-gpg-sign`.
- Pushes via `git push origin <currentBranch>`.
- Writes state with `status: 'pushed'`, `pushed_remote: 'origin'`, `pushed_ref`, `commit_sha`, `updated_at`, `safety_note`.
- Apply failure: prints `Apply failed` + `Manual inspection required`, does not commit/push/state.
- Check failure: rolls back, does not commit/push/state.
- No merge, no checkout, no pull/fetch/rebase/reset, no main touch, no force, no tags, no `--all`/`--mirror`, no provider call, no API keys.

Properties:
- 40 CLI tests covering all refusal paths (missing opt-ins, missing/malformed provider response, guardrails, line delta, main branch, work_branch main, branch mismatch, dirty tree), apply failure (no commit/push/state), check failure with rollback, success path (apply + commit + push + state), state validation, content safety, no force/all/mirror/tags, no merge/checkout/reset/main touch, working tree clean after success, existing commands unchanged.
- **Wired to CLI.**
- **Unified workflow enabled.**

### 8.7 Completed — `real-repo-run-ai <taskId>` unified workflow with real provider (Stage 5.1)

- **Status:** ✅ Implemented and tested.
- **Location:** `src/cli.ts`
- **Tests:** `test/cli-real-repo-run-ai.test.ts`

One-command unified workflow with real AI provider integration behind four opt-ins:

- Requires `ALLOW_REAL_PROVIDER=true`, `ALLOW_REAL_REPO_APPLY=true`, `ALLOW_REAL_REPO_COMMIT=true`, `ALLOW_REAL_REPO_PUSH=true`.
- Validates repo safety BEFORE provider call: clean working tree, non-main current branch, valid `work_branch`, branch match, `auto_commit`/`auto_push`/`auto_merge` all `false`.
- Builds prompt via `buildContext` + `buildKimiPrompt`.
- Calls real provider via `createRealProviderCall` with `KIMI_API_KEY` + `KIMI_BASE_URL` + `KIMI_MODEL`. Supports `KIMI_FAKE_RESPONSE` test seam for injected fake fetch.
- Parses provider response via `parseKimiOutputJson`.
- Validates file list via `validateFileList`.
- Validates line deltas via `validateProposedFileLineDeltas`.
- Runs identical safe sequence as `real-repo-run`: apply → checks → rollback on fail → commit → push → state.
- Provider call failure prints `Provider call failed` + `Manual inspection required`, does not apply/commit/push/state.
- Malformed provider output prints `Provider output malformed` + `Manual inspection required`, does not apply/commit/push/state.
- No provider raw output printed in success path.
- No merge, no checkout, no pull/fetch/rebase/reset, no main touch, no force, no tags, no `--all`/`--mirror`.

Properties:
- 39 CLI tests covering missing opt-ins (each individually), repo safety failures before provider call, provider call failure, malformed output, guardrails failure, line delta failure, apply failure, check failure with rollback, success path with provider→apply→commit→push→state, state content safety, no force/all/mirror/tags, no merge/checkout/reset/main touch, working tree clean after success, existing commands unchanged.
- **Wired to CLI.**
- **Real provider integrated into one-command workflow.**

### 8.8 Completed — Stage 5.2 Self-Repair Loop

- **Status:** ✅ Implemented and tested.
- **Location:** `src/cli.ts`
- **Tests:** `test/cli-real-repo-run-ai.test.ts`

Self-repair loop for `real-repo-run-ai <taskId>`:

- `REAL_REPO_AI_MAX_ATTEMPTS` env var controls bounded retry (default 2, min 1, max 3). Invalid values refuse before provider call.
- On check failure after apply, working tree is rolled back via `rollbackFileUpdates`.
- If attempts remain, a repair prompt is built via `buildRepairPrompt` containing: failed check command, check output summary, previously proposed file paths. No API keys, env values, or remote URLs with credentials are included.
- The real provider is called again with the repair prompt.
- Provider parse failures on repair are reported as `Provider repair output malformed`. Provider call failures on repair are reported as `Provider repair call failed`.
- On final failed attempt: prints `Checks failed after N attempt(s)`, no commit/push/state, working tree clean, branch unchanged.
- On successful repair: exactly one commit, exactly one push, one state write. Output includes `Repair attempt succeeded`.
- Tests use `KIMI_FAKE_RESPONSES` (JSON array) to simulate multiple provider responses. `__FETCH_ERROR__` marker simulates repair provider call failure.

Properties:
- 67 CLI tests covering missing opt-ins, repo safety, provider call failure, malformed output, guardrails/line delta, apply failure, check failure with rollback, max attempts validation (default/1/2/3/0/4/non-numeric), repair success path, repair provider failure/malformed, final failure state, commit/push/state safety on repair, prompt content safety, no force/all/mirror/tags, no merge/checkout/reset/main touch, working tree clean after success.
- **Wired to CLI.**
- **Self-repair loop integrated into real provider workflow.**

### 8.9 Completed — `real-repo-commit <taskId>` local commit

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

### 8.10 Completed — Stage 5.3 Readiness + Operator Guide

- **Status:** ✅ Implemented and tested.
- **Location:** `src/cli.ts`, `STAGE5_OPERATOR_GUIDE.md`, `STAGE5_REAL_SMOKE_DEMO.md`
- **Tests:** `test/cli-real-repo-run-ai-readiness.test.ts`

Readiness command `real-repo-run-ai-readiness <taskId>`:

- Validates that `real-repo-run-ai <taskId>` is safe to start, **without** calling the provider and without mutating the repo.
- Checks all four opt-ins (`ALLOW_REAL_PROVIDER`, `ALLOW_REAL_REPO_APPLY`, `ALLOW_REAL_REPO_COMMIT`, `ALLOW_REAL_REPO_PUSH`).
- Validates task existence, `repo_path`, `work_branch` not main.
- Validates repo: current branch exists, not main, matches `work_branch`, clean working tree, HEAD commit exists, origin remote exists with non-empty URL.
- Validates provider env presence (`KIMI_API_KEY`, `KIMI_BASE_URL`).
- On success prints readiness summary with `Provider call: not performed`, `Apply: not performed`, `Commit: not performed`, `Push: not performed`.
- On any failure prints safe error + standard safety messages. No stack trace.
- Hard forbidden: no provider call, no apply, no commit, no push, no state write, no merge, no checkout/switch, no pull/fetch/rebase/reset, no main touch, no API key printing.

Operator guide (`STAGE5_OPERATOR_GUIDE.md`):

- Documents what Stage 5 supports and what it does NOT support (no merge, no PR, no main touch).
- Lists required environment variables.
- Provides exact safe operator sequence (branch → clean → task → readiness → run → inspect → decide).
- Includes safety checklist and recovery checklist.

Real smoke demo doc (`STAGE5_REAL_SMOKE_DEMO.md`):

- Tiny safe demo plan using `smoke-demo/ai-smoke.txt`.
- Exact copy-paste steps: branch creation, task config, readiness, real AI run, verification, cleanup.
- No merge, no force push, no main touch.

Properties:
- 32 CLI tests covering missing taskId, missing opt-ins (each individually), missing provider env, task/repo validation, branch safety, working tree checks (dirty/untracked/staged), HEAD/origin checks, success output validation, no mutation (files/commit/push/state), no checkout/switch, no main touch, no stack trace, existing `real-repo-run-ai` behavior unchanged.
- **Wired to CLI.**
- **Readiness check + operator docs added.**

### 8.11 Completed — Stage 5.4 Real Smoke Demo Execution

- **Status:** ✅ Executed and reported.
- **Location:** `STAGE5_REAL_SMOKE_DEMO_REPORT.md`, `ai/smoke-demo` branch
- **Bug found and fixed:** `createRealProviderCall` did not pass `KIMI_USER_AGENT` header, causing HTTP 403 from Kimi For Coding API.
- **Fix commit:** `319efb808224ae308d7e72d041f438e6c5022402`

Real smoke demo results:
- **Branch:** `ai/smoke-demo`
- **Task:** `smoke-demo`
- **Readiness:** ✅ Passed
- **Real AI run:** ✅ Success on first attempt (no self-repair)
- **File changed:** `smoke-demo/ai-smoke.txt` created with content "AI smoke demo"
- **Commit:** `df083194068c2f913492161233224f45ef0054a8` (`ai-orchestrator: apply smoke-demo`)
- **Pushed:** `origin/ai/smoke-demo`
- **State:** `runs/smoke-demo/state.json` with `status: pushed`
- **No merge:** ✅ `ai/smoke-demo` not merged into `main`
- **No main touch:** ✅ `main` unchanged at `065568b`

### 8.12 Completed — Stage 5.5 Manual Approval / PR Boundary Report

- **Status:** ✅ Implemented and tested.
- **Location:** `src/cli.ts`, `test/cli-real-repo-approval-report.test.ts`, `STAGE5_PR_BOUNDARY_AUDIT.md`
- **Tests:** 45 CLI tests

Command `real-repo-approval-report <taskId>`:
- Generates `runs/<taskId>/approval-report.md` after successful push (`status: pushed`).
- Requires `ALLOW_REAL_REPO_APPROVAL_REPORT=true`.
- No provider call, no apply, no commit, no push, no PR creation, no merge, no checkout/switch, no main touch, no API keys required.
- Validates task and state file rigorously.
- Validates commit SHA exists locally via `git rev-parse --verify --end-of-options <sha>^{commit}`.
- Generates diff stat via read-only `git diff --stat`.
- Report includes: task metadata, commit SHA, diff stat (or warning), manual review checklist, exact manual commands, hard safety statements.
- Report excludes: API keys, env values, remote URL credentials.

### 8.13 Completed — Stage 5.6 PR Readiness / Dry-Run Stub

- **Status:** ✅ Implemented and tested.
- **Location:** `src/cli.ts`, `test/cli-real-repo-pr-readiness.test.ts`
- **Tests:** 60 CLI tests

Command `real-repo-pr-readiness <taskId>`:
- Generates `runs/<taskId>/pr-readiness.md` and `runs/<taskId>/pr-body.md` after successful push.
- Requires `ALLOW_REAL_REPO_PR_READINESS=true` and existing `approval-report.md`.
- Validates task, state, commit SHA, approval report, base/work branch refs.
- Includes PR title suggestion, diff stat, manual `gh pr create` command as text only, hard safety statements.
- No provider call, no apply, no commit, no push, no PR creation, no GitHub API call, no gh execution, no merge, no checkout/switch, no main touch.

### 8.14 Completed — Stage 5.7 Real PR Creation

- **Status:** ✅ Implemented and tested.
- **Location:** `src/cli.ts`, `test/cli-real-repo-pr-create.test.ts`
- **Tests:** 69 CLI tests

Command `real-repo-pr-create <taskId>`:
- Creates a GitHub Pull Request via REST API after successful push.
- Requires `ALLOW_GITHUB_PR_CREATE=true`, `GITHUB_TOKEN`, `GITHUB_REPOSITORY`.
- Validates task, state (`status: pushed`), commit SHA, approval report, PR readiness report, PR body, base/work branch refs.
- Calls GitHub API `POST /repos/{owner}/{repo}/pulls` with title, body, base, head.
- Tests use `GITHUB_FAKE_PR_RESPONSE` injected fake fetch — no real GitHub API calls.
- Writes `runs/<taskId>/pr-created.json` with PR metadata and safety note.
- No merge, no auto-merge, no checkout/switch, no main touch, no push, no provider call, no gh execution.
- Safe error on API failure: `GitHub PR creation failed`, `Manual inspection required`.

### 8.15 Completed — Stage 5.8 PR Status / Checks Read-Only Report

- **Status:** ✅ Implemented and tested.
- **Location:** `src/cli.ts`, `test/cli-real-repo-pr-status.test.ts`
- **Tests:** 83 CLI tests

Command `real-repo-pr-status <taskId>`:
- Read-only PR status/checks report after PR creation.
- Requires `ALLOW_GITHUB_PR_STATUS=true`, `GITHUB_TOKEN`, `GITHUB_REPOSITORY`.
- Validates task, state (`status: pushed`), commit SHA, approval report, PR readiness report, PR body, `pr-created.json` fields.
- Calls GitHub API read-only GET: `/pulls/{number}`, `/commits/{sha}/status`, `/commits/{sha}/check-runs`.
- Tests use `GITHUB_FAKE_PR_RESPONSE`, `GITHUB_FAKE_STATUS_RESPONSE`, `GITHUB_FAKE_CHECKS_RESPONSE` injected fake fetch — no real GitHub API calls.
- Writes `runs/<taskId>/pr-status-report.md` with PR metadata, combined status, check runs summary, next-step guidance.
- Writes `runs/<taskId>/pr-status.json` with machine-readable status snapshot.
- No PR creation, no PR update, no merge, no auto-merge, no checkout/switch, no main touch, no push, no provider call, no gh execution.
- Safe error on API failure: `GitHub PR status fetch failed`, `Manual inspection required`.

### 8.16 Completed — Stage 5.9 MVP Hardening / Final Documentation

- **Status:** ✅ Documentation finalized.
- **Location:** `MVP_FINAL_REPORT.md`, `COMMAND_REFERENCE.md`, `SAFETY_MODEL.md`, `README.md`

Final documentation created:
- `MVP_FINAL_REPORT.md` — current status, verified pipeline, demo proof, safety boundaries, known limitations, recommended next phase.
- `COMMAND_REFERENCE.md` — all real-repo commands with purpose, required env, allowed mutation, forbidden actions, outputs, success messages, failure behavior.
- `SAFETY_MODEL.md` — safety philosophy, opt-in table, git operation policy, provider policy, GitHub API policy, state/report file policy, human boundary.
- `README.md` updated with MVP overview, pipeline diagram, quick links.
- `PHASE4_PLAN.md` updated with Stage 5.9 completion.
- `TESTING_SUMMARY.md` updated with docs rules.
- `STAGE5_PR_BOUNDARY_AUDIT.md` updated with Stage 5.9.

### 8.17 Completed — Stage 5.10 Live Operator Demo Evidence Pack

- **Status:** ✅ Executed and documented.
- **Location:** `STAGE5_LIVE_DEMO_EVIDENCE.md`
- **Evidence commit:** `36d8581f5cc171ebc12a93d10a672a26695984f6`

Live demo results:
- **Branch:** `demo/stage5-live-proof`
- **Task:** `stage5-live-proof`
- **Readiness:** ✅ Passed
- **Real AI run:** ✅ Success on first attempt (no self-repair)
- **File changed:** `live-demo/stage5-proof.txt` created with content "Stage 5 live proof works"
- **Commit:** `77e8f2e539e167a38ea33cb15c24898d40e53eba` (`ai-orchestrator: apply stage5-live-proof`)
- **Pushed:** `origin/demo/stage5-live-proof`
- **State:** `runs/stage5-live-proof/state.json` with `status: pushed`
- **Approval report:** ✅ Generated
- **PR readiness:** ✅ Generated (`pr-readiness.md` + `pr-body.md`)
- **PR creation:** ❌ Blocked — `GITHUB_TOKEN` not available (expected safe refusal)
- **No merge:** ✅ `demo/stage5-live-proof` not merged
- **No main touch:** ✅ `main` unchanged

---

## Stage 6 — Autonomous Block Orchestrator

Stage 5 built the safe repo/PR pipeline. Stage 6 turns it into autonomous block execution.

### Stage 6.0A — Product Vision and Autonomous Architecture Documentation ✅

- **Status:** Documentation complete.
- **Location:** `PRODUCT_VISION.md`, `AUTONOMOUS_BLOCK_ARCHITECTURE.md`, `PROVIDER_COMBINATION_ROADMAP.md`

Documents created:
- `PRODUCT_VISION.md` — fixes the original product goal, defines what the project is and is not, states core principles, defines first autonomous target (Kimi coder + Kimi reviewer), lists future provider combinations, defines human role.
- `AUTONOMOUS_BLOCK_ARCHITECTURE.md` — defines block concept, block task concept, task statuses, block statuses, autonomous loop, reviewer gate, deterministic checks before AI review, reviewer input/output schemas, stop conditions, what is not autonomous.
- `PROVIDER_COMBINATION_ROADMAP.md` — documents provider roles, intended interfaces, current implementation status, immediate roadmap (Stage 6.0–6.7), future provider combinations, configuration examples, product rule against provider hardcoding.

### Stage 6.0 — Provider Abstraction Foundation ✅

- **Status:** Implemented and tested.
- **Location:** `src/providers/`, `src/reviewer/`, `test/provider-*.test.ts`, `test/fake-provider.test.ts`, `test/reviewer-schema.test.ts`, `test/kimi-reviewer-provider.test.ts`, `test/cli-reviewer-gate-dry-run.test.ts`
- **Tests:** 62 tests across 7 new test suites

Implementation:
- Extracted provider-agnostic interfaces (`CoderProvider`, `ReviewerProvider`) in `src/providers/provider-types.ts`.
- Implemented `ProviderRegistry` in `src/providers/provider-registry.ts` — registers and resolves providers by id + role, throws safe errors.
- Implemented fake coder (`fake-coder-provider.ts`) and fake reviewer (`fake-reviewer-provider.ts`) — deterministic, no network, no API keys.
- Implemented Kimi coder adapter (`kimi-coder-provider.ts`) wrapping existing Kimi coder logic.
- Implemented Kimi reviewer provider (`kimi-reviewer-provider.ts`) with `ALLOW_KIMI_REVIEWER=true` opt-in, `KIMI_FAKE_REVIEWER_RESPONSE` test seam.
- Defined strict reviewer decision schema in `src/reviewer/reviewer-schema.ts` (`validateReviewerDecision`) — accepted must have empty blocking_issues, rejected must have blocking_issues or fix_task, safe errors without secret leak.
- Created reviewer prompt builder in `src/reviewer/reviewer-prompt.ts` — requires factual evidence, does not trust coder self-report.
- Added `reviewer-gate-dry-run <taskId>` CLI command in `src/cli.ts` — resolves reviewer provider via `REVIEWER_PROVIDER` env, validates provider contract without repo mutation.

Properties:
- No real provider calls in tests (all use fake seams).
- No GitHub API calls.
- No merge, no main touch, no checkout/switch in new code.
- 62 new tests covering all new modules. All 1096 tests pass (66 suites).

### Stage 6.1 — Deterministic Commit Verifier for Reviewer Gate ✅

- **Status:** Implemented and tested.
- **Location:** `src/reviewer/commit-verifier.ts`, `src/reviewer/deterministic-review-checks.ts`, `src/reviewer/review-input-builder.ts`, `src/reviewer/reviewer-gate.ts`, `test/commit-verifier.test.ts`, `test/deterministic-review-checks.test.ts`, `test/review-input-builder.test.ts`, `test/reviewer-gate.test.ts`, `test/cli-reviewer-gate-evidence-dry-run.test.ts`
- **Tests:** 82 tests across 5 new test suites

Implementation:
- **Commit verifier** (`commit-verifier.ts`): `validateCommitSha` (40-char hex), `verifyCommitExists` (git rev-parse), `getCommitChangedFiles` (git diff/show), `getCommitDiff` (git diff/show with truncation guard), `getGitStatusPorcelain`, `buildCommitEvidence` — all read-only, shell: false.
- **Deterministic checks** (`deterministic-review-checks.ts`): `runDeterministicReviewChecks` validates commit SHA, changed files non-empty, allowedFiles scope, deniedFiles rejection, maxLinesChanged counting (ignores `+++`, `---`, `@@`), typecheck/build/test pass detection, clean git status, non-main branch, secret detection in diff (`sk-`, `Bearer`, API key names, `.env`), merge conflict markers. Rejects with `block_for_human` for severe issues, `send_fix_to_coder` for non-severe.
- **Review input builder** (`review-input-builder.ts`): `buildReviewInput` validates and assembles `ReviewInput` from evidence. Trims strings, validates arrays, normalizes SHA.
- **Reviewer gate** (`reviewer-gate.ts`): `runReviewerGate` calls deterministic checks first. If they fail, returns rejected decision without calling AI reviewer. If they pass, calls `reviewer.reviewCommit()` and validates output via `validateReviewerDecision`.
- **CLI command** `reviewer-gate-evidence-dry-run <taskId> <commitSha>`: Loads task, validates SHA, builds commit evidence, runs deterministic checks, builds ReviewInput, resolves reviewer provider, runs reviewer gate, prints summary. No file writes, no state writes, no git mutation, no push/merge/checkout/main touch.

Properties:
- No real provider calls in tests (all use fake seams).
- No GitHub API calls.
- No merge, no main touch, no checkout/switch in new code.
- 82 new tests covering all new modules. All tests pass.

### Stage 6.1 — Deterministic Commit Verifier for Reviewer Gate

- Build `buildReviewerInput` pure helper that gathers commit evidence.
- Ensure deterministic checks (typecheck/build/test/guardrails) run before reviewer call.
- Validate reviewer output schema before acting on it.

### Stage 6.1.1 — Reviewer Gate Safety Hardening ✅

- **Status:** Implemented and tested.
- **Location:** `src/reviewer/reviewer-redaction.ts`, `src/reviewer/deterministic-review-checks.ts`, `src/reviewer/reviewer-gate.ts`, `src/reviewer/commit-verifier.ts`, `src/cli.ts`, tests

Safety fixes:
1. **Redaction helper** (`reviewer-redaction.ts`): `redactReviewerText` and `redactReviewerList` redact `sk-` tokens, `Bearer` tokens, API key assignments (`KIMI_API_KEY=...`, `OPENAI_API_KEY=...`, `ANTHROPIC_API_KEY=...`, `GITHUB_TOKEN=...`), generic GitHub PATs (`ghp_...`, `github_pat_...`), and `.env`-like secret patterns before inclusion in blocking issues, safety findings, review summary, fix task, or CLI output.
2. **Deterministic checks** now redact typecheck/build/test/gitStatus strings before adding them to `blockingIssues`. Secret detection still runs on raw diff for accuracy, but reported issues use generic labels.
3. **Reviewer gate** (`reviewer-gate.ts`) redacts `blockingIssues` and `safetyFindings` before building `review_summary` and `fix_task`.
4. **Current branch capture** (`commit-verifier.ts`): `getCurrentBranchName` reads branch via `git rev-parse --abbrev-ref HEAD`. `CommitEvidence` includes `currentBranch`. `buildCommitEvidence` populates it.
5. **CLI** (`reviewer-gate-evidence-dry-run`) passes `currentBranch` into `runDeterministicReviewChecks`, prints `Current branch: <branch>`. If branch is `main`, deterministic checks FAIL, reviewer is NOT called, next action is `block_for_human`.
6. **Word-level pass detection**: `looksLikePass` uses word-level matching (`split(/[^a-z0-9]+/)`) to avoid false positives like `token` matching `ok`.

Properties:
- No real provider calls in tests.
- No GitHub API calls.
- No merge, no main touch, no checkout/switch.
- 19 new tests (redaction, current branch, main branch blocking, token redaction in CLI).

### Stage 6.2 — Block State Runner ✅

- **Status:** Implemented and tested.
- **Location:** `src/block/`, `test/block-*.test.ts`, `test/cli-block-state.test.ts`, `docs/block-example.json`
- **Tests:** 75 tests across 5 new test suites

Implementation:
- **Block types** (`block-types.ts`): `BlockTaskStatus`, `BlockStatus`, `BlockDefinition`, `BlockTaskDefinition`, `BlockState`, `BlockTaskState`, `BlockProviderConfig`, `BlockReviewPolicy`.
- **Block loader** (`block-loader.ts`): `loadBlockDefinition(path)` loads and validates JSON block definitions. Rejects missing fields, main work_branch, empty tasks, duplicate task_ids, invalid max_fix_attempts (1–5), missing providers. No provider/git/GitHub calls.
- **Block state manager** (`block-state-manager.ts`): `initBlockState`, `saveBlockState` (atomic temp+rename), `loadBlockState`, `updateBlockState`, `getBlockRunDir`. State stored under `runs/blocks/<block_id>/block-state.json`. Path validation rejects writes outside allowed directory.
- **Block transitions** (`block-transitions.ts`): Pure functions `markTaskInProgress`, `markTaskCoderDone`, `markTaskChecksFailed`, `markTaskCommitted`, `markTaskPushed`, `markTaskWaitingReview`, `markTaskAccepted`, `markTaskRejected`, `markTaskFixRequired`, `markTaskBlocked`. Accepted tasks cannot transition backwards. `markTaskAccepted` advances `current_task_id` or completes block. `markTaskBlocked` sets block status to `blocked`.
- **Block report** (`block-report.ts`): `buildBlockStatusReport` produces markdown with task table, counts, safety note.
- **CLI commands**:
  - `block-init <blockJsonPath>` — loads definition, initializes and saves state.
  - `block-status <blockId>` — loads state, prints markdown report.
  - `block-transition <blockId> <taskId> <transition> [value]` — applies transition and saves state.
- **Example block** (`docs/block-example.json`): 3-task auth block with Kimi coder + reviewer.

Properties:
- No provider calls.
- No git commands.
- No GitHub API calls.
- No apply/commit/push/merge/checkout/main touch.
- State files contain no API keys, provider output, or git credentials.

### Stage 6.2.1 — Block State Fix Loop Hardening ✅

- **Status:** Implemented and tested.
- **Location:** `src/block/block-types.ts`, `src/block/block-state-manager.ts`, `src/block/block-transitions.ts`, `src/block/block-report.ts`, `test/block-*.test.ts`, `test/cli-block-state.test.ts`

Fixes:
1. **`review_policy` stored in `BlockState`**: `initBlockState` copies `definition.review_policy` into state. Old state missing `review_policy` fails safely when transition requires it.
2. **`max_fix_attempts` enforced**: `markTaskFixRequired` uses `state.review_policy.max_fix_attempts`. If `fix_attempts >= max_fix_attempts`, task becomes `blocked`, block status becomes `blocked`, `current_task_id` is cleared.
3. **Stale blocking issues cleared on fix start**: `markTaskInProgress` from `rejected`/`fix_required`/`checks_failed` clears `blocking_issues`, `reviewer_decision`, `reviewer_summary`, `commit_sha`, `pushed_ref`.
4. **Blocked task cannot restart**: `markTaskInProgress` from `blocked` throws error.
5. **Report includes review policy**: `buildBlockStatusReport` shows `max_fix_attempts` and `reviewer_mode`.

Properties:
- No provider calls.
- No git commands.
- No GitHub API calls.
- No apply/commit/push/merge/checkout/main touch.

### Stage 6.3 — Autonomous One-Task Loop

- Wire Kimi coder + Kimi reviewer for a single task.
- Run full loop: coder → apply → checks → commit → push → reviewer → decision.
- Support fix loop: reviewer rejects → repair prompt → coder retry.

### Stage 6.4 — Autonomous Multi-Task Block Runner

- Run multiple tasks in sequence inside one block.
- Advance to next task only on `accepted`.
- Stop on `blocked` or `block_for_human`.

### Stage 6.5 — Fix Loop

- Bounded retry with `max_fix_attempts`.
- Repair prompt includes reviewer feedback + prior attempt context.
- Final failure stops block, writes report.

### Stage 6.6 — Block Completion Report

- Generate human-readable block report.
- Include task list, commit SHAs, reviewer decisions, fix history, safety notes.
- Write to `runs/{block_id}/block-report.md`.

### Stage 6.7 — Live 3-Task Autonomous Demo

- Define a 3-task block in `tasks.yaml`.
- Run end-to-end with real Kimi coder + Kimi reviewer.
- Document results in `AUTONOMOUS_BLOCK_DEMO_REPORT.md`.

### Stage 6 Safety Rules

- Do not implement merge in Stage 6.
- Do not add more demo/docs stages instead of autonomous loop work.
- `main` remains protected by design.
- Possible refactor: extract modules from `src/cli.ts` before adding more commands.
- Merge must not be added without dedicated safety design document.

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
| Phase 4 Stage 4.4 actual push implemented | ✅ |
| Phase 4 Stage 4.4 actual push enabled | Confirmed |
| Phase 4 Stage 4.5 state write after push implemented | ✅ |
| Phase 4 Stage 5.0 unified workflow implemented | ✅ |
| Phase 4 Stage 5.1 real provider integration implemented | ✅ |
| Phase 4 Stage 5.2 self-repair loop implemented | ✅ |
| Phase 4 Stage 5.3 readiness + operator guide implemented | ✅ |
| Phase 4 Stage 5.4 real smoke demo executed | ✅ |
| Phase 4 Stage 5.5 manual approval / PR boundary report implemented | ✅ |
| Phase 4 Stage 5.6 PR readiness / dry-run stub implemented | ✅ |
| Phase 4 Stage 5.7 real PR creation implemented | ✅ |
| Phase 4 Stage 5.8 PR status / checks read-only report implemented | ✅ |
| Phase 4 Stage 5.9 MVP hardening / final documentation | ✅ |
| Phase 4 Stage 5.10 live operator demo evidence pack | ✅ |
| Phase 4 Stage 6.0A product vision / autonomous architecture docs | ✅ |
| Phase 4 Stage 6.0 provider abstraction foundation | ✅ |
| Phase 4 Stage 6.1 deterministic commit verifier / reviewer gate | ✅ |
| Phase 4 Stage 6.1.1 reviewer gate safety hardening | ✅ |
| Phase 4 Stage 6.2 block state runner | ✅ |
| Opt-in flags defined | Confirmed |
