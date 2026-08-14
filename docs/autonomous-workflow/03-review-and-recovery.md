# Autonomous Workflow 03 — Review, Fix Loop, and Crash Recovery

This document describes how review verdicts are produced, how the fix loop
executes, how dependency evidence flows between tasks, and how a crashed or
paused run is reconciled on resume. It builds on `01-one-click.md` (launch) and
`02-task-lifecycle.md` (single-task lifecycle) and is grounded in the actual
code: `src/autopilot-one-click/multitask/final-review.ts`,
`src/autopilot-one-click/multitask/reviewer-provider.ts`,
`src/reviewer-fix-task-runner.ts`, `src/reviewer-fix-task-real-executor.ts`,
`src/reviewer-evidence.ts`, `src/autopilot-one-click/multitask/state-manager.ts`,
`src/state-manager.ts`, and the resume behavior exercised by
`test/cli-real-block-run-ai-resume.test.ts`.

## Reviewer providers

Two reviewer layers exist, matching the per-task gate from document 02 and the
mission-level review:

1. **Per-task reviewer gate** — deterministic evidence first, LLM only when
   clean (see `02-task-lifecycle.md`, Step 5).
2. **Mission final review** — `runMissionFinalReview` in
   `multitask/final-review.ts` reviews the *integrated* diff across all tasks.

The mission reviewer provider is built by `reviewer-provider.ts`:

- `buildOpenAIReviewCallFn` posts to `https://api.openai.com/v1/chat/completions`
  with a strict JSON schema (`FinalMissionReview`): `verdict` ∈
  `approved | approved_with_caveats | needs_changes | rejected`, plus `summary`,
  `caveats`, `unauthorized_files`, `acceptance_gaps`. Temperature is 0.
- Model defaults to `config.openaiReviewModel` (`OPENAI_REVIEW_MODEL`, falling
  back to `gpt-4o`); the API key comes from `OPENAI_API_KEY`. Both are required
  for a real review; a missing key throws.
- `buildProductionFinalReviewCallFn` wraps construction and **redacts secrets**
  from the error (`sk-…` tokens, `Bearer …` headers) before surfacing "Final
  reviewer is not available". When the final reviewer is unavailable, the
  mission verdict is `MULTITASK_MISSION_NEEDS_HUMAN` (document 02).
- `fakeResponse` short-circuits the network call entirely — this is how
  safe-mode and tests get a reviewer without a token.
- The reviewer never merges, pushes, or mutates the repo; it only returns a
  verdict string.

## The deterministic mandatory gate

Model approval is **not** a security boundary. `runMissionFinalReview` always
computes mandatory facts itself (`computeMandatoryGaps`) and can override the
model:

- **Diff collection fails closed.** `collectDiff` runs
  `git diff <base>...<work>`, falls back to `origin/<base>...<work>` for CI
  checkouts, and *throws* if neither works — an unreadable diff means the
  reviewer cannot authorize what it cannot see (and the mission rolls back, see
  below).
- **Unauthorized files.** `collectUnauthorizedFiles` parses `diff --git`
  headers (including Git's quoted paths for special characters, decoded by
  `unquoteGitPath`), classifies each file entry as create / delete / rename /
  modify, and checks the semantically correct side(s) against the **union of
  every task's `allowed_files`** via `matchesPattern`. Absolute paths and any
  path containing `..` are automatically unauthorized.
- **Acceptance gaps.** `collectAcceptanceGaps` flags every planned task whose
  persisted status is not `accepted` or `fixed_and_accepted`, quoting the
  task's expected result.

Outcomes:

- No reviewer function configured → `buildDeterministicReview` alone decides:
  gaps or unauthorized files ⇒ `rejected`; `AUTOPILOT_GREEN` ⇒ `approved`;
  `AUTOPILOT_MVP_DONE_CI_NOT_OBSERVED` ⇒ `approved_with_caveats` ("CI
  observation was disabled."); anything else ⇒ `needs_changes`.
- Reviewer configured → the model's answer is parsed (`extractJsonBlock` +
  `parseReviewJson`, strict verdict validation), but if it says `approved` or
  `approved_with_caveats` while mandatory checks found gaps or unauthorized
  files, `buildGateRejectedReview` **downgrades the verdict to `rejected`** and
  merges the deterministic findings into the caveats. The deterministic
  `unauthorized_files` / `acceptance_gaps` are always written into the final
  review regardless of what the model claimed — this rejects false greens.

