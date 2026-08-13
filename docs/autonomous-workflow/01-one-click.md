# One-Click Autopilot Launch

`autopilot-one-click` is the canonical entry point for autonomous workflow runs.
It turns either a raw goal sentence or a prepared mission JSON into a full
`autopilot-plan` → `autopilot-run` execution, writes a unified report, and exits
with the orchestrator's final verdict.

This document describes the launcher based strictly on the implementation in
`src/autopilot-one-click/`.

## What it does

1. **Intake** — accepts a raw goal string or a `*.json` mission config.
2. **Mission construction** — when a raw goal is given, `buildMissionFromGoal`
   builds an `AutopilotPlanMission` from the goal text, preset, and CLI flags.
3. **Plan** — runs `autopilot-plan` against the mission.
4. **Run** — runs the generated `autopilot-run` config (or the multitask runner
   for multitask presets).
5. **Report** — writes `one-click-report.md` and `one-click-report.json` under
   `<output_dir>/<run_id>/`.

## One-time user setup

- Node.js 20+ and npm.
- git available on `PATH`.
- For any real-provider or GitHub-touching preset:
  - `KIMI_API_KEY` — used by the planner and repair loop.
  - `GITHUB_TOKEN` — used for GitHub reads/writes.
  - `OPENAI_API_KEY` — used by the multitask final reviewer in `github` mode.
- Tokens are read from the environment (dotenv is loaded by `src/config.ts`);
  they are never printed or persisted to reports.
- The target repository must already be cloned at `--repo-path` when mutation is
  requested. The one-click wrapper does not clone or initialize repositories.

## Canonical launch

### Safe / dry-run mode (default)

```bash
npx tsx src/cli.ts autopilot-one-click "Add a health endpoint and tests"
```

This uses the `safe` preset, `fake` mode, and the current directory as the repo.
No real provider is called and no repository mutation occurs.

### Real PR mode

```bash
npx tsx src/cli.ts autopilot-one-click \
  "Implement feature X" \
  --preset real-pr \
  --mode github \
  --repo-slug owner/repo \
  --repo-path ./target-repo
```

### Real multitask mode

```bash
npx tsx src/cli.ts autopilot-one-click \
  "Refactor auth and add tests" \
  --preset real-multitask \
  --mode github \
  --repo-slug owner/repo \
  --repo-path ./target-repo
```

### From a prepared mission config

```bash
npx tsx src/cli.ts autopilot-one-click configs/mission.example.json
```

## Input resolution

- If the first positional argument ends with `.json`, it is resolved as a mission
  config path and loaded directly via `loadMissionConfig`.
- Otherwise all positional arguments are joined with a single space and treated
  as the raw goal string. From that goal, `buildMissionFromGoal` constructs the
  mission.

## `owner/repo` handling

- `--repo-slug <owner/repo>` sets `mission.repo_slug`.
- Default for raw goals: `local/raw-goal`.
- The slug is passed verbatim to GitHub API paths such as
  `https://api.github.com/repos/${repoSlug}/...`; it must already be in
  `owner/repo` form. The wrapper does not parse, validate, or transform it.
- Required for presets that touch GitHub (`read-ci`, `real-pr`, `real-repair`,
  `real-multitask`).

## Local repository

- `--repo-path <path>` sets `mission.repo_path`.
- Default: `.` (current working directory).
- Path traversal sequences (`..` or traversal-style slashes) are rejected.
- When repository mutation is allowed, the path must point to a git repository
  with the configured base branch present.
- The wrapper itself does not clone, init, or otherwise bootstrap the repository.

## Base branch resolution

