# AI Orchestrator — Safety Model

## 1. Safety Philosophy

The AI Orchestrator follows a **deny-by-default** safety philosophy:

- **Opt-in gates:** Every real action requires an explicit environment variable.
- **Branch safety:** Work happens only on dedicated work branches. `main` is never touched.
- **No automatic merge:** Merge decisions are intentionally left to human operators.
- **Human review boundary:** After PR status report, the system stops. The human decides whether to merge, reject, or clean up.

---

## 2. Opt-In Table

| Opt-In Flag | Stage | Required For |
|-------------|-------|--------------|
| `ALLOW_REAL_REPO_APPLY=true` | 4.2+ | Any real-repo file write |
| `ALLOW_REAL_REPO_COMMIT=true` | 4.3 | Local commit on work branch |
| `ALLOW_REAL_REPO_PUSH=true` | 4.4 | Pushing work branch to remote |
| `ALLOW_REAL_PROVIDER=true` | 5.1 | Calling real AI provider |
| `ALLOW_REAL_REPO_APPROVAL_REPORT=true` | 5.5 | Generating approval report |
| `ALLOW_REAL_REPO_PR_READINESS=true` | 5.6 | Generating PR readiness report |
| `ALLOW_GITHUB_PR_CREATE=true` | 5.7 | Creating GitHub Pull Request |
| `ALLOW_GITHUB_PR_STATUS=true` | 5.8 | Reading PR status from GitHub API |
| `ALLOW_KIMI_REVIEWER=true` | 6.0 | Using Kimi as reviewer provider (default is fake) |
| `ALLOW_BLOCK_RUN_ONE=true` | 6.3.1 | Running one-task autonomous loop in real mode |
| *(none required)* | 6.9 | Generating block approval report (read-only + report write) |
| *(none required)* | 6.10 | Generating block PR draft package (read-only + draft files write) |

**Stage 6.3.1 / 6.4 Fake Mode Safety:** Fake mode does NOT mutate the real repository. No `git add`, `git commit`, `git push`, `git reset`, file apply, or check execution on the real repo. Fake mode simulates all outcomes and only updates block state.

**Multi-task fake loop (Stage 6.4):**
- `maxTasksPerRun` bounded (1–100) to prevent runaway loops
- `stopOnRejected` and `stopOnBlocked` stop the loop safely
- If `stopOnRejected=false` and a task remains `fix_required`, the loop stops anyway to avoid infinite loops
- Only fake providers
- No real repo mutation across all tasks

**Stage 6.5 Real One-Task Mode Safety:**
- Pure flag checks (`ALLOW_BLOCK_RUN_ONE`, `ALLOW_REAL_PROVIDER`, `ALLOW_REAL_REPO_APPLY`, `ALLOW_REAL_REPO_COMMIT`) happen BEFORE any git or filesystem call.
- Git-based safety checks: current branch must equal `work_branch`, `work_branch` must not be `main`, working tree must be clean.
- `git add -- <file1> <file2>` only — never `git add -A`.
- `git reset --hard` is never used.
- Check failure triggers `rollbackFileUpdates` before any commit.
- Push is optional (`ALLOW_REAL_REPO_PUSH`); if disabled, commit is local only.
- **API keys are never stored in block JSON.** `KIMI_API_KEY` is read from environment variables at runtime. Block JSON rejection guards prevent `apiKey` from being persisted in block definitions.
- Push state is recorded in block state only when push succeeds.

**Stage 6.6 Real Kimi Reviewer One-Task Mode Safety:**
- All Stage 6.5 safety rules apply.
- Provider config is resolved BEFORE state mutation (`markTaskInProgress`). Missing `KIMI_API_KEY` fails before task status changes.

**Stage 6.9 Block Approval Report Safety:**
- No opt-in flag required. The command is read-only except for writing the report file.
- No provider call, no GitHub API, no git mutation, no PR creation, no push, no merge, no checkout/switch, no main touch.
- Git operations are read-only: `git diff --name-only` and `git diff --stat` only.
- Output path is restricted to `runs/blocks/`, current working directory, or system tmpdir.
- All secrets are redacted from the report before write (`sk-`, `Bearer`, `KIMI_API_KEY`, `GITHUB_TOKEN`, etc.).
- `pr_ready` is computed deterministically from block state; it is never influenced by external APIs.

