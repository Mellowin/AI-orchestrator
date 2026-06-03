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

## Future Possible Stage 5.6

- PR creation **readiness** command (dry-run / stub).
- GitHub API opt-in flag (separate from push opt-in).
- Still **no auto-merge**.

## Future Possible Stage 6

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
