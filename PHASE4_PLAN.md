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

### Stage 6.3.1 — Safe One-Task Loop Rewrite ✅

**Status:** Implemented.

**What was built:**
- `src/block/block-runner-types.ts` — input/output types for the one-task loop
- `src/block/block-task-runner.ts` — task runner helpers: `getCurrentBlockTaskDefinition`, `buildCoderInputFromBlockTask`, `buildTaskGuardrailsFromBlockTask`, `resolveCoderAndReviewerProviders`
- `src/block/block-one-task-loop.ts` — `runOneTaskLoop`: safe fake-mode-only pipeline
- `block-run-one <blockJsonPath>` CLI command

**Pipeline (fake mode only):**
1. Load block definition and state
2. Mark current task `in_progress`
3. Call coder provider (fake by default)
4. Validate output with guardrails (path-only, no filesystem mutation)
5. **Simulate** checks, commit, evidence — no real repo mutation
6. Run deterministic review checks
7. Call reviewer gate (fake reviewer by default)
8. Update block state based on decision (`accepted`, `fix_required`, or `blocked`)

**Fake mode guarantees:**
- No `applyFileUpdates`, `rollbackFileUpdates`, `runChecks` on real repo
- No `git add`, `git commit`, `git push`, `git reset`, `git config`, `git checkout`
- Commit SHA is deterministic fake (`f`.repeat(40))
- Evidence is simulated from coder result, not read from git
- Only real filesystem write: block state save

**Real mode:** Fails safely before provider call or mutation. Requires `ALLOW_BLOCK_RUN_ONE=true`, `ALLOW_REAL_PROVIDER=true`, `ALLOW_REAL_REPO_APPLY=true`, `ALLOW_REAL_REPO_COMMIT=true`, and `ALLOW_KIMI_REVIEWER=true` (for Kimi reviewer). Real repo mutation is NOT implemented in Stage 6.3.1 — it will be added in a dedicated real-mode substage.

**Safety:**
- No merge, no checkout, no main touch, no force push, no auto-merge
- No `git add -A`
- No `git reset --hard`
- Guardrails before simulation
- Deterministic severe findings → `block_for_human` without AI review

**Tests:** 37 tests across `test/block-task-runner.test.ts` (9), `test/block-one-task-loop.test.ts` (15), `test/cli-block-run-one.test.ts` (9).

### Stage 6.4 — Safe Multi-Task Fake Block Loop ✅

**Status:** Implemented.

**What was built:**
- `src/block/block-multi-runner-types.ts` — `MultiTaskLoopInput`, `MultiTaskLoopResult`
- `src/block/block-multi-task-loop.ts` — `runMultiTaskFakeLoop`: safe fake multi-task orchestration
- `block-run <blockJsonPath>` CLI command

**Behavior:**
1. Load block definition
2. Initialize block state if missing
3. Loop while block not completed/blocked and tasks remain
4. Call existing safe fake `runOneTaskLoop` for each task
5. Stop on `maxTasksPerRun`, `fix_required` (if `stopOnRejected`), or `blocked` (if `stopOnBlocked`)
6. Return summary with counts

**Safety:**
- `maxTasksPerRun` bounded (1–100)
- `stopOnRejected` / `stopOnBlocked` prevent runaway loops
- If `stopOnRejected=false` and task remains `fix_required`, loop stops anyway to avoid infinite loops
- Only fake providers
- No real repo mutation
- No git commands
- No GitHub API

**Tests:** 34 tests across `test/block-multi-task-loop.test.ts` (20), `test/cli-block-run.test.ts` (14).

### Stage 6.5 — Real Kimi Coder + Fake Reviewer One-Task Loop ✅

- Real Kimi coder provider call (credentials from env only)
- Fake reviewer (deterministic gate + fake provider)
- Real file apply, check, commit on work branch
- Optional push (`ALLOW_REAL_REPO_PUSH`)
- Strict allow flags before any mutation
- Branch safety and dirty repo protection
- `real_kimi_coder_kimi_reviewer` explicitly rejected
- API keys never stored in block JSON
- Push state recorded in block state when push succeeds

