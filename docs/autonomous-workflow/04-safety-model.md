# Autonomous Workflow 04 — Safety Model

This document describes the safety model that governs the autonomous workflow
launched in `01-one-click.md` and executed through the task lifecycle in
`02-task-lifecycle.md` and the review/fix machinery in `03-review-and-recovery.md`.
It is grounded in the actual safety code: `src/guardrails.ts`,
`src/ai-safety-policy.ts`, `src/real-repo-apply-safety.ts`, and
`src/block/block-real-mode-safety.ts`.

The model has two layers, and keeping them separate is the point of this document:

1. **Hard safety** — checks that block the run. A violation stops the workflow;
   there is no override flag, no `--force`, and no human-in-the-loop bypass
   inside the tool. These protect the repository, credentials, and the integrity
   of the test suite.
2. **Quality / advisory policy** — guidance that shapes the size and style of
   changes (most notably `max_lines_changed`). These are planning aids and
   review signals. They are **not** security boundaries and must never be
   described as hard limits.

## Hard safety: main and branch protection

`main` is protected by construction, not by convention.

- `validateRealRepoApplySafety` (`src/real-repo-apply-safety.ts`) refuses to
  proceed when the current branch is `main`, when `work_branch` is `main`, when
  either is missing/empty, when the current branch does not equal `work_branch`,
  or when the working tree is not clean. Any of these returns `{ ok: false }`
  before a single file is touched.
- The same validator requires `auto_commit`, `auto_push`, and `auto_merge` to be
  explicitly `false` — merge automation is not implemented anywhere.
- `validateRealOneTaskModeSafety` (`src/block/block-real-mode-safety.ts`)
  repeats the branch gate at the loop level: current branch `main` or detached
  `HEAD` is a blocking issue, a `work_branch` of `main` is a blocking issue, a
  branch mismatch is a blocking issue, and a dirty working tree before mutation
  is a blocking issue. Real modes additionally require their explicit opt-in
  flags (`ALLOW_BLOCK_RUN_ONE`, `ALLOW_REAL_PROVIDER`, `ALLOW_REAL_REPO_APPLY`,
  `ALLOW_REAL_REPO_COMMIT`, and for the Kimi reviewer variant
  `ALLOW_KIMI_REVIEWER`); any missing flag blocks the run.
- The one-click layer prints the same standing prohibitions on every launch:
  no merge, no force push, no Actions rerun, no branch deletion (see document
  01).

## Hard safety: path safety

Path validation runs at two levels — the declared file list and the proposed
file contents.

- `validateFileList` (`src/guardrails.ts`) rejects, per file: absolute paths,
  any path containing `..`, any path containing a backslash (unix-style paths
  only), any path outside `allow_modify` when that list is defined, and any path
  matching `deny_modify`. `matchesPattern` compiles glob patterns (`*`, `**`) to
  anchored regular expressions so matching is exact, not substring-based.
- `checkPathEscape` (`src/ai-safety-policy.ts`) is the deeper guard: it
  normalizes separators, detects absolute paths on both unix and Windows
  (`/…` and `C:/…` forms), rejects `..` segments, and resolves the candidate
  against the repo root to prove it stays inside (`isInsideRepo`). It also
  hard-denies path segments `.env`, `.env.local`, `.git`, and `node_modules`,
  and enforces explicit `allowed_files` / `denied_files` when provided.
