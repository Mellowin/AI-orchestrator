# Stage 5 Real Smoke Demo

A tiny, safe, manual demo plan to verify `real-repo-run-ai` end-to-end with a real provider.

## Demo Goal

Create or update one tiny allowed file via real AI provider, with all safety checks passing.

## Demo File

- **Path:** `smoke-demo/ai-smoke.txt`
- **Content:** one short line written by the AI

## Guardrails

- `allow_modify`: `["smoke-demo/ai-smoke.txt"]`
- `deny_modify`: `[".env", ".env.*", "node_modules/**"]`
- `max_lines_changed`: `10`
- `auto_commit`: `false`
- `auto_push`: `false`
- `auto_merge`: `false`

## Prerequisites

- Valid `KIMI_API_KEY` and `KIMI_BASE_URL` in environment
- Clean working tree
- Origin remote configured

## Step-by-Step

### 1. Create branch

```bash
git checkout -b ai/smoke-demo
```

### 2. Create task

Add to `tasks.yaml`:

```yaml
tasks:
  - id: smoke-demo
    title: "AI smoke demo"
    repo_path: "./"
    base_branch: "main"
    work_branch: "ai/smoke-demo"
    goal: "Write one short line into smoke-demo/ai-smoke.txt. Do not touch any other files."
    context_files: []
    checks:
      - command: "node"
        args: ["-e", "const fs=require('fs'); const c=fs.readFileSync('smoke-demo/ai-smoke.txt','utf8'); if(!c.trim()) process.exit(1);"]
    guardrails:
      allow_modify:
        - "smoke-demo/ai-smoke.txt"
      deny_modify:
        - ".env"
        - ".env.*"
        - "node_modules/**"
      max_lines_changed: 10
      require_tests: false
      auto_commit: false
      auto_push: false
      auto_merge: false
```

### 3. Run readiness

```bash
export ALLOW_REAL_PROVIDER=true
export ALLOW_REAL_REPO_APPLY=true
export ALLOW_REAL_REPO_COMMIT=true
export ALLOW_REAL_REPO_PUSH=true
export REAL_REPO_AI_MAX_ATTEMPTS=2
export KIMI_API_KEY="your-key"
export KIMI_BASE_URL="https://api.moonshot.cn/v1"

npx tsx src/cli.ts real-repo-run-ai-readiness smoke-demo
```

Expected output:
```
[real-repo-run-ai-readiness] Readiness check passed
[real-repo-run-ai-readiness] Task: smoke-demo
[real-repo-run-ai-readiness] Branch: ai/smoke-demo
...
[real-repo-run-ai-readiness] Ready to run: real-repo-run-ai smoke-demo
```

### 4. Run real AI

```bash
npx tsx src/cli.ts real-repo-run-ai smoke-demo
```

### 5. Verify

Check file changed:
```bash
cat smoke-demo/ai-smoke.txt
```

Check one commit created:
```bash
git log --oneline -3
```

Check branch pushed:
```bash
git log --oneline origin/ai/smoke-demo
```

Check state:
```bash
cat runs/smoke-demo/state.json
```
Expected: `status: "pushed"`

Check no merge:
```bash
git branch --merged main
```
`ai/smoke-demo` should **not** appear.

Check main unchanged:
```bash
git log --oneline main -1
```
Should be the same commit as before the demo.

## Cleanup Options

### Delete demo branch locally and remotely

```bash
git push origin --delete ai/smoke-demo
git branch -D ai/smoke-demo
```

### Remove smoke file in a later cleanup branch

```bash
git checkout -b cleanup/remove-smoke-demo
git rm smoke-demo/ai-smoke.txt
git commit -m "cleanup: remove smoke demo file"
```

## Safety Rules

- **Do NOT run on `main`.**
- **Do NOT force push.**
- **Do NOT merge automatically.**
- **Do NOT include real API keys in any committed files or docs.**
