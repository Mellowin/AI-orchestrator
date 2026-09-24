# 01 — One-Click Launch of the Autonomous Multitask Workflow

This document describes the canonical one-click entry point to the autonomous
multitask workflow **as actually implemented** in `src/cli.ts` and
`src/autopilot-one-click/*`. It covers invocation, owner/repo resolution,
automatic local repository bootstrap (clone when missing), base branch
resolution, and work branch creation. It also lists which settings are
configured only once.

## 1. Invocation

The one-click command is a subcommand of the CLI:

```bash
npx tsx src/cli.ts autopilot-one-click <mission.json | "goal text"> [options]
```

Two npm scripts alias the same command (see `package.json`):

```bash
npm run autopilot:one-click -- "goal text"
npm run one-click -- "goal text"
```

The command accepts either:

- **A mission config path** (any positional argument ending in `.json`), which
  is loaded via `loadMissionConfig` from `src/autopilot-plan/config-loader.js`.
- **A raw goal string** (all positional arguments joined with spaces), which is
  converted into a mission config by `buildMissionFromGoal` in
  `src/autopilot-one-click/mission-builder.ts`.

Argument parsing is implemented in `parseArgs` in
`src/autopilot-one-click/index.ts`. The recognized flags are exactly:

| Flag | Effect |
|---|---|
| `--mode fake\|github` | Execution mode. For raw goals, defaults to `fake` for the `safe`/`multitask-safe` presets and `github` otherwise. |
| `--preset safe\|read-ci\|real-pr\|real-repair\|real-multitask\|multitask-safe` | Capability preset. For raw goals the default is `real-multitask` (see below). |
| `--run-id <id>` | Override the generated run id (sanitized to `[a-zA-Z0-9_-]`). |
| `--repo <owner/repo\|URL\|local-path>` | Repository target; in `github` mode this triggers automatic clone/bootstrap (see §3). |
| `--repo-slug <owner/repo>` | Slug used when `--repo` is not given. Defaults to `local/raw-goal` for raw goals. |
| `--repo-path <path>` | Local repo path used when `--repo` is not given. Defaults to `.`. |
| `--base-branch <branch>` | Base branch override (see §4). |
| `--output-dir <path>` | Report output directory. Defaults to `reports/autopilot-plans`. |
| `--allowed-files <path>` | Repeatable; restricts the files the mission may touch. |
| `--yes` | Confirms remote-write capabilities (see §6). |
| `--resume` | Resume a paused mission (see §7). |

Any other `--flag` is rejected with `Unknown option`.

> Note: `docs/ONE_CLICK.md` describes an older four-preset surface. The code in
> `src/autopilot-one-click/` is authoritative: six presets exist, and the raw-goal
> default preset is `real-multitask`, not `safe`.

## 2. Presets and capabilities

`applyPreset` in `mission-builder.ts` maps each preset to a capability set:

