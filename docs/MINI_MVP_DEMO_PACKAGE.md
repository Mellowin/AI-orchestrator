# Mini-MVP Demo Package

## Purpose

This document summarizes what the AI Orchestrator mini-MVP has proven, what it explicitly does **not** claim, and how to demonstrate it to an operator or reviewer without deep codebase knowledge.

---

## What is proven

| Capability | Evidence |
|---|---|
| Real Kimi coder call | Stage 6.15, 6.16 — live API calls with real file generation |
| Real Kimi reviewer call | Stage 6.15, 6.16 — live diff review with `accepted`/`rejected` decisions |
| Deterministic check failure → fix retry | Stage 6.15.1, 6.15.2, 6.16 — verifier-driven fix loops |
| Multi-task block execution | Stage 6.16 — 3 tasks executed sequentially in one block run |
| Local commits with `pushed=false` | Stage 6.16 — commits created, push disabled by default |
| Max fix attempts safety | Stage 6.15.2 Scenario B — task blocked after exhaustion |
| Global attempt cap safety | Stage 6.15.2 Scenario C — loop stops safely, state resumable |
| PR tools exist (separate/manual) | Stage 6.9–6.13 — draft, create, status, cleanup helpers |

---

## What is not claimed

- **Production-ready sandboxing** — the tool runs in the local repo; cloud isolation is not implemented.
- **Cloud CI green** — GitHub Actions workflow runs are empty; CI is not verified.
- **Arbitrary large codebase autonomous edits** — demos use small doc/check tasks; large refactors are untested.
- **Automatic merge** — merge is always manual.
- **Automatic PR without explicit opt-in** — PR creation requires separate env flags and manual invocation.
- **Perfect reviewer quality** — AI reviewer can make mistakes; deterministic checks are the safety net.
- **Security certification** — the tool has safety invariants but no formal audit.

---

## Demo flow

1. **Show the block definition**
   ```bash
   cat docs/live-stage-6-16-block.json
   ```
   Explain: tasks, allowed files, checks, review policy.

2. **Run a fake block for speed**
   ```bash
   BLOCK_RUN_MODE=fake npx tsx src/cli.ts block-run docs/live-stage-6-16-block.json
   ```
   Show: tasks transition `pending → accepted`, no API calls.

3. **Run a real block (requires API key)**
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
   Show: live API calls, local commits, reviewer decisions, fix loop on doc-2.

4. **Inspect evidence**
   ```bash
   cat runs/blocks/stage-6-16-real-multitask-proof/block-state.json
   git log --oneline -5
   cat docs/STAGE6_16_REAL_MULTITASK_BLOCK_PROOF.md
   ```

---

## Known limitations

- **GitHub CI not verified** — workflow runs are empty; local tests only.
- **Current demos are doc/check based** — the tool edits markdown and runs node verifiers; complex TypeScript refactors are demoed via tests, not live autonomous runs.
- **Real provider behavior can vary** — API latency, quota, and output quality depend on the provider account.
- **Check design matters** — a poorly written verifier can cause infinite fix loops or false blocks.
- **Repository mutation still needs human control** — push and merge are manual; the tool stops at `completed`.

---

## Recommended next engineering steps

1. **Cloud sandbox** — run block execution inside an isolated container or temp repo copy.
2. **CI wiring** — add a GitHub Actions workflow that runs the test suite on push.
3. **Provider registry expansion** — wire Claude, DeepSeek, or OpenAI as alternative coders/reviewers.
4. **Larger task demos** — autonomous edit of a real TypeScript module with compile + test checks.
5. **Review quality metrics** — track reviewer accuracy, false accepts, and false rejects.
