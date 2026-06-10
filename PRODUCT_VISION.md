# AI Orchestrator Product Vision

> **Purpose:** Fix the original product goal in writing so that future work does not drift into "more demos", "more docs", or "more PR status reports". This document is the source of truth for why this project exists.

---

## 1. Original User Goal

The user wants a program that can **autonomously manage a block of development tasks with AI agents**.

The desired flow:

```text
User defines block of 5–10 small tasks
        ↓
Orchestrator sends task to Coder AI
        ↓
Coder AI writes code
        ↓
System applies / checks / commits / pushes
        ↓
System gets full commit hash
        ↓
Reviewer AI reviews actual commit / diff / status
        ↓
accepted → next task
rejected → fix task back to Coder AI
        ↓
repeat until block is complete
```

The human defines the block, provides API keys, and reviews the final result. The human does **not** manually shuttle every output between Coder and Reviewer.

---

## 2. What This Project Is

- **Autonomous AI development orchestrator** — it runs tasks without human intervention between coder and reviewer.
- **Block-based task runner** — tasks are grouped into blocks; the block completes only when all tasks are accepted.
- **Multi-provider AI architecture** — coder and reviewer can be different AI providers; neither is hardcoded.
- **Reviewer-gated workflow** — every task must pass an AI reviewer before the block advances.
- **Human-outside-the-loop for individual tasks** — the human does not need to manually pass every task between coder and reviewer.
- **Human-inside-the-loop for the block** — the human reviews the final block report / PR / status and decides merge.

---

## 3. What This Project Is NOT

- **Not only a demo script** — the MVP proved the pipeline works; the product target is autonomous block execution.
- **Not only a portfolio project** — the goal is a working tool, not a showcase.
- **Not only manual ChatGPT review** — the reviewer is called by the system, not by the user copy-pasting into a chat UI.
- **Not only a Kimi wrapper** — Kimi is the first provider target; the architecture must accept others.
- **Not a merge bot** — merge remains a manual human decision.
- **Not an auto-main writer** — `main` is never touched automatically.
- **Not a production autonomous merge system yet** — merge safety requires a separate design phase.

---

## 4. Core Product Principles

| Principle | Meaning |
|---|---|
| **Blocks, not one-off tasks** | A user defines a block of related tasks. The orchestrator runs the whole block autonomously. |
| **Small tasks inside a block** | Each task is small enough to be coded, checked, and reviewed in one pass. |
| **AI coder and AI reviewer are separate roles** | Coder writes code. Reviewer reviews the actual commit. They are not the same prompt. |
| **Providers are interchangeable** | Coder can be Kimi, Claude, Gemini, OpenAI, DeepSeek, Qwen, or any OpenAI-compatible endpoint. Reviewer can be a different provider. |
| **Deterministic checks run before AI reviewer** | Typecheck, build, test, guardrails, and git safety checks run before the reviewer is ever called. |
| **Reviewer gate cannot be skipped** | A task is not "done" until the reviewer accepts it. No flag overrides this. |
| **Fix loop is part of the system** | If the reviewer rejects, the orchestrator creates a fix task and sends it back to the coder automatically. |
| **Merge remains outside MVP** | The system stops before merge. Human decides. |
| **Main remains protected** | No automatic commit, push, or merge to `main`. |

---

## 5. First Autonomous Target

The first implementation target is:

- **Kimi as Coder**
- **Kimi as Reviewer**

Details:
- The same Kimi API key can be used for both roles.
- Coder and Reviewer use **different prompts and system roles**.
- The Reviewer must review **factual commit evidence** (diff, test results, commit SHA), not the Coder's self-report.
- Tests must use **fake providers**, not real Kimi calls.

This target is chosen because:
- Kimi integration already exists for the Coder role.
- It proves the architecture supports same-provider dual-role.
- It is the fastest path to a working autonomous loop.

---

## 6. Future Provider Combinations

The architecture must support these combinations without code changes to the core loop:

| Coder | Reviewer |
|---|---|
| Kimi | Kimi |
| Kimi | Claude |
| Claude | Gemini |
| Gemini | OpenAI |
| DeepSeek | Kimi |
| OpenAI | Qwen |

Future extensions:
- **Multiple reviewers** — a task can be reviewed by more than one AI before acceptance.
- **Multiple coders** — different tasks in a block can use different coder providers.
- **Specialized roles** — planner, summarizer, security reviewer.

---

## 7. Human Role

### Human SHOULD:
- Define the block of tasks.
- Provide provider keys and configuration.
- Run the autonomous block command.
- Inspect the final block report / PR / status.
- Manually decide whether to merge.

### Human should NOT be required to:
- Copy every Kimi result into ChatGPT.
- Manually ask the reviewer to check every commit.
- Manually decide the next task after every accepted commit.
- Fix trivial issues that the AI can repair itself.

---

## 8. Success Criteria for Autonomous Block Mode

The product is successful when a user can:

1. Write a `tasks.yaml` block with 3–5 small tasks.
2. Run one command.
3. Walk away.
4. Return to find:
   - All accepted tasks committed and pushed.
   - All rejected tasks auto-fixed and re-reviewed.
   - A block report summarizing what happened.
   - No merge performed.
   - `main` untouched.
