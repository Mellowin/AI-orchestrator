# 01 — One-Click Autopilot (`autopilot-one-click`)

The `autopilot-one-click` command turns a single sentence (or a prepared mission JSON) into a full
mission → plan → autopilot run, and writes a consolidated report. It is implemented in
`src/autopilot-one-click/` and dispatched from `src/cli.ts`.

```bash
npx tsx src/cli.ts autopilot-one-click <mission.json>
npx tsx src/cli.ts autopilot-one-click "goal text" [flags]
```

The first positional argument (all positionals are joined with spaces) is the **input**:

- If it ends with `.json`, it is resolved and loaded as a mission config (`loadMissionConfig`).
- Otherwise it is treated as a raw goal string, and a mission is built from it
  (`buildMissionFromGoal`).

Running with no arguments prints an error and usage, and exits with code 1.

## Flags

All flags are parsed in `parseArgs` (`src/autopilot-one-click/index.ts`). Any unknown `--flag`
is rejected with `Unknown option: <flag>`.

| Flag | Values | Default | Notes |
|---|---|---|---|
| `--mode <mode>` | `fake`, `github` | derived from preset | Values must start with `fake` or `github`. |
| `--preset <name>` | `safe`, `read-ci`, `real-pr`, `real-repair`, `real-multitask`, `multitask-safe` | `real-multitask` (raw-goal mode) | See "Presets" below. |
| `--run-id <id>` | string | generated | Sanitized to `[a-zA-Z0-9_-]`; path traversal is rejected; empty-after-sanitize is an error. |
| `--repo <target>` | `owner/repo`, GitHub HTTPS/SSH URL, or local path | unset | See "Repo targeting" below. |
| `--repo-slug <owner/repo>` | string | `local/raw-goal` (raw-goal, no `--repo`) | Used only when `--repo` is not given. |
| `--repo-path <path>` | string | `.` | Used only when `--repo` is not given. Path traversal rejected. |
| `--base-branch <branch>` | string | `main`, or resolved from the cloned repo | Must not contain `..`, `/`, or `\`. |
| `--output-dir <path>` | string | `reports/autopilot-plans` | Path traversal rejected. |
| `--allowed-files <path>` | string | unset | **Repeatable** — each occurrence appends one entry. Path traversal rejected. |
| `--yes` | boolean flag | `false` | Confirms remote-write capabilities. |
| `--resume` | boolean flag | `false` | Passed through to the multitask mission runner. |

There are no other flags. In particular there is no `--dry-run`, `--force`, or `--token` flag.

## Modes and presets

When building a mission from a raw goal:

- Default preset is `real-multitask`.
- Default mode is `fake` when the preset is `safe` or `multitask-safe`, otherwise `github`.
- `safe` and `multitask-safe` **require** `fake` mode (a `github` mode here is a config error).
- `real-multitask` requires `github` mode, unless `--mode fake` is passed explicitly.
- In `fake` mode **all** capabilities are forced to `false`, regardless of preset — this is a
  hard safety ceiling.

Preset capability matrix (raw-goal missions):

| Capability | safe | read-ci | real-pr | real-repair | real-multitask | multitask-safe |
|---|---|---|---|---|---|---|
| `allow_real_provider` | – | – | ✓ | ✓ | ✓ | – |
| `allow_repo_apply` | – | – | ✓ | ✓ | ✓ | – |
| `allow_repo_commit` | – | – | ✓ | ✓ | ✓ | – |
| `allow_repo_push` | – | – | ✓ | ✓ | ✓ | – |
| `allow_pr_create` | – | – | ✓ | ✓ | ✓ | – |
| `allow_pr_update` | – | – | ✓ | ✓ | ✓ | – |
| `allow_actions_read` | – | ✓ | ✓ | ✓ | ✓ | – |
| `allow_repair` | – | – | – | ✓ | ✓ | – |

`real-pr` and `real-repair` differ only in `allow_repair`. `real-multitask` has the same
capability set as `real-repair` but routes the run through the multitask mission runner (see
"Execution flow").

## Repo targeting (`--repo`)

`--repo` accepts three forms:

1. **`owner/repo`** — converted to `https://github.com/owner/repo.git`.
2. **GitHub URL** — `https://github.com/owner/repo(.git)` or `git@github.com:owner/repo(.git)`;
   the slug is extracted from the URL.