- `--base-branch <branch>` sets `mission.base_branch`.
- Default: `main`.
- Branch values containing `..`, `/`, or `\` are rejected.
- In mutation-allowed mode, the runner resolves the base SHA with git.
- In safe (`fake`) mode, a synthetic base SHA is used so no git repository is
  required.
- During `--resume`, the resolved base SHA is compared to the persisted value;
  if it changed, the resume is aborted.

## Automatic work-branch / mission branch creation

- The one-click wrapper does **not** pre-create the work branch. The plan step
  generates `autopilot.config.json`, and the inner `autopilot-run` / `mvp-run`
  runner is responsible for checking out the base branch and creating the work
  branch from it.
- In the multitask runner, the mission work branch is named
  `mission-${mission.run_id}`.
- For standard (single-task) runs, the work branch is written into the
  generated `autopilot.config.json` by the plan step.
- The wrapper tracks the resolved `run_id`, base SHA, and, in multitask mode,
  task commits, so a failed or rejected mission can be rolled back locally.

## Run ID generation

- Default run ID: `mission-YYYYMMDD-HHMMSS-<goal-slug>` where the slug is the
  first 20 characters of the sanitized goal.
- `--run-id <id>` overrides it. The value is sanitized to `[a-zA-Z0-9_-]` and
  rejected if it becomes empty or contains path traversal.

## Presets and capabilities

| Preset | Mode default | Real provider | Repo apply/commit/push | PR create/update | CI read | Repair |
|---|---|---|---|---|---|---|
| `safe` | `fake` | No | No | No | No | No |
| `read-ci` | `github` | No | No | No | Read only | No |
| `real-pr` | `github` | Yes | Yes | Yes | Yes | No |
| `real-repair` | `github` | Yes | Yes | Yes | Yes | Yes, `max_attempts: 2` |
| `real-multitask` | `github` | Yes | Yes (commit), no push/PR by preset | No | No | Yes, `max_attempts: 2` |
| `multitask-safe` | `fake` | No | No | No | No | No |

Notes:

- `safe` and `multitask-safe` require `fake` mode.
- `real-multitask` requires `github` mode.
- In `fake` mode, a final capability ceiling zeros out all real-provider and
  repository-write capabilities regardless of the preset.
- For `github` mode, the mission is always configured with:
  - `provider.name: 'kimi'`, `token_env: 'KIMI_API_KEY'`
  - `github.token_env: 'GITHUB_TOKEN'`
  - `ci.wait_for_ci` mirroring `allow_actions_read`
  - `ci.poll_interval_seconds: 15`, `ci.timeout_seconds: 900`
  - `repair.max_attempts: 2` for `real-repair` / `real-multitask`, otherwise `1`

## CLI flags

| Flag | Value | Description |
|---|---|---|
| positional | `<mission.json>` or raw goal | Required. A JSON mission file or the goal text. |
| `--mode` | `fake` or `github` | Execution mode. Defaults from preset. |
| `--preset` | `safe`, `read-ci`, `real-pr`, `real-repair`, `real-multitask`, `multitask-safe` | Capability preset. Default `safe`. |
| `--run-id` | string | Override the generated run id. |
| `--repo-slug` | `owner/repo` | GitHub repository slug. Default `local/raw-goal`. |
| `--repo-path` | path | Local repository path. Default `.`. |
| `--base-branch` | branch | Base branch. Default `main`. |
| `--output-dir` | path | Output directory. Default `reports/autopilot-plans`. |
| `--allowed-files` | path | Restricts file scope; repeatable. |
| `--yes` | flag | Accepted for forward compatibility; currently a no-op. |
| `--resume` | flag | Resume a previous run when supported by the run stage. |

Unknown flags produce an error and non-zero exit.

## Hard safety rules

Every invocation prints:

```text
Forbidden:
  - github.merge
  - git.force_push
  - github.actions.rerun
  - repo.delete_branch
```

No preset enables these capabilities. Merge, force-push, workflow rerun, and
branch deletion are always forbidden.

## Reports

Reports are written to `<output_dir>/<run_id>/`:

- `one-click-report.md`
- `one-click-report.json`

The plan step also generates files such as `mission.md`, `mission.json`,
`plan.md`, `plan.json`, `mvp-run.config.json`, and `autopilot.config.json`.

## Verdicts and exit codes

| Verdict | Meaning | Exit code |
|---|---|---|
| `ONE_CLICK_DONE` | Plan and autopilot completed successfully. | 0 |
| `ONE_CLICK_DONE_WITH_CAVEATS` | Completed; the planner returned ready-with-caveats. | 0 |
| `ONE_CLICK_PLAN_FAILED` | The plan step failed or produced no usable config. | 1 |
| `ONE_CLICK_AUTOPILOT_FAILED` | The autopilot/run step failed. | 1 |
| `ONE_CLICK_NEEDS_TOKEN` | A required provider/GitHub token is missing. | 1 |
| `ONE_CLICK_CONFIG_ERROR` | Mission construction failed (e.g., invalid preset/mode). | 1 |
| `MULTITASK_MISSION_DONE` | Multitask mission accepted. | 0 |
| `MULTITASK_MISSION_DONE_WITH_CAVEATS` | Multitask mission accepted with caveats. | 0 / 1 depending on downstream |
| `MULTITASK_MISSION_FAILED` | Multitask mission failed. | 1 |
| `MULTITASK_MISSION_NEEDS_HUMAN` | Human review required before continuing. | 1 |
| `MULTITASK_MISSION_EXTERNAL_BLOCKER` | External blocker such as CI timeout. | 1 |

## Limitations

- The one-click wrapper does not clone or initialize repositories.
- It does not merge PRs, force-push, rerun workflows, or delete branches.
- Raw-goal mode uses deterministic fake plans when real provider is disabled.
- Real provider output is parsed as JSON; malformed responses fail safely.
- For multitask missions, PR creation is gated by `capabilities.allow_pr_create`;
  the default `real-multitask` preset leaves PR creation disabled.
