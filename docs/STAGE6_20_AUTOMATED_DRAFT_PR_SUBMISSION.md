# Stage 6.20 — Automated Draft PR Submission Flow

**Date:** 2026-06-10
**Branch:** `feature/mvp-skeleton`
**Status:** Implemented and tested

---

## Purpose

Automate the final PR creation step after a completed block.

Before this stage, the operator had to manually run a chain of commands:
1. `block-approval-report`
2. `block-pr-draft`
3. `block-pr-create` (gated)
4. `block-pr-status` (optional)

Stage 6.20 introduces `block-pr-submit`, a single command that safely orchestrates the entire chain.

---

## Implementation summary

### New module

- `src/block/block-pr-submit.ts` — `submitBlockPr(input)`
  - Validates `ALLOW_BLOCK_PR_SUBMIT=true`
  - Dry-run by default (`BLOCK_PR_SUBMIT_DRY_RUN`)
  - Generates approval report via existing `generateBlockApprovalReport`
  - Generates PR draft via existing `generateBlockPrDraft`
  - Validates block is completed and PR-ready
  - Rejects `main`/`master` work branch
  - In dry-run: validates PR create gates without calling GitHub API
  - In real mode: delegates to existing `createBlockPullRequest` (draft-only)
  - Optionally checks PR status via `getBlockPrStatus` when `ALLOW_GITHUB_PR_STATUS=true`
  - Writes `pr-submit-report.md` with full evidence
  - Redacts tokens from all outputs

### New CLI command

- `block-pr-submit <blockJsonPath>`

### New tests

- `test/block-pr-submit.test.ts` — 10 unit tests
- `test/cli-block-pr-submit.test.ts` — 8 CLI tests
- Total suite: 1757 tests / 104 suites / 0 failures

---

## Commands tested

### Dry-run (default)

```bash
ALLOW_BLOCK_PR_SUBMIT=true \
BLOCK_PR_SUBMIT_DRY_RUN=true \
ALLOW_BLOCK_PR_CREATE=true \
ALLOW_GITHUB_PR_CREATE=true \
GITHUB_TOKEN=ghp_fake \
GITHUB_REPOSITORY=test-owner/test-repo \
npx tsx src/cli.ts block-pr-submit docs/<block>.json
```

- Generates approval report and PR draft.
- Validates that PR create gates are satisfied.
- Does **not** call GitHub API.
- Writes `runs/blocks/<block_id>/pr-submit/pr-submit-report.md`.

### Real mode (fake fetch in tests)

```bash
ALLOW_BLOCK_PR_SUBMIT=true \
ALLOW_BLOCK_PR_CREATE=true \
ALLOW_GITHUB_PR_CREATE=true \
BLOCK_PR_SUBMIT_DRY_RUN=false \
GITHUB_TOKEN=ghp_fake \
GITHUB_REPOSITORY=test-owner/test-repo \
npx tsx src/cli.ts block-pr-submit docs/<block>.json
```

- Creates draft PR via fake fetch in unit tests.
- PR number and URL recorded in report.
- Duplicate guard prevents second creation.

---

## Test results

| Test | Result |
|---|---|
| Dry-run default does not call GitHub API | ✅ |
| Missing `ALLOW_BLOCK_PR_SUBMIT` blocks | ✅ |
| Missing PR create gates blocks real mode | ✅ |
| Non-completed block blocks submission | ✅ |
| Main/master work branch blocks submission | ✅ |
| Real mode creates draft PR with `draft: true` | ✅ |
| Real mode writes report with PR number/URL | ✅ |
| Duplicate PR guard prevents second creation | ✅ |
| Existing open PR returns safely | ✅ |
| Token-like values redacted | ✅ |
| No provider calls | ✅ |
| CLI prints expected summary | ✅ |
| No stack trace in failure paths | ✅ |

---

## Safety model

- **No merge** — `block-pr-submit` never merges.
- **No auto-merge** — no auto-merge flag exists.
- **No `main` touch** — `main`/`master` work branch is rejected.
- **No force push** — no git push performed by this command.
- **No `git reset --hard`** — no destructive git ops.
- **No `git add -A`** — only helpers stage files.
- **Draft PR only** — delegates to `block-pr-create`, which sets `draft: true`.
- **No PR update/close/comment/review** — only creation and optional status read.
- **No provider calls** — orchestrates PR helpers only.
- **Token redaction** — `redactReviewerText` applied to report.
- **Dry-run by default** — safe to run without credentials.

---

## Real proof

No real GitHub API call was performed in this stage.
All PR creation paths were verified with injected fake fetch in unit and CLI tests.

Real proof can be performed later by an operator with a valid `GITHUB_TOKEN`:
1. Run dry-run first.
2. Inspect `pr-submit-report.md`.
3. Set `BLOCK_PR_SUBMIT_DRY_RUN=false`.
4. Re-run and verify draft PR is created.

---

## Final status

**PASS ✅**

- Implementation complete.
- Tests pass.
- Documentation updated.
- No source code changes outside new module and CLI wiring.
