# Demo Command Cookbook

## Safety rules for all commands

- **Never paste tokens into files.** Use environment variables only.
- **Delete or revoke temporary GitHub tokens after use.**
- **Set `ALLOW_REAL_REPO_PUSH=false` for demos.** Push is manual.
- **Never put raw secrets in block JSON.** Block definitions are committed to git.

---

## 1. Fake block run

Fastest way to verify a block definition without API keys.

```bash
BLOCK_RUN_MODE=fake \
BLOCK_RUN_MAX_TASKS=3 \
BLOCK_RUN_MAX_TOTAL_ATTEMPTS=8 \
npx tsx src/cli.ts block-run docs/<block>.json
```

- Uses fake coder and fake reviewer.
- No network calls.
- Good for testing block JSON syntax and check scripts.

---

## 2. Real Kimi coder + fake reviewer

Test real AI generation with a deterministic (fake) reviewer gate.

```bash
BLOCK_RUN_MODE=real_kimi_coder_fake_reviewer \
ALLOW_BLOCK_RUN_ONE=true \
ALLOW_REAL_PROVIDER=true \
ALLOW_REAL_REPO_APPLY=true \
ALLOW_REAL_REPO_COMMIT=true \
ALLOW_REAL_REPO_PUSH=false \
CODER_PROVIDER=kimi \
KIMI_API_KEY=<env only> \
KIMI_BASE_URL=https://api.kimi.com/coding/v1 \
KIMI_MODEL=kimi-k2.6 \
npx tsx src/cli.ts block-run docs/<block>.json
```

- Real API call to Kimi for file generation.
- Reviewer is fake (always accepts or follows mock config).
- Good for validating coder prompt quality before enabling real review.

---

## 3. Real Kimi coder + real Kimi reviewer

Full autonomous loop. Both coder and reviewer are real Kimi API calls.

```bash
BLOCK_RUN_MODE=real_kimi_coder_kimi_reviewer \
ALLOW_BLOCK_RUN_ONE=true \
ALLOW_REAL_PROVIDER=true \
ALLOW_REAL_REPO_APPLY=true \
ALLOW_REAL_REPO_COMMIT=true \
ALLOW_REAL_REPO_PUSH=false \
ALLOW_KIMI_REVIEWER=true \
CODER_PROVIDER=kimi \
REVIEWER_PROVIDER=kimi \
KIMI_API_KEY=<env only> \
KIMI_BASE_URL=https://api.kimi.com/coding/v1 \
KIMI_MODEL=kimi-k2.6 \
npx tsx src/cli.ts block-run docs/<block>.json
```

- Two real API calls per task (coder + reviewer).
- Deterministic checks run before reviewer is called.
- Fix loops are fully autonomous up to `max_fix_attempts`.

---

## 4. Approval report

Generate a human-readable summary of a completed block.

```bash
npx tsx src/cli.ts block-approval-report docs/<block>.json
```

- Reads block state.
- Produces `runs/blocks/<block_id>/approval-report.md`.
- No API calls, no mutations.

---

## 5. PR draft package

Generate PR title, body, and readiness check without creating a PR.

```bash
npx tsx src/cli.ts block-pr-draft docs/<block>.json
```

- Produces `runs/blocks/<block_id>/pr-draft/`.
- No GitHub API calls.
- Safe to run anytime.

---

## 6. PR create helper (optional, explicitly gated, draft-only)

Create a GitHub Pull Request after manual review. **Separate opt-in required.**

```bash
ALLOW_BLOCK_PR_CREATE=true \
ALLOW_GITHUB_PR_CREATE=true \
GITHUB_TOKEN=<env only> \
GITHUB_REPOSITORY=Mellowin/AI-orchestrator \
npx tsx src/cli.ts block-pr-create docs/<block>.json
```

- Calls GitHub REST API.
- Creates draft PR only.
- Never merges.
- Token must have `repo` scope.

---

## 7. PR status

Read-only PR status and check runs after PR creation.

```bash
GITHUB_REPOSITORY=Mellowin/AI-orchestrator \
BLOCK_PR_NUMBER=<number> \
npx tsx src/cli.ts block-pr-status docs/<block>.json
```

- Calls GitHub REST API read-only endpoints.
- No mutations.

---

## 9. Automated draft PR submission

One-shot safe finalization command that orchestrates approval report → PR draft → draft PR creation → PR status check.

### Dry-run (default)

```bash
ALLOW_BLOCK_PR_SUBMIT=true \
BLOCK_PR_SUBMIT_DRY_RUN=true \
GITHUB_REPOSITORY=Mellowin/AI-orchestrator \
npx tsx src/cli.ts block-pr-submit docs/<block>.json
```

- Generates approval report and PR draft package.
- Validates that real PR creation would be allowed.
- Does **not** call GitHub API.
- Safe to run anytime.

### Real draft PR creation

```bash
ALLOW_BLOCK_PR_SUBMIT=true \
ALLOW_BLOCK_PR_CREATE=true \
ALLOW_GITHUB_PR_CREATE=true \
BLOCK_PR_SUBMIT_DRY_RUN=false \
GITHUB_TOKEN=<env only> \
GITHUB_REPOSITORY=Mellowin/AI-orchestrator \
npx tsx src/cli.ts block-pr-submit docs/<block>.json
```

- Creates draft PR only.
- No merge.
- No automatic `main` change.
- No provider call.
- Delete/revoke temporary GitHub token after use.

---

## 8. PR cleanup

Clean up a proof PR (close PR, optionally delete branch).

```bash
ALLOW_BLOCK_PR_CLEANUP=true \
GITHUB_REPOSITORY=Mellowin/AI-orchestrator \
BLOCK_PR_NUMBER=<number> \
BLOCK_PR_CLEANUP_DRY_RUN=true \
npx tsx src/cli.ts block-pr-cleanup docs/<block>.json
```

- `BLOCK_PR_CLEANUP_DRY_RUN=true` previews actions without executing.
- Remove `BLOCK_PR_CLEANUP_DRY_RUN` to actually close/delete.
- Never touches `main`.

---

## Quick reference: env vars

| Var | Required for | Example |
|---|---|---|
| `KIMI_API_KEY` | Real Kimi provider | `sk-...` (env only) |
| `KIMI_BASE_URL` | Real Kimi provider | `https://api.kimi.com/coding/v1` |
| `KIMI_MODEL` | Real Kimi provider | `kimi-k2.6` |
| `ALLOW_REAL_PROVIDER` | Any real provider call | `true` |
| `ALLOW_REAL_REPO_APPLY` | Write files to repo | `true` |
| `ALLOW_REAL_REPO_COMMIT` | Create local git commit | `true` |
| `ALLOW_REAL_REPO_PUSH` | Push to origin | `false` (demo default) |
| `ALLOW_KIMI_REVIEWER` | Real Kimi reviewer | `true` |
| `CODER_PROVIDER` | Select coder | `kimi` |
| `REVIEWER_PROVIDER` | Select reviewer | `kimi` |
| `BLOCK_RUN_MODE` | Select block run mode | `fake` / `real_kimi_coder_fake_reviewer` / `real_kimi_coder_kimi_reviewer` |
| `ALLOW_BLOCK_PR_SUBMIT` | Automated draft PR submission | `true` |
| `BLOCK_PR_SUBMIT_DRY_RUN` | Dry-run mode for PR submit | `true` (default) / `false` |
