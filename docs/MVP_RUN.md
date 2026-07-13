# MVP Run

`mvp-run` is the product-facing command for autonomous multi-task execution with AI Orchestrator.

One config file, one command, no manual orchestration.

## Quick start

```bash
# Safe fake demo (no real AI, no repo mutation)
npx tsx src/cli.ts mvp-run configs/mvp-run.example.json

# Or via package script
npm run mvp:run -- configs/mvp-run.example.json
```

## What it does

1. Reads a single JSON config.
2. Validates environment variables and opt-ins.
3. Prints a preflight summary.
4. Prepares the target repo and work branch.
5. Runs tasks autonomously (fake or real Kimi provider).
6. Enforces guardrails and recovers from provider bad output.
7. Runs configured tests/checks.
8. Commits and pushes when enabled.
9. Optionally creates a draft PR.
10. Writes a human-readable `report.md` and machine-readable `report.json`.
11. Prints a final verdict.

## Config

See `configs/mvp-run.example.json`.

Key fields:

- `provider`: `"fake"` or `"kimi"`
- `repo_path`: local path to the target git repository
- `repo_slug`: `"owner/repo"` — required only for PR creation
- `base_branch`, `work_branch`: branch configuration
- `run_id`: unique identifier for this run
- `allow_real_provider`: set to `true` to call real Kimi
- `allow_real_repo_apply/commit/push`: mutation opt-ins
- `allow_github_pr_create`: PR creation opt-in
- `tasks`: list of tasks with `id`, `title`, `goal`, `allowed_files`, `denied_files`, `tests`

## Safety

By default the example config uses:

- `provider: "fake"` — no real AI provider call
- `allow_real_repo_apply: false` — no file changes
- `allow_github_pr_create: false` — no PR created

To execute tasks for real you must set both config flags **and** environment opt-ins.

## Real run

```bash
export AI_PROVIDER=kimi
export KIMI_API_KEY=...
export KIMI_BASE_URL=https://api.moonshot.cn/v1
export KIMI_MODEL=kimi-k2.6
export ALLOW_REAL_PROVIDER_RUN=true
export ALLOW_REAL_REPO_APPLY=true
export ALLOW_REAL_REPO_COMMIT=true
export ALLOW_REAL_REPO_PUSH=true

npx tsx src/cli.ts mvp-run my-real-config.json
```

## Resume

To continue from a previous run without re-running completed tasks:

```bash
npx tsx src/cli.ts mvp-run my-config.json --resume
```

Resume uses the existing block state under `report_dir/<run_id>/runs/`.

## Reports

Reports are written to:

```
<report_dir>/<run_id>/report.md
<report_dir>/<run_id>/report.json
<report_dir>/<run_id>/block.json
<report_dir>/<run_id>/runs/
```

## Final verdicts

- `MVP_RUN_PASSED` — all tasks completed.
- `MVP_RUN_PASSED_WITH_CAVEATS` — completed, but some tasks were skipped or no execution happened (safe mode).
- `MVP_RUN_NEEDS_HUMAN` — a task is blocked or needs manual fix.
- `MVP_RUN_FAILED` — a failure occurred (provider bad output, config error, etc.).

## Required environment variables

| Mode | Required env |
|------|--------------|
| Fake provider | None |
| Real provider | `AI_PROVIDER=kimi`, `KIMI_API_KEY`, `KIMI_BASE_URL`, `KIMI_MODEL`, `ALLOW_REAL_PROVIDER_RUN=true` |
| Repo apply | `ALLOW_REAL_REPO_APPLY=true` |
| Repo commit | `ALLOW_REAL_REPO_COMMIT=true` |
| Repo push | `ALLOW_REAL_REPO_PUSH=true` |
| PR create | `ALLOW_GITHUB_PR_CREATE=true`, `GITHUB_TOKEN` |

## Observability

`mvp-run` is the execution layer. For diagnosing CI failures after a run, use the read-only `diagnose-ci` command instead of sending screenshots:

```bash
npx tsx src/cli.ts diagnose-ci configs/diagnose-ci.example.json
npm run diagnose:ci -- configs/diagnose-ci.example.json
```

See `docs/AGENT_ACCESS.md` for token permissions and verdicts.
