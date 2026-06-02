# MVP Test Hardening Summary

**Branch:** `feature/mvp-skeleton`

**Last verified:** `0753dfb0be205923b5b2cd91ac886fd70c6d04c9`

## Test metrics

- **Total tests:** 284
- **Total suites:** 37
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
| CLI entrypoint | `test/cli.test.ts`, `test/cli-*.test.ts` | Usage, missing args, missing task, mock provider, env override, pipeline-loop approve / needs_changes / reject / missing reviewer response, real-provider-plan dry-run safeguard |
| Pipeline loop | `test/pipeline-loop.test.ts` | approve keeps patch, needs_changes rolls back, reject rolls back, invalid reviewer JSON rolls back |
| Pipeline loop CLI | `test/cli-pipeline-loop.test.ts` | approve success, needs_changes failure + rollback, reject failure + rollback, missing MOCK_REVIEWER_RESPONSE |
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

## Next recommended work

1. Design explicit opt-in config/flag for real-provider execution.
2. Add tests that default behavior refuses real-provider execution without opt-in.
3. Keep mock mode as default for tests and local development.
4. Keep no push, no merge, no main touch.