**Files:**
- `src/block/block-real-mode-safety.ts` — pure safety validation
- `src/block/block-real-mode-git.ts` — git helpers (`stageOnlyFiles`, `commitStagedChanges`, `pushCurrentBranch`, `assertNoUnrelatedChanges`)
- `src/block/block-one-task-loop.ts` — wired real mode, push state recording
- `src/block/block-task-runner.ts` — `convertBlockChecks`, `buildProviderConfigForRuntime`
- `src/block/block-loader.ts` — rejects `apiKey` in block JSON
- `test/block-real-mode-safety.test.ts` (14 tests)
- `test/block-real-mode-git.test.ts` (12 tests)
- `test/block-one-task-loop.test.ts` (+19 real mode tests)
- `test/cli-block-run-one.test.ts` (+2 tests)
- `test/block-loader.test.ts` (+3 tests)
- `test/block-task-runner.test.ts` (+8 tests)

**Safety:**
- No `git add -A`
- No `git reset --hard`
- No real reviewer call
- No merge, no PR, no checkout/switch, no main touch
- API keys rejected in block JSON
- `KIMI_API_KEY` loaded from env at runtime
- Missing key fails safely before provider call
- Tests use temp git repos + injected fake `fetch` — no real API calls

### Stage 6.6 — Real Kimi Reviewer Gate ✅

- Real Kimi coder + real Kimi reviewer one-task loop
- Deterministic checks gate before reviewer call — reviewer NOT called if deterministic checks fail
- Provider config resolved BEFORE `markTaskInProgress` — missing `KIMI_API_KEY` fails before state mutation
- Requires `ALLOW_KIMI_REVIEWER=true`, `REVIEWER_PROVIDER=kimi`, `CODER_PROVIDER=kimi`
- Invalid reviewer schema or API failure throws safely without corrupting committed state
- Push state recording same as Stage 6.5

**Files:**
- `src/block/block-one-task-loop.ts` — preflight provider resolution before state mutation, removed Stage 6.5 rejection
- `src/block/block-real-mode-safety.ts` — `real_kimi_coder_kimi_reviewer` validation with `ALLOW_KIMI_REVIEWER` + `reviewerProvider=kimi` + `coderProvider=kimi`
- `src/block/block-task-runner.ts` — `createKimiReviewerProvider` with `allowReal: true`
- `test/block-one-task-loop.test.ts` — 9 new tests for real Kimi reviewer mode
- `test/block-real-mode-safety.test.ts` — 6 new tests for kimi_reviewer safety validation
- `test/block-task-runner.test.ts` — 6 new tests for reviewer runtime config
- `test/cli-block-run-one.test.ts` — 1 new test for missing ALLOW_KIMI_REVIEWER

**Safety:**
- No real Kimi calls in tests (injected fake fetch)
- No `git add -A`, no `git reset --hard`
- No merge, no PR, no checkout/switch, no main touch
- API keys rejected in block JSON
- `KIMI_API_KEY` loaded from env at runtime

### Stage 6.7 — Live 3-Task Autonomous Demo

- Define a 3-task block in `tasks.yaml`.
- Run end-to-end with real Kimi coder + Kimi reviewer.
- Document results in `AUTONOMOUS_BLOCK_DEMO_REPORT.md`.

### Stage 6.8 — Safe Real Multi-Task Kimi→Kimi Block Loop ✅

- Extend `MultiTaskLoopMode` and input types for real modes.
- Implement `runMultiTaskLoop` with `maxTasksPerRun <= 3`, push rejection, explicit allow flag validation.
- Update CLI `block-run` with mode validation and safety bounds.
- Live proof: 3 doc-only tasks accepted by real Kimi coder + real Kimi reviewer, block completed, no push/merge/PR.

### Stage 6.8.1 — Evidence Docs Cleanup ✅

- Correct `docs/stage-6-8-doc-3.md` to reflect actual Stage 6.8 results (3 accepted tasks, real commit SHAs).
- Remove fake hashes, skipped/rejected contradictions.
- No code changes.

### Stage 6.9 — PR-ready Human Approval Package ✅

**Status:** Implemented and tested.

**Goal:** Generate a read-only markdown approval report from block definition + block state. Report is for human review before manual PR creation. No provider calls, no GitHub API, no git mutation, no PR creation, no push, no merge, no checkout/switch, no main touch.

**Files:**
- `src/block/block-approval-report.ts` — `generateBlockApprovalReport(input)` reads block definition and state, computes `pr_ready` boolean, gathers changed files from git (read-only diff), builds markdown report with secret redaction, writes report to `runs/blocks/<block_id>/approval-report.md` (or custom path under allowed directories).
- `src/cli.ts` — `block-approval-report <blockJsonPath>` CLI command with optional `BLOCK_APPROVAL_REPORT_OUTPUT` and `BLOCK_APPROVAL_INCLUDE_DIFF_SUMMARY` env vars.
- `test/block-approval-report.test.ts` — 24 unit tests covering `pr_ready` logic, report content, secret redaction, path safety, read-only behavior.

