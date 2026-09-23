# One-Click Autonomous Multitask Workflow

This document describes the canonical way to launch an autonomous multitask mission from a single command, based strictly on the behavior implemented in `src/cli.ts` and the `src/autopilot-one-click/` modules.

## The canonical command

```bash
npx tsx src/cli.ts autopilot-one-click \
  "Create docs/proofs note summarizing the one-click flow" \
  --repo owner/repo
```

The same entry point is exposed as npm scripts:

```bash
npm run autopilot:one-click -- "goal text" --repo owner/repo
npm run one-click -- "goal text" --repo owner/repo
```

With no `--preset` flag, a raw-goal mission defaults to the `real-multitask` preset in `github` mode (see `buildMissionFromGoal` in `mission-builder.ts`). The canonical `real-multitask` command does **not** require `--yes`: `runner.ts` auto-enables confirmation for this preset.

You can also start from a persisted mission config instead of a raw goal:

```bash
npx tsx src/cli.ts autopilot-one-click path/to/mission.json
```

A mission config carries its own stable `run_id`, so it can be resumed with `--resume` directly. A raw-goal mission derives its run id from the current time, so `--resume` on a raw-goal mission additionally requires the original `--run-id`.

## Owner/repo configuration (`--repo`)

`--repo` accepts three forms, parsed by `parseRepoInput`:

| Form | Example | Behavior |
|---|---|---|
| `owner/repo` slug | `Mellowin/AI-orchestrator` | Clone URL derived as `https://github.com/owner/repo.git`. |
| GitHub URL (HTTPS or SSH) | `https://github.com/owner/repo.git`, `git@github.com:owner/repo.git` | Used as the clone URL directly; the slug is extracted from the URL. |
| Local path | `../my-repo` | Must exist and contain `.git`. The slug is derived from the local repo's `origin` remote when it points at GitHub, otherwise `local/mission`. |

The `repo_slug` recorded in the mission is used for PR creation and CI observation.

## Local repo handling and automatic repo bootstrap

In `github` mode with `--repo`, the mission does not run in your current working tree. `resolveRepoAndBase` bootstraps an isolated execution workspace:

1. A short workspace root is derived from the run id via `getDefaultWorkspaceRoot()`, `makeMissionWorkspaceRoot()`, and `makeMissionRepoPath()` (`workspace-paths.ts`). The short path avoids Windows `MAX_PATH` problems during clone.
2. `cloneMissionRepo` clones the repository into that workspace with `git clone --config core.autocrlf=false <url> <path>`.
3. If the workspace path already exists and is a git repo (for example on `--resume`), it is reused as-is. If it exists but is not a git repo, the mission fails with a config error.

In `fake`/safe mode, no isolated workspace is created: the source path or URL is used directly, and all mutation capabilities are force-disabled.

Without `--repo`, the mission falls back to `--repo-path` (default `.`), `--repo-slug` (default `local/raw-goal`), and `--base-branch` (default `main`).

## Base branch resolution

When `--base-branch` is not given for a `--repo` github-mode mission, the base branch is auto-detected from the cloned repo by `resolveDefaultBaseBranch`:

1. Fast path: read the `origin/HEAD` symbolic ref (`git symbolic-ref refs/remotes/origin/HEAD`).
2. Fallback: parse `HEAD branch:` from `git remote show origin`.
3. Final default: `main`.

