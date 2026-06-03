# Stage 5.10 Live Operator Demo Evidence Pack

> Generated: 2026-06-04T00:24:00+03:00  
> Agent: Kimi Code CLI  
> Repository: Mellowin/AI-orchestrator  
> Branch: `feature/mvp-skeleton` (docs base) / `demo/stage5-live-proof` (demo execution)

---

## 1. Demo Summary

| Field | Value |
|---|---|
| **Task ID** | `stage5-live-proof` |
| **Demo branch** | `demo/stage5-live-proof` |
| **Base branch** | `feature/mvp-skeleton` |
| **Generated file** | `live-demo/stage5-proof.txt` |
| **Provider attempts count** | 1 |
| **Self-repair used** | No |
| **Final status** | `pushed` (commit created and pushed); PR creation blocked by missing `GITHUB_TOKEN` |

---

## 2. Commands Run

All secrets redacted. No API keys or tokens are shown.

### Setup
```bash
git checkout feature/mvp-skeleton
git pull origin feature/mvp-skeleton
git checkout -b demo/stage5-live-proof
git status --short   # clean
```

### Task added to tasks.yaml
Added `stage5-live-proof` task with:
- `repo_path: "."`
- `base_branch: "feature/mvp-skeleton"`
- `work_branch: "demo/stage5-live-proof"`
- `goal: "Create live-demo/stage5-proof.txt with one short line: Stage 5 live proof works"`
- `checks: node -e "verify file exists and has non-empty text"`
- `guardrails.allow_modify: ["live-demo/stage5-proof.txt"]`
- `guardrails.max_lines_changed: 10`
- `auto_commit: false`, `auto_push: false`, `auto_merge: false`

Committed task config:
```bash
git add tasks.yaml
git commit -m "chore: add stage5-live-proof demo task to tasks.yaml"
# → b3d4654
```

### Step 5 — Readiness
```bash
export ALLOW_REAL_PROVIDER=true
export ALLOW_REAL_REPO_APPLY=true
export ALLOW_REAL_REPO_COMMIT=true
export ALLOW_REAL_REPO_PUSH=true
export KIMI_API_KEY=<redacted>
export KIMI_BASE_URL=https://api.kimi.com/coding/v1
export KIMI_MODEL=kimi-for-coding
npx tsx src/cli.ts real-repo-run-ai-readiness stage5-live-proof
```

### Step 7 — Real provider run
```bash
npx tsx src/cli.ts real-repo-run-ai stage5-live-proof
```

### Step 12 — Approval report
```bash
export ALLOW_REAL_REPO_APPROVAL_REPORT=true
npx tsx src/cli.ts real-repo-approval-report stage5-live-proof
```

### Step 13 — PR readiness
```bash
export ALLOW_REAL_REPO_PR_READINESS=true
npx tsx src/cli.ts real-repo-pr-readiness stage5-live-proof
```

### Step 14 — PR creation (ATTEMPTED, BLOCKED)
```bash
export ALLOW_GITHUB_PR_CREATE=true
export GITHUB_REPOSITORY=Mellowin/AI-orchestrator
# GITHUB_TOKEN not available in environment
npx tsx src/cli.ts real-repo-pr-create stage5-live-proof
```

### Step 15 — PR status (SKIPPED)
Skipped because step 14 did not produce `pr-created.json`.

### Step 16 — Verification
```bash
npm run typecheck
npm run build
npx tsx --test test/**/*.test.ts
```

---

## 3. Readiness Result

**Status:** ✅ PASSED

Output:
```
[real-repo-run-ai-readiness] Readiness check passed
[real-repo-run-ai-readiness] Task: stage5-live-proof
[real-repo-run-ai-readiness] Branch: demo/stage5-live-proof
[real-repo-run-ai-readiness] Provider opt-in: enabled
[real-repo-run-ai-readiness] Repo apply opt-in: enabled
[real-repo-run-ai-readiness] Repo commit opt-in: enabled
[real-repo-run-ai-readiness] Repo push opt-in: enabled
[real-repo-run-ai-readiness] Provider call: not performed
[real-repo-run-ai-readiness] Apply: not performed
[real-repo-run-ai-readiness] Commit: not performed
[real-repo-run-ai-readiness] Push: not performed
[real-repo-run-ai-readiness] Ready to run: real-repo-run-ai stage5-live-proof
```

