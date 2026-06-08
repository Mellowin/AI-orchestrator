# Block State Runner

> **Purpose:** Track the execution state of autonomous task blocks without calling providers, mutating git, or touching the filesystem outside `runs/blocks`.

---

## What this stage does

Stage 6.2 implements the **memory layer** for autonomous blocks. It provides:

- Block definition loading (JSON)
- Block state initialization and persistence
- Safe state transitions for tasks
- Status reporting
- CLI commands to inspect and manipulate state

Stage 6.3 implements the one-task autonomous loop on top of this state layer.

Stage 6.5 implements **real Kimi coder + fake reviewer one-task mode**:
- Real Kimi API call for coder
- Fake reviewer (deterministic gate)
- Real file apply, check, commit on work branch
- Push optional (`ALLOW_REAL_REPO_PUSH`)
- Strict allow flags before any mutation
- Branch safety and dirty repo protection

Stage 6.6 implements **real Kimi coder + real Kimi reviewer one-task mode**:
- Real Kimi API calls for both coder and reviewer
- Deterministic checks gate before reviewer call
- Reviewer called only after deterministic checks pass
- Same git mutation and block state transitions
- Requires `ALLOW_KIMI_REVIEWER=true`

Stage 6.8 implements **safe real multi-task Kimi→Kimi block loop**:
- Orchestrates multiple one-task loops automatically
- `maxTasksPerRun` bounded to `<= 3` for real modes
- Rejects `ALLOW_REAL_REPO_PUSH=true`
- Requires explicit allow flags for every real operation
- Stops safely on `fix_required`, `blocked`, or completed block
- Preserves fake mode compatibility

Stage 6.9 implements **PR-ready Human Approval Package**:
- `block-approval-report <blockJsonPath>` CLI command generates markdown approval report
- Reads block definition + state, computes `pr_ready` boolean
- Gathers changed files from git read-only (`git diff --name-only`, `--stat`)
- Report includes task table, commit evidence, file scope, safety checklist, human decision, manual next commands
- Secret redaction applied before write (`sk-`, `Bearer`, `KIMI_API_KEY`, `GITHUB_TOKEN`)
- No provider calls, no GitHub API, no git mutation, no PR creation, no push/merge/checkout/main touch
- Output path restricted to `runs/blocks/`, cwd, or system tmpdir

Stage 6.10 implements **Manual PR Draft Package / PR Body Generator**:
- `block-pr-draft <blockJsonPath>` CLI command generates PR draft files (`pr-title.txt`, `pr-body.md`, `manual-pr-checklist.md`)
- Reuses block analysis logic (`analyzeBlockForPrReadiness`) — no duplication
- PR body includes summary, what changed, task results table, commit evidence, test evidence, safety checklist, risks/reviewer notes, manual next steps
- PR title limited to 100 characters, newlines removed, secrets redacted
- Manual checklist includes branch confirmation, file review, secret check, CI status, manual PR opening, no-merge/auto-merge warnings
- Generates drafts for both `pr_ready=true` and `pr_ready=false` blocks, with clear header distinction
- Secret redaction applied to all generated files; safety finding added if redaction occurred
- Output directory restricted to `runs/blocks/`, cwd, or system tmpdir via `isPathInside`
- No provider calls, no GitHub API, no PR creation/update, no push/merge/checkout/main touch

---

## What this stage does NOT do

- **No provider call.** Block state commands never call Kimi, OpenAI, or any AI provider.
- **No coding.** The runner does not write or apply files.
- **No review.** The runner does not run deterministic checks or call the reviewer gate.
- **No git mutation.** The runner does not commit, push, checkout, merge, or touch branches.
- **No GitHub API.** The runner does not create PRs or query GitHub.
- **No merge.** Block completion is a local state change only.

---

## Block Definition

A block definition describes a group of small tasks that together achieve a larger goal.

