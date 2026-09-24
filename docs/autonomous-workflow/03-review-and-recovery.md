# 03 — Review/Fix Loop, Dependency Evidence, Accepted-Only History, and Crash/Resume Reconciliation

This document describes how reviewer verdicts drive fix tasks and re-review,
how accepted dependency evidence reaches downstream tasks, why only accepted
results feed subsequent context, and how persisted state is reconciled with
the repository on resume after an interruption. It builds on
[01-one-click.md](./01-one-click.md) (launch, presets, resume command) and
[02-task-lifecycle.md](./02-task-lifecycle.md) (per-task states, scheduling,
sticky acceptance, task-level rollback) and reflects only what the code
implements.

## 1. The reviewer/fix loop

### 1.1 The reviewer gate

`runReviewerGate` in `src/reviewer/reviewer-gate.ts` is the decision point for
each task attempt. It runs in a strict order:

1. **Deterministic checks gate the model.** If the deterministic result is not
   OK, the reviewer provider is **never called** (`reviewerCalled: false`).
   The gate synthesizes a high-confidence `rejected` decision whose
   `blocking_issues` and `fix_task` text are the (secret-redacted)
   deterministic findings.
2. **Next-action routing.** The synthetic rejection's `next_action` is:
   - `block_for_human` when any severe safety finding is present — secret
     pattern detected, main branch violation, merge conflict markers in the
     diff, invalid commit SHA format, or denied file touched
     (`SEVERE_SAFETY_FINDINGS`); or
   - `send_fix_to_coder` otherwise — this is the verdict that drives the fix
     loop, because the rejection carries an explicit `fix_task` instruction
     for the coder.
3. **Summary checks.** `runSummaryChecks` validates the commit against
   `allowed_files` and `acceptance_criteria` (and receives the task's
   `dependency_evidence`). Failure is again a deterministic
   `send_fix_to_coder` rejection without a reviewer call.
4. **Reviewer call.** Only when every deterministic gate passes is
   `reviewer.reviewCommit(reviewInput)` invoked, and its raw output is
   schema-validated (`validateReviewerDecision`) before use.

Reviewer-facing evidence is assembled by `src/reviewer-evidence.ts`:
`buildReviewerEvidence` (for committed work) and
`buildCandidateReviewerEvidence` (for staged candidates against a
`task_base_sha`) collect the changed-file list, diff stat, commit existence,
check summary, acceptance criteria, allowed files, previous failure reason,
and dependency evidence, plus deterministic safety flags
(`commitShaIsFullLength`, `branchIsNotMain`, `hasChangedFiles`).

### 1.2 Fix task execution

A `send_fix_to_coder` verdict materializes as a reviewer fix task. The
control flow is `runReviewerFixTaskWithExecutor` in
`src/reviewer-fix-task-runner.ts`:

- No run plan → `not_ready` / `wait` (the executor is not called).
- Invalid run plan state → `blocked` / `block` for human review.
- Ready → the executor runs once per invocation and the outcome maps to:
  - executor `completed` → `executed` with next action `review_fix_result`
    (the fix goes back through the reviewer gate — this closes the loop);
  - executor `failed` → `failed_attempt` with next action `retry_fix`;
  - executor `blocked` or a thrown executor error → `blocked` / `block`.
- Executor inputs/outputs are cloned defensively, and executor-thrown errors
  are secret-redacted before being recorded.

The production executor (`createReviewerFixTaskRealExecutor` in
`src/reviewer-fix-task-real-executor.ts`) implements the real fix attempt:

1. **Hard gates.** It refuses to run unless `ALLOW_REAL_PROVIDER`,
   `ALLOW_REAL_REPO_APPLY`, and `ALLOW_REAL_REPO_COMMIT` are all enabled and
   `KIMI_API_KEY`/`KIMI_BASE_URL` are set; violations return `blocked`.
2. **Fix prompt.** `buildFixTaskPrompt` gives the coder the blocking issues,
   current candidate files, read-only repository context, allowed/denied
   files, dependency evidence, previously changed files, the previous
   reviewer summary, and the check commands. The prompt explicitly forbids
   modifying read-only context and dependency evidence.
