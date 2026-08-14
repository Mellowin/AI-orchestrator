# Autonomous Workflow 01 — Canonical One-Click Launch

This document describes the canonical one-click launch path as implemented in
`src/cli.ts` (`autopilot-one-click`) and `src/autopilot-one-click/*`. It covers only
commands and flags that actually exist in the code; anything not listed here is not
supported by the CLI.

## The command

```bash
npx tsx src/cli.ts autopilot-one-click <mission.json | "goal text"> [flags]
```

The first positional argument is either:

- a path to a mission config JSON file (input ends with `.json` — loaded via the
  autopilot-plan config loader), or
- a raw goal string (any other positional input), which is converted into a mission
  by the mission builder.

Examples:

```bash
# Raw goal, safe fake-mode demo (no tokens, no repo mutation)
npx tsx src/cli.ts autopilot-one-click "Add a docs note"

# Raw goal, real GitHub mode targeting an owner/repo
npx tsx src/cli.ts autopilot-one-click "Implement feature X" \
  --preset real-pr --mode github \
  --repo-slug owner/repo --repo-path . --base-branch main

# Prepared mission config
npx tsx src/cli.ts autopilot-one-click configs/mission.example.json
```

## Flags that actually exist

Parsed in `src/autopilot-one-click/index.ts`:

| Flag | Effect |
|---|---|
| `--preset safe\|read-ci\|real-pr\|real-repair\|real-multitask\|multitask-safe` | Capability preset. Default `safe`. |
| `--mode fake\|github` | Execution mode. Default: `fake` for `safe`/`multitask-safe`, otherwise `github`. |
| `--run-id <id>` | Override the generated run id (sanitized; path traversal rejected). |
| `--repo-slug <owner/repo>` | Target repository in `owner/repo` form. Default `local/raw-goal`. |
| `--repo-path <path>` | Local working copy path. Default `.`. Path traversal rejected. |
| `--base-branch <branch>` | Base branch. Default `main`. Must not contain `..`, `/`, or `\`. |
| `--output-dir <path>` | Report output directory. Default `reports/autopilot-plans`. Path traversal rejected. |
| `--allowed-files <path>` | Restrict allowed file paths (repeatable; each entry checked for traversal). |
| `--yes` | Accepted flag; currently a no-op placeholder (no interactive prompt exists). |
| `--resume` | Resume flag; honored by the multitask mission runner. |

Unknown `--flags` cause an argument error. There are no other one-click flags.

## Owner/repo targeting (`--repo-slug`)

- The mission field `repo_slug` is set from `--repo-slug`; the default for raw goals
  is `local/raw-goal`.
- For real (`github`) modes you must pass the real target, e.g. `--repo-slug owner/repo`.
- The slug is rejected if it contains path traversal (`..`).
- In `github` mode the mission also wires `github.token_env: 'GITHUB_TOKEN'`, so the
  slug must identify a repository reachable with that token.

## Local repo handling (`--repo-path`)

- `repo_path` defaults to `.` (the current working directory) and is rejected if it
  contains path traversal.
- The one-click wrapper itself does not clone or fetch; it runs plan and autopilot in
  the same process against the local working copy you point it at. For real runs,
  point `--repo-path` at a prepared local clone (the proof in
  `docs/proofs/STAGE_18_22_REAL_ONE_CLICK.md` used a disposable clone under `tmp/`).
- Downstream git operations validate that `repo_path` exists, is a directory, and is
  a git repository (`.git` present), and require a clean working tree before branch
  preparation.

## Automatic repo bootstrap

What the one-click launch bootstraps automatically:

1. **Mission construction** — from the JSON file or from the raw goal plus flags
   (run id, slug, repo path, base branch, capabilities, output dir, constraints).
2. **Plan generation** — `autopilot-plan` runs on the mission and writes generated
   files under `<output-dir>/<run-id>/`, including `mission.md/json`,
   `plan.md/json`, `mvp-run.config.json`, `autopilot.config.json`, and
   `operator-command.md`.
3. **Autopilot execution** — the generated `autopilot.config.json` is loaded and
   executed (`autopilot-run`), except for multitask presets (`real-multitask`,
   `multitask-safe`), which route to the multitask mission runner instead.
4. **Reporting** — a `one-click-report.md` / `one-click-report.json` summary is
   written into the run directory.

What it does **not** bootstrap: cloning the remote repo, installing dependencies,
or configuring tokens. Those are one-time operator setup (below).

## Base branch resolution

- Default base branch is `main` (`--base-branch` overrides it).
- Validation: the base branch must not contain `..`, `/`, or `\`; otherwise the
  mission builder fails with a config error before any repo work happens.
- For prepared mission JSON files, `base_branch` comes from the file itself.

## Mission branch creation

Work branch naming is deterministic, derived from the run id
(`src/autopilot-one-click/goal-parser.ts`):

- Run id (when not overridden): `mission-<yyyymmdd>-<hhmmss>-<goal-slug>` where the
  goal slug is the lowercased goal with non-alphanumerics replaced by `-`,
  truncated.
- Work branch: `autopilot-demo-<run-id>` in `fake` mode, `autopilot-<run-id>` in
  `github` mode. The run id portion is sanitized to `[a-zA-Z0-9_-]`.
- Branch creation itself is performed downstream by the git layer
  (`prepareWorkBranch`): it requires a clean tree, checks out the base branch,
  fast-forward pulls it, and creates the work branch. On resume, the work branch
  must already exist and is checked out as-is.

The one-click flow never merges, never force-pushes, never reruns Actions, and never
deletes branches. These hard rules are printed on every invocation:

```text
Forbidden:
  - github.merge
  - git.force_push
  - github.actions.rerun
  - repo.delete_branch