**Report sections:**
- Summary (block ID, title, branch, status, PR-ready yes/no)
- Task Results table (task ID, status, commit SHA, reviewer decision, fix attempts, blocking issues, summary)
- Commit Evidence (list of commit SHAs)
- File Scope (allowed files, denied files, actually changed files, optional git diff stat)
- Safety Checklist (no auto-merge, no PR creation, no main touch, no checkout, no force push, no API keys)
- Human Decision (PR-ready or not with reasons)
- Manual Next Commands (git status, git log, git diff suggestions)

**`pr_ready` rules:**
- Block status must be `completed`
- All tasks must be `accepted`
- Every accepted task must have a `commit_sha`
- No tasks with `fix_required`, `blocked`, or `checks_failed`
- `current_task_id` must be `null`
- `work_branch` must not be `main`
- No secrets detected in block state or definition

**Safety:**
- Read-only except report file write.
- No provider calls.
- No GitHub API.
- No PR creation.
- No merge.
- No push.
- No checkout/switch.
- No main touch.
- Secret redaction via `redactReviewerText` (sk-, Bearer, KIMI_API_KEY, GITHUB_TOKEN, etc.).
- Output path restricted to `runs/blocks/`, cwd, or system tmpdir.

**Tests:** 24 tests, all pass. Total suite: 1492 tests, 93 suites, 0 failures.

### Stage 6.10 — Manual PR Draft Package / PR Body Generator ✅

**Status:** Implemented and tested.

**Goal:** Generate a safe manual PR draft package (`pr-title.txt`, `pr-body.md`, `manual-pr-checklist.md`) from block definition and block state. This stage does NOT create a PR.

**Files:**
- `src/block/block-pr-draft.ts` — `generateBlockPrDraft(input)` reuses `analyzeBlockForPrReadiness` from `block-approval-report.ts` to avoid logic duplication. Generates title, body, and checklist with secret redaction.
- `src/cli.ts` — `block-pr-draft <blockJsonPath>` CLI command with optional `BLOCK_PR_DRAFT_OUTPUT_DIR` and `BLOCK_PR_DRAFT_INCLUDE_DIFF_STAT` env vars.
- `test/block-pr-draft.test.ts` — 32 unit tests covering PR-ready wording, title limits, body sections, checklist items, secret redaction, path safety.
- `test/cli-block-pr-draft.test.ts` — 19 CLI tests covering missing args, PR-ready output, custom env, no API key leak, no stack trace, safety messages.
- `docs/STAGE6_10_PR_DRAFT_EXAMPLE.md` — example generated draft with placeholder SHAs and clear safety notes.

**PR draft sections:**
- PR-ready or NOT PR-READY header
- Summary (block ID, title, branches, status)
- What Changed (changed files, optional diff stat)
- Task Results table (task ID, title, status, commit SHA, reviewer decision, pushed ref)
- Commit Evidence (list of SHAs)
- Test Evidence (typecheck/build/tests/CI — CI explicitly marked as not verified unless available)
- Safety Checklist (no auto-merge, no PR creation/update, no push, no checkout, no main touch, no provider call, no GitHub API call, no secrets)
- Risks / Reviewer Notes (blocking issues or "Human review is still required")
- Manual Next Steps (`git status`, `git log`, `git diff` as text only)

**Safety:**
- Read-only except draft file writes.
- No provider calls, no GitHub API, no PR creation/update, no push/merge/checkout/main touch.
- Secret redaction on all files; safety finding recorded if redaction occurs.
- Output directory restricted to `runs/blocks/`, cwd, or system tmpdir via `isPathInside`.
- Prefix bypass (`/repo` → `/repo-evil`) rejected.

**Tests:** 51 new tests (32 unit + 19 CLI). Total suite: 1561 tests, 96 suites, 0 failures.

### Stage 6.11 — Optional Manual PR Creation Helper ✅

**Status:** Implemented and tested.

**Goal:** Create a draft GitHub Pull Request from a completed, PR-ready block, strictly gated by opt-in flags and safety prerequisites.

