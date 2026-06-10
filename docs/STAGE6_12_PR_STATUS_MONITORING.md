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
- `GITHUB_TOKEN` — for private repos or higher rate limits

## Source mode distinction

`block-pr-status` clearly reports whether it used the real GitHub API or a mock response:

- **Real GitHub API:** `source_mode: github_api`, `github_api_verified: true`, `mock_used: false`
- **Mock response:** `source_mode: mock`, `github_api_verified: false`, `mock_used: true`

When mock is used, the report includes:

> Mock-based status proof. Real GitHub API was not verified by this run.

And the CLI prints:

```
[block-pr-status] Warning: mock response used; real GitHub API status was not verified by this run
```

## Stage 6.12 proof summary

**Caveat:** During the initial Kimi live proof session, the GitHub API rate limit was exceeded for the unauthenticated IP. The proof was completed using `MOCK_GITHUB_PR_STATUS_RESPONSE` with the exact known state of PR #2. This is recorded as a **mock-based proof**, not a real authenticated GitHub API proof.

Mock data used:
- state: `open`
- draft: `true`
- merged: `false`
- base: `feature/mvp-skeleton`
- head: `stage-6-11-pr-create-proof`
- html_url: `https://github.com/Mellowin/AI-orchestrator/pull/2`

The real PR #2 state was independently verified externally and matches the mock data.

**Authenticated live proof:** remains pending until an authenticated run with `GITHUB_TOKEN` is performed.

## Report output

`runs/blocks/<block_id>/pr-status-report.md`

Sections:
- **Summary** — PR number, URL, state, draft, merged, branches, counts, checks status, safety flag, source mode, GitHub API verified, mock used
- **Branch verification** — expected vs actual base/head with match indicators
- **Safety findings** — blocking issues or warnings (e.g., CI not verified, mock used)
- **What this command did NOT do** — explicit no-mutation statement

## Safety invariants

- No POST / PATCH / PUT / DELETE to GitHub API
- No PR creation, update, close, merge, comment, or review
- No push, no checkout/switch, no main touch
- No provider call
- `GITHUB_TOKEN` never printed or persisted
- Output path restricted to `runs/blocks/`, cwd, or tmpdir
