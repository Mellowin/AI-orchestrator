# Real Provider Execution Plan

## 1. Current status

| Component | Status |
|-----------|--------|
| `provider-preview` | Mock-only. Uses `createMockProviderCall(MOCK_PROVIDER_RESPONSE)`. No real API calls. |
| `real-provider-plan` | Dry-run only. Prints plan, loads task, validates config. No API, no patch, no git mutation. |
| `real-provider-run` | Refusal stub. Requires `ALLOW_REAL_PROVIDER_RUN=true` and still refuses because execution is not implemented. |
| `createRealProviderCall()` | Throws `real provider call is not implemented yet`. No network code exists. |
| `buildProviderCallInput` | Pure builder. Validates role/prompt/provider/model. No env reads, no network. |
| `normalizeProviderCallResult` | Pure normalizer. Trims whitespace, preserves newlines, validates shape. |
| `normalizeProviderCallError` | Pure error normalizer. Redacts secrets, detects retryable errors, no stack leak. |

## 2. Explicit opt-in rules

- **Real execution requires `ALLOW_REAL_PROVIDER_RUN=true`.** Without this env var, any real-provider command must refuse immediately.
- **No real execution by default.** Default mode for all commands, tests, and CI is mock-only.
- **Tests must stay mock-only.** No test may call a real API, require real API keys, or make network requests. All tests use `AI_PROVIDER=mock`, fake `fetchFn`, or `createMockProviderCall`.
- **Opt-in is per-session, not persistent.** No config file or state file may silently enable real execution.

## 3. Safety boundaries

The following rules are non-negotiable for every phase:

- **No push.** The orchestrator never runs `git push`.
- **No merge.** The orchestrator never runs `git merge`.
- **No main touch.** The `main` branch is never checked out, modified, or reset by the orchestrator.
- **Patch application only after validated AI output.** Every file update passes through `validateKimiOutput` / `validateFileList` and `validateProposedFileLineDeltas` before `applyFileUpdates` is called.
- **Rollback on reviewer rejection.** If the reviewer returns `needs_changes`, `reject`, or outputs invalid JSON, the patch is rolled back via `rollbackFileUpdates` before the next attempt.
- **Guardrails run before and after.** `validateFileList` runs on the generated file list; diff-based checks run before any commit.
- **Backup before patch.** `applyFileUpdates` creates backups in `attempt-N/files-before/`. Rollback uses those backups.

## 4. Proposed future phases

Execution will open in small, reversible phases. No phase may be skipped.

### Phase 1: Real provider call only, no patch/git
- Implement `createRealProviderCall()` for Kimi (and later OpenAI).
- Call the real API, normalize the result with `normalizeProviderCallResult`, print the raw response.
- **No file updates.** No patch engine. No git branch creation.
- Goal: prove API integration, prompt formatting, and error handling in isolation.

### Phase 2: Parse provider output only, no patch/git
- Feed the real response through `parseKimiOutputJson` / `parseReviewerOutputJson`.
- Run full guardrails (`validateFileList`, `validateProposedFileLineDeltas`) on the parsed output.
- Print the proposed diff and guardrails verdict.
- **Still no file updates.** Human reviews the diff before any apply.

### Phase 3: Guarded apply in temp repo / test fixture
- Apply the validated patch to a temporary git repository (a test fixture or clone).
- Run configured checks (`runChecks`) in the temp repo.
- Rollback if checks fail or reviewer rejects.
- Goal: prove the full Coder → Patch → Checks → Reviewer loop in a sandbox.

### Phase 4: Real repo apply behind opt-in
- Move the temp-repo flow to the real `repo_path` from `tasks.yaml`.
- Require `ALLOW_REAL_PROVIDER_RUN=true`.
- Create `work_branch`, apply patch, run checks, run reviewer.
- Rollback on any failure. Human reviews `summary.md` before deciding to push manually.

## 5. Failure handling

All provider-call failures must go through `normalizeProviderCallError`:

- **Secrets redaction:** `sk-...` and `Bearer ...` tokens are stripped from messages.
- **No stack traces in CLI output.** Stack traces may be written to `attempt-N/error.log` for debugging, but never printed to `stderr`.
- **Retryable vs non-retryable:**
  - Retryable: timeout, rate limit, `ECONNRESET`, `ETIMEDOUT`, `temporarily unavailable`. The loop may retry with exponential backoff.
  - Non-retryable: invalid API key (after redaction), malformed response, guardrails failure. The attempt stops immediately.
- **Every failure path prints safety messages:** `No real API call was made` (or equivalent), `No patch was applied`, `No git mutation was performed` — where applicable.

## 6. CI / testing rules

- **No real API calls in CI.** GitHub Actions runs only mock tests.
- **No API keys required for tests.** The test suite passes with an empty `.env` file.
- **Mock mode stays default.** `AI_PROVIDER=mock` is the default in `config.ts`. No PR may change this default without human review.
- **Unit tests for every new phase.** Each phase requires tests before the next phase starts:
  - Phase 1: unit tests for `createRealProviderCall`, fake fetch, error paths.
  - Phase 2: unit tests for parse + guardrails on real-shaped responses.
  - Phase 3: integration tests with temp git repo, full loop with mock AI.
  - Phase 4: E2E smoke test with mock AI in real repo path (no real API yet).

## 7. Human approval

- **No auto-push.** The orchestrator never pushes. The human reads `runs/{task_id}/summary.md` and decides whether to push.
- **No auto-merge.** The orchestrator never merges. Branch cleanup is manual.
- **User reviews report before next action.** After `approved`, `needs_changes`, `rejected`, or `failed_max_attempts`, the human inspects the report before re-running or proceeding.
- **Opt-in is intentional.** Setting `ALLOW_REAL_PROVIDER_RUN=true` is an explicit human decision, not a side effect of another command.
