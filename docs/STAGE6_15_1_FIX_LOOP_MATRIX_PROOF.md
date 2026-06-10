# Stage 6.15.1 — Deterministic Real Kimi→Kimi Fix-Loop Trigger Proof

**Date:** 2026-06-09
**Branch:** `feature/mvp-skeleton`
**Block ID:** `stage-6-15-1-fix-loop-trigger-proof`

---

## Root cause

Stage 6.15 proved real Kimi→Kimi one-task success, but did **not** prove the fix loop because the first attempt passed.

Stage 6.15.1 was designed to force deterministic failure on the first attempt by requiring an exact-line marker (`SECOND_ATTEMPT_FIX`) that the initial task instruction told the coder **not** to include.

However, the first live runs revealed a **source code bug**: `runChecks()` captured stdout/stderr in `checkResult.logs`, but `block-one-task-loop.ts` discarded `checkResult.logs` and sent only:

```
Checks failed: node
```

to the coder's fix context. Without the actionable verifier message, the coder could not self-repair.

### Fixes applied

1. **`src/block/block-one-task-loop.ts`** — `buildCheckFailureMessage`
   - Builds raw message from `failedStep.command` + `checkResult.logs`
   - Redacts via `redactReviewerText`
   - Truncates to 4000 chars with `[truncated]` suffix
   - Applied to both check-failure path and apply-error catch

2. **`src/providers/kimi/kimi-coder-provider.ts`** — `buildCoderPrompt`
   - Now includes `# Context` section with `repo_context`
   - This propagates fix attempt metadata (`# Fix Attempt N`, `## Blocking Issues`, `## Check Failure Summary`) to the real Kimi coder

3. **`src/providers/provider-types.ts`** — `ReviewInput`
   - Added optional `previous_failure?: string`

4. **`src/reviewer/review-input-builder.ts`** — `buildReviewInput`
   - Accepts `previousFailure` parameter

5. **`src/reviewer/reviewer-prompt.ts`** — `buildReviewerPrompt`
   - Renders `# Previous Failure` section when present
   - This allows the real Kimi reviewer to understand that a fix attempt is being reviewed, not a first attempt

---

## Scenario A — Real Kimi→Kimi multi-retry success

### Setup

```json
{
  "block_id": "stage-6-15-1-fix-loop-trigger-proof",
  "providers": {
    "coder": { "provider": "kimi", "model": "kimi-k2.6" },
    "reviewer": { "provider": "kimi", "model": "kimi-k2.6" }
  },
  "review_policy": {
    "max_fix_attempts": 2,
    "reviewer_mode": "single"
  },
  "tasks": [
    {
      "task_id": "doc-1",
      "checks": ["node checks/stage-6-15-1-verify.mjs"]
    }
  ]
}
```

Verifier requires exact line `SECOND_ATTEMPT_FIX`.

### Execution

```text
Task doc-1: pending → checks_failed
  Coder called: true
  Reviewer called: false
  Next action: send_fix_to_coder

Task doc-1: checks_failed → accepted
  Coder called: true
  Reviewer called: true
  Commit SHA: 6b3bb7c75e46d1afdaa679cfefde2a94b4332a04
  Reviewer decision: accepted
  Next action: advance_to_next_task
```

### Evidence

- **First attempt:** File created without `SECOND_ATTEMPT_FIX` → verifier exit 1 → rollback.
- **Fix context propagated:**
  ```
  Checks failed: node
  Missing required marker: SECOND_ATTEMPT_FIX. Add this exact marker on its own line in the next fix attempt.
  ```
- **Second attempt:** Coder added `SECOND_ATTEMPT_FIX` on its own line → verifier exit 0 → reviewer called.
- **Reviewer summary:**
  > "The SECOND_ATTEMPT_FIX marker is present in response to the previous check feedback that explicitly required it, satisfying the conditional requirement."

### Result

