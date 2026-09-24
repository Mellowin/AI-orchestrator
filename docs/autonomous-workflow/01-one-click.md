# 01 — Canonical One-Click Launch (Post Stage 18.26)

This document describes the canonical one-click launch of the autonomous multitask AI Orchestrator, based strictly on the actual implementation in `src/cli.ts`, `src/autopilot-one-click/index.ts`, `src/autopilot-one-click/runner.ts`, and `src/autopilot-one-click/mission-builder.ts`.

## The canonical command

```bash
npx tsx src/cli.ts autopilot-one-click "<your goal in plain language>" \
  --preset real-multitask \
  --repo owner/repo
```

Equivalent npm shortcuts exist: `npm run autopilot:one-click -- "goal" ...` and `npm run one-click -- "goal" ...`.

A prepared mission JSON can be used instead of a raw goal:

```bash
npx tsx src/cli.ts autopilot-one-click path/to/mission.json
```

## One-time configuration (configure once, reuse forever)

The only things the user must configure once per machine/environment are credentials exposed as environment variables. They are never printed or persisted by the tool:

| Variable | When needed |
|---|---|
| `KIMI_API_KEY` | Real (non-fake) provider missions; the mission provider defaults to `{ name: 'kimi', token_env: 'KIMI_API_KEY' }`. |
| `GITHUB_TOKEN` | `github` mode missions that push, create/update PRs, or read CI; the mission github config defaults to `{ token_env: 'GITHUB_TOKEN' }`. |

Everything else — repo resolution, clone/bootstrap, base branch detection, branch naming, planning, execution, and reporting — is derived from the command line and the code, and does not need repeated manual setup.

## Owner/repo configuration

The target repository is supplied with `--repo` and accepts exactly three forms, parsed in `mission-builder.ts`:

1. **`owner/repo` slug** — validated against `^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$`; converted to `https://github.com/<owner>/<repo>.git` for cloning.
2. **GitHub URL** — `https://github.com/owner/repo[.git]` or `git@github.com:owner/repo[.git]`; the clone URL is used verbatim and the slug is extracted.
3. **Local path** — must exist and must be a git repository (a `.git` entry must be present). The repo slug is derived from the local repo's `origin` remote when it points at GitHub; otherwise it falls back to `local/mission`.

Alternatives without `--repo`:

- `--repo-path <path>` — repository path, default `.`.
- `--repo-slug <owner/repo>` — default `local/raw-goal` when no `--repo` is given.

Path traversal (`..`) in `--repo`, `--repo-path`, `--repo-slug`, `--run-id`, `--output-dir`, and `--allowed-files` is rejected with a configuration error.

## Local repo handling and automatic repo bootstrap

Behavior depends on the mode:

- **`github` mode with `--repo`:** the repository is bootstrapped automatically. The one-click runner clones it into an isolated mission workspace decoupled from the human-readable report path (so long run ids do not hit Windows `MAX_PATH` limits): the workspace root is derived from the default workspace root plus a short run id, and the repo lives at the mission repo path inside it. The clone uses `git clone --config core.autocrlf=false`. If the workspace path already exists and is a git repository, it is **reused** (this is what makes resume work); if it exists but is not a git repository, the run fails with a configuration error.
- **`fake` mode with `--repo`:** no isolated workspace is created; the source path/URL is used directly, since fake mode never mutates a repository.
- **No `--repo`:** the current directory (or `--repo-path`) is used as-is.

## Base branch resolution

The base branch is resolved in this order:

1. `--base-branch <branch>` explicit override always wins.
2. In `github` mode with `--repo`, the default branch is auto-detected from the cloned repo: first `git symbolic-ref refs/remotes/origin/HEAD`, then `git remote show origin` (`HEAD branch:` line) as fallback.
3. Final fallback: `main`.

Base branch values containing `..`, `/`, or `\` are rejected as unsafe.

## Mission branch creation

The multitask runner derives the mission work branch as `mission-<run_id>` and resolves the base SHA from the base branch (`git rev-parse <base>`, falling back to `origin/<base>` for CI-style checkouts).

The branch is **not** pre-created by the one-click wrapper. The inner MVP runner creates and checks out the work branch from the resolved base SHA. On a fresh (non-resume) run, if `mission-<run_id>` already exists the run fails closed: it tells you to rerun with `--resume`, or to use a different `--run-id`, and it refuses to reuse a branch that is not based on the current base SHA.

The default run id is generated from the goal plus a timestamp (`mission-YYYYMMDD-HHMMSS-<goal-slug>`); override it with `--run-id`.

## Presets and confirmation

`--preset` selects the capability set. Relevant to the canonical launch:

- `real-multitask` (the default preset) — real provider, repo apply/commit/push, PR create/update, CI read, repair enabled. The canonical `real-multitask` command does **not** require `--yes`; confirmation is auto-applied for this preset.
- `multitask-safe` / `safe` — plan-only; requires `--mode fake` and never mutates anything.
- `real-pr`, `real-repair`, `read-ci` — other capability combinations; any mission enabling remote writes (push, PR create/update, CI read) requires explicit `--yes` confirmation, otherwise the run stops with `ONE_CLICK_NEEDS_CONFIRMATION`.

## What happens on launch

1. Hard safety rules are printed: `github.merge`, `git.force_push`, `github.actions.rerun`, and `repo.delete_branch` are always forbidden.
2. A mission is built from the raw goal (or loaded from JSON), including repo bootstrap as described above.
3. For `github` mode with push allowed, a non-mutating Git write-auth preflight verifies `GITHUB_TOKEN` can push **before** the first planner/coder provider call, so a bad credential pauses the mission resumably with zero provider quota spent.
4. The plan is generated and an immutable resume plan snapshot is persisted for multitask missions.
5. The multitask mission executes tasks on the mission branch, runs integrated validation and final review, creates the PR when allowed, and observes CI.
6. Reports are written under `<output-dir>/<run_id>/` (default output dir `reports/autopilot-plans`), including mission/plan files, generated configs, and `one-click-report.md` / `one-click-report.json`; multitask mission state lives under `<output-dir>/missions/<run_id>/`.

## Resume

If the mission pauses (provider interruption, git auth failure), fix the external cause and rerun the same command with `--resume`. For raw-goal missions you must pass the original `--run-id` — otherwise the time-derived run id would silently start a new mission. On resume the persisted plan snapshot is reused exactly (zero planner provider calls), and accepted commits are verified to still be ancestors of the mission branch.
