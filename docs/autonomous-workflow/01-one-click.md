# 01 — One-Click Launch of the Autonomous Multitask Workflow

This document describes the canonical one-click entry point for the autonomous
multitask workflow, exactly as implemented in `src/autopilot-one-click/`
(`index.ts`, `runner.ts`, `mission-builder.ts`, `goal-parser.ts`) and wired into
the CLI in `src/cli.ts`. It covers owner/repo configuration, local repository
usage, automatic repository bootstrap, base branch resolution, mission branch
creation, and the configuration a user must provide exactly once.

## Canonical command

```bash
npx tsx src/cli.ts autopilot-one-click "<your goal in plain language>" --repo owner/repo
```

Equivalent npm script aliases (defined in `package.json`):

```bash
npm run autopilot:one-click -- "<your goal>" --repo owner/repo
npm run one-click -- "<your goal>" --repo owner/repo
```

Why this is "one click":

- For a raw goal string, the default preset is `real-multitask`
  (`buildMissionFromGoal`: `options.preset ?? 'real-multitask'`), and the default
  mode is `github`. You do not need to pass `--preset` or `--mode`.
- The runner automatically sets `--yes` for the `real-multitask` preset
  ("The canonical real-multitask one-click command does not require --yes"), so
  no confirmation flag is needed either.
- The command chains mission building, planning (`autopilot-plan`), and the
  multitask mission runner in a single process, and writes a
  `one-click-report.md` / `one-click-report.json` summary.

## Inputs the command accepts

`parseArgs` in `src/autopilot-one-click/index.ts` accepts exactly these options:

| Flag | Meaning |
|---|---|
| `<mission.json>` or `"goal text"` (positional) | A mission config path (must end in `.json`) or a raw goal string. Required. |
| `--mode fake\|github` | Execution mode. Default: `github` for real presets, `fake` for `safe`/`multitask-safe`. |
| `--preset safe\|read-ci\|real-pr\|real-repair\|real-multitask\|multitask-safe` | Capability preset. Default for raw goals: `real-multitask`. |
| `--run-id <id>` | Override the generated run id (sanitized to `[a-zA-Z0-9_-]`). Required together with `--resume` for raw-goal missions. |
| `--repo <owner/repo\|URL\|local-path>` | Repository target. See below. |
| `--repo-slug <owner/repo>` | Slug override used when `--repo` is not given. Default `local/raw-goal`. |
| `--repo-path <path>` | Local repo path used when `--repo` is not given. Default `.` (current directory). |
| `--base-branch <branch>` | Base branch override. See "Base branch resolution". |
| `--output-dir <path>` | Report root. Default `reports/autopilot-plans`. The run directory is `<output-dir>/<run_id>`. |
| `--allowed-files <path>` | Restrict which files the mission may touch. Repeatable. |
| `--yes` | Confirm remote writes. Not needed for `real-multitask` (auto-applied). Required for other presets that enable push/PR/CI read. |
| `--resume` | Resume a paused mission. For raw-goal missions the original `--run-id` is mandatory (fail-closed otherwise). |

Unknown `--flags` are rejected with an error. There are no other CLI
capabilities for this command.

## Owner/repo configuration (`--repo`)

`parseRepoInput` in `mission-builder.ts` accepts three forms:

1. **`owner/repo` slug** — validated against `^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$`.
   The clone URL is derived as `https://github.com/<owner>/<repo>.git`.
2. **GitHub URL** — HTTPS (`https://github.com/owner/repo[.git]`) or SSH
   (`git@github.com:owner/repo[.git]`). Used as the clone URL verbatim; the slug
   is extracted from the URL.
3. **Local path** — see the next section.

Path traversal (`..`) in `--repo` is rejected with a config error.

## Using a local repository

Passing a local path to `--repo` (or omitting `--repo` and using `--repo-path`,
which defaults to `.`) targets a repository that already exists on disk.

For `--repo <local-path>`:

- The path must exist and must be a git repository (a `.git` entry must be
  present); otherwise the run fails with `ONE_CLICK_CONFIG_ERROR`.
- The `repo_slug` is derived from the local repo's `origin` remote when it
  matches a GitHub HTTPS/SSH URL; otherwise it falls back to `local/mission`.

Behavior then depends on the mode:

- **Fake mode** (`safe` / `multitask-safe`): the source path is used directly as
  `repo_path`; no isolated workspace is created and the fake-mode safety ceiling
  disables all real capabilities (no provider, apply, commit, push, PR, CI read,
  or repair).
- **GitHub mode**: the local path is used as the *clone source* for an isolated
  mission workspace (see the next section) — the multitask mission does not run
  inside your working checkout.

## Automatic repository bootstrap (github mode)

When `--repo` is given and the mode is `github`, `resolveRepoAndBase` +
`cloneMissionRepo` bootstrap the execution workspace automatically:

1. A workspace root is computed under `getDefaultWorkspaceRoot()` using a
   shortened run id (`makeShortRunId`), deliberately decoupled from the
   human-readable report path so long run ids do not hit Windows `MAX_PATH`
   limits during `git clone`.
