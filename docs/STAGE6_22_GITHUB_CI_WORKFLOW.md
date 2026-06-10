# Stage 6.22 — GitHub CI Workflow for Mini-MVP Checks

**Status:** 🟡 Workflow added; CI pass not yet verified until workflow run completes.
**Branch:** `feature/mvp-skeleton`
**Date:** 2026-06-10

---

## Purpose

Add a GitHub Actions CI workflow that automatically runs the project checks (typecheck, build, test) on every PR and push to key branches. This is a prerequisite for any future auto-merge work — CI must pass before a PR can be safely merged.

---

## Workflow file

**Path:** `.github/workflows/ci.yml`

**Name:** Mini-MVP CI

### Triggers

- `pull_request` — any PR against any branch
- `push` to:
  - `feature/mvp-skeleton`
  - `stage-6-21-proof`
  - `stage-6-22-ci-proof`
- `workflow_dispatch` — manual trigger

### Job: `checks`

| Property | Value |
|---|---|
| Runner | `ubuntu-latest` |
| Node.js | `20` |

### Steps

1. `actions/checkout@v4` — checkout repository
2. `actions/setup-node@v4` — setup Node.js 20 with npm cache
3. `npm ci` — install dependencies
4. `npm run typecheck` — TypeScript strict type check
5. `npm run build` — TypeScript compilation (ES Modules, NodeNext)
6. `npm test` — run all tests (`tsx --test`)

---

## Safety restrictions

- **No secrets in workflow file.** The workflow does not reference `KIMI_API_KEY`, `GITHUB_TOKEN`, or any other secrets.
- **No provider calls.** CI runs only static analysis and local tests.
- **No PR/merge actions.** The workflow does not create, update, close, merge, comment on, or review PRs.
- **No deployment.** The workflow does not deploy to any environment.
- **No auto-merge.** The workflow does not enable or perform auto-merge.

---

## Expected result

After the workflow is pushed to `feature/mvp-skeleton`, GitHub Actions should:

1. Trigger on the next push or PR.
2. Run the `checks` job on `ubuntu-latest`.
3. Execute all six steps successfully.
4. Report:
   - Typecheck: ✅ pass
   - Build: ✅ pass
   - Tests: ✅ pass (1757 tests / 104 suites / 0 failures)

---

## How to verify in GitHub UI

1. Open the repository on GitHub: `https://github.com/Mellowin/AI-orchestrator`
2. Go to the **Actions** tab.
3. Look for a workflow run named **"Mini-MVP CI"**.
4. Click the run to see:
   - Branch name
   - Commit SHA
   - Job list (`checks`)
   - Step-by-step logs
   - Final status (success / failure)

---

## Verification status

> **GitHub CI workflow added; CI pass not yet verified until workflow run completes.**

A follow-up stage will verify the first successful workflow run and update this document with:
- Run ID
- Branch
- Status and conclusion
- Job logs summary

---

## Operator note

- Do not enable auto-merge based on this workflow alone.
- Human review of PR content remains required before merge.
- The workflow is read-only with respect to repository state (no pushes, no merges, no secret uploads).
