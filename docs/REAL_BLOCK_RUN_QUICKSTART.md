# Real Block Run Quickstart

This guide explains how to run an autonomous multi-task block with the AI Orchestrator.

For a high-level summary of what is complete in Stage 10 and what remains, see [`docs/STAGE_10_V0_RELEASE.md`](STAGE_10_V0_RELEASE.md).

## What the orchestrator currently does

A **block** is a JSON file that describes a sequence of coding tasks against a target git repository. The orchestrator runs each task in order:

1. Calls the configured AI coder (Kimi).
2. Applies the returned file changes safely.
3. Runs checks.
4. Commits the result on the configured `work_branch`.
5. Calls the configured AI reviewer.
6. If the reviewer rejects, runs **one fix attempt** with a second review.
7. Stops safely if a task is blocked, rejected after fix, or fails checks.

The block runner never merges, never force-pushes, never touches `main`, and never runs a mutation before the built-in readiness check passes.

## Required environment variables

To run a real block you must opt in explicitly:

```bash
export ALLOW_REAL_BLOCK_RUN_AI=true
# or
export REAL_BLOCK_RUN_AI=1

export ALLOW_REAL_PROVIDER=true
export ALLOW_REAL_REPO_APPLY=true
export ALLOW_REAL_REPO_COMMIT=true
export ALLOW_REAL_REPO_PUSH=true

export KIMI_API_KEY="sk-your-key"
export KIMI_BASE_URL="https://api.moonshot.cn/v1"
```

> **Safety note:** do not commit real keys. Use a local `.env` file or your shell environment. The example block uses placeholder values only.

## Preparing a block file

Create a JSON file like `examples/block-smoke.json`:

```json
{
  "block_id": "block_smoke",
  "title": "Block smoke example",
  "repo_path": "/absolute/path/to/target/repo",
  "base_branch": "main",
  "work_branch": "ai-block-smoke",
  "providers": {
    "coder": { "provider": "kimi", "model": "kimi-k2.6" },
    "reviewer": { "provider": "kimi", "model": "kimi-k2.6" }
  },
  "review_policy": {
    "require_deterministic_checks": true,
    "max_fix_attempts": 1,
    "reviewer_mode": "single"
  },
  "tasks": [
    {
      "task_id": "task_1",
      "title": "Update README",
      "goal": "Make a small README update.",
      "allowed_files": ["README.md"],
      "denied_files": [],
      "max_lines_changed": 100,
      "checks": []
    }
  ]
}
```

Requirements enforced by the loader:

- `block_id` and `task_id` must match `^[A-Za-z0-9_-]+$`.
- `work_branch` must not be `main` and must not equal `base_branch`.
- `allowed_files` must be a non-empty array.
- `denied_files` must be an array.
- `max_fix_attempts` must be an integer from 1 to 5.
- Provider API keys are **never** stored in the block file.

## Readiness command

Before running the block, check that everything is ready:

```bash
npx tsx src/cli.ts real-block-run-ai-readiness examples/block-smoke.json
```

This prints a JSON report and exits `0` only when:

- the block file is valid,
- all opt-in flags are set,
- `KIMI_API_KEY` and `KIMI_BASE_URL` are present,
- the target repo exists and is a git repository,
- the branches are valid,
- existing state is compatible (fresh or resume).

The report is redacted: secrets are removed before printing.

## Run the block

```bash
npx tsx src/cli.ts real-block-run-ai examples/block-smoke.json
```

The runner will:

- run the readiness check internally,
- stop with exit code `1` and print the redacted report if readiness fails,
- otherwise execute tasks sequentially and persist state under `runs/block/block_smoke/state.json`.

## Resume a block run

If a previous run stopped after a task failure, resume with:

```bash
npx tsx src/cli.ts real-block-run-ai examples/block-smoke.json --resume
# or
REAL_BLOCK_RUN_RESUME=1 npx tsx src/cli.ts real-block-run-ai examples/block-smoke.json
```

Resume skips already-completed tasks and continues with the next pending task. If the block is already completed, resume exits `0` and prints a summary without re-running anything.

## State path

Block state is stored at:

```text
runs/block/<block_id>/state.json
```

For the example block:

```text
runs/block/block_smoke/state.json
```

Inspect this file to see current task, statuses, commit SHAs, reviewer decisions, and safety notes.

## Read-only block run report

To render a human-readable report from an existing state file without mutating anything:

```bash
npx tsx src/cli.ts real-block-run-ai-report runs/block/block_smoke/state.json
```

This command is read-only and safe: it does not call providers, does not touch the repository, does not write state, does not create commits, and does not push or merge. It prints a summary of the block, each task result, and redacts any secret-like values before printing.

## Task statuses

Common statuses you will see in the block state:

- `pending` — task has not started.
- `in_progress` — task is being executed.
- `coder_done` — coder produced output.
- `checks_failed` — local checks failed; a fix attempt may follow.
- `committed` / `pushed` — git operations completed.
- `waiting_review` — waiting for reviewer result.
- `accepted` — reviewer accepted; block advances.
- `rejected` — reviewer rejected; triggers one fix attempt.
- `fix_required` — fix was attempted but reviewer still wants changes.
- `blocked` — a safety or guardrail violation stopped the task.

## Safety guarantees

- **No merge.** The tool never runs `git merge`.
- **No force push.** Push uses normal `git push` only when explicitly allowed.
- **No `main` mutation.** `work_branch` cannot be `main`.
- **Readiness before mutation.** The runner calls the same readiness check used by `real-block-run-ai-readiness` before writing state, spawning children, calling providers, applying patches, or committing.
- **Id validation.** Block and task ids are strictly validated against `^[A-Za-z0-9_-]+$`.
- **No shell interpolation.** Child runners are spawned with argument arrays, not shell strings.
- **Guardrails.** Only `allowed_files` can be modified; `denied_files` are rejected.
- **Secret redaction.** Output and persisted state remove `KIMI_API_KEY`, `OPENAI_API_KEY`, GitHub tokens, and generic `*_TOKEN=` patterns.