The resolved base branch is validated (no `..`, `/`, or `\` characters) before the mission is built.

## Mission branch creation

The multitask runner (`multitask/runner.ts`) derives the mission work branch from the run id:

```text
mission-<run_id>
```

The branch is not pre-created by the multitask runner; the inner MVP runner creates and checks it out from the base SHA. Safety rules around it:

- On a fresh (non-resume) run, if the work branch already exists the mission fails rather than resetting it. If it exists but is not based on the recorded base SHA, reuse is refused. Rerun with `--resume`, or use a different `--run-id`.
- On resume, persisted accepted commits must still be ancestors of the work branch, the plan hash must match, and the base SHA must not have moved; otherwise the resume is aborted.
- Merging, force-push, workflow rerun, and branch deletion are hard-forbidden capabilities and are printed on every invocation.

## What you configure only once

The one-click flow needs no per-run flags beyond the goal and `--repo`. The only prerequisites are environment credentials, set once in your shell or environment:

| Variable | Needed for | Notes |
|---|---|---|
| `KIMI_API_KEY` | Real provider calls (planner/coder) in `github` mode missions. | Referenced via `mission.provider.token_env` (default `KIMI_API_KEY`). |
| `GITHUB_TOKEN` | Push, PR creation/update, and CI observation. | Referenced via `mission.github.token_env`. Must be able to push to the target repository. |
| `OPENAI_API_KEY` | Mission-level final review in `github` mode. | Fake-mode missions use a deterministic reviewer instead. |

Tokens are read from the environment only; they are never printed or persisted.

Before the first provider call, a non-mutating Git write-auth preflight (`runGitWriteAuthPreflight`) verifies that `GITHUB_TOKEN` can push to the cloned repo. If it fails, the mission pauses resumably with **zero** provider calls consumed, and the printed resume command can be rerun after fixing the token.

## Presets and confirmation

| Preset | Mode | Capabilities enabled |
|---|---|---|
| `safe` (default for `--mode fake`) | fake | None; plan and validate only. |
| `multitask-safe` | fake | None; multitask plan is validated but tasks are skipped (`skipped_safe_mode`). |
| `read-ci` | github | CI read only. |
| `real-pr` | github | Real provider, apply/commit/push, PR create/update, CI read. |
| `real-repair` | github | Same as `real-pr` plus repair loop (`max_attempts: 2`). |
| `real-multitask` (default for raw goals) | github | Same as `real-repair`, executed by the multitask runner; `--yes` is auto-enabled. |

For presets other than `real-multitask`, capabilities that perform remote writes (`allow_repo_push`, `allow_pr_create`, `allow_pr_update`, `allow_actions_read`) require explicit `--yes`; otherwise the run exits with `ONE_CLICK_NEEDS_CONFIRMATION` before any provider call.

## Run ids, reports, and resume

- A raw-goal run id is generated as `mission-<yyyymmdd>-<hhmmss>-<goal-slug>`; override it with `--run-id` (sanitized to `[a-zA-Z0-9_-]`).
- Reports are written under `<output-dir>/<run_id>/` (default `reports/autopilot-plans`), including the mission config, plan, generated `mvp-run.config.json` and `autopilot.config.json`, and `one-click-report.md` / `one-click-report.json`.
- Pause verdicts (`MULTITASK_MISSION_PAUSED_PROVIDER`, `MULTITASK_MISSION_PAUSED_GIT_AUTH`) print a resume command. Accepted work is preserved; rerun the printed command (with `--resume` and, for raw goals, the original `--run-id`) after restoring provider access or fixing `GITHUB_TOKEN`.

## Flags reference

| Flag | Description |
|---|---|
| `--mode fake\|github` | Execution mode. Default: `fake` for `safe`/`multitask-safe`, otherwise `github`. |
| `--preset <name>` | Capability preset (see table above). Default for raw goals: `real-multitask`. |
| `--run-id <id>` | Stable run id; required with `--resume` for raw-goal missions. |
| `--repo <target>` | `owner/repo`, GitHub URL, or local git repo path. Triggers workspace bootstrap in github mode. |
| `--repo-slug <owner/repo>` | Slug override when not using `--repo`. |
| `--repo-path <path>` | Local repo path when not using `--repo`. Default `.`. |
| `--base-branch <branch>` | Base branch override; otherwise auto-detected from `origin/HEAD`, then `main`. |
| `--output-dir <path>` | Report root. Default `reports/autopilot-plans`. |
| `--allowed-files <path>` | Repeatable allow-list for files the mission may touch. |
| `--yes` | Confirm remote-write capabilities (auto-enabled for `real-multitask`). |
| `--resume` | Resume a paused mission from persisted state. |