**Stage 6.10 Block PR Draft Package Safety:**
- No opt-in flag required. The command is read-only except for writing draft files.
- No provider call, no GitHub API, no PR creation, no PR update, no push, no merge, no checkout/switch, no main touch.
- Git operations are read-only: `git diff --name-only` and `git diff --stat` only.
- Output directory is restricted to `runs/blocks/`, current working directory, or system tmpdir via `isPathInside`.
- All secrets are redacted from every generated file before write (`sk-`, `Bearer`, `KIMI_API_KEY`, `GITHUB_TOKEN`, etc.).
- If redaction occurs, a safety finding is recorded.
- PR title is truncated to 100 characters and newlines are removed.
- PR body clearly states whether the block is PR-ready or not; it never implies automatic PR creation or merge.

**Stage 6.11 Block PR Create Safety:**
- Requires explicit opt-in: `ALLOW_BLOCK_PR_CREATE=true` AND `ALLOW_GITHUB_PR_CREATE=true`.
- GitHub API call is allowed ONLY for creating a draft PR (`POST /repos/{owner}/{repo}/pulls`) and for checking existing open PRs (`GET /pulls`).
- No merge, no auto-merge, no push, no checkout/switch, no main touch.
- No PR update, no PR comment, no PR review, no PR close.
- No provider calls.
- Branch must already be pushed; this command does not push.
- `GITHUB_TOKEN` is never printed, never written to disk, never included in logs.
- Duplicate protection by default: existing `pr-created.json` blocks second creation.
- Dry-run mode performs all local checks without calling GitHub API.
- PR is always created as draft (`draft: true`).
- Real Kimi reviewer is called ONLY after deterministic checks pass. If deterministic checks fail, reviewer is NOT called.
- Requires `ALLOW_KIMI_REVIEWER=true`, `REVIEWER_PROVIDER=kimi`, `CODER_PROVIDER=kimi`.
- Invalid reviewer decision schema or API failure throws safely without corrupting the committed state.

**Default:** All flags are `false` (deny-by-default).

---

## 3. Git Operation Policy

### Allowed

| Operation | Context | Notes |
|-----------|---------|-------|
| `git status` | Read-only inspection | Used for clean-tree checks |
| `git rev-parse` | Read-only ref validation | Verifies branch/commit existence |
| `git diff` | Read-only diff inspection | Guardrails post-check |
| `git add <approved path>` | Staging approved changes | Array args only, no shell interpolation |
| `git commit` | Local commit on work branch | Exact message: `ai-orchestrator: apply <taskId>` |
| `git push origin <workBranch>` | Pushing work branch | No force, no tags, no `--all`, no `--mirror` |

### Forbidden

| Operation | Reason |
|-----------|--------|
| `git checkout` / `git switch` | No automatic branch switching |
| `git merge` | Merge is not implemented |
| `git rebase` | No history rewriting |
| `git reset` | No destructive history ops |
| `git pull` / `git fetch` | No remote sync automation |
| `git push --force` | No force push |
| `git push --tags` / `--all` / `--mirror` | No bulk push |
| Direct `main` mutation | `main` is protected by design |

---

## 4. Provider Policy

- **Provider calls only after opt-in and repo safety checks.**
- **No raw provider output printed** to stdout/stderr in success path.
- **No API keys printed** in any output or file.
- **Tests use fake provider** (`KIMI_FAKE_RESPONSE`, `KIMI_FAKE_RESPONSES`) — no real API calls in tests.
- **Repair prompts do not include** API keys, env values, or remote URL credentials.

## 4.1 Deterministic Reviewer Gate

