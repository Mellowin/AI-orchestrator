# Provider Architecture

> **Purpose:** Document the provider abstraction layer that enables combining different AI providers for coding, reviewing, fixing, planning, and summarizing.

---

## 1. Product Goal

Users can mix AI providers. The orchestrator is never hardcoded to a single provider.

Examples:
- Kimi coder + Kimi reviewer
- Kimi coder + Claude reviewer
- Claude coder + Gemini reviewer
- Gemini coder + OpenAI reviewer
- DeepSeek coder + Kimi reviewer
- Multi-reviewer mode (future)
- Multi-coder mode (future)

---

## 2. Provider Roles

| Role | Responsibility |
|---|---|
| **coder** | Writes code, produces `file_update` output |
| **reviewer** | Reviews commit/diff/test evidence, produces `accepted`/`rejected` decision |
| **fixer** | Receives rejection feedback, produces corrected code (same as coder with repair prompt) |
| **planner** | Breaks a large goal into small tasks for a block (future) |
| **summarizer** | Produces the final block report for human review (future) |

---

## 3. Provider Interfaces

```ts
interface CoderProvider {
  readonly id: ProviderId;
  readonly role: 'coder';
  runTask(input: CoderTaskInput): Promise<CoderResult>;
  runFix(input: CoderTaskInput): Promise<CoderResult>;
}

interface ReviewerProvider {
  readonly id: ProviderId;
  readonly role: 'reviewer';
  reviewCommit(input: ReviewInput): Promise<ReviewerDecision>;
}
```

The core loop calls these interfaces without knowing which backend serves them.

---

## 4. Implemented Now

| Component | Status | Location |
|---|---|---|
| Provider types | ✅ | `src/providers/provider-types.ts` |
| Provider registry | ✅ | `src/providers/provider-registry.ts` |
| Fake coder provider | ✅ | `src/providers/fake/fake-coder-provider.ts` |
| Fake reviewer provider | ✅ | `src/providers/fake/fake-reviewer-provider.ts` |
| Kimi coder adapter | ✅ | `src/providers/kimi/kimi-coder-provider.ts` |
| Kimi reviewer provider | ✅ | `src/providers/kimi/kimi-reviewer-provider.ts` |
| Reviewer decision schema | ✅ | `src/reviewer/reviewer-schema.ts` |
| Reviewer prompt builder | ✅ | `src/reviewer/reviewer-prompt.ts` |
| Reviewer gate dry-run CLI | ✅ | `reviewer-gate-dry-run` in `src/cli.ts` |

---

## 5. Not Implemented Yet

- OpenAI real adapter
- Claude real adapter
- Gemini real adapter
- DeepSeek real adapter
- Qwen real adapter
- Mistral real adapter
- Multi-reviewer mode
- Multi-coder mode

Adding any of these requires only:
1. A new adapter file implementing `CoderProvider` or `ReviewerProvider`.
2. A registry entry.
3. Tests with fake responses.

No changes to the block runner, task state machine, or reviewer gate.

---

## 6. Provider Registry

The `ProviderRegistry` class registers and resolves providers by ID and role.

```ts
const registry = new ProviderRegistry();
registry.registerCoder('kimi', (config) => createKimiCoderProvider(config));
registry.registerReviewer('kimi', (config) => createKimiReviewerProvider(config));

const coder = registry.resolveCoder({ provider: 'kimi', model: 'kimi-for-coding' });
const reviewer = registry.resolveReviewer({ provider: 'kimi', model: 'kimi-for-coding' });
```

Rules:
- Registry creation does not call providers.
- Registry creation does not read API keys.
- Resolution happens at runtime when a block is executed.
- Unknown providers throw safe errors.

---

## 7. Why the Reviewer Cannot Trust the Coder

The reviewer receives **factual evidence**, not the coder's self-report:

- Task goal
- Allowed/denied files
- Changed files
- Commit SHA
- Actual diff
- Typecheck/build/test results
- Git status
- Safety findings

The reviewer prompt explicitly states:

> "You review factual evidence only. You do NOT trust the coder's self-report."

This prevents the coder from claiming correctness without proof.

---

## 8. Deterministic Checks Before AI Review

Before the AI reviewer is ever called, the system runs deterministic checks:

- `allowed_files` check
- `denied_files` check
- `max_lines_changed` guardrail
- typecheck/build/test result
- git status clean
- commit exists
- branch not main
- no secrets
- no forbidden git actions
- no merge
- no checkout/switch
- no force push

If any check fails, the task is rolled back and retried. The AI reviewer is not called for failed checks.

---

## 9. First Target: Kimi Coder + Kimi Reviewer

The first autonomous implementation target uses the same Kimi API key in two roles:

- **Coder prompt:** "Write code for this task."
- **Reviewer prompt:** "Strictly review this commit against the evidence."

Both use `src/providers/kimi/kimi-*.ts` adapters with different prompts.

---

## 10. Stage 6.1 — Evidence Layer

Before the AI reviewer is called, the system builds factual evidence:

1. **Commit verifier** (`src/reviewer/commit-verifier.ts`) — validates SHA, reads changed files, diff, git status from local git.
2. **Deterministic checks** (`src/reviewer/deterministic-review-checks.ts`) — validates scope, size, secrets, merge conflicts, branch safety, check results.
3. **Review input builder** (`src/reviewer/review-input-builder.ts`) — assembles `ReviewInput` from evidence.
4. **Reviewer gate** (`src/reviewer/reviewer-gate.ts`) — runs deterministic checks first; only calls AI reviewer if they pass.

The reviewer never sees coder self-report. It sees:
- Task goal
- Allowed/denied files
- Actual diff
- Commit SHA
- Check results
- Safety findings

## 11. Future Combinations

The architecture supports any combination without core loop changes:

```yaml
providers:
  coder: { provider: 'kimi', model: 'kimi-for-coding' }
  reviewer: { provider: 'claude', model: 'claude-sonnet-4' }
```

The only requirement is an adapter file for each provider.
