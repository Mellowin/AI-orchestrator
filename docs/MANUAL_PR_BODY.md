# Mini-MVP Manual PR Body

Ready-to-copy PR body for human review and manual PR creation.

---

## Title

Mini-MVP AI Orchestrator: block-run, fix-loop, draft PR automation, CI, and readiness gates

---

## PR Body

### Summary

This PR contains the mini-MVP of the AI Orchestrator autonomous block execution pipeline. The orchestrator can read a block definition, call a real Kimi coder to generate file changes, run deterministic safety checks, commit locally, and call a real Kimi reviewer to validate the commit. If checks fail or the reviewer requests changes, the system enters a bounded fix-loop and retries the same task with redacted failure context.

This PR also includes automated PR draft packaging, draft PR creation, PR readiness gates with CI verification, and a GitHub CI workflow.

### What is included

- Real Kimi coder + real Kimi reviewer autonomous loop
- Deterministic safety checks (guardrails, line deltas, secrets, merge conflicts)
- Bounded fix-loop with max attempts and global cap
- Local commits only (push disabled by default)
- Multi-task block execution
- PR draft package generator (`block-pr-draft`)
- Automated draft PR creation (`block-pr-create`)
- PR readiness gate with CI verification (`block-pr-readiness`)
- PR cleanup helper (`block-pr-cleanup`)
- GitHub CI workflow (`.github/workflows/ci.yml`)
- Operator runbook, demo package, command cookbook, and safety invariants
- Release-candidate audit documentation
- 1783 tests / 106 suites / 0 failures

### Safety model

- No automatic merge.
- No automatic `main` touch.
- No force push.
- No `git reset --hard`.
- No `git add -A`.
- No GitHub API usage by the core block runner.
- PR creation, readiness, and cleanup helpers are separate, opt-in, explicitly gated tools.
- API keys live in environment only; never written to files, logs, or state.
- Draft PRs are created in draft state by default.
- Mark-ready requires explicit `ALLOW_GITHUB_MARK_READY=true`.

### Proof / evidence

- Stage 6.16 - Real Kimi multi-task block with one fix loop: [`docs/STAGE6_16_REAL_MULTITASK_BLOCK_PROOF.md`](docs/STAGE6_16_REAL_MULTITASK_BLOCK_PROOF.md)
- Stage 6.15.2 - Full multi-scenario fix-loop matrix: [`docs/STAGE6_15_2_FULL_FIX_LOOP_MATRIX_PROOF.md`](docs/STAGE6_15_2_FULL_FIX_LOOP_MATRIX_PROOF.md)
- Stage 6.18 - Release-candidate audit: [`docs/STAGE6_18_RELEASE_CANDIDATE_AUDIT.md`](docs/STAGE6_18_RELEASE_CANDIDATE_AUDIT.md)
- Stage 6.21 - Real automated draft PR submission proof: [`docs/STAGE6_21_REAL_DRAFT_PR_SUBMISSION_PROOF.md`](docs/STAGE6_21_REAL_DRAFT_PR_SUBMISSION_PROOF.md)
- Stage 6.24 - Live mark-ready proof: [`docs/STAGE6_24_LIVE_MARK_READY_PROOF.md`](docs/STAGE6_24_LIVE_MARK_READY_PROOF.md)
- Stage 6.25 - Proof PR cleanup: [`docs/STAGE6_25_PROOF_PR_CLEANUP.md`](docs/STAGE6_25_PROOF_PR_CLEANUP.md)

### Local verification

```bash
npm run typecheck
npm run build
npm test
```

Results: strict typecheck passes, build produces `dist/`, 1783 tests pass with 0 failures.

### CI status

GitHub CI: **verified successful.**

Mini-MVP CI run `27306283119` completed with `success` on commit `8cab4a10fd41ae402c8286fa8d9a1dbc5ec8bea8`.

### What is intentionally not included

- Production-ready cloud sandboxing
- Automatic merge
- Automatic mark-ready (requires explicit operator opt-in)
- Arbitrary large codebase autonomous edits (demos use small doc/check tasks)
- Security certification

### Human review checklist

- [ ] Confirm `npm test` passes locally.
- [ ] Confirm no raw secrets in documentation.
- [ ] Confirm demo commands use `ALLOW_REAL_REPO_PUSH=false`.
- [ ] Confirm no automatic merge language exists.
- [ ] Confirm safety invariants are documented and match code.
- [ ] Confirm no source code or test changes were made in documentation stages.
