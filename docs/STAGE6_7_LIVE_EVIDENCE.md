# Stage 6.7 Live Evidence — Real Kimi Coder → Real Kimi Reviewer

## Summary

Live one-task autonomous loop was attempted with real Kimi providers. The block definition, safety checks, provider resolution, and HTTP request pipeline all worked correctly. The run stopped at the actual Kimi API call because the `KIMI_API_KEY` in `.env` returned `401 Invalid Authentication`.

This document captures the evidence of the partial run and the exact remediation step needed to complete Stage 6.7.

## Block Definition

- File: `docs/live-stage-6-7-block.json`
- Block ID: `stage-6-7-live-proof`
- Mode: `real_kimi_coder_kimi_reviewer`
- Task: create `docs/live-stage-6-7-proof.md`
- Checks: verify file exists and contains "Stage" and "6.7"
- Safety: `auto_commit=true`, `auto_push=false` (no remote push)

The block definition was committed to `feature/mvp-skeleton` before the live run to satisfy the clean-working-tree safety gate.

## Execution Attempt

Command used (PowerShell):

```powershell
$env:BLOCK_RUN_ONE_MODE="real_kimi_coder_kimi_reviewer"
$env:ALLOW_BLOCK_RUN_ONE="true"
$env:ALLOW_REAL_PROVIDER="true"
$env:ALLOW_REAL_REPO_APPLY="true"
$env:ALLOW_REAL_REPO_COMMIT="true"
$env:ALLOW_REAL_REPO_PUSH="false"
$env:ALLOW_KIMI_REVIEWER="true"
$env:REVIEWER_PROVIDER="kimi"
$env:CODER_PROVIDER="kimi"
npx tsx src/cli.ts block-run-one docs/live-stage-6-7-block.json
```

## Results

### What succeeded

1. Block definition loaded and validated (`loadBlockDefinition`).
2. Block state initialized at `runs/blocks/stage-6-7-live-proof/block-state.json`.
3. Real-mode safety gate passed:
   - Current branch is `feature/mvp-skeleton` (not `main`).
   - Working tree was clean.
   - All required env flags were present.
4. Provider resolution succeeded:
   - `createKimiCoderProvider` was created with runtime-injected API key and base URL.
   - `createKimiReviewerProvider(reviewerConfig, { allowReal: true })` was created.
5. Kimi API request was sent successfully over HTTP to the configured endpoint.

### What failed

The Kimi API responded with `401 Invalid Authentication` for every tested endpoint/model combination:

| Endpoint | Model | Result |
| --- | --- | --- |
| `https://api.moonshot.ai/v1` | `moonshot-v1-8k` | 401 Invalid Authentication |
| `https://api.moonshot.ai/v1` | `kimi-k2.6` | 401 Invalid Authentication |
| `https://api.moonshot.cn/v1` | `moonshot-v1-8k` | 401 Invalid Authentication |
| `https://api.moonshot.cn/v1` | `kimi-k2.6` | 401 Invalid Authentication |
| `https://api.kimi.com/coding/v1` | `kimi-for-coding` | 401 Invalid Authentication / "The API Key appears to be invalid or may have expired" |

Error from the live run:

```
[block-run-one] Error: Kimi coder failed: Invalid KimiOutput mode: expected "file_update", got "undefined"
```

The underlying cause was the API key returning 401. The parse error is a downstream symptom because the response body was an error object, not the expected JSON file-update output.

## State After Attempt

`runs/blocks/stage-6-7-live-proof/block-state.json` was updated to `blocked` with the blocking issue:

> Kimi API returned 401 Invalid Authentication. The KIMI_API_KEY in .env appears to be expired or invalid. Update .env with a valid key and retry.

No files were modified in the working tree, and no commit or push was performed.

## Safety Invariants Verified

- No `git merge` was performed.
- No branch checkout/switch was performed.
- No `main` branch mutation.
- No files outside `allowed_files` were touched.
- No push occurred (`ALLOW_REAL_REPO_PUSH=false`).
- No API key was written to state, logs, or block definition.

## Next Step to Complete Stage 6.7

1. Obtain a valid, unexpired Kimi API key.
2. Update `.env`:
   ```
   KIMI_API_KEY=sk-...
   KIMI_BASE_URL=https://api.moonshot.cn/v1
   KIMI_MODEL=kimi-k2.6
   ```
3. Reset the block state:
   ```bash
   rm runs/blocks/stage-6-7-live-proof/block-state.json
   ```
4. Re-run the same `block-run-one` command.
5. The expected outcome: coder creates `docs/live-stage-6-7-proof.md`, checks pass, commit is created locally, reviewer accepts, and state transitions to `accepted`.

## Evidence Files

- `docs/live-stage-6-7-block.json` — block definition for the live proof
- `runs/blocks/stage-6-7-live-proof/block-state.json` — state recording the blocked attempt
- `docs/STAGE6_7_LIVE_EVIDENCE.md` — this document

## Commit

Block definition committed as `393e5c5`:

```
stage-6.7: add live proof block definition
```

Working tree remains clean after the failed attempt.