**Files:**
- `src/block/block-pr-create.ts` — `createBlockPullRequest(input)` with opt-in checks, PR readiness verification, branch pushed check (`git ls-remote`), duplicate protection, dry-run mode, and GitHub API POST for draft PR creation.
- `src/cli.ts` — `block-pr-create <blockJsonPath>` CLI command with env flags.
- `test/block-pr-create.test.ts` — 37 unit tests covering opt-in blocks, PR readiness checks, secret detection, branch push verification, duplicate protection, dry-run, fake GitHub API success/failure/malformed response.
- `test/cli-block-pr-create.test.ts` — 19 CLI tests covering missing args, dry-run output, missing flags/token/repo, missing draft package, not-PR-ready body, token leak prevention, stack trace prevention, safety messages.
- `docs/STAGE6_11_PR_CREATE_EXAMPLE.md` — example documentation with required flags, prerequisites, dry-run example, successful fake response, safety invariants.

**Safety:**
- Requires `ALLOW_BLOCK_PR_CREATE=true` + `ALLOW_GITHUB_PR_CREATE=true` + `GITHUB_TOKEN` + `GITHUB_REPOSITORY`.
- Verifies block completed, all tasks accepted with commit SHAs and pushed refs, work branch not main, branch already pushed.
- Requires PR draft package and approval report (unless override).
- Rejects creation if PR body says `NOT PR-READY` or contains secrets.
- Checks existing open PR via GitHub API GET before POST.
- Duplicate protection: existing `pr-created.json` blocks second creation by default.
- Always creates `draft: true` PR; no auto-merge, no reviewers, no labels.
- No provider calls, no push, no merge, no checkout/switch, no main touch, no PR update/comment/close.
- `GITHUB_TOKEN` never printed or persisted.

**Tests:** 56 new tests (37 unit + 19 CLI). Total suite: 1617 tests, 98 suites, 0 failures.

### Stage 6.11.1 — Live Draft PR Proof ✅

**Status:** Evidence documented.

**Goal:** Prove that `block-pr-create` can create a real GitHub draft PR end-to-end on a live branch.

**What was done:**
1. Created proof branch `stage-6-11-pr-create-proof` from `feature/mvp-skeleton`.
2. Added proof file `docs/stage-6-11-pr-create-proof.md`.
3. Created block definition `docs/stage-6-11-pr-create-proof-block.json` pointing to commit `a9e967128918e908e62e3ca452dd93baec8b5488`.
4. Generated approval report (`PR-ready: yes`) and PR draft package (`PR-ready: yes`).
5. Ran dry-run (`BLOCK_PR_CREATE_DRY_RUN=true`) — passed all checks.
6. Ran real creation with:
   - `ALLOW_BLOCK_PR_CREATE=true`
   - `ALLOW_GITHUB_PR_CREATE=true`
   - `GITHUB_TOKEN=...`
   - `GITHUB_REPOSITORY=Mellowin/AI-orchestrator`
7. Draft PR #2 created successfully:
   - URL: `https://github.com/Mellowin/AI-orchestrator/pull/2`
   - Base: `feature/mvp-skeleton`
   - Head: `stage-6-11-pr-create-proof`
   - Draft: `true`
   - Output: `runs/blocks/stage-6-11-pr-create-proof/pr-created.json`

**Safety confirmations:**
- PR created as draft (`draft: true`)
- `main` untouched
- No merge performed, no auto-merge enabled
- No push, no checkout, no provider call by `block-pr-create`
- No token leak in logs or output files
- PR left open for human decision

**Files:**
- `docs/STAGE6_11_LIVE_PR_PROOF.md` — this evidence document.
- `docs/stage-6-11-pr-create-proof.md` — proof file on proof branch.
- `docs/stage-6-11-pr-create-proof-block.json` — block definition.
- `runs/blocks/stage-6-11-pr-create-proof/pr-created.json` — creation record.

### Stage 6.11.2 — PR Body Wording Hardening ✅

**Status:** Implemented and tested.

**Goal:** Fix misleading wording in generated PR body so it remains accurate both before and after `block-pr-create` creates a real draft PR.

**Problem:** The previous generated `pr-body.md` contained phrases like "No PR was created by this tool" and "no PR was created automatically." These were true before PR creation but became misleading after `block-pr-create` used the same body inside a real draft PR.

