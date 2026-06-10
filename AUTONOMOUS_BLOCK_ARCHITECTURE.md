# Autonomous Block Architecture

> **Purpose:** Define the data model, state machine, and control loop for autonomous block execution. This is the blueprint that Stage 6 implementation must follow.

---

## 1. Block Concept

A **block** is the top-level unit of autonomous work. It contains multiple tasks, provider configurations, and review policy.

```ts
interface Block {
  block_id: string;
  title: string;
  repo_path: string;
  base_branch: string;
  work_branch: string;
  tasks: BlockTask[];
  providers: {
    coder: ProviderConfig;
    reviewer: ProviderConfig;
  };
  review_policy: {
    max_fix_attempts: number;
    require_deterministic_checks: boolean;
    require_ai_review: boolean;
  };
}
```

Fields:
- `block_id` — unique identifier for the block.
- `title` — human-readable block name.
- `repo_path` — path to the target repository.
- `base_branch` — branch to merge into eventually (e.g., `feature/mvp-skeleton`).
- `work_branch` — branch where the orchestrator commits (e.g., `ai/block-42`).
- `tasks` — ordered list of tasks to execute.
- `providers` — configuration for coder and reviewer roles.
- `review_policy` — how strict the review gate is.

---

## 2. Block Task Concept

Each **task** is a single unit of work inside a block.

```ts
interface BlockTask {
  task_id: string;
  title: string;
  goal: string;
  allowed_files: string[];
  denied_files: string[];
  max_lines_changed: number;
  checks: CheckCommand[];
  status: TaskStatus;
  commit_sha?: string;
  reviewer_decision?: ReviewerDecision;
  fix_attempts: number;
}
```

Fields:
- `task_id` — unique within the block.
- `title` — short human-readable name.
- `goal` — description sent to the Coder AI.
- `allowed_files` — whitelist; task may only modify these paths.
- `denied_files` — blacklist; task may never touch these paths.
- `max_lines_changed` — guardrail for diff size.
- `checks` — deterministic commands to run after apply (e.g., `npm run typecheck`).
- `status` — current state in the task lifecycle.
- `commit_sha` — SHA of the commit created for this task.
- `reviewer_decision` — result of the AI reviewer gate.
- `fix_attempts` — how many times this task has been sent back for fixing.

---

## 3. Task Statuses

```text
pending          → task is queued, not started yet
in_progress      → coder provider is running
coder_done       → coder returned output, not yet applied
checks_failed    → deterministic checks failed, rolled back
committed        → changes committed locally
pushed           → committed changes pushed to remote
waiting_review   → deterministic checks passed, waiting for AI reviewer
accepted         → reviewer approved, task is complete
rejected         → reviewer rejected, fix required
fix_required     → fix task created, waiting for coder retry
blocked          → unrecoverable error, human intervention required
```

State transitions:
```text
pending → in_progress → coder_done → [checks_failed → in_progress (retry)]
                                    → committed → pushed → waiting_review
                                    → [rejected → fix_required → in_progress]
                                    → accepted
```

---

## 4. Block Statuses

```text
pending          → block defined, not started
running          → at least one task is in_progress
waiting_review   → a task is waiting for reviewer decision
fixing           → a task was rejected and is being fixed
completed        → all tasks accepted
blocked          → a task hit max_fix_attempts or unrecoverable error
```

---

## 5. Autonomous Loop

The exact loop the orchestrator runs:

```text
load block
for each task in order:
  compile task prompt (goal + context + prior rejection notes)
  call coder provider
  validate output (parse + guardrails + line deltas)
  apply changes
  run deterministic checks
  if checks fail:
    rollback
    if fix_attempts < max_fix_attempts:
      increment fix_attempts
      build repair prompt
      retry same task (go to "call coder provider")
    else:
      mark task blocked
      stop block
  if checks pass:
    commit
    push
    verify commit exists
    run deterministic review checks
    call reviewer provider with commit evidence
    if reviewer accepts:
      mark task accepted
      advance to next task
    if reviewer rejects:
      if fix_attempts < max_fix_attempts:
        increment fix_attempts
        build fix prompt from reviewer feedback
        retry same task (go to "call coder provider")
      else:
        mark task blocked
        stop block
stop when all tasks accepted
write block report
```

