# Safety Model: Hard Safety vs Advisory Policy

This document describes the safety model of the autonomous workflow, building on [01-one-click.md](01-one-click.md), [02-task-lifecycle.md](02-task-lifecycle.md), and [03-review-and-recovery.md](03-review-and-recovery.md). Its core principle is a strict separation between two tiers of rules:

- **Hard safety invariants** — non-negotiable boundaries enforced by deterministic code. They cannot be overridden by the model, by a plan, or by a reviewer decision. A violation stops the run (or blocks for a human) before any mutation or provider call proceeds.
- **Quality and advisory policy** — guidance that shapes good output and keeps changes reviewable, but which is not a security boundary. Advisory rules may be relaxed with a note when correctness or completeness requires it.

The deterministic layer is always the security boundary. Model output — coder or reviewer — is advisory and can never grant a capability the deterministic layer has denied.

## Hard safety invariants

Hard invariants share these properties:

- They are enforced before any mutation, push, or provider call.
- A violation is a blocking issue; severe findings escalate to `block_for_human` without calling the AI reviewer.
- No environment flag, plan field, or model decision can disable them.

### Main protection

`main` (or the resolved base branch) is protected by design, not by convention:

- **No mutation on the base branch.** The current branch must equal the mission work branch (`mission-<run_id>`), and the work branch must not be `main`. A branch mismatch, a detached `HEAD`, or `main` as current/work branch is a hard failure (`validateRealRepoApplySafety`, `validateRealOneTaskModeSafety`).
- **No automatic merge.** Merge is never performed by any command. The human operator decides whether to merge after reviewing the PR.
- **No force push, no history rewriting.** Only `git push origin <workBranch>` is allowed; `--force`, `--tags`, `--all`, and `--mirror` are forbidden. `git reset` and `git rebase` are never used by the tooling. `git checkout`/`git switch` is used exactly once per mission: to create the mission work branch `mission-<run_id>` from the pinned base SHA (see document 01). It is never used to switch to `main` or any other branch during task execution, and never for automatic branch switching beyond that one-time work-branch creation.
- **No `git add -A`.** Only explicitly allow-listed files are staged via `git add -- <file>`.
- **Clean-tree gate.** The working tree must be clean before any mutation; unrelated or unapproved changes (`assertNoUnrelatedChanges`) stop the run.
- **Base-SHA pinning and ancestry checks.** Each task builds on a pinned `task_base_sha`; on resume, accepted commits must still be ancestors of the work branch and the base SHA must not have moved, otherwise the mission aborts rather than rebuilding on different history (see document 03).

### Path safety

File paths are validated deterministically before staging or writing (`validateFileList`, `checkPathEscape`):

- **Absolute paths are rejected.**
- **Parent-directory traversal (`..`) is rejected**, including paths that escape the repository root after resolution.
- **Backslash paths are rejected**; all paths must be unix-style relative paths.
- **Allow list enforcement.** Every touched path must match `allowed_files` / `allow_modify`. A path outside the allow list is a hard failure.
- **Deny list enforcement.** Paths matching `denied_files` / `deny_modify` are hard failures, and a denied-file touch during review is a severe finding that blocks for a human.
- **Scope re-check after staging.** The post-staging status is parsed and any modified path outside the approved set fails the task.

### Sensitive files and secrets

Certain paths and content are hard-denied regardless of any plan:

- **Sensitive paths.** `.env`, `.env.local`, `.git`, and `node_modules` path segments are denied outright.
- **Secret exfiltration patterns.** Accessing secret environment variables (`process.env.*API_KEY*` / `*TOKEN*` / `*SECRET*` / `*PASSWORD*`, including bracket notation), logging or serializing `process.env`, loading `dotenv`, or reading `.env` files is flagged in proposed content.
- **Secret detection in diffs.** The deterministic reviewer gate scans the raw diff for `sk-` tokens, `Bearer` tokens, API-key assignments, and `.env`-like patterns. Detection is a severe safety finding that returns `block_for_human` immediately, without calling the AI reviewer.
- **Redaction before reporting.** Any dynamic text (tool output, check logs, reviewer summaries, fix context) is redacted (`redactReviewerText` / `redactReviewerList`) before it appears in reports, state files, prompts, or CLI output. Reported issues use generic labels, never raw secret values.
- **No credential persistence.** API keys (`KIMI_API_KEY`, `GITHUB_TOKEN`, `OPENAI_API_KEY`) live in environment variables only. They are never printed, never written to state, reports, or commit messages, and never included in fix/repair prompts.

### Test weakening

Proposed changes that weaken the test or CI safety net are hard-blocked (`checkTestWeakening`, `checkCiWeakening`, `checkRepairSafety`):

