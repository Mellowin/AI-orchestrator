# 04 — Safety Model: Hard Safety vs. Advisory Policy

This document describes the safety model of the autonomous multitask workflow,
and in particular the boundary between **hard safety** (enforced, fail-closed,
never overridable by the model) and **quality/advisory policy** (signals that
guide the planner, coder, and reviewer but are not security boundaries). It
builds on [01 — One-Click Launch](01-one-click.md),
[02 — Task Lifecycle](02-task-lifecycle.md), and
[03 — Review and Recovery](03-review-and-recovery.md). The normative
references are `SAFETY_MODEL.md`, `docs/SAFETY_INVARIANTS.md`, and the
enforcing code in `src/guardrails.ts`, `src/ai-safety-policy.ts`,
`src/real-repo-apply-safety.ts`, `src/block/block-real-mode-safety.ts`, and
`src/reliability/repair-safety.ts`.

## The two layers

The system deliberately separates two kinds of rules:

| Layer | Nature | Who enforces it | Can the model override it? |
|---|---|---|---|
| **Hard safety** | Fail-closed invariants. A violation stops the run before mutation, or blocks review before any provider call. | Deterministic code only (validators, git checks, pattern scanners). | Never. A passing model verdict cannot undo a hard-safety failure. |
| **Quality / advisory policy** | Planning estimates and review signals (size budgets, style guidance, scope expectations). | Reported to the reviewer and recorded in artifacts. | Not applicable — these are inputs to judgment, not gates. |

The reason for the separation: hard safety protects the repository, the
credentials, and the human's merge authority. Advisory policy protects
*reviewability* — small, focused, well-scoped changes are easier for a human
to audit — but an estimate being exceeded is not, by itself, a safety event.

## Hard safety: deny-by-default

Every real capability is opt-in (`ALLOW_*` environment flags, defaulting to
`false`), and flag checks run **before** any git or filesystem call. Beyond
the opt-in table in `SAFETY_MODEL.md`, the following areas are hard safety.

### Main branch protection

`main` is never touched by the workflow. This is enforced at multiple,
independent layers rather than trusted to a single check:

- `validateRealRepoApplySafety` rejects the run if the current branch is
  `main`, if `work_branch` is `main`, or if the current branch does not equal
  `work_branch`.
- `validateRealOneTaskModeSafety` additionally rejects a detached `HEAD`, a
  `main` current branch, and a `main` work branch before any mutation.
- The working tree must be clean before any mutation (`ensureClean`), so the
  workflow never commits on top of unreviewed local changes.
- There is no automatic merge, rebase, reset, checkout/switch, or force push:
  the git operation policy in `SAFETY_MODEL.md` §3 forbids them outright.
  Only read-only inspection, `git add -- <file>` for explicitly approved
  paths, `git commit` on the work branch, and a plain
  `git push origin <workBranch>` are allowed.
- Rollback is a local `git revert --no-edit` of mission-owned commits (newest
  first), never a destructive history rewrite; the human decides what to push
  (see doc 02, "Push").

### Path safety

File paths are validated before any write, at two levels:

- **Guardrail scope** (`validateFileList` in `src/guardrails.ts`): every
  changed file must match `allow_modify` (when defined) and must not match
  any `deny_modify` pattern. Absolute paths, `..` traversal segments, and
  backslash paths are rejected unconditionally — unix-style relative paths
  only.
- **Policy scope** (`checkPathEscape` in `src/ai-safety-policy.ts`):
  proposed file contents are checked for absolute paths, parent-directory
  references, and escapes outside the repository root, in addition to the
  `allowed_files` / `denied_files` lists.
- **Content-level path operations**: in code-like files (`.js`, `.ts`,
  `.mjs`, `.cjs`, `.sh`, `.ps1`, `package.json`, workflow files), literal
  file-system or `child_process` calls that target dangerous paths (`/etc/`,
  `/tmp/`, home/root/system directories, `..` traversal, drive-letter
  absolute paths) are rejected, as are `path.join('..', ...)` and
  `package.json` scripts redirecting to such paths.
- **Unrelated changes**: `assertNoUnrelatedChanges` stops the run if the
  working tree contains unapproved modifications after apply.

### Sensitive files and secrets

Two mechanisms apply:

1. **Denied paths.** Any path containing a `.env`, `.env.local`, `.git`, or
   `node_modules` segment is denied outright (`isDeniedPath`). Workflow files
   under `.github/workflows/` are additionally protected from repair patches
   unless explicitly allowed (`checkRepairSafety`, `workflow_modified`).