2. The repository is cloned with
   `git clone --config core.autocrlf=false <cloneUrl> <workspaceRepoPath>`.
3. If the workspace path already exists and is a git repo, it is **reused**
   (this is what makes `--resume` work without re-cloning). If it exists but is
   not a git repo, the run fails with a config error.

The resulting `repo_path`, `workspace_root`, and `repo_slug` are recorded on the
mission object.

## Base branch resolution

When `--repo` is used in github mode, the base branch is resolved in this order
(`resolveDefaultBaseBranch`):

1. `--base-branch <branch>` explicit override, if given.
2. The `origin/HEAD` symbolic ref of the cloned repo
   (`git symbolic-ref refs/remotes/origin/HEAD`).
3. The `HEAD branch:` line from `git remote show origin`.
4. Fallback: `main`.

Without `--repo`, the base branch is `--base-branch` or `main`. Base branch
values containing `..`, `/`, or `\` are rejected as unsafe.

The base SHA used for branching is resolved later with `git rev-parse <base>`,
falling back to `git rev-parse origin/<base>` for CI-style checkouts that only
have remote-tracking refs (`getBaseSha` in `multitask/git-helpers.ts`).

## Mission branch creation

The mission work branch name is derived from the run id
(`makeWorkBranch` in `goal-parser.ts`):

- github mode: `autopilot-<runId>`
- fake mode: `autopilot-demo-<runId>`

(run ids are sanitized to `[a-zA-Z0-9_-]`; auto-generated ids look like
`mission-YYYYMMDD-HHMMSS-<goal-slug>`.)

The branch itself is created inside the mission workspace with
`git checkout -B <workBranch> <startRef>` (`createWorkBranch` in
`multitask/git-helpers.ts`), starting from the resolved base. The branch is
pushed with a plain `git push origin <branch>` (`pushBranch`).

## What the user configures only once

Everything else is derived from the goal and flags. The durable, one-time setup
is limited to:

1. **`GITHUB_TOKEN`** — a GitHub credential that can push to the target
   repository (and read Actions when CI observation is enabled). In github mode
   the mission records `github: { token_env: 'GITHUB_TOKEN' }`. Before the first
   provider call, a non-mutating git write-auth preflight
   (`runGitWriteAuthPreflight`) verifies this token can push; on failure the
   mission pauses resumably (`MULTITASK_MISSION_PAUSED_GIT_AUTH`) with zero
   provider calls consumed.
2. **`KIMI_API_KEY`** — the provider API key. In github mode the mission records
   `provider: { name: 'kimi', token_env: 'KIMI_API_KEY' }`. If the token is
   absent, planning fails with `ONE_CLICK_NEEDS_TOKEN`.
3. **A way to clone the repo** — network access plus credentials for the clone
   URL you pass (the derived HTTPS URL, an SSH URL using your agent/keys, or a
   local path that needs no network).
4. **(Optional) a persisted mission JSON config** — instead of a raw goal you
   can pass a `mission.json` file. Persisted configs carry a stable `run_id`,
   which exempts them from the `--resume` + `--run-id` requirement that applies
   to raw-goal missions. The preset is read back from the mission's
   `Preset: <name>` constraint line.

Tokens are read from the environment at run time; they are not printed or
persisted by the one-click flow. No other env vars or config files are required
by the code paths described here.

## Confirmation and resume semantics

- Presets that enable remote writes (`allow_repo_push`, `allow_pr_create`,
  `allow_pr_update`, `allow_actions_read`) normally require `--yes`; otherwise
  the run stops with `ONE_CLICK_NEEDS_CONFIRMATION`. The `real-multitask`
  preset (flag or from the mission's `Preset:` constraint) auto-sets `--yes`.
- `--resume` on a multitask mission reuses the persisted plan snapshot (zero
  planner provider calls) and validates plan-hash integrity and mission identity
  before continuing. Raw-goal resumes must repeat the original `--run-id`
  because generated run ids embed the current time; without it the command
  fails closed with `ONE_CLICK_CONFIG_ERROR` instead of silently starting a new
  mission. Legacy runs without a snapshot fail closed with
  `LEGACY_RESUME_PLAN_UNAVAILABLE` rather than re-planning.
- Paused missions print a concrete resume command
  (`... --run-id <id> --resume`) and the next human action.

## Hard safety rules

Every invocation prints the forbidden capability list before doing any work:

- `github.merge`
- `git.force_push`
- `github.actions.rerun`
- `repo.delete_branch`

No preset enables these. The multitask preset enables real provider calls, repo
apply/commit/push, PR create/update, CI read, and a repair loop
(`max_attempts: 2`), and nothing more.

## Output

All artifacts land under `<output-dir>/<run_id>` (default
`reports/autopilot-plans/<run_id>/`), including the plan files, the generated
configs, and the `one-click-report.md` / `one-click-report.json` summary. The
CLI prints the run id, mode, preset, plan verdict, final verdict, and report
directory to stderr.