- `checkContentLevelPathOperations` looks inside code-like files
  (`.js/.ts/.mjs/.cjs/.sh/.ps1`, `package.json`, workflows) for operations
  pointing outside the repo: `fs` read/write calls with dangerous path literals
  (`/etc`, `/tmp`, `C:\`, `/proc`, …), `path.join('..', …)`, `child_process`
  exec/spawn commands targeting outside paths, and `package.json` scripts that
  redirect to dangerous paths. All of these produce blocking reasons via
  `validateAiSafetyPolicy`, which aggregates every reason and returns
  `ok: false` if any exist.

## Hard safety: sensitive files and secrets

Secret protection is content-aware, not just path-based.

- The path layer (above) denies `.env`, `.env.local`, `.git`, and
  `node_modules` outright.
- `checkSecretExfiltration` (`src/ai-safety-policy.ts`) blocks proposed content
  that: accesses sensitive env vars (`process.env.*API_KEY`, `*SECRET`,
  `*TOKEN`, `*PASSWORD`, including bracket notation), logs or serializes
  `process.env`, loads `dotenv`, reads a `.env` file with `readFileSync`, or
  references the literal `KIMI_API_KEY` name.
- Consistent with `SAFETY_MODEL.md`, tokens are never printed or persisted;
  redaction in the reviewer/fix pipeline (document 03) means secrets cannot
  leak into prompts, state files, or reports even when a failure message
  contains them.

## Hard safety: test weakening and CI weakening

A change that quietly neuters the safety net is treated as unsafe, not merely
low-quality.

- `checkTestWeakening` (`src/ai-safety-policy.ts`) applies to anything that
  looks like a test: files under a `test(s)/` directory, `*.test.*` / `*.spec.*`
  names, `test*.js` files, or content containing assertion markers (`assert`,
  `expect`, `describe(`, `it(`, `test(`, `process.exit(1)`, `throw new Error`).
  For such files it blocks: `.only` / `.skip` selectors, an empty test file,
  commented-out assertion lines, and files with no assertions at all that only
  `console.log('ok')`.
- `checkCiWeakening` blocks `continue-on-error` in GitHub workflow files
  (`.github/workflows/*.yml|yaml`).
- Complementing this, `validateTestsPresent` (`src/guardrails.ts`) can require
  that a change set includes at least one `.test.` or `.spec.` file when
  `requireTests` is enabled, and `validateDiffSize` rejects diffs containing
  binary files outright.

## Advisory policy: max_lines_changed is not a hard limit

`max_lines_changed` is the workflow's **change-size budget**. It exists to keep
changes reviewable and to surface scope creep early. It is quality policy, not
a security control:

- The mechanism is a *per-file line delta*: `validateProposedFileLineDeltas`
  (`src/guardrails.ts`) compares the current line count of each file on disk
  with the proposed content and reports when `Math.abs(delta)` exceeds
  `max_lines_changed`; `validateDiffSize` does the analogous whole-diff
  comparison (`insertions + deletions` against `maxLines`).
- Because the check measures volume, not danger, the budget is treated as
  **advisory guidance and a planning estimate** — for a newly created file it
  simply estimates the full file length. It is deliberately overridable with
  justification: when a correct, safe change legitimately needs more lines, the
  right response is a larger change plus a note explaining why, not a weakened
  or incomplete change squeezed under the number.
- **The budget must never be satisfied by compromising correctness or safety.**
  Splitting a change to dodge the budget, deleting tests to shrink a diff, or
  truncating required content to fit are all worse than exceeding the budget.
  Conversely, the hard checks above apply in full no matter how small the diff
  is — a one-line change that touches `main`, escapes the repo, exfiltrates a
  secret, or weakens a test is still blocked.
- In short: hard safety decides *whether* a change may be applied at all; the
  line budget informs *how* changes should be sized and reviewed, and deviations
  are documented, not forbidden.

## Summary

| Layer | Examples | On violation |
|---|---|---|
| Hard safety | main/branch protection, clean-tree gate, opt-in flags, path escape and deny-list checks, sensitive-file/secret blocks, test and CI weakening detection | Run is blocked; no in-tool override |
| Quality / advisory | `max_lines_changed` line-delta budget, per-file change-size planning estimates | Documented with a justification note; never resolved by compromising correctness or safety |

The guarantee mirrors the rest of this series: the orchestrator can autonomously
propose, apply, and commit work on a dedicated branch, but the hard layer
ensures it can never touch `main`, escape the repository, leak credentials, or
gut the tests — and the advisory layer ensures big changes stay visible to the
human who owns the final merge decision.
