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

It does **not** implement the autonomous loop itself. That is Stage 6.3.

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
- `markTaskFixRequired` increments `fix_attempts`.
- `markTaskBlocked` sets block status to `blocked` and clears `current_task_id`.
- `markTaskCommitted` requires a full 40-character hex SHA.

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

---

## Safety

- State files are written only under `runs/blocks/<block_id>/`.
- Path validation rejects writes outside the allowed directory.
- No provider, git, or GitHub API calls from block state commands.
- Safe error messages without secret leakage.
