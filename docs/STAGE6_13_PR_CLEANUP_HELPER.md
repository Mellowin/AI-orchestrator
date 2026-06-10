# Stage 6.13 — Proof PR Cleanup Helper

## Purpose

Add a strictly gated cleanup helper for proof PR branches created during live proof stages (e.g., Stage 6.11.1 / 6.12). This helper can read PR status, verify it is the expected proof PR, optionally close the PR, optionally delete the proof branch, and write a cleanup report.

This is **opt-in and safe by default**. Dry-run is the default. Real write actions require explicit flags and a token.

## Context

We currently have proof PR #2:
- URL: https://github.com/Mellowin/AI-orchestrator/pull/2
- base: `feature/mvp-skeleton`
- head: `stage-6-11-pr-create-proof`
- draft: true
- merged: false
- purpose: Stage 6.11.1 / 6.12 live proof evidence

The cleanup helper is implemented now, but **real cleanup should only be run when explicitly authorized later**. PR #2 should remain open after this stage.

## Module

`src/block/block-pr-cleanup.ts`

Export:
```ts
cleanupBlockProofPr(input: {
  blockDefinitionPath: string;
  prNumber?: number;
  closePr?: boolean;
  deleteBranch?: boolean;
  dryRun?: boolean;
  fetchFn?: typeof fetch;
  outputPath?: string;
}): Promise<BlockPrCleanupResult>
```

Result fields:
- `block_id`
- `pr_number`, `pr_url`
- `base_branch`, `head_branch`
- `expected_base_branch`, `expected_head_branch`
- `state_before`, `draft_before`, `merged_before`
- `close_pr_requested`, `delete_branch_requested`
- `dry_run`
- `pr_closed`, `branch_deleted`
- `cleanup_safe`
- `blocking_issues[]`
- `safety_findings[]`
- `output_path`

## Required env

- `ALLOW_BLOCK_PR_CLEANUP=true`
- `GITHUB_REPOSITORY=owner/repo`

## Optional / write-action env

- `GITHUB_TOKEN` — required for real close/delete
- `ALLOW_GITHUB_PR_CLOSE=true` — required to close PR
- `ALLOW_GITHUB_BRANCH_DELETE=true` — required to delete branch
- `BLOCK_PR_NUMBER` — override PR number (default reads from `pr-created.json`)
- `BLOCK_PR_CLEANUP_DRY_RUN=true/false` — default is dry-run (`true`)
- `BLOCK_PR_CLEANUP_CLOSE_PR=true/false`
- `BLOCK_PR_CLEANUP_DELETE_BRANCH=true/false`
- `BLOCK_PR_CLEANUP_OUTPUT` — custom report path

## Safety gates

Before any close/delete, the helper verifies:
- PR number exists
- PR is **NOT merged**
- PR base equals block base branch
- PR head equals block work branch
- PR head is **not main**
- PR base is **not main** unexpectedly
- Head branch looks like a proof branch (`stage-*` or contains `proof`)
- `pr-created.json` base/head match block definition
- If `closePr` requested: `ALLOW_GITHUB_PR_CLOSE=true`
- If `deleteBranch` requested: `ALLOW_GITHUB_BRANCH_DELETE=true`
- **If `deleteBranch` requested and PR is open: `closePr` must also be requested in the same command**
- If any blocking issue exists: **no close/delete is performed**

Blocking issues include:
- PR is merged
- PR base mismatch
- PR head mismatch
- PR head is main
- PR base is main unexpectedly
- Branch name not proof-like
- Missing allow env
- Missing token for real write
- Malformed GitHub response
- **Cannot delete proof branch while PR is still open unless closePr is requested**

## GitHub API usage

**Read-only (always allowed):**
- `GET /repos/{owner}/{repo}/pulls/{pull_number}`

**Write-only with explicit flags:**
- `PATCH /repos/{owner}/{repo}/pulls/{pull_number}` with `{ state: "closed" }`
- `DELETE /repos/{owner}/{repo}/git/refs/heads/{head_branch}`

**Forbidden:**
- PUT merge endpoint
- POST comments/reviews/auto-merge
- Any other POST/PATCH/PUT
- `git push`, local checkout/switch, local branch delete
- `main` touch

## Dry-run behavior

- Default `dryRun=true`
- In dry-run, no `PATCH` or `DELETE` is performed
- Report still written with planned actions

## Report

`runs/blocks/<block_id>/pr-cleanup-report.md`

Sections:
- Summary (block id, PR number, URL, dry run, requested actions, outcomes, cleanup safe)
- Safety verification (checks and pass/fail)
- Blocking issues (list or "none")
- Safety findings (list or "none")
- What this command did NOT do (no merge, no auto-merge, no push, no checkout/switch, no main touch, no provider call, no token persisted)

## CLI

```bash
npx tsx src/cli.ts block-pr-cleanup <blockJsonPath>
```

Env overrides:
- `BLOCK_PR_NUMBER`, `BLOCK_PR_CLEANUP_DRY_RUN`, `BLOCK_PR_CLEANUP_CLOSE_PR`, `BLOCK_PR_CLEANUP_DELETE_BRANCH`, `BLOCK_PR_CLEANUP_OUTPUT`
- `ALLOW_BLOCK_PR_CLEANUP`, `ALLOW_GITHUB_PR_CLOSE`, `ALLOW_GITHUB_BRANCH_DELETE`
- `GITHUB_REPOSITORY`, `GITHUB_TOKEN`

## Mock test seams

- `MOCK_GITHUB_PR_CLEANUP_RESPONSE` — mock PR GET response
- `MOCK_GITHUB_PR_CLEANUP_CLOSE_RESPONSE` — mock PATCH response
- `MOCK_GITHUB_PR_CLEANUP_DELETE_RESPONSE` — mock DELETE response

## Safety confirmations

- No merge, no auto-merge
- No push, no checkout/switch, no main touch
- No provider call
- No token printed or persisted
- Branch deletion only with `ALLOW_GITHUB_BRANCH_DELETE=true`
- PR close only with `ALLOW_GITHUB_PR_CLOSE=true`
- Proof branch name validation prevents accidental deletion of non-proof branches

## Next steps

- Real cleanup of PR #2 remains a human decision.
- When ready, set `ALLOW_BLOCK_PR_CLEANUP=true`, `ALLOW_GITHUB_PR_CLOSE=true`, `ALLOW_GITHUB_BRANCH_DELETE=true`, `GITHUB_TOKEN`, and run the CLI.
