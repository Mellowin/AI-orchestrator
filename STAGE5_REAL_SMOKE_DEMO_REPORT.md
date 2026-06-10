# Stage 5 Real Smoke Demo Execution Report

## Summary

The real smoke demo was executed successfully. The `real-repo-run-ai` command called the live Kimi API, applied a file update, created a local commit, pushed the branch to origin, and wrote state — all safety checks passed.

A real bug was discovered and fixed during the demo: `createRealProviderCall` did not pass the `KIMI_USER_AGENT` header, causing the Kimi For Coding API to return HTTP 403.

---

## Environment

| Variable | Value (redacted) |
|----------|------------------|
| `ALLOW_REAL_PROVIDER` | `true` |
| `ALLOW_REAL_REPO_APPLY` | `true` |
| `ALLOW_REAL_REPO_COMMIT` | `true` |
| `ALLOW_REAL_REPO_PUSH` | `true` |
| `REAL_REPO_AI_MAX_ATTEMPTS` | `2` |
| `KIMI_BASE_URL` | `https://api.kimi.com/coding/v1` |
| `KIMI_MODEL` | `kimi-for-coding` |
| `KIMI_USER_AGENT` | `claude-code/0.1.0` |

---

## Branch Used

- **Demo branch:** `ai/smoke-demo`
- **Created from:** `feature/mvp-skeleton` HEAD (`76946b9a11ec3e9da0b04dae2875defc98811292`)

---

## Task Configuration

- **Task ID:** `smoke-demo`
- **Goal:** Write one short line into `smoke-demo/ai-smoke.txt`. Do not touch any other files.
- **Allowed file:** `smoke-demo/ai-smoke.txt`
- **Max lines changed:** `10`
- **Work branch:** `ai/smoke-demo`
- **Auto flags:** all `false`

Full task config is in `tasks.yaml` under the `smoke-demo` entry.

---

## Execution Steps

### 1. Readiness Check

```bash
npx tsx src/cli.ts real-repo-run-ai-readiness smoke-demo
```

**Result:** ✅ PASSED

Output:
```
[real-repo-run-ai-readiness] Readiness check passed
[real-repo-run-ai-readiness] Task: smoke-demo
[real-repo-run-ai-readiness] Branch: ai/smoke-demo
[real-repo-run-ai-readiness] Provider opt-in: enabled
[real-repo-run-ai-readiness] Repo apply opt-in: enabled
[real-repo-run-ai-readiness] Repo commit opt-in: enabled
[real-repo-run-ai-readiness] Repo push opt-in: enabled
[real-repo-run-ai-readiness] Provider call: not performed
[real-repo-run-ai-readiness] Apply: not performed
[real-repo-run-ai-readiness] Commit: not performed
[real-repo-run-ai-readiness] Push: not performed
[real-repo-run-ai-readiness] Ready to run: real-repo-run-ai smoke-demo
```

### 2. Real AI Run

```bash
npx tsx src/cli.ts real-repo-run-ai smoke-demo
```

**Result:** ✅ SUCCESS

Output:
```
[real-repo-run-ai] Real provider run completed
[real-repo-run-ai] Applied files: 1
[real-repo-run-ai] Commit created
[real-repo-run-ai] Push completed
[real-repo-run-ai] State written
[real-repo-run-ai] Human review required before merge
```

- **Provider attempts:** 1 (no self-repair needed)
- **Self-repair used:** No

---

## Verification

### Changed File

```bash
cat smoke-demo/ai-smoke.txt
```

Content:
```
AI smoke demo
```

### Commit Created

```bash
git log -1 --oneline
```

```
df08319 ai-orchestrator: apply smoke-demo
```

**Full commit hash:** `df083194068c2f913492161233224f45ef0054a8`

### Branch Pushed

```bash
git log --oneline origin/ai/smoke-demo -1
```

```
df08319 ai-orchestrator: apply smoke-demo
```

Branch `ai/smoke-demo` pushed to `origin` successfully.

### State File

```bash
cat runs/smoke-demo/state.json
```

```json
{
  "task_id": "smoke-demo",
  "status": "pushed",
  "current_attempt": 0,
  "branch": "ai/smoke-demo",
  "repo_path": ".",
  "created_at": "2026-06-03T19:02:47.706Z",
  "updated_at": "2026-06-03T19:02:47.706Z",
  "pushed_remote": "origin",
  "pushed_ref": "ai/smoke-demo",
  "commit_sha": "df083194068c2f913492161233224f45ef0054a8",
  "safety_note": "Push completed; merge not performed; human review required before merge"
}
```

### No Merge

```bash
git branch --merged main
```

Result: only `main` is listed. `ai/smoke-demo` is **not** merged.

### Main Unchanged

```bash
git log --oneline main -1
```

```
065568b Initial commit: ARCHITECTURE.md, AGENTS.md, .gitignore
```

Main branch was **not touched**.

### Working Tree Clean

```bash
git status --short
```

Result: empty.

---

## Bug Found and Fixed

### Problem

The first real provider call failed with HTTP 403:

```
Provider returned status 403
```

Investigation revealed the actual API error:

```
Kimi For Coding is currently only available for Coding Agents such as Kimi CLI, Claude Code, Roo Code, Kilo Code, etc.
```

### Root Cause

`createRealProviderCall` in `src/provider-call.ts` did **not** pass the `User-Agent` header, even though `KIMI_USER_AGENT` was configured in `.env` and `KimiClient` already supported it.

### Fix

- `src/provider-call.ts`: Added `userAgent?: string` to `CreateRealProviderCallOptions` and included `User-Agent` header in the fetch request when provided.
- `src/cli.ts`: Passed `process.env.KIMI_USER_AGENT?.trim()` to both call sites of `createRealProviderCall`.

### Fix Commit

```
319efb8 fix(provider-call): pass KIMI_USER_AGENT header in createRealProviderCall
```

---

## Safety Checklist Results

| Check | Result |
|-------|--------|
| Current branch is not `main` | ✅ `ai/smoke-demo` |
| `task.work_branch` equals current branch | ✅ |
| Guardrails restrict files | ✅ Only `smoke-demo/ai-smoke.txt` allowed |
| Origin remote points to correct repository | ✅ `github.com/Mellowin/AI-orchestrator.git` |
| Working tree is clean before run | ✅ |
| No secrets in task description | ✅ |
| Readiness command passes | ✅ |
| No merge performed | ✅ |
| No main touch | ✅ |
| No force push | ✅ |
| Commit message safe | ✅ `ai-orchestrator: apply smoke-demo` |

---

## Commands Run (API keys redacted)

```bash
# Create branch
git checkout -b ai/smoke-demo

# Readiness
npx tsx src/cli.ts real-repo-run-ai-readiness smoke-demo

# Real AI run
npx tsx src/cli.ts real-repo-run-ai smoke-demo

# Verification
cat smoke-demo/ai-smoke.txt
git log -1 --oneline
git log --oneline origin/ai/smoke-demo -1
cat runs/smoke-demo/state.json
git branch --merged main
git log --oneline main -1
git status --short
```

---

## Conclusion

Stage 5 `real-repo-run-ai` works end-to-end with a live AI provider. The full pipeline — provider call → parse → guardrails → apply → checks → commit → push → state — executed successfully on the first attempt with no self-repair needed.

The demo branch `ai/smoke-demo` contains the AI-generated commit and may be deleted after review.