## The fix loop

Document 02 described how a `send_fix_to_coder` decision creates a fix task.
Execution goes through `runReviewerFixTaskWithExecutor`
(`reviewer-fix-task-runner.ts`), a pure state-machine wrapper around a
pluggable executor:

| Run plan state / executor result | Runner status | Next action |
|---|---|---|
| `not_present` | `not_ready` | `wait` (no executor call) |
| `invalid` plan state | `blocked` | `block` (blocking issues propagated) |
| executor returns `completed` | `executed` | `review_fix_result` |
| executor returns `blocked` | `blocked` | `block` |
| executor throws | `executor_failed` | `block`, message redacted via `redactSecrets` |

All inputs and outputs are cloned defensively (execution request, fix task
draft, executor result including its `checkSummary`), so the executor cannot
mutate orchestrator state. Attempt budgets are enforced by the orchestrator
layer, not here: `docs/STAGE6_14_FIX_LOOP.md` documents that check failures and
reviewer fix requests share one `fix_attempts` counter bounded by
`max_fix_attempts` (1–5), and that fix context is redacted (`sk-`, `Bearer`,
`*_API_KEY=`, GitHub PATs, `.env` patterns) before being shown to the coder.

### The real fix executor

`createReviewerFixTaskRealExecutor` (`reviewer-fix-task-real-executor.ts`)
performs an actual fix attempt. Every step can short-circuit to a `blocked`
result with a redacted reason:

1. **Env gates** — requires `ALLOW_REAL_PROVIDER`, `ALLOW_REAL_REPO_APPLY`,
   `ALLOW_REAL_REPO_COMMIT` (all explicitly true), plus `KIMI_API_KEY` and
   `KIMI_BASE_URL`. Push additionally requires `ALLOW_REAL_REPO_PUSH`.
2. **Repo safety** — working tree must be clean (`ensureClean`);
   `validateRealRepoApplySafety` runs against the parent task's guardrails.
3. **Provider call** — builds a fix-task prompt containing the blocking issues,
   allowed/denied files, previous changed files, and check commands; parses the
   response with `parseKimiOutputJson`. Fake responses
   (`REAL_REPO_REVIEWER_FIX_TASK_KIMI_FAKE_RESPONSE[S]`) substitute for the
   network in tests.
4. **Guardrails on proposed files** — `validateFileList` against
   allow/deny lists, `validateProposedFileLineDeltas` against
   `max_lines_changed`, and `validateAiSafetyPolicy`.
5. **Sandbox preflight** — `runRealRepoSandboxPreflight` in a temp directory
   (always removed afterwards, even on failure).
6. **Checkpoint → apply → checks → rollback on any failure** —
   `captureCheckpoint` snapshots the repo; `applyFileUpdates` applies via an
   apply plan; `runChecks` runs the task's checks. Any failure after the
   checkpoint (apply error, failing checks, unrelated changes, no matching
   changes, `git add` / `git commit` / `git push` failure) calls
   `rollbackToCheckpoint` and returns a `blocked` result whose reason embeds
   the rollback status (`rollback_status=… checkpointHead=… finalHead=…`).
7. **Commit** — message `ai-orchestrator: apply <taskId>`, `--no-gpg-sign`;
   the new SHA and its changed files (`git diff-tree --root`) are returned for
   evidence. The executor never merges, force-pushes, or touches `main`.

A completed fix contributes `fix_commit_sha` to the task state; the task ends
as `fixed_and_accepted` once the reviewer gate passes (document 02, Step 6).

## Dependency evidence handling

Evidence is built fresh from git, never trusted from prose:

