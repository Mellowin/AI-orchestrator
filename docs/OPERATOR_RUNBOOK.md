# AI Orchestrator — Operator Runbook

## What this project does (one page)

AI Orchestrator is an autonomous Node.js CLI tool that reads a block definition (a JSON file describing one or more tasks), calls an AI coder to generate file changes, runs deterministic checks, commits the result locally, and calls an AI reviewer to validate the commit. If checks fail or the reviewer requests changes, the system enters a fix-loop and retries the same task with context about the failure. If all tasks pass review, the block is marked `completed`.

The orchestrator never merges, never pushes unless explicitly allowed, and never touches `main`.

---

## The core loop

```
block JSON → coder → apply → checks → commit → reviewer → decision
                ↑                                          |
                └──────── fix required ─────────────────────┘
```

1. **block JSON** — defines tasks, allowed files, checks, and review policy.
2. **coder** — AI provider generates a JSON response with file updates.
3. **apply** — validated file updates are written to the working tree.
4. **checks** — deterministic commands (e.g., `npm test`, custom verifiers) run against the updated tree.
5. **commit** — if checks pass, changes are staged and committed locally.
6. **reviewer** — AI provider reviews the commit diff and deterministic evidence.
7. **decision**:
   - `accepted` → advance to next task.
   - `fix_required` / `checks_failed` → retry same task with failure context.
   - `blocked` → stop; human intervention required.

---

## Supported modes

| Mode | Coder | Reviewer | Use case |
|---|---|---|---|
| `fake` | Fake | Fake | Fast local testing without API keys |
| `real_kimi_coder_fake_reviewer` | Real Kimi | Fake | Test real coder output with deterministic reviewer |
| `real_kimi_coder_kimi_reviewer` | Real Kimi | Real Kimi | Full autonomous loop with real AI on both sides |

Set mode via `BLOCK_RUN_MODE`.

---

## Required env vars for real mode

```bash
# AI provider credentials
KIMI_API_KEY=<env only, never paste into files>
KIMI_BASE_URL=https://api.kimi.com/coding/v1
KIMI_MODEL=kimi-k2.6
# Optional: KIMI_USER_AGENT if your endpoint requires it

# Real-mode opt-in flags
ALLOW_REAL_PROVIDER=true
ALLOW_REAL_REPO_APPLY=true
ALLOW_REAL_REPO_COMMIT=true
ALLOW_REAL_REPO_PUSH=false   # keep false for demos
ALLOW_KIMI_REVIEWER=true

# Provider selection
CODER_PROVIDER=kimi
REVIEWER_PROVIDER=kimi
```

---

## Safety defaults

- **No PR creation by `block-run`** — PR tools are separate manual helpers.
- **No GitHub API by `block-run`** — block-run never calls GitHub.
- **No merge** — the orchestrator never merges branches.
- **No `main` touch** — work happens on `work_branch`; `main` is protected.
- **No checkout/switch** — the orchestrator does not change branches.
- **No force push** — push uses standard `git push origin <branch>`.
- **No `git reset --hard`** — rollback is file-level via patch manifest.
- **No `git add -A`** — only explicitly allowed files are staged.
- **No token persistence** — API keys live in env only; never written to state or logs.

---

## What "accepted" means

A task is `accepted` when:
1. The coder generated valid file updates.
2. All deterministic checks passed.
3. The reviewer reviewed the commit diff and returned `accepted`.
4. The commit was created locally (push is separate and opt-in).

The block advances to the next task.

---

## What "blocked" means

A task is `blocked` when:
1. A deterministic safety check detected a severe issue (e.g., secret leak, merge conflict marker, `main` branch).
2. The reviewer returned `rejected` with safety findings.
3. Max fix attempts were exhausted.

The block stops. Human must inspect `block-state.json`, diff, and evidence before deciding next steps.

---

## CI status

The repository includes a GitHub Actions workflow (`.github/workflows/ci.yml`) that runs `typecheck`, `build`, and `test` on every PR and push to `feature/mvp-skeleton`.

- Open **Actions** tab on GitHub to see workflow runs.
- The workflow is read-only — it does not push, merge, or deploy.
- A green CI check is required before any PR should be merged.

> **Note:** GitHub CI workflow added; CI pass not yet verified until workflow run completes.

---

## What to do if a block gets stuck

1. Check `runs/blocks/<block_id>/block-state.json` for the current task status and blocking issues.
2. Inspect the latest commit with `git show <commit_sha>` (if a commit was made).
3. Read reviewer summary in the block state for the reason.
4. If blocked due to deterministic checks, inspect the diff for secrets or conflict markers.
5. If blocked due to max attempts, decide whether to increase `max_fix_attempts` in the block definition or fix the issue manually.
6. To resume after manual fix, clear or edit block state and re-run `block-run`.

---

## How to inspect evidence

| Document | Purpose |
|---|---|
| [`TESTING_SUMMARY.md`](../TESTING_SUMMARY.md) | All completed stages, test metrics, verification commits |
| [`PHASE4_PLAN.md`](../PHASE4_PLAN.md) | Roadmap, stage definitions, acceptance criteria |
| [`docs/STAGE6_16_REAL_MULTITASK_BLOCK_PROOF.md`](STAGE6_16_REAL_MULTITASK_BLOCK_PROOF.md) | Full multi-task autonomous run with fix loop |
| [`docs/STAGE6_15_2_FULL_FIX_LOOP_MATRIX_PROOF.md`](STAGE6_15_2_FULL_FIX_LOOP_MATRIX_PROOF.md) | Multi-scenario fix-loop matrix proof |

---

## Automated PR submission

After a block is `completed` and PR-ready, you can use the automated submission command:

```bash
ALLOW_BLOCK_PR_SUBMIT=true \
BLOCK_PR_SUBMIT_DRY_RUN=true \
GITHUB_REPOSITORY=Mellowin/AI-orchestrator \
npx tsx src/cli.ts block-pr-submit docs/<block>.json
```

This command orchestrates:
1. Approval report generation
2. PR draft package generation
3. PR create validation (dry-run) or actual draft PR creation (real mode)
4. Optional PR status check

It is dry-run by default. Real mode requires explicit `BLOCK_PR_SUBMIT_DRY_RUN=false` plus all `block-pr-create` gates.

---

## See also

- [`DEMO_COMMAND_COOKBOOK.md`](DEMO_COMMAND_COOKBOOK.md) — exact commands for each mode
- [`SAFETY_INVARIANTS.md`](SAFETY_INVARIANTS.md) — hard invariants enforced by the system
- [`MINI_MVP_DEMO_PACKAGE.md`](MINI_MVP_DEMO_PACKAGE.md) — what is proven, what is not, known limitations
- [`STAGE6_20_AUTOMATED_DRAFT_PR_SUBMISSION.md`](STAGE6_20_AUTOMATED_DRAFT_PR_SUBMISSION.md) — Stage 6.20 implementation evidence
