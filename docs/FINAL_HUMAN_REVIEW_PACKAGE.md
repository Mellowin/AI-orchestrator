# Mini-MVP Final Human Review Package

**Branch:** `feature/mvp-skeleton`
**Final accepted head:** `c053e7091319c974bfe6f712c1333478f987d733`

---

## What the mini-MVP does

AI Orchestrator is an autonomous Node.js CLI tool that takes a block definition (a JSON file with one or more tasks), calls an AI coder to generate file changes, runs deterministic safety checks, commits the result locally, and calls an AI reviewer to validate the commit. If checks fail or the reviewer requests changes, the system enters a bounded fix-loop and retries the same task with redacted failure context.

The orchestrator never merges, never pushes unless explicitly allowed, and never touches `main`.

---

## What has been proven

| Capability | Evidence |
|---|---|
| Real Kimi coder works | Stage 6.15, 6.16 — live API calls with real file generation |
| Real Kimi reviewer works | Stage 6.15, 6.16 — live diff review with `accepted`/`rejected` decisions |
| Deterministic checks work | Guardrails, line-delta checks, secret detection, merge-conflict detection |
| Autonomous fix-loop works | Stage 6.15.2, 6.16 — verifier-driven fix loops with retry bounds |
| Real multi-task block works | Stage 6.16 — 3 tasks executed sequentially in one block run |
| Local commits work | Stage 6.16 — commits created, push disabled by default |
| PR helper/status/cleanup exist | Stage 6.9–6.13 — draft, create, status, cleanup helpers (opt-in only) |
| Operator docs/package exist | Stage 6.17 — runbook, demo package, command cookbook, safety invariants |
| Release-candidate audit passed | Stage 6.18 — internal consistency, safety, and demo-readiness verified |

---

## What has not been claimed

- **Production-ready sandboxing** — the tool runs in the local repo; cloud isolation is not implemented.
- **Cloud CI green** — GitHub Actions workflow runs are empty; CI is not verified.
- **Arbitrary large codebase autonomous edits** — demos use small doc/check tasks; large refactors are untested.
- **Automatic merge** — merge is always manual.
- **Automatic PR without explicit opt-in** — PR creation requires separate env flags and manual invocation.
- **Perfect reviewer quality** — AI reviewer can make mistakes; deterministic checks are the safety net.
- **Security certification** — the tool has safety invariants but no formal audit.

---

## Safety boundaries

- No automatic merge.
- No automatic `main` touch.
- No force push.
- No `git reset --hard`.
- No `git add -A`.
- No GitHub API usage by `block-run`.
- PR creation/update/close/merge/comment/review are opt-in helpers only.
- Token/API key only from environment; never written to files, logs, or state.

See [`docs/SAFETY_INVARIANTS.md`](SAFETY_INVARIANTS.md) for the full invariant list.

---

## How to demo it

1. **Fake block run** (no API keys):
   ```bash
   BLOCK_RUN_MODE=fake npx tsx src/cli.ts block-run docs/live-stage-6-16-block.json
   ```

2. **Real block run** (requires `KIMI_API_KEY`):
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
     npx tsx src/cli.ts block-run docs/live-stage-6-16-block.json
   ```

3. **Inspect evidence**:
   ```bash
   cat runs/blocks/stage-6-16-real-multitask-proof/block-state.json
   git log --oneline -5
   ```

See [`docs/DEMO_COMMAND_COOKBOOK.md`](DEMO_COMMAND_COOKBOOK.md) for the full command reference.

---

## Where to find evidence

| Document | Purpose |
|---|---|
| [`docs/STAGE6_16_REAL_MULTITASK_BLOCK_PROOF.md`](STAGE6_16_REAL_MULTITASK_BLOCK_PROOF.md) | Full multi-task autonomous run with fix loop |
| [`docs/STAGE6_15_2_FULL_FIX_LOOP_MATRIX_PROOF.md`](STAGE6_15_2_FULL_FIX_LOOP_MATRIX_PROOF.md) | Multi-scenario fix-loop matrix proof |
| [`docs/STAGE6_18_RELEASE_CANDIDATE_AUDIT.md`](STAGE6_18_RELEASE_CANDIDATE_AUDIT.md) | Release-candidate audit report |
| [`TESTING_SUMMARY.md`](../TESTING_SUMMARY.md) | All completed stages, test metrics, verification commits |
| [`PHASE4_PLAN.md`](../PHASE4_PLAN.md) | Roadmap, stage definitions, acceptance criteria |

---

## Where to find operator docs

| Document | Purpose |
|---|---|
| [`docs/OPERATOR_RUNBOOK.md`](OPERATOR_RUNBOOK.md) | One-page overview, core loop, modes, safety defaults |
| [`docs/MINI_MVP_DEMO_PACKAGE.md`](MINI_MVP_DEMO_PACKAGE.md) | What is proven, what is not claimed, known limitations |
| [`docs/DEMO_COMMAND_COOKBOOK.md`](DEMO_COMMAND_COOKBOOK.md) | Exact commands for fake, real coder, real reviewer runs |
| [`docs/SAFETY_INVARIANTS.md`](SAFETY_INVARIANTS.md) | Hard design-level guarantees |

---

## Known limitations

- **GitHub CI not verified** — workflow runs are empty; local tests only.
- **Current demos are doc/check based** — the tool edits markdown and runs node verifiers; complex TypeScript refactors are demoed via tests, not live autonomous runs.
- **Real provider behavior can vary** — API latency, quota, and output quality depend on the provider account.
- **Check design matters** — a poorly written verifier can cause infinite fix loops or false blocks.
- **Repository mutation still needs human control** — push and merge are manual; the tool stops at `completed`.

---

## Recommended reviewer checklist

- [ ] Read [`docs/SAFETY_INVARIANTS.md`](SAFETY_INVARIANTS.md) and confirm invariants match code.
- [ ] Read [`docs/OPERATOR_RUNBOOK.md`](OPERATOR_RUNBOOK.md) and confirm core loop is understandable.
- [ ] Run `npm run typecheck`, `npm run build`, `npm test` locally and confirm pass.
- [ ] Run fake block run (`BLOCK_RUN_MODE=fake`) and confirm no API calls are made.
- [ ] Verify no raw secrets in `README.md`, `docs/*.md`, `TESTING_SUMMARY.md`, `PHASE4_PLAN.md`.
- [ ] Confirm `ALLOW_REAL_REPO_PUSH=false` in demo commands.
- [ ] Confirm no automatic merge language exists in docs.
- [ ] Confirm GitHub CI is described as "not verified / no workflow runs".
- [ ] Confirm no source code or test changes were made in this stage.
