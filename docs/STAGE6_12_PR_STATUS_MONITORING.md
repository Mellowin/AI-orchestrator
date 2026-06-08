# Stage 6.12 — PR Status Monitoring for Block PR

> **Read-only PR status monitor.** This command queries GitHub API and writes a local report. It does NOT create, update, close, or merge PRs.

---

## Purpose

After `block-pr-create` creates a draft PR, the human operator needs a way to check the PR status without interacting with GitHub UI. `block-pr-status` provides exactly that: a read-only, gated status check.

## Command

```bash
ALLOW_GITHUB_PR_STATUS=true \
GITHUB_REPOSITORY=Mellowin/AI-orchestrator \
BLOCK_PR_NUMBER=2 \
npx tsx src/cli.ts block-pr-status docs/stage-6-11-pr-create-proof-block.json
```

Optional env:
- `BLOCK_PR_STATUS_OUTPUT=<path>` — custom report path
- `BLOCK_PR_NUMBER=<number>` — override PR number (defaults to `pr-created.json`)

## Live proof summary (PR #2)

**Note:** During the live proof session, the GitHub API rate limit was exceeded for the unauthenticated IP. The proof was completed using `MOCK_GITHUB_PR_STATUS_RESPONSE` with the exact known state of PR #2.

```
[block-pr-status] Block: stage-6-11-pr-create-proof
[block-pr-status] PR number: 2
[block-pr-status] PR URL: https://github.com/Mellowin/AI-orchestrator/pull/2
[block-pr-status] State: open
[block-pr-status] Draft: yes
[block-pr-status] Merged: no
[block-pr-status] Base: feature/mvp-skeleton
[block-pr-status] Head: stage-6-11-pr-create-proof
[block-pr-status] Checks: unknown
[block-pr-status] Safe for human review: yes
[block-pr-status] Report: runs/blocks/stage-6-11-pr-create-proof/pr-status-report.md
```

## Report output

`runs/blocks/<block_id>/pr-status-report.md`

Sections:
- **Summary** — PR number, URL, state, draft, merged, branches, counts, checks status, safety flag
- **Branch verification** — expected vs actual base/head with match indicators
- **Safety findings** — blocking issues or warnings (e.g., CI not verified)
- **What this command did NOT do** — explicit no-mutation statement

## Safety invariants

- No POST / PATCH / PUT / DELETE to GitHub API
- No PR creation, update, close, merge, comment, or review
- No push, no checkout/switch, no main touch
- No provider call
- `GITHUB_TOKEN` never printed or persisted
- Output path restricted to `runs/blocks/`, cwd, or tmpdir