**Changes:**
- `src/block/block-pr-draft.ts`:
  - Safety checklist now says "No PR creation was performed by this draft package" instead of "No PR was created by this tool."
  - Safety checklist now says "No provider call was made by this draft package" and "No GitHub API call was made by this draft package."
  - Footer now reads: "*This PR body was generated by the PR draft package. PR creation, if performed, is handled only by the separate explicitly gated `block-pr-create` command.*"
  - Removed "Open a PR manually in GitHub UI if this package looks correct."
- `test/block-pr-draft.test.ts`:
  - Updated safety checklist assertions to match new wording.
  - Added test: body does NOT contain old misleading phrases.
  - Added test: body contains `separate explicitly gated` and `block-pr-create`.
  - Added test: body hardening wording stays valid after PR creation.
- Docs updated: `STAGE6_10_PR_DRAFT_EXAMPLE.md`, `STAGE6_11_LIVE_PR_PROOF.md`, `COMMAND_REFERENCE.md`, `SAFETY_MODEL.md`.

**Safety:**
- No GitHub API call.
- No PR creation, update, close, or merge.
- No provider call.
- No push, no checkout, no main touch.
- Wording-only change; no runtime behavior change.

**Tests:** 1 new test. Total suite: 1618 tests, 98 suites, 0 failures.

### Stage 6.12 — PR Status Monitoring for Block PR ✅ (accepted with caveat)

**Status:** Implemented and tested. Accepted with caveat: Kimi live proof was mock-based due to GitHub 403 rate limit. PR #2 state independently verified externally.

**Goal:** Add a read-only PR status monitor for PRs created by Stage 6.11.

**What was done:**
1. Created `src/block/block-pr-status.ts` with `getBlockPrStatus(input)`:
   - Reads block definition, block state, and `pr-created.json`
   - Calls GitHub API GET `/pulls/{number}` and `/commits/{ref}/check-runs`
   - Evaluates PR safety: merged, closed, non-draft, branch mismatch, head=main, checks failure
   - Generates `pr-status-report.md` with summary, branch verification, safety findings, no-mutation statement
2. Added `block-pr-status <blockJsonPath>` CLI command in `src/cli.ts`.
3. Added 25 unit tests in `test/block-pr-status.test.ts` covering:
   - PR status fetch, open draft acceptance, merged/closed/non-draft flags
   - Wrong base/head flags, head=main flag
   - Missing/malformed pr-created.json, malformed GitHub response
   - checks_status success/failure/pending/unknown
   - Report generation, no mutation claims, no token leak
4. Added 17 CLI tests in `test/cli-block-pr-status.test.ts` covering:
   - Missing args/flags, successful status output, custom PR number/output path
   - No token leak, no stack trace, safety messages
5. Live proof on PR #2 using known state (GitHub API rate limit was exceeded during proof; mock response with exact PR #2 data was used).
6. Added mock support for tests: `MOCK_GITHUB_PR_STATUS_RESPONSE` and `MOCK_GITHUB_PR_STATUS_CHECKS_RESPONSE`.

**Caveat:**
- Kimi live proof was mock-based, not a real authenticated GitHub API proof.
- GitHub CI/checks status remains unknown; workflow runs are empty.

**Safety:**
- No POST/PATCH/PUT/DELETE to GitHub API.
- No PR creation, update, close, merge, comment, review approval.
- No push, no checkout/switch, no main touch.
- No provider call.
- `GITHUB_TOKEN` never printed or persisted.
- Output path restricted to `runs/blocks/`, cwd, or tmpdir.

**Tests:** 42 new tests (25 unit + 17 CLI). Total suite: 1660 tests, 100 suites, 0 failures.

### Stage 6.12.1 — PR Status Monitor Live-Proof Hardening ✅

**Status:** Implemented and tested.

**Goal:** Distinguish real GitHub API proof from mock-based proof in code, CLI output, reports, and docs.

**Changes:**
1. `src/block/block-pr-status.ts`:
   - Added `source_mode`, `github_api_verified`, `mock_used` to `BlockPrStatusResult`
   - Detects `MOCK_GITHUB_PR_STATUS_RESPONSE` env var and sets `source_mode: 'mock'`
   - Adds safety finding when mock is used: "PR status came from mock response; real GitHub API status was not verified by this run"
   - Report includes Source mode, GitHub API verified, Mock used fields
   - Mock report includes warning: "Mock-based status proof. Real GitHub API was not verified by this run."
2. `src/cli.ts`:
   - Prints `Source mode`, `GitHub API verified`, `Mock used` fields
   - Prints warning when mock is used
