# Phase 4 Real Repo Apply Plan

**Status:** planning only  
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

### Stage 4.1 — Dry-Run Command

- Create a CLI command (e.g., `real-repo-apply-dry-run <taskId>`).
- **No file writes.**
- Load task, parse provider output, run guardrails.
- Print proposed target files, line deltas, and safety check results.
- Output must include safety messages: `No files were modified`, `No commit was made`, `No push was performed`.

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

- `validateRealRepoApplySafety(task, repoStatus)` — pure helper that validates all preconditions before any write.

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

## 8. Recommended First Implementation Task

After this plan is accepted, the first implementation task should be:

> **Add `validateRealRepoApplySafety(task, repoStatus)`**

A pure helper function that checks:

- Working tree is clean (`repoStatus.isClean === true`).
- Current branch is not `main` (`repoStatus.currentBranch !== 'main'`).
- `task.work_branch` exists and is not empty.
- `task.work_branch` is not `main`.
- `task.guardrails.auto_commit === false`.
- `task.guardrails.auto_push === false`.
- `task.guardrails.auto_merge === false`.

This helper must:
- Return `ValidationResult` (`{ ok: boolean; reason?: string }`).
- Be 100% pure (no file mutation, no network, no API keys).
- Be unit-testable in isolation.

> **This helper is documented here but must not be implemented in this planning commit.**

---

## 9. Sign-Off

| Check | Status |
|-------|--------|
| Phase 4 is planning only | Confirmed |
| No runtime code changes | Confirmed |
| Real repo apply remains disabled | Confirmed |
| No push / no merge / no main touch | Confirmed |
| Opt-in flags defined | Confirmed |
