# AI Orchestrator — Operator Golden Path

This document gives a single, safe, repeatable path a human operator can run from a clean checkout to confirm the current MVP works. No API keys are required. No real repository is mutated.

## What this project does

AI Orchestrator is a Node.js CLI tool that reads task definitions from a `block.json` file, runs a mock or real AI coder, runs a mock or real reviewer, applies guardrails, executes checks, and manages attempt state in a local `runs/` directory. The MVP supports fully fake/local runs that prove the pipeline end-to-end without calling external AI services or touching real repositories.

## Current safe MVP mode

The safe, operator-ready mode uses **fake providers** and **disposable local repositories**. It exercises:

- block init, validate, checklist, dry-run, readiness, run, and report commands
- fake Kimi coder and reviewer responses
- local git operations inside a throw-away temp repo
- rollback and fix-loop state transitions

Nothing in the golden path calls the real Kimi API, pushes to GitHub, or modifies the `ai-orchestrator` repository itself.

## Prerequisites

- Node.js 20+
- npm
- git
- A clean checkout of `ai-orchestrator`
- No uncommitted changes (recommended, not enforced by the script)

## Golden path commands

Run these from the repository root, in order:

```bash
# 1. Verify TESTING_SUMMARY evidence lock is green.
npm run verify:summary

# 2. Type-check the TypeScript sources.
npm run typecheck

# 3. Build the project.
npm run build

# 4. Run the evidence verifier unit test.
npx tsx --test test/verify-testing-summary.test.ts

# 5. Run the operator golden path smoke.
npm run demo:operator-golden-path
```

The last command is equivalent to running the following safe sub-commands in one shot:

```bash
npm run verify:summary
npm run typecheck
npm run build
npx tsx --test test/verify-testing-summary.test.ts
npm run demo:block:fake
npm run demo:disposable-pilot
```

## What each command proves

| Command | What it proves |
|---|---|
| `npm run verify:summary` | `TESTING_SUMMARY.md` evidence matches `HEAD` (or `HEAD~1` for a docs-only update), required package scripts exist, Product verification workflow is manual-only, and no debug markers are present. |
| `npm run typecheck` | The TypeScript project compiles under `strict` mode. |
| `npm run build` | The project builds cleanly to `dist/` as ES Modules. |
| `npx tsx --test test/verify-testing-summary.test.ts` | The evidence verifier logic itself passes its own unit tests. |
| `npm run demo:block:fake` | The full block runner pipeline works with fake providers: init → validate → checklist → dry-run → readiness → run → report, including a reject→fix→accept loop. |
| `npm run demo:disposable-pilot` | The disposable pilot can prepare a throw-away repo and block file; without real-provider opt-ins it prints the command needed for a real run and exits safely. |

## Expected success output/signals

All commands must exit with code `0`. You should see:

- `TESTING_SUMMARY verification passed.`
- `npm run typecheck` produces no errors.
- `npm run build` produces no errors.
- `npx tsx --test test/verify-testing-summary.test.ts` reports `# pass 7`, `# fail 0`.
- `npm run demo:operator-golden-path` ends with a summary similar to:

```text
=== Operator Golden Path Summary ===
All 6 steps passed.
- verify:summary
- typecheck
- build
- verify-testing-summary.test.ts
- demo:block:fake
- demo:disposable-pilot
No real AI provider was called.
No git push/commit/merge/checkout was performed on this repository.
```

## Safe / read-only commands

These commands do not write to the project repository or call external APIs:

- `npm run verify:summary`
- `npm run typecheck`
- `npm run build`
- `npx tsx --test test/verify-testing-summary.test.ts`
- `npm run demo:operator-golden-path`
- `npm run demo:block:fake`
- `npm run demo:disposable-pilot` (without real-provider opt-ins)

## Commands that create disposable / local temp data only

These commands create temporary directories under the system temp folder. They clean up after themselves unless `KEEP_DEMO_ARTIFACTS=1` is set:

- `npm run demo:block:fake`
- `npm run demo:disposable-pilot`

Temp directories are named `ai-orchestrator-demo-*` and `ai-orchestrator-disposable-pilot-*`.

## Commands that must NOT be run without explicit human approval

The following commands can mutate real repositories, call real AI APIs, or push to remotes. Do not run them unless you have explicitly decided to do so and have the required environment variables:

- Any command with `ALLOW_REAL_PROVIDER=true` or `ALLOW_REAL_PROVIDER=1`
- Any command using `KIMI_API_KEY`
- `real-block-run-ai`, `real-repo-run-ai`, and similar real-provider paths
- `git push`, `git commit`, `git merge`, `git checkout`, `git switch` inside a real target repository configured in a block file
- `ALLOW_REAL_REPO_APPLY=true`, `ALLOW_REAL_REPO_COMMIT=true`, `ALLOW_REAL_REPO_PUSH=true`

## Where to check evidence

| Source | What it shows | How to check |
|---|---|---|
| `TESTING_SUMMARY.md` | Latest verified commit, CI run numbers, Product verification status | Read the top of the file and confirm `Last verified` matches the current code commit or the previous docs-only summary commit. |
| Mini-MVP CI | Automated typecheck/build/test/verify:summary on `push`/`pull_request` | Open `.github/workflows/ci.yml` and check the latest GitHub Actions run on `main`. |
| Product verification | Heavy, manual-only full verification | Open `.github/workflows/product-verify.yml` and trigger/run `workflow_dispatch` only when explicitly needed. |

## Known limits

- **Product verification is manual-only.** It is triggered by `workflow_dispatch` and is intentionally not run on every push. See `.github/workflows/product-verify.yml`.
- **Real AI/provider paths require explicit opt-in gates.** Without `ALLOW_REAL_PROVIDER`, `KIMI_API_KEY`, and related variables, the CLI refuses to call real providers.
- **Real repo mutation paths require explicit allow flags.** Even with a real provider, `ALLOW_REAL_REPO_APPLY`, `ALLOW_REAL_REPO_COMMIT`, and `ALLOW_REAL_REPO_PUSH` must each be set to `true` before any file changes, commits, or pushes happen.
- The golden path does **not** prove real Kimi/OpenAI connectivity. It proves the local pipeline, guardrails, and state management are healthy.
- The golden path does **not** prove Windows/libuv edge cases or CI-specific chunk timeouts. Those are covered by Product verification and Mini-MVP CI respectively.

## Quick reference

```bash
# One command to prove the MVP is operator-ready:
npm run demo:operator-golden-path
```
