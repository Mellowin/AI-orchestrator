# AI Orchestrator

![CI](https://github.com/Mellowin/AI-orchestrator/actions/workflows/ci.yml/badge.svg?branch=feature/mvp-skeleton)

Autonomous Node.js CLI tool (TypeScript, ES Modules) that takes tasks from `tasks.yaml`, prepares context for AI models, validates outputs, applies safe patches, runs checks, and persists state in `runs/`.

> **Status:** MVP skeleton. Real Kimi generation is wired as explicit opt-in via `--allow-real-ai`; OpenAI reviewer is not wired yet.
> Supported workflows:
> - Manual Kimi JSON workflow (copy prompt to Kimi, save response, validate and apply).
> - Mock AI workflow via `AI_PROVIDER=mock` (`ai-generate` → `ai-validate` → `ai-preview` → `ai-apply`).
> - Real Kimi generation via `AI_PROVIDER=kimi` + `--allow-real-ai` (`ai-generate` only; validate/apply remain local).

Use ai-preview before ai-apply to inspect proposed changes.

---

## Current MVP workflow

### A. Manual Kimi JSON workflow

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
         "content": "console.log('hello from AI');\n"
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

### B. Mock AI workflow

1. **Set mock provider**
   ```bash
   export AI_PROVIDER=mock
   export MOCK_AI_RESPONSE='{"mode":"file_update","files":[]}'
   ```

   Windows PowerShell:
   ```powershell
   $env:AI_PROVIDER = 'mock'
   $env:MOCK_AI_RESPONSE = '{"mode":"file_update","files":[]}'
   ```

2. **Generate AI output**
   ```bash
   npx tsx src/cli.ts ai-generate demo-task
   ```
   Writes `runs/demo-task/ai-output.json`.

3. **Validate the generated output**
   ```bash
   npx tsx src/cli.ts ai-validate demo-task
   ```

4. **Apply the validated output**
   ```bash
   npx tsx src/cli.ts ai-apply demo-task
   ```
   Delegates to `runMockApplyFlow` — handles state, attempts, patch, checks, and rollback.

5. **Check status**
   ```bash
   npx tsx src/cli.ts status demo-task
   ```

6. **Inspect attempt artifacts**
   ```bash
   npx tsx src/cli.ts attempt demo-task 1
   ```

> Mock workflow does not require `--allow-real-ai`.

### C. Real Kimi opt-in (advanced, requires valid API key)

Use only when you have valid credentials and intend to make a real API request:

```bash
export AI_PROVIDER=kimi
export KIMI_API_KEY=...
export KIMI_MODEL=kimi-k2.6
npx tsx src/cli.ts ai-generate demo-task --allow-real-ai
```

> ⚠️ This performs a real HTTP request to the Kimi API. Do not use without valid credentials and intent.

#### Real Kimi troubleshooting

- `429 Too Many Requests` with a message like `insufficient balance`, `exceeded_current_quota_error`, or `suspended due to insufficient balance` means the request reached the Moonshot/Kimi API, but the account cannot generate because billing/quota is not available.
- This is **not** an orchestrator code failure. Recharge or check billing on the Moonshot platform, then rerun the command.
- If `ai-generate` fails, `runs/{taskId}/ai-output.json` is **not** created.
- Do **not** run `ai-apply` unless `ai-validate` succeeds.

---

## Current safety limits

- **No auto-commit** — `auto_commit` is `false` by default.
- **No auto-push** — `auto_push` is `false` by default.
- **No merge** — the orchestrator never merges branches.
- **No reset/clean** — no destructive git operations (`git reset`, `git clean`) are performed.
- **Work happens on `task.work_branch`** — `prepareWorkBranch` creates or resumes the dedicated work branch, never touching `main` directly.
- **Output is validated before apply** — `validate-output` and `ai-validate` check JSON schema and guardrails without writing to disk.
- **Attempts are limited by `MAX_ATTEMPTS`** — default is `3`. Exceeding it returns `failed_max_attempts`.
- **Artifacts are saved in `runs/{taskId}/attempt-{n}/`** — each attempt gets its own directory with `raw-kimi-output.json`, `parsed-kimi-output.json`, `patch-manifest.json`, and `logs.txt`.

---

## Current AI limitations

- **Real Kimi HTTP is opt-in only** — `KimiClient.generate` is implemented, but `ai-generate` requires explicit `--allow-real-ai` before making a real API request.
- **OpenAI reviewer is not wired yet** — the review pipeline (`gpt-4o` / `gpt-5.5`) is not connected.
- **`ai-generate` blocks real AI providers by default** — `AI_PROVIDER=kimi` requires explicit `--allow-real-ai` flag. Mock mode works without it.
- **`ai-apply` delegates to `runMockApplyFlow`** — it reads `runs/{taskId}/ai-output.json`, pre-validates it, and passes it to the existing mock apply pipeline.
- **No auto push, no merge, no reset, no clean** — these operations are explicitly prohibited by the safety rules.

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
| `ai-generate <taskId>` | Build prompt, call mock AI, save output to `runs/{taskId}/ai-output.json` |
| `ai-validate <taskId>` | Read and validate `runs/{taskId}/ai-output.json` |
| `ai-preview <taskId>` | Preview proposed file changes without writing to disk |
| `ai-apply <taskId>` | Apply validated `ai-output.json` via `runMockApplyFlow` |
| `attempt <taskId> <n>` | Inspect artifacts of a specific attempt |

---

## Environment variables

Copy `.env.example` to `.env` and set:

```bash
AI_PROVIDER=mock
MOCK_AI_RESPONSE={"mode":"file_update","files":[]}
KIMI_API_KEY=...
KIMI_MODEL=moonshot-v1-8k
OPENAI_API_KEY=...
# Optional:
MAX_ATTEMPTS=3
# TASKS_FILE is optional; use it to point to a custom task YAML file for local smoke tests.
# Defaults to tasks.yaml.
# KIMI_USER_AGENT is optional and can be set for provider-specific compatibility
# when your endpoint requires a custom User-Agent.
```

---

## Architecture

See `ARCHITECTURE.md` for module descriptions, data flow, and contracts.
See `AGENTS.md` for coding conventions, safety rules, and agent workflow.
