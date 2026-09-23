# 01 — Canonical One-Click Launch of the Autonomous Multitask Workflow

This document describes, strictly based on the code in `src/autopilot-one-click/`, how the
one-click command launches the autonomous multitask workflow: how the repository target is
configured, how a local repo is handled, how a missing repo is bootstrapped automatically,
how the base branch is resolved, how the mission branch is created, and what the operator
must configure exactly once.

Only CLI capabilities that exist in `src/autopilot-one-click/index.ts` (`parseArgs`) are
documented here. No other flags or commands exist for this entrypoint.

## Canonical command

The canonical one-click launch of the autonomous multitask workflow is a raw-goal invocation
with a repository target:

```bash
npx tsx src/cli.ts autopilot-one-click "<goal text>" \
  --repo owner/repo \
  --preset real-multitask
```

Key properties of this canonical form (all enforced by code):

- `--preset real-multitask` selects github mode by default and enables the full mutation
  capability set (real provider, apply, commit, push, PR create/update, CI read, repair).
- The canonical `real-multitask` command does **not** require `--yes`:
  `runner.ts` auto-sets `options.yes = true` when the preset is `real-multitask`
  (either passed via `--preset` or embedded in a mission JSON as a `Preset: real-multitask`
  constraint). Other remote-writing presets require explicit `--yes`, otherwise the run
  exits with `ONE_CLICK_NEEDS_CONFIRMATION`.
- If `--preset` is omitted entirely, `buildMissionFromGoal` defaults the preset to
  `real-multitask` (and therefore mode `github`) for raw goals. So the minimal canonical
  launch is:

  ```bash
  npx tsx src/cli.ts autopilot-one-click "<goal text>" --repo owner/repo
  ```

  (Note: the older `docs/ONE_CLICK.md` describes `safe` as the default preset; the current
  code in `mission-builder.ts` defaults raw-goal missions to `real-multitask`.)

An alternative input form is a prepared mission JSON file (any input ending in `.json`):

```bash
npx tsx src/cli.ts autopilot-one-click mission.json
```

Mission JSON files are loaded as-is by `loadMissionConfig` and carry their own stable
`run_id`; the repo/base-branch bootstrap logic below applies only to raw-goal missions.

## Complete flag surface

`parseArgs` in `src/autopilot-one-click/index.ts` accepts exactly these options:

| Flag | Effect |
|---|---|
| `--mode fake\|github` | Execution mode. Default: derived from preset (`fake` for `safe`/`multitask-safe`, otherwise `github`). |
| `--preset safe\|read-ci\|real-pr\|real-repair\|real-multitask\|multitask-safe` | Capability preset. Default for raw goals: `real-multitask`. |
| `--run-id <id>` | Override the generated run id (sanitized to `[a-zA-Z0-9_-]`; path traversal rejected). |
| `--repo <owner/repo\|URL\|local-path>` | Repository target (see below). |
| `--repo-slug <owner/repo>` | Repo slug override used when `--repo` is not given (default `local/raw-goal`). |
| `--repo-path <path>` | Local repo path used when `--repo` is not given (default `.`). |
| `--base-branch <branch>` | Base branch override (see base branch resolution). |
| `--output-dir <path>` | Report output dir (default `reports/autopilot-plans`; path traversal rejected). |
| `--allowed-files <path>` | Repeatable; constrains the mission's allowed files (path traversal rejected). |
| `--yes` | Skip the confirmation gate for remote writes. |
| `--resume` | Resume a paused mission (see resume rules). |

Any other `--option` is rejected with `Unknown option`. There is no `--clone-url`,
`--workspace`, `--provider`, or similar flag; the workspace location is derived internally.

## Owner/repo configuration (`--repo` input parsing)

`parseRepoInput` in `mission-builder.ts` accepts three forms of `--repo`:

1. **`owner/repo` slug** — matched against `^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$`. The clone URL
   is derived as `https://github.com/<owner>/<repo>.git`.
2. **GitHub URL** — HTTPS (`https://github.com/owner/repo[.git]`) or SSH
   (`git@github.com:owner/repo[.git]`). The URL is used as the clone URL and the slug is
   extracted from it.
3. **Local path** — any other value is resolved as a filesystem path. It must exist and must
   contain a `.git` directory; otherwise the mission fails with `ONE_CLICK_CONFIG_ERROR`.
   The repo slug is derived from the local repo's `origin` remote when it points at GitHub
   (HTTPS or SSH form); otherwise the slug falls back to `local/mission`.

Path traversal (`..`, `../`, `/..`) in `--repo` is rejected before any of the above.

## Local repo handling and automatic repo bootstrap

What happens next depends on the mode:

### github mode (canonical `real-multitask` path)

