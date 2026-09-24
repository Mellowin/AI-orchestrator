# 04 — Safety Model: Hard Invariants vs. Advisory Policy

This document describes the safety model of the autonomous multitask
workflow, building on [01-one-click.md](./01-one-click.md) (launch and hard
launch rules), [02-task-lifecycle.md](./02-task-lifecycle.md) (per-task
execution), and [03-review-and-recovery.md](./03-review-and-recovery.md)
(review/fix loop and resume reconciliation). It is grounded in the actual
enforcement code (`src/real-repo-apply-safety.ts`,
`src/block/block-real-mode-safety.ts`, `src/guardrails.ts`,
`src/ai-safety-policy.ts`, `src/reviewer/deterministic-review-checks.ts`) and
in `docs/SAFETY_INVARIANTS.md`.

## 1. Two tiers, and why the distinction matters

The system has **two fundamentally different kinds of rules**, and they must
never be conflated:

1. **Hard safety invariants** — enforced, blocking checks. A violation stops
the run (or the review) *before* the dangerous thing happens. These are
design-level guarantees, not configuration options, and they do not depend on
provider behavior, model judgment, or budget tuning.
2. **Quality / advisory policy** — non-blocking guidance. These signals inform
the planner, the coder, and the reviewer, but they do **not** gate execution.
Exceeding an advisory budget is a reason to look closer, never an automatic
stop.

The distinction matters because describing an advisory budget as a hard limit
would be false documentation: it would claim a guarantee the code does not
enforce, and it would invite operators to rely on a control that does not
exist. Section 6 states this explicitly for `max_lines_changed`.

## 2. Hard safety invariants

Hard invariants share these properties:

- They are checked **deterministically in code**, before any mutation or
  provider call.
- A violation **blocks** — the command refuses to proceed, or the reviewer
  gate synthesizes a rejection (`block_for_human` for severe findings,
  `send_fix_to_coder` otherwise) **without calling the reviewer model**.
- They cannot be weakened by prompt wording, plan content, or retry loops.

The hard invariant families are:

| Family | Guarantee | Enforcement point |
|---|---|---|
| Main branch protection | Never commit/push directly to `main` | `validateRealRepoApplySafety`, `validateRealOneTaskModeSafety`, deterministic review checks |
| Path safety | Writes stay inside the repo; no traversal/absolute paths | `validateFileList`, `validateProposedFileLineDeltas`, `checkPathEscape` in `validateAiSafetyPolicy` |
| Sensitive file protection | `.env`, credentials, and secret-handling patterns are denied | `isDeniedPath`, `checkSecretExfiltration`, secret patterns in deterministic review checks |
| Test weakening detection | Tests cannot be gutted to make checks pass | `checkTestWeakening` in `validateAiSafetyPolicy` |
| Git operation policy | No merge, force-push, reset, checkout/switch, or `git add -A` | `SAFETY_MODEL.md` §3, `stageOnlyFiles`, file-level rollback only |
| Clean tree / branch match | Mutation requires a clean tree on the expected work branch | `ensureClean`, `validateRealRepoApplySafety` |
| Opt-in gating | Every real action requires an explicit env flag, default off | `SAFETY_MODEL.md` §2 opt-in table |

## 3. Main branch protection

The protected base branch (`main`) is never mutated. This is enforced at
multiple independent layers, so no single check failure can expose it:

- **Pre-mutation validation.** `validateRealRepoApplySafety` rejects the run
  if the current branch is `main`, if `work_branch` is `main`, if the current
  branch does not equal `work_branch`, or if the working tree is dirty. It
  also requires `auto_commit`, `auto_push`, and `auto_merge` to all be
  `false` in the task guardrails.
- **Real-mode one-task gate.** `validateRealOneTaskModeSafety` repeats the
  branch checks (current branch is not `main`, not detached `HEAD`, equals
  the work branch; work branch is not `main`) **before** any git or
  filesystem call, alongside the pure flag checks.
- **Reviewer gate.** The deterministic review checks flag a `main` current
  branch as a *severe safety finding*, producing `block_for_human`
  immediately — the reviewer model is never consulted on a main-branch
  violation.
- **No merge at all.** No command merges anything. Merge decisions belong to
  the human operator after the PR status report; the tool stops at that
  boundary (`SAFETY_MODEL.md` §7).

All work happens on the dedicated mission work branch (`mission-<run_id>`,
see document 02 §2), and rejected commits are removed with revert commits on
that branch — never by rewriting history and never by touching `main`.

## 4. Path safety

All file writes are confined to the repository and to the task's declared
scope:

- **No absolute paths.** `validateFileList` and `validateProposedFileLineDeltas`
  reject absolute paths outright; `isAbsolutePath` in the AI safety policy
  also catches Windows-style `C:/...` forms.
- **No traversal.** Any path containing `..` is rejected, and backslash paths
  are rejected in favor of unix-style separators.
- **Repo-confined writes.** `isInsideRepo` resolves the candidate path
  against the repo root and rejects anything that escapes it.
- **Allow/deny lists.** When `allowed_files` is set, every changed file must
  match it; `denied_files` matches are always rejected. The same lists are
  re-checked at review time: a changed file outside `allowedFiles` or
  matching a denied pattern is a blocking issue (denied files are a severe
  finding).
