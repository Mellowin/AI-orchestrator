# MVP Test Hardening Summary

**Branch:** `feature/mvp-skeleton`

**Last verified:** `594c81d6632b8043ac4fccca4de00b40aee8262a`

## Test metrics

- **Total tests:** 349
- **Total suites:** 40
- **Type check:** strict (`tsc --noEmit`)
- **Build:** `tsc` (ES Modules, NodeNext resolution)

## Covered layers

| Layer | Test file(s) | Key behaviors |
|-------|-------------|---------------|
| TaskLoader | `test/task-loader.test.ts` | YAML parsing, defaults, path traversal, repo validation |
| StateManager | `test/state-manager.test.ts` | Atomic save/load, attempt dirs, path validation |
| GitManager | `test/git-manager.test.ts` | Clean check, branch ops, diff/stat, work-branch prep |
| Guardrails | `test/guardrails.test.ts` | allow/deny, diff size, tests presence, line deltas |
| PatchEngine | `test/patch-engine.test.ts` | Apply, create, backup, rollback, path validation |
| ContextBuilder | `test/context-builder.test.ts` | File reading, metadata, empty context, path guards |
| AI Client | `test/ai-client.test.ts`, `test/kimi-client.test.ts` | Mock client, factory, config mapping, fake fetch, no secret leak |
| AI output validator | `test/kimi-output-validator.test.ts`, `test/ai-response-parser.test.ts` | JSON parsing, fenced blocks, schema validation, unsafe paths |
| Reviewer output validator | `test/reviewer-output-validator.test.ts` | approve / needs_changes / reject, strict schema validation, fenced JSON parsing, secret-safe errors |
| Runner | `test/runner.test.ts` | Exit codes, stdout/stderr, secret env cleanup, command validation |
| CLI entrypoint | `test/cli.test.ts`, `test/cli-*.test.ts` | Usage, missing args, missing task, mock provider, env override, pipeline-loop approve / needs_changes / reject / missing reviewer response, real-provider-plan dry-run safeguard, real-provider-run refusal with task validation after opt-in, provider-preview mock-only output preview |
| Pipeline loop | `test/pipeline-loop.test.ts` | approve keeps patch, needs_changes rolls back, reject rolls back, invalid reviewer JSON rolls back |
| Pipeline loop CLI | `test/cli-pipeline-loop.test.ts` | approve success, needs_changes failure + rollback, reject failure + rollback, missing MOCK_REVIEWER_RESPONSE |
| Provider call | `test/provider-call.test.ts` | Mock provider returns deterministic result, preserves role/provider/model, no network, `createRealProviderCall` implemented for kimi with injected `fetchFn`, not wired to CLI/runtime, validates provider/apiKey/baseUrl/fetchFn (`baseUrl` non-empty and `http://`/`https://`, `fetchFn` is function, trailing slash normalization), sends `Authorization: Bearer`, prompt/model in JSON body, parses `choices[0].message.content`, non-OK HTTP throws safe error without apiKey leak, malformed response throws clear error, `buildProviderCallInput` validates role/prompt/provider/model, runtime invalid-role guard, pure function (no env/network/file mutation), `normalizeProviderCallResult` trims whitespace/preserves internal newlines, validates object/role/text/provider/model at runtime, `normalizeProviderCallError` handles Error/string/unknown input, retryable detection (timeout/rate limit/ECONNRESET/ETIMEDOUT), redacts sk-/Bearer tokens, no stack trace leak |
| Provider preview CLI | `test/cli-provider-preview.test.ts` | Mock provider-call output preview with MOCK_PROVIDER_RESPONSE, uses `buildProviderCallInput` + `createMockProviderCall` + `normalizeProviderCallResult`, `normalizeProviderCallError` in failure path, trimmed response output, internal newlines preserved, no stack trace leak, safety messages on failure, missing env error, missing task error, no file mutation, `--role coder|reviewer` flag with validation |
| E2E mock smoke | `test/e2e-mock-smoke.test.ts` | Full happy path: ai-generate → ai-apply, file update, approved state, no push |
| CI | `.github/workflows/ci.yml` | typecheck / build / test on PR and `feature/mvp-skeleton` push |

## Safety guarantees

- **Mock AI only:** All tests use `AI_PROVIDER=mock` or fake `fetchFn`. No real OpenAI/Kimi API calls.
- **No auto-push / auto-merge:** Smoke flow asserts work branch is created locally and never pushed.
- **No destructive git ops:** No `git push`, `git merge`, `git reset --hard`, or `git clean -fd` in test or production code.
- **Temp directories:** Every filesystem test uses `mkdtempSync` and cleans up in `finally`.
- **No real secrets required:** `.env` is optional for tests; all sensitive env vars are deleted before spawning child processes.

## Known limitation

- **Minimal pipeline loop is exposed through CLI (`pipeline-loop <taskId>`), but only with mock inputs (`MOCK_AI_RESPONSE` + `MOCK_REVIEWER_RESPONSE`).** Full real-provider multi-attempt Coder → Reviewer → Coder retry loop is still not implemented.
- **`real-provider-plan` exists as a dry-run safeguard, but real-provider execution is not yet implemented.** It only prints a plan without calling APIs, applying patches, or touching git.
- **`real-provider-run` exists as a safe refusal stub.** Without `ALLOW_REAL_PROVIDER_RUN=true` it refuses; even with opt-in it still refuses because execution is not implemented. No API call, no patch, no push, no merge, no main touch.
- **`createRealProviderCall()` is implemented for `provider: 'kimi'` with injected `fetchFn`.** It validates `baseUrl` (non-empty, `http://`/`https://`) and `fetchFn` (callable function), strips trailing slashes from `baseUrl`, sends requests to `/chat/completions`, includes `Authorization: Bearer` header, parses `choices[0].message.content`, and normalizes results. It is **not wired to CLI or runtime execution**. All tests use fake fetch only — no real network calls, no real API keys.
- **`buildProviderCallInput` exists as a pure builder.** Validates role (`coder|reviewer`), prompt, provider, model. No env reads, no network, no file mutation.
- **`normalizeProviderCallResult` exists as a pure normalizer.** Trims leading/trailing whitespace, preserves internal newlines, validates object/role/text/provider/model at runtime. No env reads, no network, no file mutation.
- **`normalizeProviderCallError` exists as a pure error normalizer.** Accepts Error/string/unknown, trims message, detects retryable cases (timeout, rate limit, temporarily unavailable, ECONNRESET, ETIMEDOUT), redacts sk-/Bearer tokens, never leaks stack traces. No env reads, no network, no file mutation.
- **`provider-preview <taskId>` uses only mock provider-call.** It loads task, builds context/prompt read-only, creates input via `buildProviderCallInput`, calls `createMockProviderCall(MOCK_PROVIDER_RESPONSE)`, normalizes result via `normalizeProviderCallResult`, prints output. Catch path normalizes errors via `normalizeProviderCallError` with safety messages. No real API call, no patch, no git mutation, no task state mutation.

## Real provider execution plan

See `REAL_PROVIDER_PLAN.md` for the phased approach to enabling real API calls safely.

## Next recommended work

1. Phase 1 hardening: plan timeout/retry helpers (docs or pure helpers) before CLI wiring.
2. Keep `createRealProviderCall` disabled behind `ALLOW_REAL_PROVIDER_RUN=true` — not wired to CLI yet.
3. Keep mock mode as default for tests and local development.
4. Keep no push, no merge, no main touch.