- `buildReviewerEvidence` (`reviewer-evidence.ts`) verifies the commit exists
  (`git cat-file -t` returns `commit`), collects changed files
  (`git diff-tree --root`) and a diff stat (`git show --stat`), and computes
  safety flags: full 40-char SHA, branch is not `main`, at least one changed
  file. `checkSummary`, `stateStatus`, and `previousFailure` are carried
  through so the reviewer sees the same facts the orchestrator saw.
- The fix executor feeds **previous changed files** into the fix prompt by
  reading the current HEAD commit's file list — i.e., the fix coder sees what
  the immediately preceding accepted/attempted commit actually touched.
- At the mission level, dependent tasks receive evidence from **accepted
  ancestor tasks** (per the plan DAG from document 02, Step 2); evidence from
  failed, blocked, or skipped ancestors is never injected, because those tasks'
  commits are reverted (`revertCommits`) and their descendants are marked
  `skipped` by `markDescendantsSkipped`.

## Accepted-only history

Acceptance is sticky and exclusive:

- `mergeTaskStates` keeps any task already `accepted`/`fixed_and_accepted`
  across resumes, only filling in missing commit metadata.
- `scheduleTasks` dispositions previously accepted tasks as
  `skip_already_finished` — they are never re-run and their provider calls are
  never repeated.
- Only accepted tasks contribute surviving commits. Commits of `blocked`,
  `failed`, and `needs_human` tasks are reverted newest-first, and both the
  reverted SHAs and the revert commits are recorded in `rolled_back_commits`
  so rollback never double-reverts. Mission-owned commits are exactly those
  between `base_sha` and HEAD (`mission_commits`); if the final review rejects,
  `performMissionRollback` reverts everything not already rolled back. Rollback
  is local-only; pushing the cleaned branch is a human decision.
- A DONE verdict requires `allRequiredTasksAccepted` — every planned task, no
  partial credit.

## Crash / resume reconciliation

State is durable and validated before it is trusted:

- **Atomic writes.** `saveMissionState` writes `multitask-mission-state.json`
  via temp file + rename; the per-task `saveState` in `src/state-manager.ts`
  uses `writeJsonAtomic`. A crash mid-write cannot leave a torn state file.
- **Schema + identity validation.** `loadMissionState` returns `null` for
  malformed JSON or missing required fields (`run_id`, `stage`, `plan_hash`,
  `base_sha`, `work_branch`, `tasks[]`). The per-task `loadState` goes further:
  it rejects unknown statuses, non-integer `current_attempt`, and a `task_id`
  that does not match the directory — a state file can never be replayed
  against the wrong task.
- **Plan and base anchoring.** On `--resume`, persisted state is honored only
  if `plan_hash` (SHA-256 over the canonicalized plan, 16 hex chars) and
  `base_sha` still match. A changed plan aborts with "Resume aborted: mission
  plan changed"; a moved base with "Resume aborted: base branch moved"
  (document 02, Step 1).
- **Commit re-verification.** Every recorded `commit_sha` / `fix_commit_sha`
  must be an ancestor of `mission-<run_id>` (`git merge-base --is-ancestor`);
  stale state aborts the resume instead of being trusted.
- **Idempotent resume of finished runs.** The resume tests
  (`test/cli-real-block-run-ai-resume.test.ts`) pin the contract: resuming a
  `completed_with_caveats` block is a **no-op** — exit 0, no new commits, no
  provider calls (empty fake-response queues would fail any provider attempt).
  Resuming a `paused` block completes the remaining tasks and preserves prior
  task results (accepted stays accepted). A blocked task with the default
  `on_blocked_task: stop` policy halts the run; with `continue` the run
  proceeds, ends `completed_with_caveats`, records the blocked task as
  `blocked_skipped`, and still exits non-zero on the first pass.
- **No false reporting after a crash.** A task blocked before apply reports
  `codeApplied: false` and `pushed: false` — nothing is claimed committed or
  pushed that was not.

The net guarantee: history contains only accepted work, evidence is always
re-derived from git, and resuming after a crash either continues exactly where
the persisted state left off or refuses to proceed at all.
