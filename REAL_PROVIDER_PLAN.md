# Real Provider Execution Plan

## 1. Current status

| Component | Status |
|-----------|--------|
| `provider-preview` | Mock-only. Uses `createMockProviderCall(MOCK_PROVIDER_RESPONSE)`. No real API calls. |
| `real-provider-preview` | Implemented behind `ALLOW_REAL_PROVIDER_RUN=true`. Requires `KIMI_API_KEY` + `KIMI_BASE_URL`, optional `KIMI_MODEL`. `KIMI_FAKE_RESPONSE` test seam creates injected fake fetchFn. Production path uses `globalThis.fetch`. Parse-only: runs `parseKimiOutputJson`, `validateFileList`, `validateProposedFileLineDeltas`, prints proposed diff summary. Read-only: no patch, no git, no state mutation. Tests/CI use fake response only. |
| `real-provider-plan` | Dry-run only. Prints plan, loads task, validates config. No API, no patch, no git mutation. |
| `real-provider-run` | Refusal stub. Requires `ALLOW_REAL_PROVIDER_RUN=true` and still refuses because execution is not implemented. |
| `createRealProviderCall()` | Implemented for `provider: 'kimi'`. Accepts `apiKey`, `baseUrl`, injected `fetchFn`, optional `model`. Sends POST to `/chat/completions` with `Authorization: Bearer` header, parses `choices[0].message.content`, normalizes via `normalizeProviderCallResult`. Not wired to CLI or runtime execution. Tests use fake fetch only. |
| `buildProviderCallInput` | Pure builder. Validates role/prompt/provider/model. No env reads, no network. |
| `normalizeProviderCallResult` | Pure normalizer. Trims whitespace, preserves newlines, validates shape. |
| `getProviderRetryDecision()` | Pure helper. Exponential backoff retry policy (attempt 1→1000ms, 2→2000ms, 3→4000ms, 4+→no retry). Non-retryable → no retry immediately. Not wired to `createRealProviderCall` or CLI yet. |
| `createSandboxRepoCopy()` | Pure helper. Creates isolated temp copy of source repo, excludes `.git`, `node_modules`, `runs`, `.env`, `.env.*`. No git commands, no state write. Wired to `sandbox-apply-preview` CLI. |
| `applyToSandboxRepo()` | Pure helper. Applies validated `FileUpdate[]` inside sandbox only, delegates to patch-engine for apply/rollback/path validation. No git mutation, no state write. Wired to `sandbox-apply-preview` CLI. |
| `runSandboxApplyFlow()` | Pure helper. Orchestrates parse → guardrails → sandbox copy → apply → checks → rollback/cleanup. Checks run only in sandbox path. Real repo untouched. No state write. Wired to `sandbox-apply-preview` CLI. |
| `sandbox-apply-preview` | Implemented behind `ALLOW_SANDBOX_APPLY_PREVIEW=true`. Requires `SANDBOX_PROVIDER_RESPONSE` + `SANDBOX_ROOT`. Uses `runSandboxApplyFlow`. No real provider call, no network, no API keys, no real repo mutation, no state write. |
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
**Status: abstraction and tests complete. Not wired to CLI/runtime yet.**

- ✅ Implement `createRealProviderCall()` for Kimi with injected `fetchFn`.
- ✅ Validate `provider === 'kimi'` and non-empty `apiKey` at factory time.
- ✅ Send POST to `/chat/completions` with `Authorization: Bearer {apiKey}`, `Content-Type: application/json`, body containing `model` and `messages: [{role: 'user', content: prompt}]`.
- ✅ Parse `choices[0].message.content` from response.
- ✅ Normalize result via `normalizeProviderCallResult` before returning.
- ✅ Non-OK HTTP throws safe Error without leaking `apiKey`.
- ✅ Malformed response throws clear Error.
- ✅ Tests use fake fetch only — no real network, no real API keys.
- **No file updates.** No patch engine. No git branch creation.
- Goal: prove API integration, prompt formatting, and error handling in isolation.

**Next hardening before CLI wiring:**
- ✅ Validate `baseUrl` (non-empty string, starts with `http://` or `https://`, trailing slash normalization).
- ✅ Validate `fetchFn` (callable function).
- ✅ Implement `getProviderRetryDecision()` pure helper with exponential backoff (1000ms / 2000ms / 4000ms, max 3 retries). Not wired yet.

