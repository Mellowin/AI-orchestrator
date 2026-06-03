# Stage 5 Operator Guide

## What Stage 5 Currently Supports

- **`real-repo-run`** — one-command unified workflow: parse provider response → validate guardrails → apply files → run checks → commit → push → write state. Uses `REAL_REPO_PROVIDER_RESPONSE` env var.
- **`real-repo-run-ai`** — same unified workflow but calls the real AI provider (Kimi) instead of reading a pre-canned response. Supports self-repair loop when checks fail.
- **Self-repair loop** — if checks fail after provider-generated apply, the tool rolls back, builds a repair prompt with check failure details, and re-calls the provider. Bounded by `REAL_REPO_AI_MAX_ATTEMPTS` (default 2, min 1, max 3).
- **Apply / check / commit / push / state** — full safe sequence with rollback on failure.

## What Is Still NOT Supported

- **No merge.** The tool never merges branches.
- **No PR creation.** The tool does not open pull requests.
- **No `main` touch.** The tool refuses to run if current branch or `work_branch` is `main`.
- **No automatic checkout/switch.** You must manually create and check out the work branch before running.
- **No auto-push without opt-in.** `ALLOW_REAL_REPO_PUSH=true` is required.

## Required Environment Variables

| Variable | Value | Purpose |
|----------|-------|---------|
| `ALLOW_REAL_PROVIDER` | `true` | Opt-in to call real AI provider |
| `ALLOW_REAL_REPO_APPLY` | `true` | Opt-in to apply file changes |
| `ALLOW_REAL_REPO_COMMIT` | `true` | Opt-in to create local commit |
| `ALLOW_REAL_REPO_PUSH` | `true` | Opt-in to push branch to origin |
| `REAL_REPO_AI_MAX_ATTEMPTS` | `2` (default) | Max repair attempts |
| `KIMI_API_KEY` | *your key* | Provider API key (never printed) |
| `KIMI_BASE_URL` | *your endpoint* | Provider base URL |
| `KIMI_MODEL` | `kimi-k2.6` (default) | Model name |

## Exact Safe Operator Sequence

1. **Create / check out a non-main work branch manually.**
   ```bash
   git checkout -b ai/my-task
   ```

2. **Ensure working tree is clean.**
   ```bash
   git status --short
   ```
   Output must be empty.

3. **Prepare task with tight guardrails.**
   - `deny_modify` should block sensitive files (`.env`, `node_modules/**`, etc.)
   - `max_lines_changed` should be small and realistic
   - `work_branch` must match current branch
   - `auto_commit: false`, `auto_push: false`, `auto_merge: false`

4. **Run readiness check.**
   ```bash
   npx tsx src/cli.ts real-repo-run-ai-readiness my-task
   ```
   This validates everything **without** calling the provider or mutating the repo.

5. **Run real AI workflow.**
   ```bash
   npx tsx src/cli.ts real-repo-run-ai my-task
   ```

6. **Inspect the commit.**
   ```bash
   git log -1 --stat
   ```

7. **Inspect the pushed branch.**
   ```bash
   git log --oneline origin/ai/my-task
   ```

8. **Inspect the state.**
   ```bash
   cat runs/my-task/state.json
   ```
   Status should be `"pushed"`.

9. **Manually decide next action.**
   - Review the diff.
   - Open a PR manually if desired.
   - Merge manually if approved.
   - Never let the tool merge for you.

## Safety Checklist Before Run

- [ ] Current branch is **not** `main`.
- [ ] `task.work_branch` equals current branch.
- [ ] Guardrails restrict files (`deny_modify`, `max_lines_changed`).
- [ ] Origin remote points to the correct repository.
- [ ] Working tree is clean (`git status --short` is empty).
- [ ] No secrets in task description or context files.
- [ ] Readiness command passes: `real-repo-run-ai-readiness <taskId>`.

## Recovery Checklist

| Failure | What happened | What to do |
|---------|---------------|------------|
| **Provider call failed** | Network error or API error | Check `KIMI_API_KEY`, `KIMI_BASE_URL`, internet connection. Re-run readiness. |
| **Checks failed after all attempts** | Self-repair exhausted `REAL_REPO_AI_MAX_ATTEMPTS` | Inspect rolled-back working tree. Adjust task description or checks. Re-run. |
| **Apply rolled back** | Check failure on first or repair attempt | Working tree is clean. Review check logs in stderr. Fix checks or prompt. |
| **Commit failed** | Git error during `git commit` | Inspect repo manually. Resolve git issues. Re-run if working tree is clean. |
| **Push failed** | Remote rejected push | Check origin remote, permissions, branch protection. Resolve manually. |
| **State write failed** | Push succeeded but `runs/state.json` could not be written | Push is already on remote. Write state manually or re-run after fixing filesystem permissions. |

## Tests vs Real Demo

- **Tests** use `KIMI_FAKE_RESPONSE` / `KIMI_FAKE_RESPONSES` injected fake fetch and a local bare repository as origin. No real API calls. No pushes to GitHub.
- **Operator demo** can use a real provider API key and a real remote. The readiness command helps verify safety before the real call.
