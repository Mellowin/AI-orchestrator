# Stage 6.13.2 — Proof PR Cleanup Dry-Run Evidence

**Date:** 2026-06-08
**Branch:** `feature/mvp-skeleton`
**Proof PR:** [#2](https://github.com/Mellowin/AI-orchestrator/pull/2)
- base: `feature/mvp-skeleton`
- head: `stage-6-11-pr-create-proof`
- draft: true
- merged: false

**Source mode:** `mock` (`MOCK_GITHUB_PR_CLEANUP_RESPONSE` used)
> Real GitHub API was not verified by this dry-run evidence. The PR state was supplied via mock response to avoid unauthenticated rate limits.

---

## Scenario A — Read-only dry-run, no actions requested

**Command:**
```bash
ALLOW_BLOCK_PR_CLEANUP=true \
GITHUB_REPOSITORY=Mellowin/AI-orchestrator \
BLOCK_PR_NUMBER=2 \
BLOCK_PR_CLEANUP_DRY_RUN=true \
MOCK_GITHUB_PR_CLEANUP_RESPONSE='{"state":"open","draft":true,"merged":false,"base":{"ref":"feature/mvp-skeleton"},"head":{"ref":"stage-6-11-pr-create-proof"},"html_url":"https://github.com/Mellowin/AI-orchestrator/pull/2"}' \
npx tsx src/cli.ts block-pr-cleanup docs/stage-6-11-pr-create-proof-block.json
```

**Output summary:**
- Dry run: yes
- Close PR requested: no
- Delete branch requested: no
- PR closed: no
- Branch deleted: no
- Cleanup safe: yes
- Blocking issues: 0
- Safety findings: 0

**Report path:** `runs/blocks/stage-6-11-pr-create-proof/pr-cleanup-report.md`

---

## Scenario B — Dry-run delete branch only

**Command:**
```bash
ALLOW_BLOCK_PR_CLEANUP=true \
GITHUB_REPOSITORY=Mellowin/AI-orchestrator \
BLOCK_PR_NUMBER=2 \
BLOCK_PR_CLEANUP_DRY_RUN=true \
BLOCK_PR_CLEANUP_DELETE_BRANCH=true \
MOCK_GITHUB_PR_CLEANUP_RESPONSE='{"state":"open","draft":true,"merged":false,"base":{"ref":"feature/mvp-skeleton"},"head":{"ref":"stage-6-11-pr-create-proof"},"html_url":"https://github.com/Mellowin/AI-orchestrator/pull/2"}' \
npx tsx src/cli.ts block-pr-cleanup docs/stage-6-11-pr-create-proof-block.json
```

**Output summary:**
- Dry run: yes
- Delete branch requested: yes
- PR closed: no
- Branch deleted: no
- Cleanup safe: no
- Blocking issues: 1
- Safety findings: 1

**Blocking issue:**
```
Cannot delete proof branch while PR is still open unless closePr is requested in the same cleanup command
```

**Report path:** `runs/blocks/stage-6-11-pr-create-proof/pr-cleanup-report.md`

---

## Scenario C — Dry-run close + delete

**Command:**
```bash
ALLOW_BLOCK_PR_CLEANUP=true \
GITHUB_REPOSITORY=Mellowin/AI-orchestrator \
BLOCK_PR_NUMBER=2 \
BLOCK_PR_CLEANUP_DRY_RUN=true \
BLOCK_PR_CLEANUP_CLOSE_PR=true \
BLOCK_PR_CLEANUP_DELETE_BRANCH=true \
MOCK_GITHUB_PR_CLEANUP_RESPONSE='{"state":"open","draft":true,"merged":false,"base":{"ref":"feature/mvp-skeleton"},"head":{"ref":"stage-6-11-pr-create-proof"},"html_url":"https://github.com/Mellowin/AI-orchestrator/pull/2"}' \
npx tsx src/cli.ts block-pr-cleanup docs/stage-6-11-pr-create-proof-block.json
```

**Output summary:**
- Dry run: yes
- Close PR requested: yes
- Delete branch requested: yes
- PR closed: no
- Branch deleted: no
- Cleanup safe: yes
- Blocking issues: 0
- Safety findings: 2

**Safety findings:**
- Dry run: PR close was not performed
- Dry run: branch delete was not performed

**Report path:** `runs/blocks/stage-6-11-pr-create-proof/pr-cleanup-report.md`

---

## Verification after scenarios

### PR #2 still open
No close action was performed. PR #2 remains open, draft=true, merged=false.

### Proof branch still present
```
$ git ls-remote --heads origin stage-6-11-pr-create-proof
a9e967128918e908e62e3ca452dd93baec8b5488	refs/heads/stage-6-11-pr-create-proof
```
Branch `stage-6-11-pr-create-proof` exists on remote `origin`.

---

## What this stage did NOT do

- No PATCH to GitHub API (PR close was not performed)
- No DELETE to GitHub API (branch deletion was not performed)
- No merge, no auto-merge
- No PR update, comment, or review
- No push
- No checkout/switch
- No main touch
- No provider call
- No token persisted or printed

---

## Real cleanup decision

Real cleanup (close PR #2 + delete proof branch) remains a human decision.
When ready, run with:
```bash
ALLOW_BLOCK_PR_CLEANUP=true \
ALLOW_GITHUB_PR_CLOSE=true \
ALLOW_GITHUB_BRANCH_DELETE=true \
GITHUB_TOKEN=<token> \
GITHUB_REPOSITORY=Mellowin/AI-orchestrator \
BLOCK_PR_NUMBER=2 \
BLOCK_PR_CLEANUP_DRY_RUN=false \
BLOCK_PR_CLEANUP_CLOSE_PR=true \
BLOCK_PR_CLEANUP_DELETE_BRANCH=true \
npx tsx src/cli.ts block-pr-cleanup docs/stage-6-11-pr-create-proof-block.json
```
