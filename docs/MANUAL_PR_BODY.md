# Mini-MVP Manual PR Body

Ready-to-copy PR body for human review and manual PR creation.

---

## Title

Mini-MVP: AI block runner with Kimi coder/reviewer, checks, fix loop, and operator docs

---

## PR Body

### Summary

This PR contains the mini-MVP of the AI Orchestrator autonomous block execution pipeline. The orchestrator can read a block definition, call a real Kimi coder to generate file changes, run deterministic safety checks, commit locally, and call a real Kimi reviewer to validate the commit. If checks fail or the reviewer requests changes, the system enters a bounded fix-loop and retries the same task with redacted failure context.

### What is included

- Real Kimi coder + real Kimi reviewer autonomous loop
- Deterministic safety checks (guardrails, line deltas, secrets, merge conflicts)
- Bounded fix-loop with max attempts and global cap
- Local commits only (push disabled by default)
- Multi-task block execution
- Operator runbook, demo package, command cookbook, and safety invariants
- Release-candidate audit documentation
- 1739 tests / 102 suites / 0 failures

### Safety model

- No automatic merge.
- No automatic `main` touch.
- No force push.
- No `git reset --hard`.
- No `git add -A`.
- No GitHub API usage by the core block runner.
- PR creation and cleanup helpers are separate, opt-in tools.
- API keys live in environment only; never written to files, logs, or state.

### Proof / evidence

- Stage 6.16 — Real Kimi multi-task block with one fix loop: [`docs/STAGE6_16_REAL_MULTITASK_BLOCK_PROOF.md`](docs/STAGE6_16_REAL_MULTITASK_BLOCK_PROOF.md)
- Stage 6.15.2 — Full multi-scenario fix-loop matrix: [`docs/STAGE6_15_2_FULL_FIX_LOOP_MATRIX_PROOF.md`](docs/STAGE6_15_2_FULL_FIX_LOOP_MATRIX_PROOF.md)
- Stage 6.18 — Release-candidate audit: [`docs/STAGE6_18_RELEASE_CANDIDATE_AUDIT.md`](docs/STAGE6_18_RELEASE_CANDIDATE_AUDIT.md)

### Local verification

```bash
npm run typecheck
npm run build
npm test
```

Results: strict typecheck passes, build produces `dist/`, 1739 tests pass with 0 failures.

### CI status

GitHub CI: **not verified / no workflow runs.**

The repository has a `.github/workflows/ci.yml` workflow definition, but no workflow runs have been executed on this branch. Local test results are the current source of truth.

### What is intentionally not included

- Production-ready cloud sandboxing
- Automatic merge
- Automatic PR creation (helpers exist but are opt-in only)
- Arbitrary large codebase autonomous edits (demos use small doc/check tasks)
- Security certification

### Human review checklist

- [ ] Confirm `npm test` passes locally.
- [ ] Confirm no raw secrets in documentation.
- [ ] Confirm demo commands use `ALLOW_REAL_REPO_PUSH=false`.
- [ ] Confirm no automatic merge language exists.
- [ ] Confirm safety invariants are documented and match code.
- [ ] Confirm no source code or test changes were made in documentation stages.