3. **Local path** — must exist and contain a `.git` directory. The repo slug is derived from the
   local repo's `origin` remote when possible, otherwise it falls back to `local/mission`.

Path traversal in `--repo` is rejected.

Behavior differs by mode:

- **`github` mode:** the repo is **cloned into an isolated mission workspace** (built from the
  default workspace root plus a shortened run id, to avoid Windows `MAX_PATH` issues). The clone
  uses `git clone --config core.autocrlf=false`. If the workspace path already exists and is a git
  repo, it is **reused** (this is what makes `--resume` workable); if it exists and is not a git
  repo, the run fails. The base branch defaults to the repo's default branch (resolved via
  `origin/HEAD`, falling back to `git remote show origin`, then `main`) unless `--base-branch` is
  given.
- **`fake` mode:** no isolated workspace is created. A local path is used directly; a slug or URL
  is passed through as the repo path. Base branch defaults to `main`.

Without `--repo`, the mission uses `--repo-path` (default `.`), `--repo-slug` (default
`local/raw-goal`), and `--base-branch` (default `main`). Nothing is cloned.

## Bootstrap behavior

`buildMissionFromGoal` constructs the mission:

- **Run id:** `mission-YYYYMMDD-HHMMSS-<slug>` where the slug is the goal lowercased,
  non-alphanumerics replaced by `-`, trimmed, and truncated (40 chars for the slug, 20 chars
  inside the run id). `--run-id` overrides this (sanitized).
- **Constraints:** the mission records `Preset: <preset>` and `Mode: <mode>` as constraints. The
  runner later reads the `Preset: ...` constraint back, so a prepared mission JSON can also
  trigger multitask routing and the `real-multitask` auto-confirmation.
- **`github` mode additions:** the mission is given a Kimi provider block (token from
  `KIMI_API_KEY`), a GitHub block (token from `GITHUB_TOKEN`), a CI block (`wait_for_ci` follows
  `allow_actions_read`, poll interval 15s, timeout 900s), and a repair block (`max_attempts: 2`
  for `real-repair`/`real-multitask`, otherwise `1`).

## Confirmation (`--yes`)

A mission **requires confirmation** when any of `allow_repo_push`, `allow_pr_create`,
`allow_pr_update`, or `allow_actions_read` is enabled. Without `--yes`, the run stops with
`ONE_CLICK_NEEDS_CONFIRMATION` (exit 1) before planning.

Exception: when the preset is `real-multitask` (from `--preset` or from a `Preset:` constraint in
a mission JSON), `--yes` is implied — the canonical real-multitask one-click command does not
require it.

## Execution flow

1. Load or build the mission (failures → `ONE_CLICK_CONFIG_ERROR` for mission-builder errors,
   `ONE_CLICK_FAILED` otherwise).
2. Enforce confirmation (see above).
3. Run `autopilot-plan`. Token/config/provider failures and empty plans stop the run.
4. If the preset is `real-multitask` or `multitask-safe` (from options or the mission's `Preset:`
   constraint), hand off to the **multitask mission runner** with `{ resume }`. Otherwise, locate
   the generated `autopilot.config.json` among the plan's generated files and run
   `autopilot-run` on it.
5. Write a one-click report (Markdown + JSON) into the run directory:
   `<output_dir>/<run_id>/`. The final CLI summary prints this directory as `Reports:`.

## Branch naming convention

Work branch names are derived from the run id by `makeWorkBranch`
(`src/autopilot-one-click/goal-parser.ts`):