---

## 4. Real Provider Run Result

**Status:** ✅ SUCCESS

- **AI-generated commit hash:** `77e8f2e539e167a38ea33cb15c24898d40e53eba`
- **Pushed branch:** `origin/demo/stage5-live-proof`
- **State status:** `pushed`
- **Provider attempts:** 1 (first attempt succeeded, no self-repair needed)
- **Applied files:** 1

Output:
```
[real-repo-run-ai] Real provider run completed
[real-repo-run-ai] Applied files: 1
[real-repo-run-ai] Commit created
[real-repo-run-ai] Push completed
[real-repo-run-ai] State written
[real-repo-run-ai] Human review required before merge
```

---

## 5. Generated File

**Path:** `live-demo/stage5-proof.txt`

**Content:**
```
Stage 5 live proof works
```

**Verification:**
```bash
cat live-demo/stage5-proof.txt
# → Stage 5 live proof works
```

---

## 6. Approval Report

**Path:** `runs/stage5-live-proof/approval-report.md`

**Exists:** ✅ Yes

Key fields:
- Task ID: `stage5-live-proof`
- Base Branch: `feature/mvp-skeleton`
- Work Branch: `demo/stage5-live-proof`
- Pushed Commit SHA: `77e8f2e539e167a38ea33cb15c24898d40e53eba`
- State Status: `pushed`

Safety statements confirmed in report:
- "This tool did not create a PR."
- "This tool did not merge."
- "This tool did not checkout or switch branches."
- "This tool did not touch main."
- "This tool did not call provider."
- "This tool did not push."

---

## 7. PR Readiness

**Path:** `runs/stage5-live-proof/pr-readiness.md`

**Exists:** ✅ Yes

**Path:** `runs/stage5-live-proof/pr-body.md`

**Exists:** ✅ Yes

Key fields:
- PR Title Suggestion: `Stage 5 live proof`
- Manual command included (text-only, not executed)
- Contains hard safety statements (no PR created, no GitHub API call, no gh, no merge, etc.)

---

## 8. PR Creation

**Status:** ❌ BLOCKED — `GITHUB_TOKEN` not available

The command `real-repo-pr-create` refused before making any API call because the `GITHUB_TOKEN` environment variable was not set.

```
[real-repo-pr-create] Error: GITHUB_TOKEN is required
[real-repo-pr-create] No PR was created
[real-repo-pr-create] No merge was performed
[real-repo-pr-create] No checkout was performed
[real-repo-pr-create] No main touch was performed
```

This is the **expected safety behavior** when the required credential is missing. No network call was attempted. No file was written.

**PR URL:** N/A (PR not created)
**PR Number:** N/A
**Path:** `runs/stage5-live-proof/pr-created.json`
**Exists:** ❌ No

> **To complete this step:** provide `GITHUB_TOKEN` with `repo` scope and re-run:
> ```bash
> export GITHUB_TOKEN=<your-token>
> export ALLOW_GITHUB_PR_CREATE=true
> npx tsx src/cli.ts real-repo-pr-create stage5-live-proof
> ```

---

## 9. PR Status

**Status:** ⏭️ SKIPPED

Skipped because `pr-created.json` does not exist (PR creation was blocked).

**Path:** `runs/stage5-live-proof/pr-status-report.md`
**Exists:** ❌ No

**Path:** `runs/stage5-live-proof/pr-status.json`
**Exists:** ❌ No

> **To complete this step:** run PR creation first, then:
> ```bash
> export GITHUB_TOKEN=<your-token>
> export ALLOW_GITHUB_PR_STATUS=true
> npx tsx src/cli.ts real-repo-pr-status stage5-live-proof
> ```

---

## 10. Safety Confirmation

