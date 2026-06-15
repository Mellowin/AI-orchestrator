# Stage 10 v0 Release Snapshot

This document captures the working vertical slice completed in Stage 10 of the AI Orchestrator.

## What works now

Stage 10 delivers a complete local-to-CI proof of the autonomous block-run flow:

- **Local fake demo** — `npm run demo:block:fake` creates a temporary git repo, runs readiness, runs a multi-task block with fake coder/reviewer responses, runs the report command, and cleans up.
- **Readiness command** — `real-block-run-ai-readiness` validates the block file, opt-in flags, provider config, repo state, branches, and existing state before any mutation.
- **Real block run command** — `real-block-run-ai` executes tasks sequentially, applies changes, commits on the work branch, runs the reviewer gate, performs one fix attempt when rejected, and persists state.
- **Resume** — `real-block-run-ai <blockPath> --resume` continues a previously stopped block run without duplicating completed tasks.
- **Report command** — `real-block-run-ai-report <statePath>` renders a read-only human-readable report from a persisted block state file.
- **Real provider smoke check** — `real-provider-smoke` verifies real AI provider connectivity/config without touching any repository or block state.
- **Product verification** — `npm run verify:product` runs typecheck, build, full test suite, and the local fake demo in one command.
- **GitHub Actions workflow** — `.github/workflows/product-verify.yml` runs the same product verification on every push and pull request to `main`.

## Supported user commands

```bash
# One-command local product verification
npm run demo:block:fake
npm run verify:product

# Block readiness / run / resume
npx tsx src/cli.ts real-block-run-ai-readiness <blockPath>
npx tsx src/cli.ts real-block-run-ai <blockPath>
npx tsx src/cli.ts real-block-run-ai <blockPath> --resume

# Read-only report from persisted state
npx tsx src/cli.ts real-block-run-ai-report <statePath>

# Optional real provider connectivity check (no repo mutation)
export ALLOW_REAL_PROVIDER=true
export KIMI_API_KEY="sk-your-key"
export KIMI_BASE_URL="https://api.moonshot.cn/v1"
npx tsx src/cli.ts real-provider-smoke
```

## End-to-end flow

The demonstrated flow is:

```text
readiness → run → reviewer gate → optional fix → second review → persisted state → report
```

In the local fake demo this entire flow runs without real AI calls or network access, using a temporary repository and deterministic fake responses.

## Safety guarantees

- **Readiness before mutation** — the runner calls the same readiness check used by `real-block-run-ai-readiness` before writing state, spawning children, calling providers, applying patches, or committing.
- **Safe block/task ids** — `block_id` and `task_id` are strictly validated against `^[A-Za-z0-9_-]+$`.
- **No shell interpolation** — child processes are spawned with argument arrays, not shell strings.
- **No raw provider/reviewer/executor output persisted** — only structured, validated results are stored; raw output is discarded after parsing.
- **Redaction** — output and state redact API keys, Bearer tokens, GitHub tokens, and generic `*_TOKEN=` patterns.
- **No merge** — the orchestrator never runs `git merge`.
- **No force push** — push uses normal `git push` only when explicitly allowed.
- **No `main` mutation** — `work_branch` cannot be `main` and cannot equal `base_branch`.
- **Local fake demo uses temp repo only** — it creates a temporary git repository and a local bare remote; nothing is pushed to an external remote.
- **Report command is read-only** — it does not mutate repo, state, or provider state; it does not spawn the block runner or call the network.
- **Real provider smoke check is provider-only** — it validates provider connectivity without repo mutation, block state access, git commands, or block runner spawn.

## State and report path

Block state is persisted at:

```text
runs/block/<block_id>/state.json
```

A run can end as `completed`, `blocked`, or `failed`. After a run finishes, the report command can be used at any time to inspect the outcome:

```bash
npx tsx src/cli.ts real-block-run-ai-report runs/block/<block_id>/state.json
```

## Verification

Local verification:

```bash
npm run verify:product
```

This runs:

1. `npm run typecheck`
2. `npm run build`
3. `npm test`
4. `npm run demo:block:fake`

No real AI credentials or network access are required.

Continuous integration:

- `.github/workflows/product-verify.yml` runs `npm run verify:product` on every push and pull request to `main`.

## Known limitations

- **One fix attempt per rejected task** at the current product slice. If the second review still rejects, the task is marked `fix_required` and the block stops for human review.
- **Real AI provider config must still be supplied for real runs** — keys, base URL, and explicit opt-in flags are required when not using fake responses.
- **No UI yet** — everything is CLI-driven.
- **No multi-provider production presets yet** — provider combinations are configurable but not shipped as curated presets.
- **No distributed/parallel block execution yet** — tasks run sequentially within a single process.
- **Human still owns final review** — the tool prepares commits, reports, and draft PR materials, but merge and release decisions remain manual.

## Portfolio summary

This project demonstrates an autonomous AI coding orchestrator with block execution, reviewer gate, one-attempt fix loop, persisted state, resume, reporting, and both local and CI-based product verification. It is built as a TypeScript Node.js CLI with strict safety defaults, deterministic fake modes for testing, and explicit opt-in gates for any real provider or repository mutation.
