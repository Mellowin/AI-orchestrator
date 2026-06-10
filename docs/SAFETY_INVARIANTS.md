# Safety Invariants

This document lists the hard safety invariants enforced by the AI Orchestrator. These are design-level guarantees, not configuration options.

---

## Git invariants

| # | Invariant | Enforcement |
|---|---|---|
| 1 | Branch must not be `main` for any mutation | `validateRealRepoApplySafety` rejects `currentBranch === 'main'` |
| 2 | No automatic merge | Merge is never performed by any command |
| 3 | No automatic `main` touch | `main` is never checked out, switched to, or committed to |
| 4 | No force push | `git push origin <branch>` only; no `--force` |
| 5 | No `git reset --hard` | Rollback is file-level via patch manifest |
| 6 | No `git add -A` | Only explicitly allowed files are staged via `git add -- <file>` |
| 7 | Working tree must be clean before mutation | `ensureClean` stops if uncommitted changes exist |
| 8 | Current branch must match `work_branch` | `validateRealRepoApplySafety` rejects branch mismatch |

---

## File mutation invariants

| # | Invariant | Enforcement |
|---|---|---|
| 9 | `allowed_files` / `denied_files` enforced | `validateFileList` rejects paths outside allow list or inside deny list |
| 10 | `max_lines_changed` enforced | `validateProposedFileLineDeltas` rejects diffs exceeding the limit |
| 11 | Path traversal blocked | `..`, absolute paths, and backslash paths are rejected |
| 12 | Unrelated changes blocked | `assertNoUnrelatedChanges` stops if working tree contains unapproved files |

---

## Review invariants

| # | Invariant | Enforcement |
|---|---|---|
| 13 | Deterministic checks run before reviewer | `runDeterministicReviewChecks` executes before `runReviewerGate` |
| 14 | Reviewer evidence must be from exact commit | `buildCommitEvidence` uses the commit SHA returned by `git rev-parse HEAD` |
| 15 | Secrets redacted in reviewer/fix context | `redactReviewerText` strips `sk-`, `Bearer`, API key names |
| 16 | Check logs truncated/redacted | `buildCheckFailureMessage` truncates to 4000 chars and redacts |

---

## CI invariants

| # | Invariant | Enforcement |
|---|---|---|
| 20 | CI does not use secrets | `.github/workflows/ci.yml` references no API keys or tokens |
| 21 | CI does not mutate repo state | Workflow runs read-only checks (typecheck, build, test) only |
| 22 | CI does not auto-merge | No merge or deployment steps in workflow |

## PR readiness invariants

| # | Invariant | Enforcement |
|---|---|---|
| 23 | Readiness gate default is dry-run | `BLOCK_PR_READINESS_DRY_RUN` defaults to `true`; only `'false'` disables |
| 24 | Mark-ready requires explicit gate | `ALLOW_GITHUB_MARK_READY=true` required for draft→ready PATCH |
| 25 | Readiness gate never merges | No merge or auto-merge steps in readiness logic |
| 26 | Readiness gate checks CI before ready | `checks_status` must be `success` unless explicitly disabled |

## Loop invariants

| # | Invariant | Enforcement |
|---|---|---|
| 17 | Fix attempts bounded by `max_fix_attempts` | `block-one-task-loop.ts` stops with `blocked` if exceeded |
| 18 | Global attempts bounded by `BLOCK_RUN_MAX_TOTAL_ATTEMPTS` | `block-multi-task-loop.ts` stops safely, state resumable |
| 19 | Fix context never contains raw secrets | `redactReviewerText` applied to all failure messages |

---

## Push / PR invariants

| # | Invariant | Enforcement |
|---|---|---|
| 20 | Push requires explicit flag | `ALLOW_REAL_REPO_PUSH=true` required |
| 21 | PR creation is separate opt-in helper | `block-pr-create` is a standalone command, not part of `block-run`; `block-pr-submit` orchestrates helpers but does not bypass gates |
| 22 | GitHub API not used by `block-run` | `block-run` never calls GitHub |
| 23 | PR helper is draft-only by default | `block-pr-create` creates draft PRs unless explicitly changed |
| 24 | No token persistence | API keys live in env only; never written to state, logs, or commit messages |

---

## Verification

These invariants are covered by the test suite (1757 tests / 104 suites / 0 failures) and by live proofs documented in:

- [`STAGE6_16_REAL_MULTITASK_BLOCK_PROOF.md`](STAGE6_16_REAL_MULTITASK_BLOCK_PROOF.md)
- [`STAGE6_15_2_FULL_FIX_LOOP_MATRIX_PROOF.md`](STAGE6_15_2_FULL_FIX_LOOP_MATRIX_PROOF.md)