- `safe` / `multitask-safe` — all capabilities off; requires mode `fake`.
- `read-ci` — `allow_actions_read` only.
- `real-pr` — real provider, repo apply/commit/push, PR create/update, CI read.
- `real-repair` — `real-pr` plus `allow_repair` (repair `max_attempts: 2`).
- `real-multitask` — same capability set as `real-repair`; runs the multitask
  mission runner. **This is the default preset for raw goals**, and the
  canonical one-click multitask command **does not require `--yes`** — the
  runner sets `options.yes = true` automatically when the preset is
  `real-multitask` (from the flag or from the mission's `Preset:` constraint).

Fake mode enforces a hard ceiling: every capability is forced to `false`
regardless of preset.

In `github` mode the mission builder also attaches:

- `provider: { name: 'kimi', token_env: 'KIMI_API_KEY' }`
- `github: { token_env: 'GITHUB_TOKEN' }`
- `ci` polling defaults (`poll_interval_seconds: 15`, `timeout_seconds: 900`)
- `repair.max_attempts` (2 for `real-repair`/`real-multitask`, else 1)

## 3. Owner/repo resolution and automatic local bootstrap

### 3.1 With `--repo` (canonical one-click form)

`parseRepoInput` in `mission-builder.ts` accepts three forms:

1. **GitHub HTTPS URL** — `https://github.com/<owner>/<repo>[.git]` → slug is
   taken from the URL, clone URL is the URL itself.
2. **GitHub SSH URL** — `git@github.com:<owner>/<repo>[.git]` → same handling.
3. **`owner/repo` slug** — validated against
   `^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$`; clone URL is synthesized as
   `https://github.com/<owner>/<repo>.git`.
4. **Local path** — must exist and contain `.git`. The slug is derived from the
   repo's `origin` remote (HTTPS or SSH) when available, otherwise
   `local/mission`.

Path traversal (`..`) in `--repo` is rejected.

**Clone/bootstrap behavior (`cloneMissionRepo`)** — only in `github` mode:

- The execution workspace is decoupled from the report path to avoid Windows
  `MAX_PATH` issues. It is computed via `getDefaultWorkspaceRoot()`,
  `makeShortRunId(runId)`, `makeMissionWorkspaceRoot(...)`, and
  `makeMissionRepoPath(...)` from `src/workspace-paths.ts`.
- If the workspace path **does not exist**, the repo is cloned with
  `git clone --config core.autocrlf=false <cloneUrl> <workspacePath>` (parent
  directories are created first). Clone failure raises a `MissionBuilderError`
  and the run ends as `ONE_CLICK_CONFIG_ERROR` before any provider call.
- If the workspace path **already exists and is a git repo**, it is reused
  as-is — this is what makes `--resume` work against the previously cloned
  workspace without re-cloning.
- If the path exists but is **not** a git repo, the run fails with
  `Mission workspace path exists but is not a git repo`.

In `fake` mode no workspace or clone is created: the mission's `repo_path` is
the `--repo` source directly (local path or URL string).

### 3.2 Without `--repo` (raw goal against the current repo)

- `repo_path` = `--repo-path` or `.`
- `repo_slug` = `--repo-slug` or `local/raw-goal`

No clone is performed in this form.

## 4. Base branch resolution

Order of precedence in `resolveRepoAndBase`:

1. `--base-branch <branch>` (explicit override) always wins.
2. In `github` mode with `--repo` (after clone/reuse):
   `resolveDefaultBaseBranch(repoPath)` probes the cloned repo:
   - `git symbolic-ref refs/remotes/origin/HEAD` → strips the
     `refs/remotes/origin/` prefix (fast path);
   - fallback: parse `HEAD branch: <name>` from `git remote show origin`.
3. Final fallback: `main`.

Without `--repo`, base branch is simply `--base-branch` or `main` — no probing.

The resolved base branch is validated: it must not contain `..`, `/`, or `\`.

## 5. Mission work branch creation

Run id generation (`src/autopilot-one-click/goal-parser.ts`):

- `makeRunId(goal)` → `mission-<yyyymmdd>-<hhmmss>-<goal-slug>` where the goal
  slug is lowercased, non-alphanumerics collapsed to `-`, truncated.
- `--run-id` values are sanitized to `[a-zA-Z0-9_-]`.

Branch naming (`makeWorkBranch` in `goal-parser.ts`): the run id is sanitized
again for branch use, and the branch is:

- `autopilot-<runId>` in `github` mode
- `autopilot-demo-<runId>` in `fake` mode

Actual checkout/creation semantics are implemented by `prepareWorkBranch` in
`src/git-manager.ts`:

1. The working tree must be clean (`ensureClean`).
2. **Fresh run**: the work branch must not already exist; it is created from
   the base branch via `checkout <base>`, `pull --ff-only`,
   `checkout -b <workBranch>`.
3. **Resume**: the work branch must already exist and is simply checked out.

Branch names are validated (no leading `-`, no spaces, `..`, `~ ^ : ? * [ \`,
trailing `/`, or `//`). The work branch is never `main`: git health preflight
(`src/git-health-preflight.ts`) rejects `main`/`master` as the work branch, and
the push/PR commands independently refuse `main` as current or work branch.

## 6. One-time configuration (configure once, then one-click)

These are the only settings a user must set up once before the canonical
one-click command works end to end:

1. **Provider token** — `KIMI_API_KEY` in the environment. Required for all
   real (`github` mode) presets; the planner reports
   `ONE_CLICK_NEEDS_TOKEN` without burning a provider call when it is missing.
2. **GitHub token** — `GITHUB_TOKEN` in the environment. Required when the
   mission pushes branches, creates/updates PRs, or reads CI. Before the first
   expensive provider call, `runAutopilotOneClick` executes a **non-mutating
   git write-auth preflight** (`runGitWriteAuthPreflight`) that verifies the
   token can push to the target repo. On failure the mission pauses resumably
   (`MULTITASK_MISSION_PAUSED_GIT_AUTH`) with zero provider calls made.
3. **Mission/repo configuration** — either a persisted mission JSON
   (`run_id`, `repo_slug`, `repo_path`, `base_branch`, `goal`, `mode`,
   `capabilities`, `output_dir`; see `configs/mission.example.json`) or the
   equivalent one-time flags (`--repo`, `--base-branch`, `--run-id`,
   `--output-dir`).

Confirmation: missions whose capabilities include push, PR create/update, or
actions read require `--yes` — **except** the canonical `real-multitask`
preset, for which the runner sets `yes` automatically. Otherwise the run exits
with `ONE_CLICK_NEEDS_CONFIRMATION`.

Tokens are read from the environment only; they are never printed or persisted
(logs and reports pass through secret redaction).

## 7. Resume semantics

- Multitask missions paused on provider interruption
  (`MULTITASK_MISSION_PAUSED_PROVIDER`) or git auth interruption
  (`MULTITASK_MISSION_PAUSED_GIT_AUTH`) print a `Resume command` built by
  `buildResumeCommand` and preserve mission state.
- **Fail-closed rule**: `--resume` with a raw goal (not a `.json` path) and no
  `--run-id` is rejected as `ONE_CLICK_CONFIG_ERROR`, because a raw-goal run id
  is derived from the current time and would silently start a new mission
  instead of resuming the paused one. Persisted mission configs carry a stable
  `run_id` and are exempt.

## 8. Hard safety rules

Every invocation prints the hard rules before doing anything:

```text
Forbidden:
  - github.merge
  - git.force_push
  - github.actions.rerun
  - repo.delete_branch
```

No preset enables merge, force-push, Actions rerun, or branch deletion. All
reports (`one-click-report.md` / `one-click-report.json`) are written under
`<output_dir>/<run_id>/` by `writeOneClickReport`.