---

## 6. Reviewer Gate

The reviewer gate is **mandatory**. A block cannot advance without a reviewer decision.

Rules:
- `accepted` requires both deterministic checks **and** AI reviewer approval.
- `rejected` creates a fix task automatically.
- Repeated rejection stops after `max_fix_attempts`.
- The reviewer gate cannot be bypassed by configuration.

---

## 7. Deterministic Checks Before AI Review

These checks run **before** the AI reviewer is ever called:

| Check | Purpose |
|---|---|
| `allowed_files` | Proposed files are within the whitelist. |
| `denied_files` | Proposed files do not touch blacklisted paths. |
| `max_lines_changed` | Diff size is within guardrail limit. |
| `typecheck` | TypeScript compiles without errors. |
| `build` | Project builds successfully. |
| `test` | All tests pass. |
| `git status clean` | Working tree is clean after commit. |
| `commit exists` | The commit SHA is verifiable. |
| `branch not main` | Commit is not on `main`. |
| `no secrets` | Output does not contain API keys or tokens. |
| `no forbidden git actions` | No merge, rebase, reset, or force push occurred. |

If any check fails, the task is rolled back and retried (if attempts remain). The AI reviewer is **not** called for failed checks.

---

## 8. Reviewer Input

The reviewer provider receives a structured input containing factual evidence:

```ts
interface ReviewerInput {
  task_goal: string;
  allowed_files: string[];
  changed_files: string[];
  commit_sha: string;
  diff: string;
  test_result: string;
  build_result: string;
  typecheck_result: string;
  safety_findings: string[];
  block_context: string;
  prior_rejection_notes?: string;
}
```

The reviewer must base its decision on **evidence**, not on the coder's self-report.

---

## 9. Reviewer Output

The reviewer returns a JSON decision:

```json
{
  "decision": "accepted | rejected",
  "confidence": "low | medium | high",
  "blocking_issues": [],
  "non_blocking_issues": [],
  "review_summary": "...",
  "fix_task": null,
  "next_action": "advance_to_next_task | send_fix_to_coder | block_for_human"
}
```

Fields:
- `decision` — `accepted` or `rejected`.
- `confidence` — how certain the reviewer is.
- `blocking_issues` — reasons the task cannot be accepted.
- `non_blocking_issues` — suggestions that do not block acceptance.
- `review_summary` — human-readable review text.
- `fix_task` — if rejected, a structured fix prompt for the coder.
- `next_action` — what the orchestrator should do next.

If `next_action` is `block_for_human`, the autonomous loop stops and waits for human intervention.

---

## 10. Stop Conditions

The autonomous loop stops when any of the following occurs:

1. **All tasks accepted** — block is complete.
2. **Max fix attempts exceeded** — task is marked `blocked`.
3. **Deterministic safety violation** — unrecoverable guardrails failure.
4. **Reviewer says `block_for_human`** — human intervention required.
5. **Provider failure cannot be repaired** — network or API failure after retries.
6. **Tests cannot pass after retries** — checks fail on every attempt.

When the loop stops, a **block report** is written summarizing:
- Which tasks succeeded.
- Which tasks failed and why.
- Which commits were created.
- What the human should do next.

---

## 11. What Is Not Autonomous

The following remain manual or require explicit human action:

- **Merge** — never autonomous. Human decides.
- **Main branch** — never touched automatically.
- **Branch cleanup** — not automatic yet. Human deletes work branches.
- **Provider billing / config** — human provides API keys and monitors usage.
- **Block definition** — human writes the block of tasks.
- **Final review** — human reads the block report and decides merge.