```

## Presets and capabilities

Capabilities per preset (`src/autopilot-one-click/mission-builder.ts`):

| Preset | real provider | apply/commit/push | PR create/update | actions read | repair |
|---|---|---|---|---|---|
| `safe` (default) | no | no | no | no | no |
| `read-ci` | no | no | no | yes | no |
| `real-pr` | yes | yes | yes | yes | no |
| `real-repair` | yes | yes | yes | yes | yes (max 2 attempts) |
| `real-multitask` | yes | apply/commit yes, push no | no | no | yes (max 2 attempts) |
| `multitask-safe` | no | no | no | no | no |

Mode constraints enforced by the mission builder:

- `safe` and `multitask-safe` require `--mode fake` (the default for them).
- `real-multitask` requires `--mode github`.
- In `fake` mode, all capabilities are forced off regardless of preset (fake-mode
  safety ceiling).
- In `github` mode, the mission gains `provider: { name: 'kimi', token_env:
  'KIMI_API_KEY' }`, `github: { token_env: 'GITHUB_TOKEN' }`, CI polling config
  (poll 15 s, timeout 900 s, waiting enabled when `allow_actions_read`), and a
  repair config (`max_attempts` 2 for `real-repair`/`real-multitask`, otherwise 1).

## One-time operator setup

These are configured once per environment, not per run:

1. **Provider token** — `KIMI_API_KEY` (and the Kimi base URL configuration used by
   the provider layer) for any preset that enables the real provider
   (`real-pr`, `real-repair`, `real-multitask`). If it is missing, the plan step
   ends with verdict `ONE_CLICK_NEEDS_TOKEN`.
2. **GitHub token** — `GITHUB_TOKEN` for modes that read CI or create/update PRs
   (`read-ci`, `real-pr`, `real-repair`). Tokens are never printed or persisted.
3. **Repository settings** — a reachable GitHub repository matching `--repo-slug`
   and a prepared local clone at `--repo-path` with a clean working tree and the
   base branch available. The tool pushes the mission branch to `origin` when push
   is allowed; it never creates the remote repo or clones it for you.

## Verdicts and exit codes

The final line is a one-click verdict, e.g.:

- `ONE_CLICK_DONE` / `ONE_CLICK_DONE_WITH_CAVEATS` (exit 0)
- `ONE_CLICK_NEEDS_TOKEN` (exit 1 — configure `KIMI_API_KEY`)
- `ONE_CLICK_CONFIG_ERROR` (exit 1 — invalid flags/mission, e.g. path traversal)
- `ONE_CLICK_PLAN_FAILED` / `ONE_CLICK_AUTOPILOT_FAILED` / `ONE_CLICK_FAILED`
- Multitask presets report `MULTITASK_MISSION_DONE`,
  `MULTITASK_MISSION_DONE_WITH_CAVEATS`, `MULTITASK_MISSION_FAILED`,
  `MULTITASK_MISSION_NEEDS_HUMAN`, or `MULTITASK_MISSION_EXTERNAL_BLOCKER`.

Reports for each run live under `<output-dir>/<run-id>/` (default
`reports/autopilot-plans/<run-id>/`).