## Fake / local smoke without real external AI

The test suite runs a full fake-provider smoke without network access. It uses environment variables such as:

```bash
REAL_BLOCK_TASK_KIMI_FAKE_RESPONSES='["{...}"]'
REAL_BLOCK_TASK_REVIEWER_FAKE_RESPONSES='["{...}"]'
REAL_BLOCK_TASK_FIX_KIMI_FAKE_RESPONSES='["{...}"]'
REAL_BLOCK_TASK_SECOND_REVIEWER_FAKE_RESPONSES='["{...}"]'
```

These arrays must contain one JSON string per task. They are intended for deterministic local testing only and are never sent to a real API.

## Local fake demo

You can run a full block execution locally without any real AI credentials or network access:

```bash
npm run demo:block:fake
```

This command:

- creates a temporary git repository,
- generates a temporary block file pointing to that repo,
- runs `real-block-run-ai-readiness`,
- runs `real-block-run-ai` with deterministic fake coder/reviewer responses,
- executes two tasks: one accepted directly and one rejected then fixed and accepted,
- runs `real-block-run-ai-report` on the generated state file to prove the read-only report path,
- prints the temp repo path, block file path, final state path, task results, and block report,
- cleans up temporary artifacts (set `KEEP_DEMO_ARTIFACTS=1` to keep them).

The demo uses placeholder values for `KIMI_API_KEY` and `KIMI_BASE_URL`, forces fake responses via `REAL_BLOCK_TASK_*_FAKE_RESPONSES`, and does not push to any external remote.

The full local path demonstrated is: readiness → run → report.

## Real run checklist (safe operator preflight)

Before a real run, use the checklist command to verify both block readiness and provider-smoke env in one safe step:

```bash
export ALLOW_REAL_BLOCK_RUN_AI=true
export ALLOW_REAL_PROVIDER=true
export ALLOW_REAL_REPO_APPLY=true
export ALLOW_REAL_REPO_COMMIT=true
export ALLOW_REAL_REPO_PUSH=true
export KIMI_API_KEY="sk-your-key"
export KIMI_BASE_URL="https://api.moonshot.cn/v1"

npx tsx src/cli.ts real-block-run-ai-checklist examples/block-smoke.json
```

The checklist command:

- runs `real-block-run-ai-readiness` internally
- inspects provider-smoke env (`ALLOW_REAL_PROVIDER`, `KIMI_API_KEY`, `KIMI_BASE_URL`)
- prints a redacted JSON report with `ok`, `blockReadiness`, `providerSmoke`, `nextCommands`, `warnings`, and `reasons`
- does **not** call the provider, mutate the repository, write state, or spawn the block runner

Recommended real-run sequence:

```bash
npx tsx src/cli.ts real-block-run-ai-checklist <blockPath>
npx tsx src/cli.ts real-provider-smoke --provider kimi
npx tsx src/cli.ts real-block-run-ai-readiness <blockPath>
npx tsx src/cli.ts real-block-run-ai <blockPath>
npx tsx src/cli.ts real-block-run-ai-report runs/block/<block_id>/state.json
```

## Real provider smoke check (optional, no repo mutation)

Before running a real block against a real repository, you can verify that the provider configuration works without mutating anything:

```bash
export ALLOW_REAL_PROVIDER=true
export KIMI_API_KEY="sk-your-key"
export KIMI_BASE_URL="https://api.moonshot.cn/v1"
npx tsx src/cli.ts real-provider-smoke
```

This command:

- checks `ALLOW_REAL_PROVIDER`, `KIMI_API_KEY`, and `KIMI_BASE_URL`
- sends a tiny harmless prompt to the configured provider
- expects a small JSON acknowledgment such as `{"ok":true,"message":"provider smoke ok"}`
- prints a redacted JSON report
- exits non-zero if the provider call fails or if credentials are missing

It does **not** read or write block state, apply patches, create commits, push, merge, or touch the repository. Do not use it in CI with real secrets yet.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `ALLOW_REAL_BLOCK_RUN_AI=true is required` | Missing opt-in flag | Export the flag and retry. |
| `KIMI_API_KEY env var is required` | Missing key | Export a valid key or use a `.env` file. |
| `work_branch must not be "main"` | Block uses `main` as work branch | Change `work_branch` to a feature branch. |
| `Block definition block_id contains unsupported characters` | Unsafe id | Use only letters, digits, underscores, and hyphens. |
| `Existing block run is incomplete. Enable resume mode` | Previous run stopped | Add `--resume` or set `REAL_BLOCK_RUN_RESUME=1`. |
| Readiness fails on repo path | `repo_path` does not exist or is not a git repo | Create the target repo first or fix the path. |

## Product verification

To verify the whole product locally with one command:

```bash
npm run verify:product
```

This command runs:

1. `npm run typecheck`
2. `npm run build`
3. `npm test`
4. `npm run demo:block:fake`

It proves the typecheck, build, test suite, and local fake block demo all pass. No real AI credentials or network access are required.

The same product verification command is run by GitHub Actions on every push and pull request to `main` (see `.github/workflows/product-verify.yml`).

## Next steps

1. Copy `examples/block-smoke.json`.
2. Update `repo_path` to point to a real git repository.
3. Ensure the `work_branch` exists or can be created from `base_branch`.
4. Run readiness.
5. Run the block.