- **AI reviewer is NEVER called if deterministic checks fail.**
- Deterministic checks run before any provider call:
  - Commit SHA validation (full 40-char hex)
  - Changed files within `allowed_files` scope
  - No `denied_files` touched
  - `max_lines_changed` not exceeded
  - Typecheck/build/test results pass (word-level matching to avoid false positives)
  - Working tree clean
  - Current branch not `main`
  - No secrets in diff (`sk-`, `Bearer`, API key names, `.env`)
  - No merge conflict markers (`<<<<<<<`, `=======`, `>>>>>>>`)
- **Severe safety findings** (secrets, main branch, merge conflicts, denied files, invalid SHA) return `block_for_human` immediately without AI review.
- **Non-severe failures** return `send_fix_to_coder` without AI review.
- The reviewer receives **factual evidence**, not the coder's self-report.

## 4.2 Reviewer Gate Redaction

- Any dynamic text that comes from tool output (typecheck, build, test, git status) is **redacted** before inclusion in:
  - `blockingIssues`
  - `safetyFindings`
  - `review_summary`
  - `fix_task`
  - CLI stdout/stderr
- Redaction covers: `sk-` tokens, `Bearer` tokens, API key assignments (`KIMI_API_KEY=...`, `OPENAI_API_KEY=...`, `ANTHROPIC_API_KEY=...`, `GITHUB_TOKEN=...`), generic GitHub PATs, and `.env`-like secret patterns.
- Secret **detection** still runs on raw diff for accuracy, but reported issues use generic labels, never raw secret values.

---

## 5. GitHub API Policy

- **PR creation only behind `ALLOW_GITHUB_PR_CREATE=true`.**
- **PR status only behind `ALLOW_GITHUB_PR_STATUS=true`.**
- **No GitHub API calls in tests.** Tests use injected fake fetch.
- **Token is never printed or written** to any report or state file.
- **No merge API** is called.
- **No PR update/comment/approval** APIs are used.

---

## 6. State / Report File Policy

### Allowed file writes

| File | Purpose | Written By |
|------|---------|------------|
| `runs/<taskId>/state.json` | Task progress state | `real-repo-run`, `real-repo-run-ai` |
| `runs/<taskId>/approval-report.md` | Human review report | `real-repo-approval-report` |
| `runs/<taskId>/pr-readiness.md` | PR readiness report | `real-repo-pr-readiness` |
| `runs/<taskId>/pr-body.md` | Suggested PR body | `real-repo-pr-readiness` |
| `runs/<taskId>/pr-created.json` | PR metadata | `real-repo-pr-create` |
| `runs/<taskId>/pr-status-report.md` | PR status report | `real-repo-pr-status` |
| `runs/<taskId>/pr-status.json` | PR status snapshot | `real-repo-pr-status` |
| `runs/blocks/<blockId>/block-state.json` | Block state | `block-init`, `block-transition` |

### Must never be stored

- Provider raw output (except in attempt debug files during development)
- API keys (`KIMI_API_KEY`, `GITHUB_TOKEN`, `OPENAI_API_KEY`)
- Env values or secrets
- File contents in state/report files (unless expected output/report)
- Credentials in URLs (`user:pass@host`)

## 6.1 Block State Safety

- Block state commands (`block-init`, `block-status`, `block-transition`) do not call providers.
- Block state commands do not execute git commands.
- Block state commands do not call GitHub API.
- Block state files are stored only under `runs/blocks/<block_id>/`.
- Path validation rejects writes outside the allowed runs directory.
- Block state does not contain API keys, provider output, or git credentials.
- `review_policy` is stored in `BlockState` on initialization and is required for `markTaskFixRequired`.
- `max_fix_attempts` is enforced in `markTaskFixRequired`; exceeding it blocks the task automatically.
- Restarting a task from `rejected`/`fix_required`/`checks_failed` clears stale reviewer data and blocking issues to prevent false rejections on the next attempt.
- `blocked` tasks cannot be restarted via `in_progress` without human intervention.
- No endless retry loops: `max_fix_attempts` is bounded (1–5) and enforced.

---

## 7. Human Boundary

After the `real-repo-pr-status` command completes, the system stops. The human operator must decide:

- **Merge** the PR manually after review.
- **Reject** the PR and clean up the branch.
- **Request changes** and re-run the workflow.

The tool never makes this decision automatically.
