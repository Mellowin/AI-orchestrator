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

## 11. Stage 6.2 — Block State Runner

The block state runner is **provider-agnostic**. It tracks task and block statuses without knowing which provider executes the coder or reviewer.

- `BlockDefinition` stores provider configuration, but the state manager does not read it.
- `BlockState` tracks `task_id`, `status`, `commit_sha`, `reviewer_decision` — all provider-neutral fields.
- The autonomous loop (Stage 6.3 / 6.4) resolves providers from the registry and updates block state via transitions.
- **Stage 6.4 multi-task loop uses only fake providers.** Real provider multi-task mode is a future stage.

## 12. Stage 6.5 — Real Kimi Coder + Fake Reviewer

Stage 6.5 wires the real Kimi coder provider into the one-task loop while keeping the reviewer fake:

- **Coder:** `createKimiCoderProvider` with real `KIMI_API_KEY` + `KIMI_BASE_URL` read from environment variables at runtime via `buildProviderConfigForRuntime`
- **Reviewer:** `createFakeReviewerProvider` (deterministic gate handles rejection; fake reviewer only called on deterministic pass)
- **Safety:** `validateRealOneTaskModeSafety` enforces flags + branch + clean tree BEFORE provider call
- **Git helpers:** `stageOnlyFiles`, `commitStagedChanges`, `pushCurrentBranch`, `assertNoUnrelatedChanges` in `src/block/block-real-mode-git.ts`
- **Commit message:** `ai-orchestrator: <block_id> <task_id>`
- **Push:** Optional (`ALLOW_REAL_REPO_PUSH`); if disabled, `pushed=false` in result and `pushed_ref` is not set in block state
- **API keys:** Never stored in block JSON. `block-loader.ts` rejects any block definition containing `providers.coder.apiKey` or `providers.reviewer.apiKey`.
- **Push state:** `markTaskPushed` is called only when push succeeds. `markTaskAccepted` preserves `pushed_ref` if set.

## 13. Stage 6.6 — Real Kimi Coder + Real Kimi Reviewer

Stage 6.6 enables the real Kimi reviewer in the one-task loop:

- **Coder:** Same as Stage 6.5 — `createKimiCoderProvider` with `KIMI_API_KEY` + `KIMI_BASE_URL` from env
- **Reviewer:** `createKimiReviewerProvider` with `allowReal: true`, using `KIMI_API_KEY` + `KIMI_BASE_URL` from env
- **Deterministic gate:** `runReviewerGate` calls the real reviewer ONLY after deterministic checks pass. If deterministic checks fail, reviewer is NOT called and the result is `rejected` with `reviewerCalled: false`.
- **State transitions:** Same as Stage 6.5 — `accepted`, `fix_required`, or `blocked` based on reviewer decision.
- **Safety:** Provider resolution happens BEFORE `markTaskInProgress`, so missing `KIMI_API_KEY` fails before state mutation.
- **Tests:** All real Kimi calls in tests use injected fake `fetch` — no real API calls.

## 13. Future Combinations

The architecture supports any combination without core loop changes:

```yaml
providers:
  coder: { provider: 'kimi', model: 'kimi-for-coding' }
  reviewer: { provider: 'claude', model: 'claude-sonnet-4' }
```

The only requirement is an adapter file for each provider.
