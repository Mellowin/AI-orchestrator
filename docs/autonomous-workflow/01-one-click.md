# 01 — One-Click Autonomous Multitask Launch

This document describes the canonical one-click autonomous multitask launch, based strictly on the actual implementation in `src/cli.ts`, `src/autopilot-one-click/*`, and `package.json`. It does not describe flags or capabilities that do not exist in the code.

## Canonical command

The CLI entry point is the `autopilot-one-click` command, wired in `src/cli.ts` to `main()` from `src/autopilot-one-click/index.ts`:

```bash
npx tsx src/cli.ts autopilot-one-click "<goal text>" [flags]
```

Equivalent npm scripts (both map to `tsx src/cli.ts autopilot-one-click` in `package.json`):

```bash
npm run autopilot:one-click -- "<goal text>" [flags]
npm run one-click -- "<goal text>" [flags]
```

The positional argument is either:

- a raw goal string (any argument that does not end with `.json`), or
- a path to a mission config JSON file (argument ending in `.json`), loaded via `loadMissionConfig`.

For a raw goal, `buildMissionFromGoal` in `src/autopilot-one-click/mission-builder.ts` constructs the mission. The default preset for a raw goal is `real-multitask`, and the default mode for non-safe presets is `github`. So the minimal canonical multitask launch is:

```bash
npx tsx src/cli.ts autopilot-one-click "Implement feature X with tests" --repo owner/repo
```

The canonical `real-multitask` one-click command does **not** require `--yes`: the runner auto-confirms when the preset is `real-multitask` (or the mission config carries the `Preset: real-multitask` constraint). For other presets that enable remote writes (push, PR create/update, CI read), the run stops with `ONE_CLICK_NEEDS_CONFIRMATION` unless `--yes` is passed.

## Flags (exactly as parsed by `parseArgs`)

| Flag | Effect |
|---|---|
| `--mode fake\|github` | Execution mode. Default: `fake` for `safe`/`multitask-safe` presets, `github` otherwise. |
| `--preset safe\|read-ci\|real-pr\|real-repair\|real-multitask\|multitask-safe` | Capability preset. Default for raw goals: `real-multitask`. |
| `--run-id <id>` | Override the generated run id (sanitized to `[a-zA-Z0-9_-]`). Required with `--resume` for raw-goal missions. |
| `--repo <value>` | Repository target: `owner/repo`, GitHub HTTPS URL, SSH URL, or a local path. |
| `--repo-slug <owner/repo>` | Explicit repo slug (used when `--repo` is not given). |
| `--repo-path <path>` | Local repo path (used when `--repo` is not given). Default `.`. |
| `--base-branch <branch>` | Base branch override. |
| `--output-dir <path>` | Report output root. Default `reports/autopilot-plans`. |
| `--allowed-files <path>` | Restrict allowed files; repeatable. |
| `--yes` | Confirm remote writes (push/PR/CI read). Auto-applied for multitask presets. |
| `--resume` | Resume a paused mission using its persisted plan snapshot. |

Any other `--flag` is rejected with `Unknown option`. There are no other flags.

## Owner/repo handling (`--repo`)

`parseRepoInput` in `mission-builder.ts` accepts exactly three forms:

1. **`owner/repo` slug** — matched against `^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$`. Clone URL is derived as `https://github.com/<owner>/<repo>.git`.
2. **GitHub URL** — HTTPS (`https://github.com/owner/repo[.git]`) or SSH (`git@github.com:owner/repo[.git]`). The URL itself is used as the clone URL; the slug is extracted from it.
3. **Local path** — must exist and contain a `.git` directory, otherwise the mission build fails with `ONE_CLICK_CONFIG_ERROR`. The slug is derived from the local repo's `origin` remote when it is a GitHub URL; otherwise it falls back to `local/mission`.

Path traversal in `--repo`, `--repo-path`, `--repo-slug`, `--run-id`, `--output-dir`, or `--allowed-files` values is rejected before any git or network operation.

## Local repo path usage (`--repo-path`)

When `--repo` is not given, the mission targets `options.repo_path ?? '.'` directly, with `repo_slug` defaulting to `local/raw-goal` and `base_branch` defaulting to `main` unless `--base-branch` is given. No cloning or workspace isolation happens on this path — the given directory is used in place.

## Automatic repo bootstrap (clone/prepare when missing)

In `github` mode with `--repo`, the runner bootstraps an isolated execution workspace (`resolveRepoAndBase` → `cloneMissionRepo`):

- The workspace root is derived from `getDefaultWorkspaceRoot()` plus a short run id (`makeShortRunId`) so long run ids do not hit Windows `MAX_PATH` limits during clone; the repo itself is placed at `makeMissionRepoPath(workspaceRoot)`.
- If the workspace path already exists and is a git repo, it is **reused** (this is how resume works).
- If the path exists but is not a git repo, the mission build fails.
- Otherwise the repo is cloned with `git clone --config core.autocrlf=false <cloneUrl> <workspacePath>`.

In `fake` mode with `--repo`, no isolated workspace is created: the source path (local path or clone URL string) is used directly.

## Base branch resolution