When `--repo` is given and the mode is `github`, the runner **never executes inside the
human's checkout**. It bootstraps an isolated mission workspace:

1. A workspace root is derived from the default workspace root plus a shortened run id
   (`getDefaultWorkspaceRoot()` + `makeShortRunId(runId)` via `makeMissionWorkspaceRoot`),
   so that long run ids do not create Windows `MAX_PATH` problems during clone. The
   execution workspace is therefore decoupled from the human-readable report path.
2. The repo path inside that workspace is `makeMissionRepoPath(workspaceRoot)`.
3. `cloneMissionRepo` then runs, with `--config core.autocrlf=false`:
   - If the workspace path already exists **and** is a git repository, it is **reused**
     (this is what makes `--resume` work against the same clone).
   - If the path exists but is **not** a git repository, the mission fails with
     `ONE_CLICK_CONFIG_ERROR` ("Mission workspace path exists but is not a git repo").
   - Otherwise the parent directory is created recursively and
     `git clone --config core.autocrlf=false <cloneUrl> <workspacePath>` is executed.
     A local-path `--repo` is cloned from that local path; slug/URL forms are cloned from
     their clone URL.

So "automatic repo bootstrap" means: with `--repo owner/repo` (or a GitHub URL, or a local
repo path), the one-click command clones the repository into a fresh isolated workspace on
first run and reuses that clone on resume. The operator does not have to clone anything
manually.

### fake mode

With `--repo` in fake mode (e.g. `safe` / `multitask-safe` presets), no isolated workspace is
created. The source is used directly:

- local path `--repo` → the resolved local path becomes `repo_path`;
- slug/URL `--repo` → the clone URL string becomes `repo_path` (fake mode never mutates the
  repo; all mutation capabilities are force-disabled in fake mode).

### No `--repo` given

Without `--repo`, the mission uses `--repo-path` (default `.`, i.e. the current directory),
`--repo-slug` (default `local/raw-goal`), and `--base-branch` (default `main`). No cloning
occurs. This form is intended for prepared repos, but note that the canonical real-multitask
workflow expects a github-mode repo with an `origin` remote it can push to.

## Base branch resolution

Base branch resolution order in `resolveRepoAndBase`:

1. **`--base-branch`** — always wins when provided.
2. **github mode with `--repo`** — auto-detected from the cloned repository via
   `resolveDefaultBaseBranch`:
   - fast path: `git symbolic-ref refs/remotes/origin/HEAD` (e.g. resolves to
     `refs/remotes/origin/main` → `main`);
   - fallback: parse `HEAD branch: <name>` from `git remote show origin`;
   - final fallback: literal `main`.
3. **fake mode / no `--repo`** — literal `main`.

