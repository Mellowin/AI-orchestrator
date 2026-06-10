# Stage 6.23 — PR Readiness Gate with CI Verification

**Status:** ✅ Implemented
**Branch:** `feature/mvp-skeleton`
**Date:** 2026-06-10

---

## Purpose

Add a safe PR readiness gate that verifies a draft PR is ready for human review based on PR status + GitHub CI status. This stage does **not** merge and does **not** auto-merge. Default behavior is dry-run / report-only.

---

## Implementation

### New files

| File | Purpose |
|---|---|
| `src/block/block-pr-readiness.ts` | Core readiness check logic |
| `test/block-pr-readiness.test.ts` | 16 unit tests |
| `test/cli-block-pr-readiness.test.ts` | 8 CLI integration tests |

### Updated files

| File | Change |
|---|---|
| `src/cli.ts` | Added `block-pr-readiness <blockJsonPath>` command |

### Command

```bash
npx tsx src/cli.ts block-pr-readiness docs/<block>.json
```

### Environment variables

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `ALLOW_BLOCK_PR_READINESS` | Yes | — | Gate to enable the command |
| `GITHUB_REPOSITORY` | Yes | — | `owner/repo` format |
| `BLOCK_PR_NUMBER` | Yes | — | PR number to check |
| `BLOCK_PR_READINESS_DRY_RUN` | No | `true` | Dry-run by default |
| `BLOCK_PR_READINESS_REQUIRE_CI` | No | `true` | Require CI success |
| `ALLOW_GITHUB_MARK_READY` | No | — | Required for real mark-ready |
| `GITHUB_TOKEN` | For mark-ready | — | GitHub API token |

---

## Readiness checks

A PR is considered `ready` only when **all** of the following are true:

1. PR state is `open`
2. PR is `draft`
3. PR is **not** merged
4. Head branch is **not** `main` / `master`
5. Base branch matches block definition
6. GitHub CI/checks status is `success` (if `BLOCK_PR_READINESS_REQUIRE_CI=true`)
7. No blocking safety findings

If all checks pass and **all** mark-ready gates are enabled:

- `ALLOW_BLOCK_PR_READINESS=true`
- `ALLOW_GITHUB_MARK_READY=true`
- `BLOCK_PR_READINESS_DRY_RUN=false`
- `GITHUB_TOKEN` present

Then the command sends a `PATCH { draft: false }` to mark the PR ready for review.

---

## Live dry-run proof on PR #3

Command:

```bash
ALLOW_BLOCK_PR_READINESS=true \
GITHUB_REPOSITORY=Mellowin/AI-orchestrator \
BLOCK_PR_NUMBER=3 \
BLOCK_PR_READINESS_DRY_RUN=true \
npx tsx src/cli.ts block-pr-readiness docs/stage-6-21-proof-block.json
```

Output:

```
[block-pr-readiness] Block: stage-6-21-proof
[block-pr-readiness] PR number: 3
[block-pr-readiness] PR URL: https://github.com/Mellowin/AI-orchestrator/pull/3
[block-pr-readiness] State: open
[block-pr-readiness] Draft: yes
[block-pr-readiness] Merged: no
[block-pr-readiness] Base: feature/mvp-skeleton
[block-pr-readiness] Head: stage-6-21-proof
[block-pr-readiness] Head SHA: 8d10356f710ec13f6890f5a6afd0ce186869f5dc
[block-pr-readiness] Checks: success
[block-pr-readiness] Readiness: ready
[block-pr-readiness] Dry run: yes
[block-pr-readiness] Would mark ready: no
[block-pr-readiness] Marked ready: no
[block-pr-readiness] Report: .../runs/blocks/stage-6-21-proof/pr-readiness/report.md
[block-pr-readiness] No merge was performed
[block-pr-readiness] No auto-merge was performed
[block-pr-readiness] No push was performed
[block-pr-readiness] No checkout was performed
[block-pr-readiness] No main touch was performed
[block-pr-readiness] No provider call was made
```

**PR #3 was checked live. PR #3 was NOT marked ready for review (dry-run mode).**

---

## Safety invariants

| Invariant | Status |
|---|---|
| No merge performed | ✅ |
| No auto-merge performed | ✅ |
| No push performed | ✅ |
| No checkout performed | ✅ |
| No main touch | ✅ |
| No provider call | ✅ |
| Default dry-run | ✅ |
| Mark-ready only with explicit gates | ✅ |
| Token redacted in all outputs | ✅ |
| CI status verified before readiness | ✅ |

---

## Test summary

| Suite | Tests | Result |
|---|---|---|
| `block-pr-readiness.test.ts` | 16 | ✅ Pass |
| `cli-block-pr-readiness.test.ts` | 8 | ✅ Pass |

---

## Operator note

- Always run with `BLOCK_PR_READINESS_DRY_RUN=true` first to review the report.
- Do not enable `ALLOW_GITHUB_MARK_READY` unless you are certain the PR should leave draft state.
- Even after marking ready, **human review and manual merge are still required**.
