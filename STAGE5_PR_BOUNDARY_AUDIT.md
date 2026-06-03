# Stage 5 PR Boundary Audit

## Current Post-Push Boundary

After `real-repo-run-ai` or `real-repo-run` successfully completes:

- Branch is pushed to `origin`.
- State file `runs/<taskId>/state.json` has `status: "pushed"`.
- **The system stops here.**
- Human must review before any further action.

## What Is Allowed Now

- **`real-repo-approval-report <taskId>`** — generates `runs/<taskId>/approval-report.md` with:
  - task metadata
  - pushed commit SHA
  - diff stat (if available)
  - manual review checklist
  - exact manual commands to inspect the branch
  - hard safety statements
- Read local git metadata (branch, commit, diff) — **read-only**.
- Show manual commands for human execution.

## What Is Still Forbidden

- **No PR creation.** The tool does not open pull requests.
- **No merge.** The tool never merges branches.
- **No checkout/switch.** The tool does not change the current branch.
- **No main touch.** The tool refuses to run if current branch or `work_branch` is `main`.
- **No force push.** The tool never uses `--force`.
- **No GitHub API calls.** No `gh` CLI automation, no REST/GraphQL calls.
- **No automatic approval.** Human review is mandatory.

## Command Reference

```bash
# Generate approval report after successful push
export ALLOW_REAL_REPO_APPROVAL_REPORT=true
npx tsx src/cli.ts real-repo-approval-report <taskId>
```

Report location: `runs/<taskId>/approval-report.md`

## Stage 5.6 — PR Readiness / Dry-Run Stub

- **Command:** `real-repo-pr-readiness <taskId>`
- **Requires:** `ALLOW_REAL_REPO_PR_READINESS=true`
- **Requires:** `runs/<taskId>/approval-report.md` exists
- **Produces:**
  - `runs/<taskId>/pr-readiness.md` — full PR readiness report
  - `runs/<taskId>/pr-body.md` — suggested PR body text
- **Includes:** PR title suggestion, manual `gh pr create` command as text only, diff summary
- **Does NOT:** create PR, call GitHub API, execute `gh`, merge, checkout, push, call provider

## Stage 5.7 — Real PR Creation

- **Command:** `real-repo-pr-create <taskId>`
- **Requires:** `ALLOW_GITHUB_PR_CREATE=true`
- **Requires:** `GITHUB_TOKEN`
- **Requires:** `GITHUB_REPOSITORY` in `owner/repo` format
- **Requires:** prior `approval-report.md`, `pr-readiness.md`, `pr-body.md`
- **Requires:** pushed state (`status: pushed`)
- **Calls:** GitHub REST API `POST /repos/{owner}/{repo}/pulls`
- **Produces:** `runs/<taskId>/pr-created.json` with PR metadata
- **Does NOT:** merge, auto-merge, checkout/switch, push, call provider, execute `gh`

## Stage 5.8 — PR Status / Checks Read-Only Report

- **Command:** `real-repo-pr-status <taskId>`
- **Requires:** `ALLOW_GITHUB_PR_STATUS=true`
- **Requires:** `GITHUB_TOKEN`, `GITHUB_REPOSITORY`
- **Requires:** prior `pr-created.json` (from Stage 5.7)
- **Calls:** GitHub REST API read-only GET:
  - `/repos/{owner}/{repo}/pulls/{number}`
  - `/repos/{owner}/{repo}/commits/{sha}/status`
  - `/repos/{owner}/{repo}/commits/{sha}/check-runs`
- **Produces:**
  - `runs/<taskId>/pr-status-report.md` — human-readable report with PR state, checks summary, next-step guidance
  - `runs/<taskId>/pr-status.json` — machine-readable status snapshot
- **Does NOT:** create PR, update PR, comment, approve, merge, auto-merge, checkout/switch, push, call provider, execute `gh`

## Stage 5.9 — MVP Hardening / Final Documentation

- **Status:** Documentation finalized.
- **No new code or tests.** Pure documentation stage.
- **Created:**
  - `MVP_FINAL_REPORT.md` — MVP status, verified pipeline, demo proof, safety boundaries, known limitations.
  - `COMMAND_REFERENCE.md` — all real-repo commands with env, outputs, safety notes.
  - `SAFETY_MODEL.md` — opt-in gates, git policy, provider/GitHub API policy, human boundary.
- **Updated:**
  - `README.md` — MVP overview, pipeline diagram, quick links.
  - `PHASE4_PLAN.md` — Stage 5.9 marked complete.
  - `TESTING_SUMMARY.md` — docs rules for commit hash accuracy.
  - `STAGE5_PR_BOUNDARY_AUDIT.md` — this section.

## Future Possible Stage 6

- Architecture refactor / merge safety design.
- Merge must not be added without dedicated safety design document.
- Still **no merge** until Stage 6 is explicitly designed.
- Still **no main touch**.
- Still **no automatic checkout/switch**.

- Controlled merge only after explicit separate design document.
- Merge would require its own opt-in flag, safety checks, and human confirmation.
- **Not now.**

## Safety Chain Summary

```
Provider call → Apply → Checks → Commit → Push → Approval Report → STOP
                                              ↑
                                       Human decides:
                                       - open PR manually
                                       - review & merge manually
                                       - reject & delete branch
```

The approval report is the **final automated output**. Everything after it is human responsibility.