| Rule | Status | Evidence |
|---|---|---|
| No merge | ✅ | Tool output: "No merge was performed" |
| No auto-merge | ✅ | `auto_merge: false` in task config; no merge API call |
| No main touch | ✅ | Work branch is `demo/stage5-live-proof`; base is `feature/mvp-skeleton` |
| No checkout/switch by the tool | ✅ | Tool stayed on `demo/stage5-live-proof`; no branch switch in code path |
| No force push | ✅ | Push target: `origin demo/stage5-live-proof`; no `--force` flag |
| No token printed | ✅ | Output contains no `GITHUB_TOKEN`, no `KIMI_API_KEY` |
| No provider raw output printed | ✅ | State does not contain provider raw output; stdout does not print it |
| No secrets written to reports | ✅ | `approval-report.md`, `pr-readiness.md`, `pr-body.md`, `state.json` inspected: no secrets |

---

## 11. Test Verification

### Typecheck
```bash
npm run typecheck
```
**Result:** ✅ Pass (`tsc --noEmit` — no errors)

### Build
```bash
npm run build
```
**Result:** ✅ Pass (`tsc` — compiles cleanly)

### Tests
```bash
npx tsx --test test/**/*.test.ts
```
**Result:** ✅ Pass
- **Tests:** 1034
- **Suites:** 59
- **Pass:** 1034
- **Fail:** 0
- **Cancelled:** 0
- **Skipped:** 0
- **Duration:** ~95s

Test count matches baseline exactly. No regressions.

---

## 12. Working Tree Status

```bash
git status --short
```
**Result:** clean (no output)

Current branch: `demo/stage5-live-proof`

Recent commits:
```
77e8f2e ai-orchestrator: apply stage5-live-proof
b3d4654 chore: add stage5-live-proof demo task to tasks.yaml
d1f1850 docs: update TESTING_SUMMARY and MVP_FINAL_REPORT with Stage 5.9 commit hash
```

---

## 13. State File

**Path:** `runs/stage5-live-proof/state.json`

```json
{
  "task_id": "stage5-live-proof",
  "status": "pushed",
  "current_attempt": 0,
  "branch": "demo/stage5-live-proof",
  "repo_path": ".",
  "created_at": "2026-06-03T21:24:42.865Z",
  "updated_at": "2026-06-03T21:24:42.865Z",
  "pushed_remote": "origin",
  "pushed_ref": "demo/stage5-live-proof",
  "commit_sha": "77e8f2e539e167a38ea33cb15c24898d40e53eba",
  "safety_note": "Push completed; merge not performed; human review required before merge"
}
```

---

## 14. What Was Proven

| Stage | Proven |
|---|---|
| Readiness validation | ✅ Real opt-in chain works |
| Provider call | ✅ Real Kimi API call succeeded |
| Response parsing | ✅ AI output parsed into valid `file_update` |
| Guardrails | ✅ `allow_modify` and `max_lines_changed` enforced |
| Apply | ✅ File created on disk |
| Checks | ✅ Node check passed (file exists, non-empty) |
| Commit | ✅ Local commit created with exact message format |
| Push | ✅ Branch pushed to origin |
| State | ✅ `state.json` written with correct metadata |
| Approval report | ✅ Report generated with safety statements |
| PR readiness | ✅ `pr-readiness.md` + `pr-body.md` generated |
| PR creation | ❌ Blocked by missing `GITHUB_TOKEN` (expected safe refusal) |
| PR status | ⏭️ Skipped (depends on PR creation) |
| Tests | ✅ 1034/59, no regressions |

---

## 15. Known Gap

**Gap:** Real PR creation and PR status steps were not executed because `GITHUB_TOKEN` was not available in the execution environment.

**Impact:** The pipeline stopped safely at the GitHub API boundary, exactly as designed. No unauthorized API call was attempted.

**Resolution path:**
1. User provides `GITHUB_TOKEN` with `repo` scope.
2. Re-run steps 14 and 15.
3. Update this evidence file with PR URL, PR number, and status report.

---

## 16. Commit Evidence

This evidence file will be committed to `feature/mvp-skeleton` as a documentation update.

```bash
git checkout feature/mvp-skeleton
# Merge evidence file, then:
git add STAGE5_LIVE_DEMO_EVIDENCE.md
git commit -m "docs: add Stage 5 live demo evidence"
git push origin feature/mvp-skeleton
```

> **Note:** The `demo/stage5-live-proof` branch contains the AI-generated commit and remains pushed to origin for inspection. It is **not merged**.