3. Tests updated:
   - Unit: real fetch sets `github_api`, mock sets `mock`, mock adds safety finding, report fields, mock warning
   - CLI: mock prints Source mode mock, warning, GitHub API verified no, Mock used yes
4. Docs updated:
   - `STAGE6_12_PR_STATUS_MONITORING.md`: explicit mock/live distinction, caveat section
   - `PHASE4_PLAN.md`: Stage 6.12 accepted with caveat, Stage 6.12.1 source-mode hardening
   - `TESTING_SUMMARY.md`: no "Green CI" claim, "Local tests" used instead
   - `COMMAND_REFERENCE.md`, `SAFETY_MODEL.md`: source_mode behavior documented

**Tests:** 8 new tests (4 unit + 4 CLI). Total suite: 1667 tests, 100 suites, 0 failures.

### Stage 6.12.2 — Testing Metrics Reconciliation ✅

**Status:** Implemented.

**Goal:** Reconcile `TESTING_SUMMARY.md` and `PHASE4_PLAN.md` test counts with actual `npm test` output. No source or test code changes.

**Changes:**
1. `TESTING_SUMMARY.md`:
   - Corrected total tests: 1668 → 1667
   - Corrected total suites: 98 → 100
   - Added Stage 6.12.2 entry
   - Last verified commit set to pending until final commit
2. `PHASE4_PLAN.md`:
   - Corrected Stage 6.12.1 total suite: 1668 → 1667
   - Added Stage 6.12.2 section

**Tests:** 0 new tests. Total suite: 1667 tests, 100 suites, 0 failures.

### Stage 6.13 — Proof PR Cleanup Helper ✅

**Status:** Implemented and tested.

**Goal:** Add a strictly gated cleanup helper for proof PR branches created during live proof stages.

**Changes:**
1. `src/block/block-pr-cleanup.ts`:
   - `cleanupBlockProofPr` reads PR status, verifies it is the expected proof PR
   - Optional close PR via PATCH `/pulls/{number}` (requires `ALLOW_GITHUB_PR_CLOSE=true`)
   - Optional delete branch via DELETE `/git/refs/heads/{branch}` (requires `ALLOW_GITHUB_BRANCH_DELETE=true`)
   - Dry-run by default
   - Safety gates: merged PR, base/head mismatch, head/main, base/main unexpectedly, non-proof-like branch name
   - Failed close prevents branch deletion
   - Writes `pr-cleanup-report.md`
2. `src/cli.ts`:
   - Added `block-pr-cleanup <blockJsonPath>` command
   - Reads env: `BLOCK_PR_NUMBER`, `BLOCK_PR_CLEANUP_DRY_RUN`, `BLOCK_PR_CLEANUP_CLOSE_PR`, `BLOCK_PR_CLEANUP_DELETE_BRANCH`, `BLOCK_PR_CLEANUP_OUTPUT`
   - Prints all result fields + safety messages
3. Tests:
   - `test/block-pr-cleanup.test.ts`: 27 unit tests
   - `test/cli-block-pr-cleanup.test.ts`: 16 CLI tests
4. Docs:
   - `docs/STAGE6_13_PR_CLEANUP_HELPER.md`
   - `COMMAND_REFERENCE.md`, `SAFETY_MODEL.md` updated

**Tests:** 43 new tests (27 unit + 16 CLI). Total suite: 1710 tests, 102 suites, 0 failures.

### Stage 6.13.1 — PR Cleanup Branch Deletion Safety Hardening ✅

**Status:** Implemented and tested.

**Goal:** Harden cleanup helper so it cannot delete the proof branch while the PR is still open unless the same command also closes the PR.

**Changes:**
1. `src/block/block-pr-cleanup.ts`:
   - Added blocking issue when `deleteBranch=true`, PR state is `open`, and `closePr` is not requested
   - Close PR first, then delete branch when both are requested and PR is open
   - If close fails, branch deletion is skipped
   - Report includes `Branch delete requires PR closed or same-command close: PASS/FAIL`
2. Tests:
   - `test/block-pr-cleanup.test.ts`: +7 unit tests
   - `test/cli-block-pr-cleanup.test.ts`: +6 CLI tests
3. Docs updated:
   - `docs/STAGE6_13_PR_CLEANUP_HELPER.md`, `COMMAND_REFERENCE.md`, `SAFETY_MODEL.md`