3. **Provider correction loop with no-effect recovery.** Up to
   `REAL_REPO_REVIEWER_MAX_FIX_ATTEMPTS` attempts (integer 1–5, default 1).
   A structurally valid but effectless response (`EMPTY_FILE_LIST` or
   `ALL_IDENTICAL`) triggers a recovery prompt demanding at least one
   effective in-scope change; exhausting the attempts fails with
   `PROVIDER_NO_EFFECT_OUTPUT`.
4. **Deterministic validation before touching the repo.** Guardrails
   (`validateFileList`, advisory `max_lines_changed`), the AI safety policy,
   and a sandbox preflight (`runRealRepoSandboxPreflight` in a temp
   directory) must all pass.
5. **Checkpoint, apply, verify, commit.** A repo checkpoint is captured
   before applying; check failures or unrelated changes roll back to it
   (`rollbackToCheckpoint`) and the result is `blocked` with the rollback
   status embedded. On success, only the approved files are staged, exactly
   one commit is created, the new SHA is validated as 40-char hex, and the
   commit must touch at least one file. A `completed` result carries the new
   `commitSha`, `baseCommitSha`, changed files, check summary, and provider
   attempt evidence.

The fix result then re-enters the reviewer gate (§1.1). In mission terms,
the loop's terminal outcomes surface as the task statuses from document 02:
`accepted`, or `fixed_and_accepted` with both `commit_sha` and
`fix_commit_sha` recorded when acceptance required a fix commit.

### 1.3 Mission-level final review

Above the per-task loop, the mission has one integrated review
(`runMissionFinalReview`, input type `FinalReviewInput`): it receives the
mission, plan, autopilot result, the integrated base-to-work-branch diff,
the per-task states, optional dependency evidence, and any
`authorized_maintenance` evidence from a successful finalization repair. The
reviewer callback is OpenAI-first with a Kimi fallback
(`buildProductionFinalReviewCallFn`); fake mode uses the deterministic
fallback so tests need no token. The response is a strict JSON schema with
verdict `approved` / `approved_with_caveats` / `needs_changes` / `rejected`.
Anything other than an approval fails the mission and triggers rollback of
all mission commits (document 02, §7 covers the per-task analogue). The
verdict is persisted in state as `final_review` and is never re-run on
resume.

## 2. Dependency evidence

Downstream tasks consume upstream output only as a packaged, read-only
artifact: the `DependencyEvidencePackage` (`src/types.ts`, threaded through
`src/reviewer-evidence.ts`, the reviewer gate's summary checks, the fix-task
prompt, and `FinalReviewInput`).

- **Contents.** Each item records the producing `task_id`, its
  `task_status`, the artifact `path`, a `content_sha256`, byte/line counts,
  a truncation flag, and the content itself. The package tracks
  `total_bytes`, a package-level `truncated` flag, and an `omitted_count`
  for items dropped to fit size limits.
- **Provenance.** Items come from **accepted ancestor tasks** — the fix
  prompt header literally describes the section as "read-only context from
  accepted ancestor tasks", and documents 02's scheduling rules guarantee a
  task only runs after its `depends_on` ancestors succeeded.
- **Read-only enforcement.** The fix-task prompt states that dependency
  evidence "must NOT be modified", and the guardrail validation
  (`validateFileList` against allow/deny lists) plus the post-apply
  unrelated-change check mechanically reject any write to evidence files
  outside the task's allowed scope.
- **Honest degradation.** When a package exists but has no items, the prompt
  says so explicitly ("No accepted ancestor artifacts available") rather
  than fabricating context; when truncated, the truncation and omission
  counts are shown to the coder and reviewer.

## 3. Accepted-only history

Only accepted task results feed subsequent context. This is enforced at
three layers:

1. **Scheduling.** `scheduleTasks` gives `skip_already_finished` only to
   `accepted`/`fixed_and_accepted` tasks, and `skip_dependency_failed`
   cascades from any `failed`/`blocked`/`needs_human` ancestor — so no
   downstream task ever runs on top of an unaccepted dependency
   (document 02, §3).