### Phase 1 CLI preview contract
**Status: implemented with fake-response test seam.**

Command: `real-provider-preview <taskId>`

**Required opt-in:**
- `ALLOW_REAL_PROVIDER_RUN=true` must be set. Without it, the command refuses immediately — before loading task or calling any API.

**Required env/config inputs:**
- `KIMI_API_KEY` — non-empty string.
- `KIMI_BASE_URL` — non-empty string starting with `http://` or `https://`.
- `KIMI_MODEL` — optional. Falls back to `kimi-k2.6`.

**Fake-response test seam:**
- `KIMI_FAKE_RESPONSE` env var creates an injected fake `fetchFn` that returns an OpenAI-compatible response.
- Tests and CI use this seam exclusively. No real network calls in automated tests.
- Production path uses `globalThis.fetch` when the fake seam is not active.

**Behavior (read-only, no mutation):**
1. Load task from `tasks.yaml`.
2. Build context and prompt read-only (same as `provider-preview`).
3. Build `ProviderCallInput` via `buildProviderCallInput`.
4. Create real provider call via `createRealProviderCall` with `apiKey`, `baseUrl`, `fetchFn`.
5. Call provider, normalize result via `normalizeProviderCallResult`.
6. Print raw normalized provider text to stdout.
7. Print safety messages: no patch applied, no git mutation, no state change.

**Strict non-mutation guarantees:**
- No patch engine invocation.
- No git mutation (no branch create, no commit, no push, no merge).
- No state mutation (no `state.json` write).
- No `main` branch touch.

**Failure behavior:**
- No opt-in → refuse before loading task / before API call.
- Missing `KIMI_API_KEY` or `KIMI_BASE_URL` → fail before API call.
- Provider errors (non-OK HTTP, malformed response, network error) → catch, normalize via `normalizeProviderCallError`, print safe error message without apiKey leak.
- No stack traces in `stderr`.
- Every failure path prints safety messages.

**Testing rules:**
- CLI tests use `KIMI_FAKE_RESPONSE` seam — no real network.
- CI must not call real network.
- No real API keys in tests.

**Real API usage:**
- Real Kimi API calls are possible only manually with opt-in (`ALLOW_REAL_PROVIDER_RUN=true`) and valid env vars.
- Tests and CI never call the real API.

### Phase 2: Parse provider output only, no patch/git
**Status: implemented at CLI preview level.**

- ✅ Feed the real response through `parseKimiOutputJson`.
- ✅ Run full guardrails (`validateFileList`, `validateProposedFileLineDeltas`) on the parsed output.
- ✅ Print the proposed diff (current lines → proposed lines, delta, `[new]` tag) and guardrails verdict (`PASS`/`REJECTED`).
- ✅ Standardized failure output: `[real-provider-preview] Error: Guardrails: REJECTED — ...` with safety messages.
- **Still no file updates.** Human reviews the diff before any apply.
- **Still no git mutation.** No branch create, no commit, no push, no merge.
- **Still no state mutation.** No `state.json` write.

### Phase 3: Guarded apply in temp repo / test fixture
**Status: helpers and CLI command implemented.**

- ✅ Implement `createSandboxRepoCopy(sourceRepoPath, sandboxRoot)` — isolated temp copy with exclusions.
- ✅ Implement `applyToSandboxRepo(sandboxRepoPath, files)` — sandbox-scoped apply with rollback via patch-engine.
- ✅ Implement `runSandboxApplyFlow({task, rawProviderText, sandboxRoot})` — orchestrates parse → guardrails → sandbox copy → sandbox apply → checks → cleanup/rollback.
- ✅ Implement `sandbox-apply-preview <taskId>` CLI command.

Command: `sandbox-apply-preview <taskId>`

**Goal:** prove the full Coder → Patch → Checks loop in an isolated sandbox without touching the real repository.