- **Content-level path operations.** For code-like files,
  `checkContentLevelPathOperations` additionally scans the *content* for
  dangerous path literals (`../`, `/etc/`, `/tmp/`, drive letters, etc.) in
  `fs` operations, `path.join('..', ...)`, `child_process` calls, and
  `package.json` scripts.

## 5. Sensitive file and secret protection

Secrets are protected on three axes — access, persistence, and leakage:

- **Sensitive paths denied.** `isDeniedPath` rejects any path containing
  `.env`, `.env.local`, `.git`, or `node_modules` segments.
- **Secret-handling patterns blocked.** `checkSecretExfiltration` blocks
  code that reads or leaks secrets: `process.env.<...API_KEY|SECRET|TOKEN|PASSWORD>`
  access (dot or bracket notation), logging or `JSON.stringify`-ing
  `process.env`, loading `dotenv`, or reading `.env` files. Literal env-var
  *names* in documentation or constants are explicitly **not** treated as
  credentials — only real secret handling is blocked.
- **Secret detection in diffs.** The deterministic review checks scan the raw
  diff for `sk-` tokens, `Bearer` tokens, `KIMI_API_KEY`, `OPENAI_API_KEY`,
  `ANTHROPIC_API_KEY`, `GITHUB_TOKEN`, and `.env` references. A hit is a
  severe safety finding → `block_for_human`, no reviewer call.
- **Redaction on output.** Reported issues use generic labels, never raw
  secret values. `redactReviewerText` / `redactReviewerList` strip secrets
  from reviewer context, fix tasks, blocking issues, check logs, and CLI
  output, so a detected secret cannot propagate into prompts, state files,
  or reports. API keys live in environment variables only and are never
  persisted (`SAFETY_MODEL.md` §6).

## 6. Test weakening detection

Making a change "pass" by weakening the tests is treated as a safety
violation, not a quality issue. `checkTestWeakening` in
`validateAiSafetyPolicy` inspects test files (identified by path:
`tests/` directories, `*.test.*`/`*.spec.*` suffixes, `test*.js` names) and
blocks:

- `.only` / `.skip` test selectors (focusing or disabling tests);
- emptying a test file;
- commented-out assertions (`// assert...`, `// expect...`,
  `// process.exit(1)`, `// throw new Error`);
- test files with no assertions that only print `ok`.

CI weakening is covered too: `checkCiWeakening` rejects `continue-on-error`
in workflow files, so a task cannot make a failing pipeline green by
silencing it.

## 7. Advisory policy: `max_lines_changed` and other budgets

**`max_lines_changed` is an advisory budget, not a hard limit. It must not
be described as a hard limit.**

This is deliberate and implemented in code. In
`src/reviewer/deterministic-review-checks.ts`, the diff line count is
computed and compared against `maxLinesChanged`, but the comment is explicit:

> Max lines changed is advisory unless the user explicitly configures a hard
> limit. The planner value is not a deterministic safety gate. ... Do NOT
> block; treat as a non-binding advisory signal for the reviewer.

Concretely:

- The budget exists to keep changes reviewable and to help the planner and
  coder scope their work. It is a *quality* signal.
- Exceeding it does **not** stop the run, does **not** reject the commit in
  the deterministic reviewer gate, and does **not** appear in any blocking
  invariant list. The reviewer prompt labels the budget as advisory.
- It must never be cited as evidence that "large changes are impossible" or
  as a substitute for the real hard gates (path scope, secrets, main-branch
  protection, check results). A small diff can be dangerous and a large diff
  can be fine; safety comes from the blocking invariants, not from line
  counts.
- The same advisory framing applies to analogous planning budgets (e.g., the
  per-task line-delta preference stated in task guardrails). They guide
  planning; they do not enforce safety, and correctness or safety must never
  be compromised to fit them.

One nuance for accuracy: at *apply* time, `validateProposedFileLineDeltas`
in `src/guardrails.ts` can throw when a proposed per-file delta exceeds a
configured `maxLinesChanged` — that is an operator-configured sanity tripwire
on the write path, separate from the reviewer gate. This does not make the
budget a safety invariant: the safety model's guarantees in §2–§6 hold with
or without any line budget, and no document should present the budget itself
as a hard safety limit.

## 8. Summary

| Rule | Tier | Effect of violation |
|---|---|---|
| Never commit/push to `main` | Hard | Run blocked pre-mutation; `block_for_human` at review |
| No merge / force-push / reset / `git add -A` | Hard | Operations not implemented; never invoked |
| Path traversal / absolute paths / repo escape | Hard | Write rejected |
| `allowed_files` / `denied_files` scope | Hard | Write rejected; denied file at review → `block_for_human` |
| `.env` / credentials / secret exfiltration | Hard | Write rejected; secret in diff → `block_for_human` |
| Test weakening (`.only`/`.skip`, dead assertions) | Hard | Write rejected |
| CI weakening (`continue-on-error`) | Hard | Write rejected |
| Secrets in prompts/reports/state | Hard | Redacted before use |
| `max_lines_changed` budget | **Advisory** | Non-blocking signal for reviewer; **not a hard limit** |

The hard rows are the safety model. The advisory row is planning guidance.
Keeping that line sharp — in docs, in prompts, and in reviews — is itself
part of the safety model.
