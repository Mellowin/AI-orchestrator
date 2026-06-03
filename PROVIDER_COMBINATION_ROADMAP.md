# Provider Combination Roadmap

> **Purpose:** Document how the orchestrator supports multiple AI providers for different roles, and map the path from the current Kimi-only Coder implementation to a multi-provider autonomous system.

---

## 1. Provider Roles

The orchestrator defines these roles. Each role can be fulfilled by a different provider.

| Role | Responsibility | Current Status |
|---|---|---|
| **coder** | Writes code, produces `file_update` output. | Kimi implemented. |
| **reviewer** | Reviews commit/diff/test evidence, produces `accepted/rejected` decision. | Not implemented yet. |
| **fixer** | Receives rejection feedback and produces corrected code. | Same as coder with repair prompt. |
| **planner** | Breaks a large goal into small tasks for a block. | Not implemented yet. |
| **summarizer** | Produces the final block report for human review. | Not implemented yet. |

---

## 2. Provider Interfaces

The intended TypeScript interfaces for provider abstraction:

```ts
interface CoderProvider {
  runTask(input: CoderInput): Promise<CoderResult>;
  runFix(input: FixInput): Promise<CoderResult>;
}

interface ReviewerProvider {
  reviewCommit(input: ReviewerInput): Promise<ReviewerDecision>;
}
```

Design rules:
- Providers are **swapped by configuration**, not by code changes.
- The core loop calls `CoderProvider.runTask()` and `ReviewerProvider.reviewCommit()` without knowing which backend serves them.
- Each provider adapter handles its own authentication, request formatting, and response parsing.

---

## 3. Implemented Now

| Component | Status | Notes |
|---|---|---|
| Kimi Coder provider | ✅ Implemented | `createRealProviderCall` with `role: 'coder'`. |
| Reviewer provider abstraction | ❌ Not implemented | No `ReviewerProvider` interface or adapter exists yet. |
| Provider factory | ⚠️ Partial | `createAIClient` supports mock + kimi; needs generalization. |
| Multi-provider config | ❌ Not implemented | `tasks.yaml` has one `AI_PROVIDER`; block config needs `providers.coder` + `providers.reviewer`. |

The current real provider integration exists for the **Kimi coder workflow only**. The reviewer provider contract is the next implementation target.

---

## 4. Immediate Roadmap

### Stage 6.0 — Provider Abstraction Foundation

- Extract provider-agnostic interfaces (`CoderProvider`, `ReviewerProvider`).
- Implement fake coder and fake reviewer for tests.
- Define Kimi reviewer provider contract (same API, different prompt/role).
- Define reviewer decision schema (JSON schema, strict validation).

### Stage 6.1 — Deterministic Commit Verifier for Reviewer Gate

- Build `buildReviewerInput` pure helper that gathers commit evidence.
- Ensure deterministic checks (typecheck/build/test/guardrails) run before reviewer call.
- Validate reviewer output schema before acting on it.

### Stage 6.2 — Block State Runner

- Implement `BlockState` data model and `BlockStateManager`.
- Support save/load block state to `runs/{block_id}/block-state.json`.
- Track task statuses, fix attempts, commit SHAs, reviewer decisions.

### Stage 6.3 — Autonomous One-Task Loop

- Wire Kimi coder + Kimi reviewer for a single task.
- Run full loop: coder → apply → checks → commit → push → reviewer → decision.
- Support fix loop: reviewer rejects → repair prompt → coder retry.

### Stage 6.4 — Autonomous Multi-Task Block Runner

- Run multiple tasks in sequence inside one block.
- Advance to next task only on `accepted`.
- Stop on `blocked` or `block_for_human`.

### Stage 6.5 — Fix Loop

- Bounded retry with `max_fix_attempts`.
- Repair prompt includes reviewer feedback + prior attempt context.
- Final failure stops block, writes report.

### Stage 6.6 — Block Completion Report

- Generate human-readable block report.
- Include task list, commit SHAs, reviewer decisions, fix history, safety notes.
- Write to `runs/{block_id}/block-report.md`.

### Stage 6.7 — Live 3-Task Autonomous Demo

- Define a 3-task block in `tasks.yaml`.
- Run end-to-end with real Kimi coder + Kimi reviewer.
- Document results in `AUTONOMOUS_BLOCK_DEMO_REPORT.md`.

---

## 5. Future Provider Combinations

The architecture must support these without rewriting the core loop:

### 5.1 Kimi Coder + Kimi Reviewer
- Same API key, different system prompts.
- Fastest path to proof. Target for Stage 6.3–6.7.

### 5.2 Kimi Coder + Claude Reviewer
- Coder uses Kimi API. Reviewer uses Anthropic API.
- Proves cross-provider architecture.

### 5.3 Claude Coder + Gemini Reviewer
- Full cross-provider pair.
- Requires both provider adapters implemented.

### 5.4 Gemini Coder + OpenAI Reviewer
- Google + OpenAI pair.
- Tests provider adapter generality.

### 5.5 DeepSeek Coder + Kimi Reviewer
- Budget coder + strong reviewer.
- Tests cost/quality trade-off configuration.

### 5.6 Multi-Reviewer Mode
- One task reviewed by multiple AIs before acceptance.
- Consensus or voting configuration.

### 5.7 Multi-Coder Mode
- Different tasks use different coders based on task type.
- Example: frontend tasks → Claude, backend tasks → Kimi.

---

## 6. Configuration Examples

### Example 1: Kimi Coder + Kimi Reviewer

```yaml
blocks:
  - block_id: demo-block
    providers:
      coder:
        name: kimi
        model: kimi-for-coding
        api_key: ${KIMI_API_KEY}
        base_url: https://api.kimi.com/coding/v1
      reviewer:
        name: kimi
        model: kimi-for-coding
        api_key: ${KIMI_API_KEY}
        base_url: https://api.kimi.com/coding/v1
    review_policy:
      max_fix_attempts: 2
```

### Example 2: Kimi Coder + Claude Reviewer (Future)

```yaml
blocks:
  - block_id: cross-provider-block
    providers:
      coder:
        name: kimi
        model: kimi-for-coding
        api_key: ${KIMI_API_KEY}
      reviewer:
        name: claude
        model: claude-sonnet-4
        api_key: ${ANTHROPIC_API_KEY}
    review_policy:
      max_fix_attempts: 3
```

### Example 3: Multi-Reviewer Future

```yaml
blocks:
  - block_id: security-sensitive-block
    providers:
      coder:
        name: kimi
        model: kimi-for-coding
      reviewers:
        - name: kimi
          model: kimi-for-coding
        - name: claude
          model: claude-sonnet-4
      review_mode: consensus  # all must accept
```

---

## 7. Important Product Rule

> **The orchestrator must never be hardcoded to one AI provider.**

Kimi is the **first implementation target**, not the final architecture limit. Every provider adapter must implement the same interface. The core loop must not contain provider-specific logic. Adding a new provider must require only:
1. A new adapter file.
2. A configuration entry.
3. Tests with fake responses.

No changes to the block runner, task state machine, or reviewer gate.