Safety: the resolved base branch is rejected if it contains `..`, `/`, or `\`
(`ONE_CLICK_CONFIG_ERROR`, "base_branch contains unsafe characters").

The resolved base branch is later pinned to a concrete SHA by the multitask runner
(`getBaseSha` resolves `base_branch`, falling back to `origin/<base_branch>` for CI-style
checkouts). That SHA is persisted in the mission state and compared on resume: if the base
branch has moved, resume aborts with `MULTITASK_MISSION_FAILED` ("Resume aborted: base
branch moved").

## Mission branch creation

The mission work branch name is deterministic:

```text
mission-<run_id>
```

where `<run_id>` is either `--run-id` (sanitized) or the generated
`mission-YYYYMMDD-HHMMSS-<goal-slug>` from `makeRunId` (goal slug lowercased,
non-alphanumerics collapsed to `-`, truncated).

Branch lifecycle in `multitask/runner.ts`:

- The multitask runner itself **does not pre-create** the work branch. Creation and checkout
  are delegated to the inner MVP runner (`prepareScenarioWorkBranch`), because pre-creating
  and checking out the branch would break the inner runner's own branch preparation.
- Before delegating, the runner checks `branchExists`. If the branch already exists and this
  is **not** a `--resume` run, the mission fails with guidance to rerun with `--resume` or a
  different `--run-id`. If the branch exists but is **not based on** the resolved base SHA
  (merge-base check), reuse is refused outright.
- On `--resume`, every accepted task commit recorded in the persisted mission state must
  still be an ancestor of the work branch (`merge-base --is-ancestor`); otherwise resume
  aborts. Terminal failed results are replayed from state without re-running; paused
  missions (`MULTITASK_MISSION_PAUSED_PROVIDER` / `..._PAUSED_GIT_AUTH`) are explicitly
  non-terminal and re-run on resume.

The mission branch is the only branch the workflow pushes. Rollbacks of rejected/blocked
task commits are `git revert --no-edit` commits on the mission branch; the workflow never
merges, never force-pushes, and never touches `main` (see safety rules below).

## What the user must configure only once

Everything else in the canonical launch is derived from the goal string and `--repo`. The
one-time, per-machine configuration is:

1. **`KIMI_API_KEY`** — provider credential for planner/coder calls. In github mode the
   mission builder sets `provider: { name: 'kimi', token_env: 'KIMI_API_KEY' }`. (The CLI's
   real provider path also reads `KIMI_BASE_URL`; a missing provider token fails the planner
   gate with `ONE_CLICK_NEEDS_TOKEN` before any repository mutation.)
2. **`GITHUB_TOKEN`** — credential used for pushing the mission branch, creating the PR, and
   reading CI (`github: { token_env: 'GITHUB_TOKEN' }`). It must be able to push to the
   target repository. This is verified by a **non-mutating write-auth preflight**
   (`runGitWriteAuthPreflight`) that runs *before the first provider call* whenever the
   mission will push. If the credential cannot push, the mission pauses resumably
   (`MULTITASK_MISSION_PAUSED_GIT_AUTH`) with **zero provider calls consumed**; after fixing
   the token you rerun the printed resume command.
3. **An OpenAI credential for the mission-level final review** in github mode: the multitask
   runner builds the production final-review call (`buildProductionFinalReviewCallFn`); when
   that reviewer is unavailable (errors referencing `OPENAI_API_KEY` / "Final reviewer is
   not available") the mission ends as `MULTITASK_MISSION_NEEDS_HUMAN` rather than failing
   silently. Fake-mode missions use a deterministic fallback reviewer and need no such
   token.
4. **`git` on `PATH`** — cloning, branch resolution, workspace reuse, and the write-auth
   preflight all shell out to `git`.

No other setup is required by the canonical command: no pre-cloned repo, no manually created
branch, no mission JSON, no `--yes`.

## Resume rules (fail-closed)

- Raw-goal missions derive their run id from the current time, so `--resume` on a raw goal
  **requires the original `--run-id`**; otherwise the run fails closed with
  `ONE_CLICK_CONFIG_ERROR` ("Resume requires the original --run-id for a raw-goal mission")
  before any provider call, report directory, or repository mutation.
- Mission JSON inputs are exempt because they carry a stable `run_id`.
- Resume aborts if the plan changed (`plan_hash` mismatch) or the base branch moved
  (`base_sha` mismatch).
- Paused missions print a ready-to-run resume command (`resume_command`), built from the
  original command plus `--run-id <id> --resume`.

## Safety envelope (always printed)

Every invocation prints the hard safety rules before doing any work:

```text
Forbidden:
  - github.merge
  - git.force_push
  - github.actions.rerun
  - repo.delete_branch
```

No preset enables any of these. Fake mode additionally force-disables every mutation
capability regardless of preset (`allow_real_provider`, `allow_repo_apply`,
`allow_repo_commit`, `allow_repo_push`, `allow_pr_create`, `allow_pr_update`,
`allow_actions_read`, `allow_repair` are all forced to `false`).

## Preset capability matrix (from `applyPreset`)

| Capability | safe | read-ci | real-pr | real-repair | real-multitask | multitask-safe |
|---|---|---|---|---|---|---|
| allow_real_provider | – | – | ✓ | ✓ | ✓ | – |
| allow_repo_apply / commit / push | – | – | ✓ | ✓ | ✓ | – |
| allow_pr_create / update | – | – | ✓ | ✓ | ✓ | – |
| allow_actions_read | – | ✓ | ✓ | ✓ | ✓ | – |
| allow_repair | – | – | – | ✓ | ✓ | – |
| default mode | fake | github* | github | github | github | fake |
| repair max_attempts | 1 | 1 | 1 | 2 | 2 | 1 |

*mode for `read-ci` defaults to `github` because only `safe` and `multitask-safe` force
`fake`. Presets `safe`/`multitask-safe` combined with `--mode github` are rejected
("preset requires mode 'fake'"), and `real-multitask` requires github mode.

Only `real-multitask` and `multitask-safe` (or a mission JSON whose constraints contain
`Preset: real-multitask` / `Preset: multitask-safe`) route into the autonomous multitask
mission runner; other presets run the single-plan autopilot flow.

## Output layout

Reports are written under `<output_dir>/<run_id>/` (default
`reports/autopilot-plans/<run_id>/`), including the plan artifacts generated by
`autopilot-plan` (`plan.md`/`plan.json`, `mvp-run.config.json`, `autopilot.config.json`,
etc.) plus `one-click-report.md` / `one-click-report.json` written by the one-click report
writer, and the multitask mission report/state files. The final console summary prints the
run id, mode, preset, plan verdict, autopilot verdict, final verdict, report directory, and
the next human action (e.g. "Review the PR at <url>..." or the resume instructions for a
paused mission).