```json
{
  "block_id": "example-auth-block",
  "title": "Authentication module block",
  "repo_path": ".",
  "base_branch": "feature/mvp-skeleton",
  "work_branch": "feature/auth-implementation",
  "providers": {
    "coder": { "provider": "kimi", "model": "kimi-k2.6" },
    "reviewer": { "provider": "kimi", "model": "kimi-k2.6" }
  },
  "review_policy": {
    "require_deterministic_checks": true,
    "max_fix_attempts": 3,
    "reviewer_mode": "single"
  },
  "tasks": [
    {
      "task_id": "auth-login",
      "title": "Implement login endpoint",
      "goal": "Create a POST /login endpoint...",
      "allowed_files": ["src/auth/login.ts"],
      "denied_files": [".env", ".env.*"],
      "max_lines_changed": 150,
      "checks": ["npm run typecheck", "npm run build", "npm test"]
    }
  ]
}
```

Validation rules:
- `block_id`, `title`, `repo_path`, `base_branch`, `work_branch` are required strings.
- `work_branch` must not be `main`.
- `providers.coder` and `providers.reviewer` are required.
- `review_policy.max_fix_attempts` must be an integer between 1 and 5.
- `tasks` must be a non-empty array.
- Each `task_id` must be unique.
- Each task must have `title`, `goal`, non-empty `allowed_files`, positive `max_lines_changed`.

---

## Block State File

State is stored at:

```
runs/blocks/<block_id>/block-state.json
```

The state file is written atomically (temp file + rename) and never contains:
- API keys
- Provider raw output
- Git credentials
- File contents

### State structure

```ts
interface BlockState {
  block_id: string;
  title: string;
  status: BlockStatus;
  repo_path: string;
  base_branch: string;
  work_branch: string;
  current_task_id: string | null;
  created_at: string;
  updated_at: string;
  tasks: BlockTaskState[];
  safety_note: string;
}
```

---

## Task Statuses

| Status | Meaning |
|---|---|
| `pending` | Task has not started yet |
| `in_progress` | Coder is working on this task |
| `coder_done` | Coder produced output |
| `checks_failed` | Deterministic checks failed |
| `committed` | Changes committed locally |
| `pushed` | Changes pushed to remote |
| `waiting_review` | Waiting for reviewer decision |
| `accepted` | Reviewer accepted, task complete |
| `rejected` | Reviewer rejected |
| `fix_required` | Reviewer requested fix |
| `blocked` | Blocked by safety issue or max attempts |

---

## Block Statuses

| Status | Meaning |
|---|---|
| `pending` | Block initialized, not yet running |
| `running` | A task is in progress |
| `waiting_review` | A task is waiting for reviewer |
| `fixing` | A task is being fixed after rejection |
| `completed` | All tasks accepted |
| `blocked` | A task is blocked, human intervention required |

---

## Transitions

Transitions are pure functions that return a new state. They do not write files.

Rules:
- An `accepted` task cannot transition backwards.
- `markTaskAccepted` advances `current_task_id` to the next pending task.
- If all tasks are `accepted`, the block status becomes `completed`.
- `markTaskFixRequired` increments `fix_attempts` and uses `state.review_policy.max_fix_attempts`.
  - If `fix_attempts >= review_policy.max_fix_attempts`, the task becomes `blocked`, the block status becomes `blocked`, and `current_task_id` is cleared.
  - Otherwise, the task becomes `fix_required` and the block status becomes `fixing`.
- `markTaskBlocked` sets block status to `blocked` and clears `current_task_id`.
- `markTaskCommitted` requires a full 40-character hex SHA.
- `markTaskInProgress` from `rejected`/`fix_required`/`checks_failed` clears stale `blocking_issues`, `reviewer_decision`, `reviewer_summary`, `commit_sha`, and `pushed_ref` so the next review starts clean.
- `markTaskInProgress` from `blocked` is rejected (human must unblock first).
- Old state missing `review_policy` fails safely when `markTaskFixRequired` is called.

---

## CLI Commands

### `block-init <blockJsonPath>`

Loads a block definition JSON file and initializes state under `runs/blocks/<block_id>/`.

