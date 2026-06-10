# Stage 6.11 — Optional Manual PR Creation Helper Example

> **This is an example only.** No real PR was created for this document.
> Stage 6.11 creates a draft PR **only** when all safety prerequisites pass and explicit opt-in flags are present.

---

## Required flags

```bash
export ALLOW_BLOCK_PR_CREATE=true
export ALLOW_GITHUB_PR_CREATE=true
export GITHUB_TOKEN="ghp_xxxxxxxxxxxxxxxxxxxx"   # never printed or persisted
export GITHUB_REPOSITORY="owner/repo"
```

## Prerequisites checked before GitHub API call

- Block status is `completed`
- `current_task_id` is `null`
- All tasks are `accepted`
- Every accepted task has `commit_sha`
- Every accepted task has `pushed_ref`
- `work_branch` is not `main`
- `base_branch` exists and differs from `work_branch`
- Work branch is already pushed to origin (`git ls-remote`)
- PR draft package exists (`pr-title.txt`, `pr-body.md`, `manual-pr-checklist.md`)
- Approval report exists (`approval-report.md`)
- PR body does **not** contain `NOT PR-READY` or `DO NOT OPEN PR YET`
- PR title/body contain no obvious secrets

## Dry-run example

```bash
export BLOCK_PR_CREATE_DRY_RUN=true
npx tsx src/cli.ts block-pr-create tasks/my-block.json
```

Expected output:

```
[block-pr-create] Block: my-block
[block-pr-create] Dry run: yes
[block-pr-create] Would create draft PR: yes
[block-pr-create] Base: main
[block-pr-create] Head: feature/my-block
[block-pr-create] Title: My Block Title
[block-pr-create] Body: runs/blocks/my-block/pr-draft/pr-body.md
[block-pr-create] No provider call was made
[block-pr-create] No push was performed
[block-pr-create] No merge was performed
[block-pr-create] No checkout was performed
[block-pr-create] No main touch was performed
```

No `pr-created.json` is written in dry-run mode.

## Successful fake response example

When all checks pass and GitHub API returns 201:

```json
{
  "block_id": "my-block",
  "pr_number": 42,
  "pr_url": "https://github.com/owner/repo/pull/42",
  "base": "main",
  "head": "feature/my-block",
  "title": "My Block Title",
  "commit_shas": [
    "abc123def456abc123def456abc123def456abcd"
  ],
  "created_at": "2026-06-08T12:00:00.000Z",
  "no_merge_performed": true,
  "no_push_performed": true,
  "no_checkout_performed": true,
  "no_main_touch_performed": true
}
```

## Safety invariants

- **Draft PR only** — `draft: true` is hardcoded in the API payload.
- **No merge** — the tool never calls the merge API.
- **No push** — the tool only verifies the branch is already pushed.
- **No checkout/switch** — no git branch operations.
- **No main touch** — `work_branch === 'main'` is rejected before any API call.
- **No provider call** — no Kimi or other AI provider is invoked.
- **No PR update** — existing PRs block duplicate creation by default.
- **No token leak** — `GITHUB_TOKEN` is never printed, never written to disk, never included in logs.
- **Duplicate protection** — if `pr-created.json` already exists, creation is blocked unless `ALLOW_BLOCK_PR_CREATE_DUPLICATE=true`.

## Required manual human review

Even after PR creation:
- A human must review the PR in GitHub UI.
- A human must decide whether to merge.
- Auto-merge is never enabled by this tool.
- CI status must be verified separately if needed.