- With `--repo` in `github` mode: `--base-branch` if given, else the repo's default branch is auto-detected via `resolveDefaultBaseBranch` — first the `origin/HEAD` symbolic ref (`git symbolic-ref refs/remotes/origin/HEAD`), then a fallback parse of `git remote show origin` (`HEAD branch: <name>`), then `main`.
- With `--repo` in `fake` mode, or with `--repo-path`: `--base-branch` if given, else `main`.
- Base branch values containing `..`, `/`, or `\` are rejected as unsafe.

## Mission branch naming

`src/autopilot-one-click/goal-parser.ts` provides `makeWorkBranch(runId, goal, mode)`:

- `github` mode: `autopilot-<safeRunId>`
- `fake` mode: `autopilot-demo-<safeRunId>`

where the run id is sanitized to `[a-zA-Z0-9_-]` (other characters become `-`). Run ids themselves are either user-supplied via `--run-id` (sanitized the same way) or generated as `mission-<yyyymmdd>-<hhmmss>-<goal-slug>` by `makeRunId`.

## Presets and capabilities

`applyPreset` maps each preset to a fixed capability set:

| Preset | real provider | apply/commit/push | PR create/update | CI read | repair |
|---|---|---|---|---|---|
| `safe` | no | no | no | no | no |
| `read-ci` | no | no | no | yes | no |
| `real-pr` | yes | yes | yes | yes | no |
| `real-repair` | yes | yes | yes | yes | yes |
| `real-multitask` (default) | yes | yes | yes | yes | yes |
| `multitask-safe` | no | no | no | no | no |

Additional rules enforced in `buildMissionFromGoal`:

- `safe` and `multitask-safe` require `mode: fake`.
- `real-multitask` requires `mode: github` (unless `--mode fake` is explicitly passed).
- In `fake` mode, **all** capabilities are forced to `false` regardless of preset.
- Repair `max_attempts` is 2 for `real-repair`/`real-multitask`, else 1.

## One-time setup the user must complete

### Environment tokens

For `github` mode missions, `buildMissionFromGoal` wires:

- `mission.provider = { name: 'kimi', token_env: 'KIMI_API_KEY' }` — the planner/coder provider token. Set `KIMI_API_KEY` in the environment before launching a real preset. If it is missing, the plan step ends with verdict `AUTOPILOT_PLAN_NEEDS_PROVIDER_TOKEN`, surfaced as `ONE_CLICK_NEEDS_TOKEN`.
- `mission.github = { token_env: 'GITHUB_TOKEN' }` — used for push/PR/CI operations. Before the first provider call, a non-mutating Git write-auth preflight (`runGitWriteAuthPreflight`) verifies that `GITHUB_TOKEN` can push to the target repo. If it fails resumably, the mission pauses with verdict `MULTITASK_MISSION_PAUSED_GIT_AUTH`, consumes zero provider calls, and prints a resume command.

Tokens are never printed in reports; failure messages are sanitized.

### Config

No config file is required for a raw-goal launch — the mission is built entirely from the goal string plus flags. Optionally, you can prepare a mission JSON (ending in `.json`) and pass its path instead of a goal; its persisted `run_id` makes it resumable without `--run-id`. Missions in `github` mode get CI wait config (`poll_interval_seconds: 15`, `timeout_seconds: 900`) and the repair config generated automatically.

## What the command does (sequenced)

1. Prints hard safety rules (always): forbidden are `github.merge`, `git.force_push`, `github.actions.rerun`, `repo.delete_branch`.
2. Builds or loads the mission (bootstrap clone if needed).
3. Runs the git write-auth preflight when applicable (see above).
4. Runs `autopilot-plan` to produce the plan and generated configs. For multitask presets, an immutable resume plan snapshot is persisted.
5. For `real-multitask`/`multitask-safe`, runs the multitask mission runner; otherwise runs `autopilot-run` against the generated `autopilot.config.json`.
6. Writes `one-click-report.md` / `one-click-report.json` under `<output-dir>/<run_id>/`.

## Resume

- For raw-goal missions, `--resume` requires the original `--run-id`; otherwise the run fails closed with `ONE_CLICK_CONFIG_ERROR` (a raw goal would otherwise derive a new time-based run id and silently start a new mission).
- On resume, the persisted plan snapshot is identity- and hash-validated and reused exactly — no planner provider call is made. If a run predates snapshots and has persisted execution state, resume fails closed with `LEGACY_RESUME_PLAN_UNAVAILABLE`.
- Missions paused on provider interruptions (`MULTITASK_MISSION_PAUSED_PROVIDER`) or git auth (`MULTITASK_MISSION_PAUSED_GIT_AUTH`) print a resume command and preserve mission state.

## Final verdicts

The command exits with the result verdict printed to stderr, e.g. `ONE_CLICK_DONE`, `ONE_CLICK_DONE_WITH_CAVEATS`, `MULTITASK_MISSION_DONE`, `MULTITASK_MISSION_DONE_WITH_CAVEATS`, `MULTITASK_MISSION_NEEDS_HUMAN`, `MULTITASK_MISSION_PAUSED_PROVIDER`, `MULTITASK_MISSION_PAUSED_GIT_AUTH`, `ONE_CLICK_NEEDS_TOKEN`, `ONE_CLICK_NEEDS_CONFIRMATION`, `ONE_CLICK_CONFIG_ERROR`, `ONE_CLICK_PLAN_FAILED`, `ONE_CLICK_AUTOPILOT_FAILED`, or `MULTITASK_MISSION_FAILED`. Exit code is 0 only for the `*_DONE*` verdicts.