- `fake` mode: `autopilot-demo-<safeRunId>`
- `github` mode: `autopilot-<safeRunId>`

`<safeRunId>` is the run id with any character outside `[a-zA-Z0-9_-]` replaced by `-`.

## Run verdicts

The final verdict is one of (`AutopilotOneClickVerdict`):

| Verdict | Exit | Meaning |
|---|---|---|
| `ONE_CLICK_DONE` | 0 | Plan and autopilot run completed. |
| `ONE_CLICK_DONE_WITH_CAVEATS` | 0 | Completed; the plan step reported `AUTOPILOT_PLAN_READY_WITH_CAVEATS`. |
| `ONE_CLICK_PLAN_FAILED` | 1 | Plan step failed, produced no files, or the generated `autopilot.config.json` was missing. |
| `ONE_CLICK_AUTOPILOT_FAILED` | 1 | `autopilot-run` exited non-zero or threw. |
| `ONE_CLICK_NEEDS_TOKEN` | 1 | Plan reported `AUTOPILOT_PLAN_NEEDS_PROVIDER_TOKEN`. |
| `ONE_CLICK_NEEDS_CONFIRMATION` | 1 | Remote-write capabilities enabled but `--yes` not given. |
| `ONE_CLICK_CONFIG_ERROR` | 1 | Mission-builder validation error (bad preset/mode combination, path traversal, bad `--repo`, etc.). |
| `ONE_CLICK_FAILED` | 1 | Other mission loading/building failure. |
| `MULTITASK_MISSION_DONE` | 0 | Multitask runner completed. |
| `MULTITASK_MISSION_DONE_WITH_CAVEATS` | 0 | Multitask runner completed with caveats. |
| `MULTITASK_MISSION_FAILED` | 1 | Multitask runner failed or threw. |
| `MULTITASK_MISSION_NEEDS_HUMAN` | 1 | Multitask runner requires a human action. |
| `MULTITASK_MISSION_EXTERNAL_BLOCKER` | 1 | Multitask runner blocked by an external dependency. |

The multitask verdicts (including their exit codes) come from the multitask mission runner; the
one-click wrapper passes them through.

## CLI output and hard safety rules

Every invocation prints the hard safety rules first:

```text
[autopilot-one-click] Hard safety rules:
  Forbidden:
    - github.merge
    - git.force_push
    - github.actions.rerun
    - repo.delete_branch
```

No preset or flag can enable merge, force-push, Actions rerun, or branch deletion.

After the run, a summary is printed to stderr: goal, run id, mode, preset, plan verdict,
autopilot verdict (`n/a` for multitask runs without an autopilot result), final verdict, reports
directory, and the next human action when one is present. The process exit code equals the
result's `exit_code`.

## Examples

```bash
# Fake-mode dry run of a raw goal (no tokens, no repo mutation)
npx tsx src/cli.ts autopilot-one-click "Add a docs note" --preset safe

# Prepared mission config
npx tsx src/cli.ts autopilot-one-click configs/mission.example.json

# Real PR flow against a GitHub repo (clones into a mission workspace)
npx tsx src/cli.ts autopilot-one-click "Implement feature X" \
  --preset real-pr --repo owner/repo --yes

# Real multitask mission (canonical one-click; --yes implied)
npx tsx src/cli.ts autopilot-one-click "Ship feature X with tests" \
  --preset real-multitask --repo https://github.com/owner/repo.git

# Resume a multitask run
npx tsx src/cli.ts autopilot-one-click "Ship feature X with tests" \
  --preset real-multitask --repo owner/repo --run-id mission-20240101-120000-ship-feature --resume
```

Real (`github`-mode) presets require `KIMI_API_KEY` for the provider and `GITHUB_TOKEN` for
GitHub operations, as wired into the generated mission. Tokens are read from the environment and
never printed by this command.
