# MVP Test Hardening Summary

**Branch:** `feature/mvp-skeleton`

**Last verified:** `34dc4c055b3cc0aa708a97ccc2612ad666f9ea89`

## Test metrics

- **Total tests:** 274
- **Total suites:** 34
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
| CLI entrypoint | `test/cli.test.ts`, `test/cli-*.test.ts` | Usage, missing args, missing task, mock provider, env override |
| E2E mock smoke | `test/e2e-mock-smoke.test.ts` | Full happy path: ai-generate → ai-apply, file update, approved state, no push |
| CI | `.github/workflows/ci.yml` | typecheck / build / test on PR and `feature/mvp-skeleton` push |

## Safety guarantees

- **Mock AI only:** All tests use `AI_PROVIDER=mock` or fake `fetchFn`. No real OpenAI/Kimi API calls.
- **No auto-push / auto-merge:** Smoke flow asserts work branch is created locally and never pushed.
- **No destructive git ops:** No `git push`, `git merge`, `git reset --hard`, or `git clean -fd` in test or production code.
- **Temp directories:** Every filesystem test uses `mkdtempSync` and cleans up in `finally`.
- **No real secrets required:** `.env` is optional for tests; all sensitive env vars are deleted before spawning child processes.

## Known limitation

- **Reviewer parser exists, but full Coder → Reviewer → Coder loop is not wired yet.** `validateReviewVerdict` and `parseReviewerOutputJson` are implemented and tested, but the pipeline does not yet use them in an iterative review loop.

## Next recommended work

1. Wire reviewer parser into the real pipeline loop (Coder → Reviewer → Coder iterations with mock responses).
2. Add focused pipeline-loop tests with mock coder/reviewer responses.
3. Keep no real API calls, no push, no merge.
