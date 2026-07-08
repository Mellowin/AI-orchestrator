# Autopilot Run

`autopilot-run` is a one-click autonomous command that composes two existing
orchestrator primitives:

- `mvp-run` — product-facing multi-task execution branch.
- `diagnose-ci` — read-only CI failure diagnosis.

After the MVP run finishes, the command can optionally wait for GitHub Actions,
diagnose a red workflow, and run a bounded repair loop using an AI provider.

## Purpose

The goal is to remove the manual hand-off between "execute tasks" and "fix CI".
A single config file describes the repo, the MVP run to execute, the CI to
watch, and the repair policy. The command then drives the loop automatically
until CI is green or a human decision is required.

## Modes

### `fake` (safe default)

- No GitHub token is required.
- No real GitHub API call is made.
- MVP runs in fake mode without repository mutation unless explicitly enabled.
- CI polling returns a deterministic fake green run.

Use this mode for local dry-runs and demos.

### `github` (real CI observation)

- Reads the GitHub token from `process.env[diagnose_config.token_env]` (default
  `GITHUB_TOKEN`).
- Required when `ci.enabled && ci.wait_for_ci` or when any GitHub read/write
  action is enabled.
- Missing token yields `AUTOPILOT_NEEDS_TOKEN`.
- Access denied yields `AUTOPILOT_ACCESS_ERROR`.

## Configuration

See `configs/autopilot-run.example.json`. All nested objects have safe defaults:

```json
{
  "mode": "fake",
  "run_id": "autopilot-demo",
  "repo_slug": "owner/repo",
  "base_branch": "main",
  "work_branch": "autopilot-demo",
  "mvp_config_path": "configs/mvp-run.example.json",
  "diagnose_config": { "token_env": "GITHUB_TOKEN", "include_raw_logs": false, "max_log_excerpt_chars": 4000 },
  "ci": { "enabled": false, "wait_for_ci": false, "poll_interval_seconds": 15, "timeout_seconds": 900 },
  "repair": { "enabled": false, "max_attempts": 2, "provider": "mock", ... },
  "github": { "allow_pr_create": false, "allow_pr_update": false, "allow_actions_read": false, "allow_write": false },
  "report_dir": "reports/autopilot"
}
```

## Capability model

Requested read capabilities:

- `repo.status.read`
- `repo.diff.read`
- `github.pr.read`
- `github.actions.read`
- `github.logs.read`

Write capabilities are only allowed when explicitly enabled:

- `repo.apply.write` — `repair.allow_apply`
- `repo.commit.write` — `repair.allow_commit`
- `repo.push.write` — `repair.allow_push`
- `github.pr.create` — `github.allow_pr_create`
- `github.pr.update` — `github.allow_pr_update`

Always forbidden:

- `github.merge`
- `git.force_push`
- `github.actions.rerun`
- `repo.delete_branch`

## Repair loop

When `repair.enabled` is true and CI is red:

1. Build a prompt from the generated `latest-fix-task.md`.
2. Call the configured provider (`mock` or `kimi`).
3. Parse and guardrail the provider output.
4. If `repair.allow_apply` is true, apply the file updates.
5. Run `npm run typecheck`, `npm run build`, and the targeted failing test if known.
6. If `repair.allow_commit` is true, commit; if `repair.allow_push` is true, push.
7. Wait for the new CI run.
8. Stop if green. Stop with `AUTOPILOT_REPAIR_EXHAUSTED` if attempts run out.

`repair.max_attempts` defaults to `2`.

## Verdicts and exit codes

| Verdict | Meaning | Exit code |
|---|---|---|
| `AUTOPILOT_GREEN` | MVP passed and CI is green (possibly after repair). | 0 |
| `AUTOPILOT_MVP_FAILED` | MVP run did not pass. | 1 |
| `AUTOPILOT_MVP_DONE_CI_NOT_OBSERVED` | MVP passed; CI observation disabled. | 0 |
| `AUTOPILOT_CI_TIMEOUT` | CI did not complete within `timeout_seconds`. | 1 |
| `AUTOPILOT_CI_RED_DIAGNOSED` | CI red, diagnosis succeeded, repair disabled. | 0 |
| `AUTOPILOT_REPAIR_EXHAUSTED` | Repair loop hit `max_attempts`. | 1 |
| `AUTOPILOT_REPAIR_FAILED` | Provider output or guardrails failed repeatedly. | 1 |
| `AUTOPILOT_NEEDS_TOKEN` | GitHub token missing for requested operation. | 1 |
| `AUTOPILOT_ACCESS_ERROR` | GitHub API access denied. | 1 |
| `AUTOPILOT_CONFIG_ERROR` | Config missing, unreadable, or invalid. | 1 |
| `AUTOPILOT_FAILED` | Unexpected orchestrator failure. | 1 |

## Environment variables

- `GITHUB_TOKEN` — GitHub token (default env name, configurable via `diagnose_config.token_env`).
- `KIMI_API_KEY`, `KIMI_BASE_URL`, `KIMI_MODEL` — Required for real Kimi repair.
- `AUTOPILOT_REPAIR_MOCK_RESPONSE` — Override deterministic mock repair JSON in tests.

## Mission intake

Normally you should not write `autopilot-run` config by hand. Generate it with `autopilot-plan`:

```bash
npx tsx src/cli.ts autopilot-plan configs/mission.example.json
npx tsx src/cli.ts autopilot-run reports/autopilot-plans/mission-demo/autopilot.config.json
```

For the fastest operator UX, use the one-click wrapper with a raw goal:

```bash
npx tsx src/cli.ts autopilot-one-click "Add a health endpoint and tests"
```

See `docs/ONE_CLICK.md` for presets and safety rules.

```bash
npx tsx src/cli.ts autopilot-plan configs/mission.example.json
npx tsx src/cli.ts autopilot-run reports/autopilot-plans/mission-demo/autopilot.config.json
```

See `docs/AUTOPILOT_PLAN.md` for details.

## Example usage

Safe fake dry-run:

```bash
npx tsx src/autopilot-run/index.ts configs/autopilot-run.example.json
```

Real CI observation (requires token and `mode: "github"`):

```bash
GITHUB_TOKEN=ghp_xxx npx tsx src/autopilot-run/index.ts configs/autopilot-run.example.json
```

## Reports

The command writes to `reports/autopilot/<run_id>/`:

- `report.md` and `report.json` — overall result.
- `timeline.json` — ordered event log.
- `latest-fix-task.md` — most recent CI fix task.
- `latest-diagnosis.json` — most recent CI diagnosis.
- `mvp-run/` — delegated MVP run reports.
- `diagnose-ci/` — delegated CI diagnosis reports.

All reports are redacted with `redactSecrets` before persistence.

## Limitations

- It does not create or merge PRs on its own; PR creation is delegated to
  `mvp-run` based on its own config.
- Real repair uses Kimi only; other providers are not supported yet.
- The repair loop does not rerun the MVP run; it only patches the latest failure.