**Tests:** 13 new tests (7 unit + 6 CLI). Total suite: 1723 tests, 102 suites, 0 failures.

### Stage 6.13.2 — Cleanup Dry-Run Proof ✅

**Status:** Evidence documented.

**Goal:** Run and document a dry-run cleanup proof for PR #2 using the Stage 6.13 cleanup helper.

**Proof performed:**
- Scenario A: read-only dry-run, no actions → cleanup safe: yes, no blocking issues
- Scenario B: dry-run delete branch only → cleanup safe: no, blocked by open-PR branch deletion rule
- Scenario C: dry-run close + delete → cleanup safe: yes, dry-run safety findings for both actions
- All scenarios used mock response to avoid unauthenticated rate limits
- PR #2 remains open after all scenarios
- Proof branch `stage-6-11-pr-create-proof` remains on remote after all scenarios

**Evidence doc:** `docs/STAGE6_13_CLEANUP_DRY_RUN_PROOF.md`

**Tests:** 0 new tests. Total suite: 1723 tests, 102 suites, 0 failures.

### Stage 6.13.3 — Real Cleanup of Proof PR #2 ✅

**Status:** Completed and verified.

**Goal:** Perform real cleanup of Stage 6.11/6.12 proof artifacts.

**Actions performed:**
1. Final dry-run: cleanup safe=yes, no blocking issues
2. Real cleanup via `block-pr-cleanup`:
   - Closed draft PR #2 (state: closed, merged: false)
   - Deleted remote proof branch `stage-6-11-pr-create-proof`
3. Verified PR #2 is closed and branch no longer exists on origin

**Evidence doc:** `docs/STAGE6_13_REAL_CLEANUP_EVIDENCE.md`

**Tests:** 0 new tests. Total suite: 1723 tests, 102 suites, 0 failures.

### Stage 6.14.1 — Fix Loop Attempt Enforcement and Redaction Hardening ✅

**Status:** Implemented and verified.

**Accepted implementation commit:** `d67c4845ba1fbe79d53b48592150f41cc7d1cacc`

**Changes:**
1. **One-task loop is single attempt only.** Removed `maxAttempts` from `OneTaskLoopInput` and `BLOCK_RUN_ONE_MAX_ATTEMPTS` from CLI. `block-run-one` runs exactly one coder→reviewer cycle.
2. **Multi-task loop owns retries.** `block-run` controls the autonomous fix loop via `BLOCK_RUN_MAX_TOTAL_ATTEMPTS`.
3. **`checks_failed` increments `fix_attempts`.** `markTaskChecksFailed` now increments `fix_attempts` and respects `review_policy.max_fix_attempts`, mirroring `markTaskFixRequired`.
4. **`checks_failed` blocks at limit.** When `fix_attempts >= max_fix_attempts`, the task and block become `blocked` and `current_task_id` is cleared.
5. **Fix context is redacted before coder prompt.** `buildCoderInputFromBlockTask` applies `redactReviewerText`/`redactReviewerList` to `reviewerSummary`, `fixTask`, `blockingIssues`, and `checkFailureSummary` before building the coder `repo_context`.
6. **Fake provider sequential response indexes fixed.** `fake-coder-provider` and `fake-reviewer-provider` now use shared mutable indexes on `options` (`taskResponseIndex`, `fixResponseIndex`, `decisionIndex`) so multi-task loops correctly consume sequential responses across provider instances.

**Test impact:**
- New block-transitions tests: `markTaskChecksFailed` increments `fix_attempts`, redacts blocking issues, blocks at `max_fix_attempts`.
- New block-one-task-loop tests: check failure increments `fix_attempts`, blocks at limit, redacts `sk-`/`Bearer`/`GITHUB_TOKEN` in fix context.
- New block-multi-task-loop tests: `checks_failed` retries same task, blocks at max, accepted after check-fix advances to next task.
- Full suite after implementation: **1734 tests, 102 suites, 0 failures.**

**Stage 6.15 — Real Kimi→Kimi Autonomous Block Run Live Proof ✅**

- Live proof with real Kimi coder + real Kimi reviewer on one-task block.
- First-attempt success path verified.
- Commit `e639bbe28806cdff76fcdb43e6d03bd167a104af` created `docs/live-stage-6-15-proof.md`.
- No push, no merge, no main touch.
- Evidence: `STAGE6_LIVE_PROOF.md`.

**Stage 6.15.1 — Deterministic Real Kimi→Kimi Fix-Loop Trigger Proof ✅**