**Required behavior (future orchestration / CLI):**
1. Load task from `tasks.yaml`.
2. Obtain provider output (from existing parse-only flow, cached response, or test fixture).
3. Parse output via `parseKimiOutputJson`.
4. Validate file list via `validateFileList(task.guardrails)`.
5. Validate proposed line deltas via `validateProposedFileLineDeltas(task.repo_path, files, task.guardrails.max_lines_changed)`.
6. Create an isolated temporary copy via `createSandboxRepoCopy(task.repo_path, sandboxRoot)`.
7. Apply patch **only inside the temp repo** via `applyToSandboxRepo(sandboxRepoPath, files)`.
8. Run configured checks (`runChecks`) inside the temp repo.
9. Print apply/check result (success or failure with step).
10. Rollback via returned `rollback()` on failure, or cleanup temp repo on success.

**Current CLI status:**
- `sandbox-apply-preview <taskId>` is implemented behind `ALLOW_SANDBOX_APPLY_PREVIEW=true`.
- It requires `SANDBOX_PROVIDER_RESPONSE` (raw provider text) and `SANDBOX_ROOT` (temp directory path) env vars.
- It does **not** call real providers (no Kimi/OpenAI API calls).
- It delegates to `runSandboxApplyFlow`, which implements steps 3–10.
- Checks run only in the sandbox path; the real repo path is never passed to `runChecks`.
- The real repository remains untouched; sandbox copy is cleaned up on both success and failure.
- No `state.json` is written.

**Strict safety boundaries:**
- **No patch to real `task.repo_path`.** The real repository is never modified.
- **No git mutation in real repo.** No branch create, no commit, no push, no merge in the real repo.
- **No state mutation.** No `state.json` write.
- **No push.** Never runs `git push`.
- **No merge.** Never runs `git merge`.
- **No main touch.** The `main` branch in the real repo is never checked out, modified, or reset.
- **No real repo branch creation.** Work branches are created only inside the temp repo if needed.
- **No real repo commit.** Commits happen only inside the temp repo if needed.
- **Checks run in sandbox only.** `runChecks` receives the sandbox path, never the real `repo_path`.
- **SANDBOX_ROOT must not equal `task.repo_path`.** Enforced by `createSandboxRepoCopy` before any copy/apply.
- **SANDBOX_ROOT must not be inside `task.repo_path`.** Enforced by `createSandboxRepoCopy` before any copy/apply.
- **Rejection happens before sandbox directory creation.** If sandboxRoot is invalid, no temp directory is created inside the real repo.

**Failure behavior:**
- Malformed provider output → fail safely before any file operation.
- Guardrails rejection → fail safely before temp repo creation.
- Patch apply failure → rollback temp repo only via `rollbackFileUpdates`, then fail.
- Checks failure → rollback temp repo only, then fail.
- No stack traces in CLI `stderr`.
- No API key leaks.
- Safety messages always printed: `No patch was applied to real repo`, `No git mutation was performed in real repo`, `No state mutation was performed`.

**Testing rules:**
- Tests must use temp directories only (`mkdtempSync`).
- Tests must not touch the real repository.
- Tests must not call real network.
- Tests must not require API keys.
- Tests must assert real repo files remain unchanged.
- Tests must assert no real repo git branch is created.
- Tests must assert no `runs/{task_id}/state.json` is written.

**Explicit disclaimer:**
- Phase 3 helpers (`createSandboxRepoCopy`, `applyToSandboxRepo`, `runSandboxApplyFlow`) are implemented and **wired to `sandbox-apply-preview` CLI**.
- `sandbox-apply-preview <taskId>` uses env-provided provider response (`SANDBOX_PROVIDER_RESPONSE`), not a real provider call.
- Real repo apply remains forbidden until Phase 4.

### Phase 4: Real repo apply behind opt-in
- Move the temp-repo flow to the real `repo_path` from `tasks.yaml`.
- Require `ALLOW_REAL_PROVIDER_RUN=true`.
- Create `work_branch`, apply patch, run checks, run reviewer.
- Rollback on any failure. Human reviews `summary.md` before deciding to push manually.

## Next recommended work

1. Polish `sandbox-apply-preview` output/error typing if needed.
2. Prepare Phase 4 plan only after human review.
3. Still no real repo apply; still no push/merge/main touch.
4. Keep `createRealProviderCall` and `getProviderRetryDecision` wired only behind opt-in.
5. Keep mock mode as default for tests and local development.

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