2. **State merge.** `mergeTaskStates` makes acceptance sticky: a task
   previously `accepted` or `fixed_and_accepted` stays accepted across runs
   (only missing commit metadata is filled in), while non-accepted states
   are replaced by the latest outcome.
3. **Repository truth.** Commits from tasks that ended `blocked`, `failed`,
   or `needs_human` are reverted newest-first on the work branch and
   recorded in `rolled_back_commits` (document 02, §7). Dependency evidence
   (§2) is sourced exclusively from accepted ancestors, so rejected work
   contributes neither code nor context to anything downstream.

`allRequiredTasksAccepted` is the final gate: the mission cannot reach final
review unless every planned task is accepted, regardless of provider
verdicts.

## 4. Crash/resume reconciliation

Mission state is persisted in `multitask-mission-state.json` under
`<output_dir>/missions/<run_id>/` and written **atomically** (temp file +
`renameSync`, or `writeJsonAtomic` for per-task state), so a crash cannot
leave a half-written state file. `loadMissionState` validates the required
fields and returns `null` on any parse/shape failure, which safely falls
back to a fresh start rather than trusting corrupt state.

On `--resume`, the runner reconciles persisted state against the repository
before doing any new work:

1. **Plan identity.** The persisted `plan_hash` (canonicalized plan hashed
   by `computePlanHash`) must equal the freshly computed hash — a changed
   plan aborts with "Resume aborted: mission plan changed".
2. **Base identity.** The persisted `base_sha` must equal the re-resolved
   base branch SHA — a moved base aborts with "Resume aborted: base branch
   moved".
3. **Terminal replay vs. re-entry.** A `completed` state with a terminal
   **failure** verdict returns the persisted result without re-running.
   Paused missions (`PAUSED_PROVIDER` / `PAUSED_GIT_AUTH`) are explicitly
   **not** terminal: their stage stays `executing_tasks` and they re-enter
   execution. Successful terminal results are returned only after the
   ancestry gate passes.
4. **Ancestry gate (state ↔ git reconciliation).** For every `accepted`
   task the persisted `commit_sha`, and for every `fixed_and_accepted` task
   both `commit_sha` and `fix_commit_sha`, must (a) exist in state —
   otherwise "required accepted commits are missing from state" — and (b)
   be ancestors of the work branch via `git merge-base --is-ancestor` —
   otherwise "required accepted commits are not ancestors of <workBranch>".
   This catches force-pushes, branch resets, or state copied from another
   run. The block-level `verifyTaskResultHistory` applies the same
   ancestor check to completed block-run task states.
5. **Stage-aware skip.** If a crash happened after the inner autopilot run
   (stage past `executing_tasks` with a persisted `autopilot_result`), the
   run is not repeated; execution resumes at the persisted stage. The same
   reuse-verbatim rule applies to `validation_outcome`,
   `finalization_repair_attempts`/`_commit_sha`, `final_review`, the
   created `pr`, and `ci_outcome` — each phase runs only if its persisted
   record is absent.
6. **Idempotent rollback.** `rolled_back_commits` records both reverted
   SHAs and the revert commits themselves, so a resume after a crash
   mid-rollback never reverts the same commit twice.
7. **Authorized maintenance reuse.** `authorized_maintenance` — evidence
   that a finalization repair stayed within the validator's maintenance
   file list and revalidated green — is persisted and reused verbatim on
   resume; it is never re-derived from the diff, and it fails closed (no
   evidence, no maintenance allowance).
8. **Mission commit attribution.** `mission_commits` is rebuilt as
   `base_sha..HEAD` (deduplicated), so commits are attributed to the
   mission by ancestry from the captured base rather than by timing, and
   finalization-repair commits join the same list.

Non-resume runs fail closed the other way: if the work branch already
exists, the mission refuses to reuse it (rerun with `--resume` or a new run
id), and it refuses outright if the branch is not based on the resolved
base SHA. The one-click fail-closed rule from document 01 still applies:
`--resume` with a raw goal and no `--run-id` is rejected.

Throughout, the hard rules are unchanged on resume: no `github.merge`, no
`git.force_push`, no `github.actions.rerun`, no `repo.delete_branch` —
reconciliation uses ancestor checks and revert commits, never history
rewrites.
