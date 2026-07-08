# One-Click Autopilot

Run the whole mission-to-autopilot flow from a single sentence or a prepared mission JSON.

```bash
npx tsx src/cli.ts autopilot-one-click "Add a health endpoint and tests"
npm run autopilot:one-click -- "Add a health endpoint and tests"
```

You can also still use a prepared mission config:

```bash
npx tsx src/cli.ts autopilot-one-click configs/mission.example.json
```

## What it does

1. Builds a mission config from the goal (or loads the JSON).
2. Generates a plan with `autopilot-plan`.
3. Generates `mvp-run` and `autopilot-run` configs.
4. Runs `autopilot-run`.
5. Writes all reports and a `one-click-report.md` summary.

## Presets

Presets control which capabilities are enabled. The default is `safe`.

### `safe` (default)

- No real provider.
- No GitHub token required.
- No repository mutation, commit, push, PR, CI wait, or repair.
- Use this for demos and dry-runs.

```bash
npx tsx src/cli.ts autopilot-one-click "Add a docs note"
```

### `read-ci`

- Allows reading GitHub Actions logs.
- No repository write, no PR write, no repair.
- Requires `GITHUB_TOKEN` only if CI observation is actually triggered.

```bash
npx tsx src/cli.ts autopilot-one-click "Fix flaky test" --preset read-ci --mode github
```

### `real-pr`

- Real provider allowed.
- Repository apply/commit/push allowed.
- PR create/update allowed.
- CI read/wait allowed.
- Repair disabled.
- Requires `KIMI_API_KEY` and `GITHUB_TOKEN`.

```bash
npx tsx src/cli.ts autopilot-one-click "Implement feature X" --preset real-pr --mode github --repo-slug owner/repo
```

### `real-repair`

- Same as `real-pr`.
- Repair loop enabled with default `max_attempts: 2`.
- Requires explicit `--preset real-repair`.

```bash
npx tsx src/cli.ts autopilot-one-click "Fix CI failure" --preset real-repair --mode github --repo-slug owner/repo
```

## Flags

| Flag | Description |
|---|---|
| `--mode fake\|github` | Execution mode. Default follows preset. |
| `--preset safe\|read-ci\|real-pr\|real-repair` | Capability preset. Default `safe`. |
| `--run-id <id>` | Override generated run id. |
| `--repo-slug <owner/repo>` | Required for real modes. |
| `--repo-path <path>` | Default `.` |
| `--base-branch <branch>` | Default `main` |
| `--output-dir <path>` | Default `reports/autopilot-plans` |
| `--yes` | Skip interactive confirmation (currently a no-op placeholder). |

## Safety

The command always prints hard safety rules:

```text
Forbidden:
  - github.merge
  - git.force_push
  - github.actions.rerun
  - repo.delete_branch
```

No preset enables merge, force-push, workflow rerun, or branch delete.

## Generated files

`reports/autopilot-plans/<run_id>/`:

- `mission.md` / `mission.json`
- `plan.md` / `plan.json`
- `mvp-run.config.json`
- `autopilot.config.json`
- `operator-command.md`
- `one-click-report.md` / `one-click-report.json`

## Environment variables

- `KIMI_API_KEY` — required for `real-pr` / `real-repair` presets.
- `GITHUB_TOKEN` — required for `read-ci` / `real-pr` / `real-repair` presets that touch GitHub.

Tokens are never printed or persisted.

## Limitations

- Raw goal mode uses deterministic fake plans when real provider is disabled.
- Real provider output is parsed as JSON; malformed responses fail safely.
- The one-click wrapper runs plan and autopilot in the same process.