✅ **Fix loop actually exercised: YES**
- Failed attempts before success: 1
- Final task status: `accepted`
- Final block status: `completed`
- `fix_attempts`: 1
- Commit SHA: `6b3bb7c75e46d1afdaa679cfefde2a94b4332a04`
- Pushed: `false`

---

## Scenario B — max_fix_attempts exhaustion

### Verification

Unit tests in `test/block-one-task-loop.test.ts`:
- `real mode check failure increments fix_attempts`
- `real mode check failure blocks when max_fix_attempts reached`

Fake-mode tests in `test/block-multi-task-loop.test.ts`:
- `stopOnRejected=false retries until max_fix_attempts then blocked`
- `repeated checks_failed blocks at max_fix_attempts`

Result: ✅ **max_fix_attempts enforced: YES**

---

## Scenario C — global cap enforced

`BLOCK_RUN_MAX_TOTAL_ATTEMPTS=5` was set during live run. The block completed in 2 attempts (1 task, 2 total coder calls), well under the cap.

Unit tests verify `BLOCK_RUN_MAX_TASKS` and `BLOCK_RUN_MAX_TOTAL_ATTEMPTS` gate behavior in `test/cli-block-run.test.ts`.

Result: ✅ **Global cap enforced: YES**

---

## Scenario D — redaction / no secret leak

### Test coverage

`test/block-one-task-loop.test.ts`:
- `real mode check failure logs are redacted before storage`
- Inputs: `GITHUB_TOKEN=fake-secret`, `Bearer fake-secret`, `sk-fake-secret`
- Assertions: `[REDACTED]` present, raw secrets absent

`test/block-one-task-loop.test.ts`:
- `redacts sk- tokens in fix context repo_context`
- `redacts Bearer tokens and GITHUB_TOKEN in fix context`

Live run state inspection:
- `blocking_issues` contains redacted text only
- No API keys in block state JSON
- No secrets in `docs/live-stage-6-15-1-proof.md`

Result: ✅ **Redaction verified: YES**

---

## Source fix commits

| Fix | Commit | Files |
|-----|--------|-------|
| Check failure log propagation + truncation + redaction | `f253b62` | `src/block/block-one-task-loop.ts`, `test/block-one-task-loop.test.ts` |
| Include repo_context in Kimi coder prompt | `3d0f0b1` | `src/providers/kimi/kimi-coder-provider.ts` |
| Propagate previous failure to reviewer prompt | `809b743` | `src/providers/provider-types.ts`, `src/reviewer/review-input-builder.ts`, `src/reviewer/reviewer-prompt.ts`, `src/block/block-one-task-loop.ts` |

---

## Safety confirmations

| Check | Result |
|-------|--------|
| No PR created | ✅ |
| No GitHub API call | ✅ |
| No merge | ✅ |
| No auto-merge | ✅ |
| No `main` touch | ✅ |
| No checkout/switch by orchestrator code | ✅ |
| No force push | ✅ |
| No `git reset --hard` | ✅ |
| No `git add -A` | ✅ |
| No token/API key leak in logs/state | ✅ |
| `KIMI_API_KEY` only from env | ✅ |
| No secrets in block JSON | ✅ |
| Push disabled (`ALLOW_REAL_REPO_PUSH=false`) | ✅ |

---

## File produced

**`docs/live-stage-6-15-1-proof.md`**

```markdown
# Stage 6.15.1

FIX_LOOP_TRIGGERED

KIMI_CODER

KIMI_REVIEWER

FINAL_ACCEPTED

SECOND_ATTEMPT_FIX

## Fix Loop Evidence

This document demonstrates the deterministic autonomous fix loop.
```

---

## Final block state

```json
{
  "status": "completed",
  "tasks": [
    {
      "task_id": "doc-1",
      "status": "accepted",
      "current_attempt": 2,
      "fix_attempts": 1,
      "commit_sha": "6b3bb7c75e46d1afdaa679cfefde2a94b4332a04",
      "reviewer_decision": "accepted",
      "blocking_issues": []
    }
  ]
}
```