- **Test selectors.** `.only`, `.skip`, and `.todo` calls in test files are flagged.
- **Commented-out assertions.** Comment lines referencing `assert`, `expect`, `process.exit(1)`, or `throw new Error` are flagged.
- **Empty or assertion-free tests.** A test file that would become empty, or that only prints `ok` with no assertion, is flagged.
- **CI weakening.** `continue-on-error` in workflow files, `|| true`, disabled verification steps, and similar failure-suppression patterns are flagged.
- **Test removal language and assertion removal** in proposed repair patches are flagged, as are token-like strings and force-push/merge commands embedded in patch content.

These checks exist so that a coder (or a fix loop) can never make a failing change pass by removing the evidence of failure.

### Opt-in gates

All real-world capabilities are deny-by-default: every flag (`ALLOW_REAL_REPO_APPLY`, `ALLOW_REAL_REPO_COMMIT`, `ALLOW_REAL_REPO_PUSH`, `ALLOW_REAL_PROVIDER`, `ALLOW_GITHUB_PR_CREATE`, and so on) defaults to `false`. Flag checks run **before** any git or filesystem call. Fake mode never mutates the real repository. This opt-in structure is itself a hard invariant: forgetting a flag stops the run, it never silently enables a capability.

## Quality and advisory policy

Advisory rules improve reviewability and keep changes small, but they are **not** hard limits. They never justify weakening correctness, skipping required changes, or removing tests to fit a budget.

### The `max_lines_changed` advisory budget

`max_lines_changed` is an **advisory size budget**, not a hard limit:

- **Purpose.** It encourages small, reviewable diffs and gives planners and operators a planning estimate for how large a task's change should be (for a newly created file, the estimate covers the full file length).
- **Guideline.** Prefer to keep the line delta for any single file under the budget (the default advisory budget used in these workflows is 250 lines per file).
- **Not a security boundary.** Exceeding the budget is acceptable when the task genuinely requires more lines — for example a thorough documentation file, a generated artifact, or a change that cannot be split further. In that case, include a short note explaining why the budget was exceeded.
- **Never trade safety for size.** Do not drop required test coverage, skip safety-related content, or weaken a change just to fit the budget. A correct, safe change that exceeds the budget is always preferred over a smaller incorrect one.

### Other advisory policies

- **Prefer tests with changes.** Tasks are encouraged to include `.test.` / `.spec.` files alongside source changes so the deterministic checks have something to verify.
- **Avoid broad `any` casts.** Where an `any` cast is unavoidable, include a justification comment rather than suppressing the concern silently.
- **Keep commits scoped.** Each accepted task should land as one logical unit of work touching only its allow-listed files.

## Summary: which tier each rule belongs to

| Rule | Tier | On violation |
|---|---|---|
| Never mutate or push to `main`; work only on the mission branch | Hard | Run blocked before any git call |
| No merge, force-push, reset, or rebase | Hard | Never executed by tooling |
| `git checkout`/`git switch` restricted to the one-time creation of `mission-<run_id>` from the pinned base SHA; never used to switch to `main` or another branch during task execution | Hard | Automatic branch switching never executed by tooling |
| Clean working tree; no unrelated changes | Hard | Task/run fails before mutation |
| Path traversal, absolute paths, backslashes | Hard | Rejected before staging |
| `allowed_files` / `denied_files` scope | Hard | Blocking issue; denied-file touch blocks for human |
| `.env` / `.git` / `node_modules` paths | Hard | Rejected before staging |
| Secret patterns in diffs; secret exfiltration in content | Hard | Severe finding → `block_for_human` |
| Redaction of secrets in reports, prompts, and logs | Hard | Always applied before output |
| Test weakening (`.only`/`.skip`, commented assertions, empty tests) | Hard | Rejected; fix loop or human |
| CI weakening (`continue-on-error`, `|| true`, disabled checks) | Hard | Rejected; fix loop or human |
| Opt-in flags default to `false` | Hard | Capability disabled unless explicitly enabled |
| Bounded fix attempts (`max_fix_attempts`) | Hard | Task becomes `blocked` when exhausted |
| `max_lines_changed` | **Advisory** | Note why when exceeded; never a hard limit |
| Prefer tests with changes; justify `any` casts; scoped commits | Advisory | Reviewer feedback / fix-loop guidance |

## Human boundary

Hard safety ends where human judgment begins. The system can plan, implement, check, review, roll back, push a work branch, and create a draft PR — but it never merges, never force-pushes, and never deletes branches on its own. After the PR and CI status are reported, the system stops: the human decides whether to merge, request changes, or clean up.
