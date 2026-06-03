# AI Orchestrator — Command Reference

## Real Repo Commands

### `real-repo-run <taskId>`

**Purpose:** One-command unified workflow using a pre-canned provider response.

**Required env:**
- `ALLOW_REAL_REPO_APPLY=true`
- `ALLOW_REAL_REPO_COMMIT=true`
- `ALLOW_REAL_REPO_PUSH=true`
- `REAL_REPO_PROVIDER_RESPONSE` — JSON string with file updates

**Allowed mutation:**
- Applies files to working tree
- Creates local commit
- Pushes work branch to origin
- Writes `runs/<taskId>/state.json`

**Forbidden actions:**
- No provider call
- No merge
- No checkout/switch
- No main touch

**Outputs/files:**
- `runs/<taskId>/state.json` — status `pushed`

**Normal success message:**
- `Push completed`
- `Push target: origin <workBranch>`

**Safe failure behavior:**
- Rolls back applied files on check failure
- Does not commit/push/write state on any failure
- Prints safe error + `Manual inspection required`

---

### `real-repo-run-ai-readiness <taskId>`

**Purpose:** Validate that `real-repo-run-ai` is safe to start without calling the provider or mutating the repo.

**Required env:**
- `ALLOW_REAL_PROVIDER=true`
- `ALLOW_REAL_REPO_APPLY=true`
- `ALLOW_REAL_REPO_COMMIT=true`
- `ALLOW_REAL_REPO_PUSH=true`
- `KIMI_API_KEY`
- `KIMI_BASE_URL`

**Allowed mutation:**
- None. Read-only validation only.

**Forbidden actions:**
- No provider call
- No file apply
- No commit
- No push
- No state write
- No merge
- No checkout/switch
- No main touch

**Outputs/files:**
- None

**Normal success message:**
- `Readiness check passed`
- Lists provider call, apply, commit, push as `not performed`

**Safe failure behavior:**
- Prints the failed safety condition
- No side effects

---

### `real-repo-run-ai <taskId>`

**Purpose:** Full unified workflow with real AI provider (Kimi). Includes self-repair loop.

**Required env:**
- `ALLOW_REAL_PROVIDER=true`
- `ALLOW_REAL_REPO_APPLY=true`
- `ALLOW_REAL_REPO_COMMIT=true`
- `ALLOW_REAL_REPO_PUSH=true`
- `KIMI_API_KEY`
- `KIMI_BASE_URL`
- `KIMI_MODEL` (optional)

**Allowed mutation:**
- Calls AI provider
- Applies files to working tree
- Creates local commit
- Pushes work branch to origin
- Writes `runs/<taskId>/state.json`

**Forbidden actions:**
- No merge
- No checkout/switch
- No main touch
- No force push

**Outputs/files:**
- `runs/<taskId>/state.json` — status `pushed`
- `runs/<taskId>/attempt-{n}/` — attempt artifacts

**Normal success message:**
- `Real provider run completed`
- `Push completed`

**Safe failure behavior:**
- Rolls back on check failure
- Re-calls provider for self-repair if attempts remain
- Does not commit/push/state on final failure
- Prints `Checks failed after N attempt(s)`

---

### `real-repo-approval-report <taskId>`

**Purpose:** Generate a local approval report after successful push.

**Required env:**
- `ALLOW_REAL_REPO_APPROVAL_REPORT=true`

**Allowed mutation:**
- Writes `runs/<taskId>/approval-report.md`

**Forbidden actions:**
- No provider call
- No apply
- No commit
- No push
- No PR creation
- No merge
- No checkout/switch
- No main touch

**Outputs/files:**
- `runs/<taskId>/approval-report.md`

**Normal success message:**
- `Approval report written`

**Safe failure behavior:**
- Prints safe error
- No file mutation other than the report

---

### `real-repo-pr-readiness <taskId>`

**Purpose:** Generate PR readiness dry-run report and suggested PR body.

**Required env:**
- `ALLOW_REAL_REPO_PR_READINESS=true`

**Allowed mutation:**
- Writes `runs/<taskId>/pr-readiness.md`
- Writes `runs/<taskId>/pr-body.md`

**Forbidden actions:**
- No PR creation
- No GitHub API call
- No gh execution
- No merge
- No checkout/switch
- No main touch

**Outputs/files:**
- `runs/<taskId>/pr-readiness.md`
- `runs/<taskId>/pr-body.md`

**Normal success message:**
- `PR readiness report written`

**Safe failure behavior:**
- Prints safe error
- No files mutated except the two reports

---

### `real-repo-pr-create <taskId>`

**Purpose:** Create a GitHub Pull Request via REST API.

> **Important:** This command creates a PR but does **not** merge it.

**Required env:**
- `ALLOW_GITHUB_PR_CREATE=true`
- `GITHUB_TOKEN`
- `GITHUB_REPOSITORY` (`owner/repo`)

**Allowed mutation:**
- Calls GitHub REST API `POST /repos/{owner}/{repo}/pulls`
- Writes `runs/<taskId>/pr-created.json`

**Forbidden actions:**
- No merge
- No auto-merge
- No checkout/switch
- No main touch
- No push
- No provider call
- No gh execution
- No PR update after creation

**Outputs/files:**
- `runs/<taskId>/pr-created.json`

**Normal success message:**
- `PR created`
- `PR URL: <url>`

**Safe failure behavior:**
- Does not write `pr-created.json` on API failure
- Prints `GitHub PR creation failed`
- Prints `Manual inspection required`

---

### `real-repo-pr-status <taskId>`

**Purpose:** Fetch read-only PR status and commit check information from GitHub API.

> **Important:** This command is read-only and does **not** update the PR.

**Required env:**
- `ALLOW_GITHUB_PR_STATUS=true`
- `GITHUB_TOKEN`
- `GITHUB_REPOSITORY` (`owner/repo`)

**Allowed mutation:**
- Calls GitHub REST API read-only GET:
  - `/repos/{owner}/{repo}/pulls/{number}`
  - `/repos/{owner}/{repo}/commits/{sha}/status`
  - `/repos/{owner}/{repo}/commits/{sha}/check-runs`
- Writes `runs/<taskId>/pr-status-report.md`
- Writes `runs/<taskId>/pr-status.json`

**Forbidden actions:**
- No PR creation
- No PR update
- No PR comment
- No approval
- No merge
- No checkout/switch
- No main touch
- No push
- No provider call
- No gh execution

**Outputs/files:**
- `runs/<taskId>/pr-status-report.md`
- `runs/<taskId>/pr-status.json`

**Normal success message:**
- `PR status report written`
- `Report path: runs/<taskId>/pr-status-report.md`

**Safe failure behavior:**
- Does not write report/json on API failure
- Prints `GitHub PR status fetch failed`
- Prints `Manual inspection required`

---

## Common Safety Notes

- **None of these commands checkout/switch branch automatically.**
- **Merge is not implemented.** Human operators must merge manually.
- **All GitHub API commands require explicit opt-in.**
- **All real-repo write commands require explicit opt-in.**
- **`main` is protected by design.** The tool refuses to run if `work_branch` is `main`.