- Forced deterministic first-attempt failure via exact-line verifier (`SECOND_ATTEMPT_FIX`).
- Source fixes applied to propagate check failure logs into coder/reviewer fix context:
  - `buildCheckFailureMessage` with redaction + 4000-char truncation in `block-one-task-loop.ts`
  - `repo_context` included in Kimi coder prompt
  - `previous_failure` propagated to reviewer prompt
- Second attempt: coder received actionable check message, added missing marker, checks passed, reviewer accepted.
- Commit `6b3bb7c75e46d1afdaa679cfefde2a94b4332a04` created `docs/live-stage-6-15-1-proof.md`.
- Block state: `completed`, `fix_attempts: 1`, `reviewer_decision: accepted`.
- Evidence: `STAGE6_15_1_FIX_LOOP_MATRIX_PROOF.md`.

**Stage 6.15.2 — Full Multi-Scenario Fix-Loop Matrix Proof ✅**

- Scenario A (live): Real Kimi→Kimi with 2 failed attempts before acceptance.
- Scenario B (fake API): `max_fix_attempts=2` exhaustion → task blocked.
- Scenario C (fake API): `maxTotalAttemptsPerRun=2` global cap → loop stops safely, state resumable.
- Evidence: `STAGE6_15_2_FULL_FIX_LOOP_MATRIX_PROOF.md`.

**Next possible stage:** Stage 6.17 — Operator-ready runbook and demo package.

**Stage 6.16 — Real Kimi Multi-Task Block with One Fix Loop ✅**

- Real Kimi→Kimi autonomous multi-task block executed end-to-end.
- Task doc-1 accepted on first attempt.
- Task doc-2 went through fix-loop: `pending → checks_failed → accepted`.
- Task doc-3 accepted on first attempt.
- Final block status: `completed`.
- Evidence: `docs/STAGE6_16_REAL_MULTITASK_BLOCK_PROOF.md`.

**Stage 6.17 — Operator-Ready Runbook and Demo Package ✅**

- Documentation-only stage. No source/test changes.
- Created: `OPERATOR_RUNBOOK.md`, `MINI_MVP_DEMO_PACKAGE.md`, `DEMO_COMMAND_COOKBOOK.md`, `SAFETY_INVARIANTS.md`.
- Updated: `README.md`, `PHASE4_PLAN.md`, `TESTING_SUMMARY.md`.
- Purpose: package proven MVP so operators can run and verify without prior knowledge.

**Stage 6.18 — Mini-MVP Release Candidate Audit ✅**

- Documentation-only stage. No source/test changes.
- Verified no placeholders remain.
- Verified no raw secrets in docs.
- Verified command cookbook safety.
- Verified stage hashes and proof claims.
- Audit status: **PASS**.
- Evidence: `docs/STAGE6_18_RELEASE_CANDIDATE_AUDIT.md`.

**Stage 6.19 — Final Human Review / Manual PR Package ✅**

- Documentation-only stage. No source/test changes.
- Created: `docs/FINAL_HUMAN_REVIEW_PACKAGE.md`, `docs/MANUAL_PR_BODY.md`, `docs/MINI_MVP_RELEASE_NOTES.md`.
- Updated: `README.md`, `PHASE4_PLAN.md`, `TESTING_SUMMARY.md`.
- Purpose: provide a ready-to-review package for human decision before any PR is opened.

### Stage 6 Safety Rules

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
| Phase 4 Stage 6.8 safe real multi-task Kimi→Kimi block loop | ✅ |
| Phase 4 Stage 6.8.1 evidence docs cleanup | ✅ |
| Phase 4 Stage 6.14.1 fix loop attempt enforcement and redaction hardening | ✅ |
| Phase 4 Stage 6.15 real Kimi→Kimi autonomous block run live proof | ✅ |
| Phase 4 Stage 6.15.1 deterministic real Kimi→Kimi fix-loop trigger proof | ✅ |
| Phase 4 Stage 6.15.2 full multi-scenario fix-loop matrix proof | ✅ |
| Phase 4 Stage 6.16 real Kimi multi-task block with one fix loop | ✅ |
| Phase 4 Stage 6.17 operator-ready runbook and demo package | ✅ |
| Phase 4 Stage 6.18 mini-MVP release candidate audit | ✅ |
| Phase 4 Stage 6.19 final human review / manual PR package | ✅ |
| Opt-in flags defined | Confirmed |