### `block-status <blockId>`

Loads block state and prints a markdown status report to stdout.

### `block-transition <blockId> <taskId> <transition> [value]`

Applies a state transition and saves the updated state.

Supported transitions:
- `in_progress`
- `coder_done`
- `checks_failed` (value = issue text)
- `committed` (value = 40-char commit SHA)
- `pushed` (value = 40-char commit SHA)
- `waiting_review`
- `accepted` (value = review summary)
- `rejected` (value = issue text)
- `fix_required` (value = issue text)
- `blocked` (value = issue text)

### `block-run <blockJsonPath>`

Runs a safe fake multi-task loop over all pending tasks in a block.

**Behavior:**
1. Load block definition
2. Initialize block state if missing
3. Loop while block is not completed/blocked and tasks remain
4. Call `runOneTaskLoop` in safe fake mode for each task
5. Stop on `maxTasksPerRun`, `fix_required` (if `stopOnRejected`), or `blocked` (if `stopOnBlocked`)
6. Print summary

**Env vars:**
- `BLOCK_RUN_MODE` — only `fake` is supported
- `BLOCK_RUN_MAX_TASKS` — max tasks per run (default 10, max 100)
- `BLOCK_RUN_STOP_ON_REJECTED` — stop on `fix_required` (default `true`)
- `BLOCK_RUN_STOP_ON_BLOCKED` — stop on `blocked` (default `true`)

**Fake mode guarantees:**
- Same as `block-run-one` fake mode
- No real repo mutation
- No provider real calls
- No git commands
- No GitHub API

**Real mode:** Not supported. Will fail safely.

---

### `block-run-one <blockJsonPath>`

Runs one task through the full autonomous loop:
1. Load block definition and state
2. Mark current task `in_progress`
3. Call coder provider
4. Validate output with guardrails (path-only, no filesystem mutation)
5. **Fake mode:** Simulate checks, commit, and evidence. No real repo mutation.
6. **Real mode:** Fails safely with clear error before any mutation (not implemented safely yet).
7. Run deterministic review checks
8. Call reviewer gate
9. Update block state based on decision (`accepted`, `fix_required`, or `blocked`)

Modes (set via `BLOCK_RUN_ONE_MODE` env):
- `fake` (default): fake coder + fake reviewer, no real API calls, no real repo mutation
- `real_kimi_coder_fake_reviewer`: gated behind `ALLOW_BLOCK_RUN_ONE=true`, `ALLOW_REAL_PROVIDER=true`, `ALLOW_REAL_REPO_APPLY=true`, `ALLOW_REAL_REPO_COMMIT=true`
- `real_kimi_coder_kimi_reviewer`: additionally requires `ALLOW_KIMI_REVIEWER=true`

**Fake mode guarantees:**
- No `applyFileUpdates`, `rollbackFileUpdates`, `runChecks` on real repo
- No `git add`, `git commit`, `git push`, `git reset`, `git config`, `git checkout`
- Commit SHA is deterministic fake (`f`.repeat(40))
- Evidence is simulated from coder result, not read from git
- Only real filesystem write: block state save

**Real mode:** Fails safely before provider call or mutation. Use fake mode only.

No merge, no checkout, no main touch, no force push, no auto-merge.

---

## Safety

- State files are written only under `runs/blocks/<block_id>/`.
- Path validation rejects writes outside the allowed directory.
- No provider, git, or GitHub API calls from block state commands.
- Safe error messages without secret leakage.
- `review_policy` is stored in `BlockState` on initialization and is required for `markTaskFixRequired`.
- `max_fix_attempts` is enforced in `markTaskFixRequired`; exceeding it blocks the task automatically.
- Restarting a task from `rejected`/`fix_required`/`checks_failed` clears stale reviewer data and blocking issues to prevent false rejections on the next attempt.
- `blocked` tasks cannot be restarted via `in_progress` without human intervention.
- No endless retry loops: `max_fix_attempts` is bounded (1–5) and enforced.
