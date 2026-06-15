# AI Orchestrator

![CI](https://github.com/Mellowin/AI-orchestrator/actions/workflows/ci.yml/badge.svg?branch=feature/mvp-skeleton)

Autonomous Node.js CLI tool (TypeScript, ES Modules) that takes tasks from `tasks.yaml`, prepares context for AI models, validates outputs, applies safe patches, runs checks, and persists state in `runs/`.

> **Status:** MVP proof completed. The pipeline from provider call through PR status read-only is implemented and tested.
> **Not production-ready automation.** Merge remains a manual human decision.
>
> Supported workflows:
> - Manual Kimi JSON workflow (copy prompt to Kimi, save response, validate and apply).
> - Mock AI workflow via `AI_PROVIDER=mock` (`ai-generate` → `ai-validate` → `ai-preview` → `ai-apply`).
> - Real Kimi workflow via `AI_PROVIDER=kimi` + `--allow-real-ai` (full pipeline through PR creation and status read-only).

Use ai-preview before ai-apply to inspect proposed changes.

## Verified real Kimi E2E smoke

The real Kimi path has been verified through a full local E2E smoke:

- `ai-generate`
- `ai-validate`
- `ai-preview`
- `ai-apply`
- `typecheck`
- `build`
- `test`

The verified smoke used a small README-only change, applied it on a work branch, passed checks, committed it, opened a PR, and merged it back into `feature/mvp-skeleton`.

Verified safety behavior:

- `files: []` is accepted as a valid no-op for unclear or unsafe tasks.
- Destructive file shrink is blocked by line-delta guardrails.
- Failed checks trigger rollback.
- Post-apply changed files are checked against guardrails.

This remains an MVP skeleton, not production-ready automation.

---

## Mini-MVP Status

The autonomous block execution pipeline is proven and documented:

- **Real Kimi coder + real Kimi reviewer** — live multi-task block with fix loop (Stage 6.16)
- **Local commits only** — push disabled by default during autonomous run
- **1739 tests / 102 suites / 0 failures** — local test suite passes
- **GitHub CI** — not verified / no workflow runs

### Quick Links

- [Stage 10 v0 Release Snapshot](docs/STAGE_10_V0_RELEASE.md) — what works now, commands, safety guarantees, known limitations
- [Real Block Run Quickstart](docs/REAL_BLOCK_RUN_QUICKSTART.md) — run an autonomous multi-task block end-to-end
- [Operator Runbook](docs/OPERATOR_RUNBOOK.md) — one-page overview, core loop, modes, safety defaults
- [Demo Command Cookbook](docs/DEMO_COMMAND_COOKBOOK.md) — exact commands for fake, real coder, real reviewer runs
- [Mini-MVP Demo Package](docs/MINI_MVP_DEMO_PACKAGE.md) — what is proven, what is not claimed, known limitations
- [Safety Invariants](docs/SAFETY_INVARIANTS.md) — hard design-level guarantees
- [Final Human Review Package](docs/FINAL_HUMAN_REVIEW_PACKAGE.md) — reviewer checklist, evidence links, known limitations
- [Manual PR Body](docs/MANUAL_PR_BODY.md) — ready-to-copy PR body for human review
- [Mini-MVP Release Notes](docs/MINI_MVP_RELEASE_NOTES.md) — stage highlights, safety notes, next candidates
- [Stage 6.16 Proof](docs/STAGE6_16_REAL_MULTITASK_BLOCK_PROOF.md) — real Kimi multi-task block with fix loop
- [Stage 6.15.2 Proof](docs/STAGE6_15_2_FULL_FIX_LOOP_MATRIX_PROOF.md) — multi-scenario fix-loop matrix
- [MVP Final Report](MVP_FINAL_REPORT.md) — current status, demo proof, known limitations
- [Command Reference](COMMAND_REFERENCE.md) — all real-repo commands with env, outputs, and safety notes
- [Safety Model](SAFETY_MODEL.md) — opt-in gates, git policy, provider/GitHub API policy, human boundary
- [Stage 5 Operator Guide](STAGE5_OPERATOR_GUIDE.md) — exact safe operator sequence
- [Stage 5 PR Boundary Audit](STAGE5_PR_BOUNDARY_AUDIT.md) — what the tool does and does not do at each stage

## Product verification

Run the full local verification in one command:

```bash
npm run verify:product
```

This runs:

1. `npm run typecheck` — TypeScript strict check
2. `npm run build` — production build
3. `npm test` — full test suite
4. `npm run demo:block:fake` — local fake-provider block demo

No real external AI or network access is required. The command uses fake responses and a temporary git repository.

The same product verification command is run automatically by GitHub Actions on every push and pull request to `main` (see `.github/workflows/product-verify.yml`).

## Real provider smoke check

Before running a real block against a real repository, verify provider connectivity safely:

```bash
export ALLOW_REAL_PROVIDER=true
export KIMI_API_KEY="sk-your-key"
export KIMI_BASE_URL="https://api.moonshot.cn/v1"
npx tsx src/cli.ts real-provider-smoke
```

This is a read-only, no-repo-mutation check. It does not read or write block state, apply patches, create commits, push, or merge. The default timeout is 15 seconds and can be changed with `REAL_PROVIDER_SMOKE_TIMEOUT_MS` (clamped to 1–60 seconds).

For a safe operator preflight that combines block readiness and provider-env checks, use `real-block-run-ai-checklist <blockPath>`. See [`docs/REAL_BLOCK_RUN_QUICKSTART.md`](docs/REAL_BLOCK_RUN_QUICKSTART.md) for details.

## Current MVP workflow

### Recommended safe flow

```bash
npx tsx src/cli.ts ai-run <taskId>
npx tsx src/cli.ts ai-apply <taskId>
```

- `ai-run <taskId>` runs `ai-generate → ai-validate → ai-preview`
- It stops on the first failure
- It does **not** run `ai-apply`
- Review preview output before running `ai-apply`
- `ai-apply` remains a separate manual step

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

2. **Run preview pipeline (generate → validate → preview)**
   ```bash
   npx tsx src/cli.ts ai-run demo-task
   ```
   Safe preview that does not apply changes. Review output, then run `ai-apply` manually.

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
npx tsx src/cli.ts ai-run demo-task --allow-real-ai
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
| `ai-run <taskId>` | Run generate → validate → preview safely (no auto-apply) |
| `ai-apply <taskId>` | Apply validated `ai-output.json` via `runMockApplyFlow` |
| `ai-output-status <taskId>` | Inspect current AI output, file paths and backups without applying changes |
| `agent-once <taskId>` | Print planned one-task agent loop steps without executing actions |
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

## Product Direction

Stage 5 completed the safe pipeline proof (provider → apply → checks → commit → push → PR status).  
Stage 6 target is **autonomous block execution with AI coder + AI reviewer**.

- First target: **Kimi as Coder + Kimi as Reviewer** (same API key, different prompts/roles).
- Future: users can combine providers — Claude coder + Gemini reviewer, DeepSeek coder + OpenAI reviewer, etc.
- The orchestrator must never be hardcoded to one AI provider.

Documents:
- [`PRODUCT_VISION.md`](PRODUCT_VISION.md) — original goal, what the project is and is not, core principles, human role.
- [`AUTONOMOUS_BLOCK_ARCHITECTURE.md`](AUTONOMOUS_BLOCK_ARCHITECTURE.md) — block concept, task state machine, autonomous loop, reviewer gate, stop conditions.
- [`PROVIDER_COMBINATION_ROADMAP.md`](PROVIDER_COMBINATION_ROADMAP.md) — provider roles, interfaces, roadmap Stage 6.0–6.7, future combinations, configuration examples.

---

## Architecture

See `ARCHITECTURE.md` for module descriptions, data flow, and contracts.
See `AGENTS.md` for coding conventions, safety rules, and agent workflow.