2. **Secret handling.** Proposed content is scanned for secret exfiltration
   patterns: `process.env` access to API-key/secret/token variables (dot or
   bracket notation), logging or `JSON.stringify` of `process.env`, loading
   `dotenv`, and reading `.env` files (`checkSecretExfiltration`). Diffs are
   also scanned for secret-shaped strings (`sk-`, `Bearer`, GitHub token
   prefixes such as `ghp_`/`github_pat_`, and key/value secret patterns in
   `checkRepairSafety`). A secret finding is a **severe** safety finding:
   the deterministic gate returns `block_for_human` immediately, without any
   AI review. API keys live only in environment variables; they are never
   printed, persisted to state/report files, or included in prompts — all
   tool output is redacted before it reaches the reviewer or the coder
   (`redactReviewerText` / `redactReviewerList`).

Note the deliberate asymmetry: the *names* of environment variables
(`KIMI_API_KEY`, `GITHUB_TOKEN`, …) in documentation or source constants are
not credentials and are not blocked; real secret access is.

### Test weakening detection

Making the test suite artificially pass is treated as a hard-safety
violation, not a style issue. `checkTestWeakening` in
`src/ai-safety-policy.ts` rejects, for files recognized as tests
(`tests/` paths, `*.test.*` / `*.spec.*`, `test*.js`):

- `.only` / `.skip` selectors that would shrink the executed test set,
- emptying a test file,
- commenting out assertions (`assert`, `expect`, `process.exit(1)`,
  `throw new Error` behind a comment),
- a "test" with no assertions that only prints `ok`.

The repair path adds a second, independent scan (`checkRepairSafety`):
`skip`/`only`/`todo` calls, patches whose text suggests removing or deleting
tests or assertions, CI failure-suppression patterns (`|| true`,
`continue-on-error: true`, `fail-fast: false`, disabled verification steps),
force-push or merge instructions, token-shaped strings, secret-like
key/value pairs, and unjustified broad `any` casts. Combined with the
workflow-file protection above (`continue-on-error` in a workflow file is
also rejected by `checkCiWeakening`), a coder cannot satisfy the reviewer by
weakening the checks that feed it.

### Deterministic-first review

As documented in doc 03, every review runs deterministic checks before any
model call, and the model can never override a deterministic failure. Severe
findings (secrets, main-branch violation, merge-conflict markers, denied
files, invalid commit SHA) short-circuit to `block_for_human`; other
failures go back to the coder as `send_fix_to_coder`. Model approval is not
a security boundary — the mission final review overrides a model "approve"
to `rejected` whenever deterministic gaps or unauthorized files exist.

## Advisory policy: `max_lines_changed` and size budgets

`max_lines_changed` is an **advisory** budget. It exists so that plans stay
small enough for a human to review, and so that an unexpectedly large diff is
*visible* — it is not a hard safety limit, and it must not be treated as
one:

- In the per-task reviewer gate it is **reported to the reviewer as context**
  rather than acting as a deterministic rejection (see doc 03, "The reviewer
  gate"). The planner's estimate of a diff's size is not a safety boundary:
  legitimate work can exceed it, and unsafe work can fit under it.
- Where a task configuration explicitly sets a per-file line budget,
  `validateProposedFileLineDeltas` (and `validateDiffSize` for whole-diff
  stats) will flag the overrun as a guardrails failure so a human sees it.
  This is a *quality signal with a fail-closed surface*, configurable per
  task — not one of the immutable invariants like branch protection, path
  scope, or secret handling.
- The same applies to documentation budgets (such as "prefer under N lines
  per file" guidance in task definitions): they are planning estimates.
  Correctness and safety take precedence; exceeding the estimate warrants a
  note explaining why, never a compromise that weakens a hard-safety check.

The practical rule: **if it protects the repo, the credentials, or the
human's merge authority, it is hard safety and fail-closed. If it protects
reviewability, it is advisory — surface it, explain it, never silently
enforce it as if it were safety.**

## The human boundary

Hard safety ends where human authority begins. After the PR status report,
the system stops: no merge, no auto-merge, no branch deletion, no
ready-for-review transition without an explicit separate gate. The human
decides whether to merge, reject, request changes, or clean up. Advisory
signals (size overruns, caveats, warnings) are presented to that human as
part of the report; hard-safety violations are what can prevent the report
from ever being produced.
