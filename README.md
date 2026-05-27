# AI Orchestrator

Autonomous Node.js CLI tool (TypeScript, ES Modules) that takes tasks from `tasks.yaml`, prepares context for AI models, validates outputs, applies safe patches, runs checks, and persists state in `runs/`.

> **Status:** MVP skeleton. Real Kimi/OpenAI API integration is not wired yet. The current workflow is fully manual — you copy the prompt to Kimi, get the JSON response back, and run it through the CLI.

---

## Manual MVP workflow

1. **Export context**
   ```bash
   npx tsx src/cli.ts context demo-task
   ```

2. **Export Kimi prompt**
   ```bash
   npx tsx src/cli.ts prompt demo-task
   ```

3. **Open the prompt**
   ```bash
   # or open in your editor
   cat runs/demo-task/kimi-prompt.md
   ```

4. **Paste the prompt into Kimi manually** and wait for the JSON response.

5. **Save Kimi response as a JSON file**

   Bash:
   ```bash
   cat > tmp/kimi-output.json << 'EOF'
   {
     "mode": "file_update",
     "files": [
       {
         "path": "src/index.ts",
         "content": "console.log('hello from AI');\n"
       }
     ],
     "notes": "Added a simple console log"
   }
   EOF
   ```

   Windows PowerShell:
   ```powershell
   New-Item -ItemType Directory -Force tmp | Out-Null

   @'
   {
     "mode": "file_update",
     "files": [
       {
         "path": "src/index.ts",
         "content": "console.log('hello from AI');`n"
       }
     ],
     "notes": "Added a simple console log"
   }
   '@ | Set-Content -Encoding UTF8 tmp/kimi-output.json
   ```

6. **Validate the output** (parse + guardrails check, no repo changes)
   ```bash
   npx tsx src/cli.ts validate-output demo-task tmp/kimi-output.json
   ```

7. **Apply the output** (mock-apply runs the full pipeline: patch → diff → guardrails → checks → rollback on failure)
   ```bash
   npx tsx src/cli.ts mock-apply demo-task tmp/kimi-output.json
   ```

8. **Check status**
   ```bash
   npx tsx src/cli.ts status demo-task
   ```

9. **Inspect attempt artifacts**
   ```bash
   npx tsx src/cli.ts attempt demo-task 1
   ```

---

## Current safety limits

- **No auto-commit** — `auto_commit` is `false` by default.
- **No auto-push** — `auto_push` is `false` by default.
- **No merge** — the orchestrator never merges branches.
- **No reset/clean** — no destructive git operations (`git reset`, `git clean`) are performed.
- **Work happens on `task.work_branch`** — `prepareWorkBranch` creates or resumes the dedicated work branch, never touching `main` directly.
- **Output is validated before apply** — `validate-output` checks JSON schema and guardrails without writing to disk.
- **Attempts are limited by `MAX_ATTEMPTS`** — default is `3`. Exceeding it returns `failed_max_attempts`.
- **Artifacts are saved in `runs/{taskId}/attempt-{n}/`** — each attempt gets its own directory with `raw-kimi-output.json`, `parsed-kimi-output.json`, `patch-manifest.json`, and `logs.txt`.

---

## Useful commands

| Command | Description |
|---------|-------------|
| `run <taskId>` | Initialize or resume task state |
| `status <taskId>` | Show current status, last logs, and attempt list |
| `git-check <taskId>` | Check current branch and working tree cleanliness |
| `git-diff <taskId>` | Show diff stats of the working tree |
| `context <taskId>` | Export `ContextPackage` to `runs/{taskId}/context-package.json` |
| `prompt <taskId>` | Export ready-to-send Kimi prompt to `runs/{taskId}/kimi-prompt.md` |
| `validate-output <taskId> <jsonPath>` | Validate Kimi JSON output without applying patches |
| `mock-apply <taskId> <jsonPath>` | Full mock pipeline: apply → guardrails → checks → rollback on failure |
| `attempt <taskId> <n>` | Inspect artifacts of a specific attempt |

---

## Environment variables

Copy `.env.example` to `.env` and set:

```bash
KIMI_API_KEY=...
OPENAI_API_KEY=...
# Optional:
MAX_ATTEMPTS=3
```

---

## Architecture

See `ARCHITECTURE.md` for module descriptions, data flow, and contracts.
See `AGENTS.md` for coding conventions, safety rules, and agent workflow.
