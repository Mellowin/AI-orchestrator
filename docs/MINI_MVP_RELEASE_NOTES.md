# Mini-MVP Release Notes

**Branch:** `feature/mvp-skeleton`
**Head:** `c053e7091319c974bfe6f712c1333478f987d733`

---

## MVP capabilities

- Autonomous block execution: read block JSON → coder → apply → checks → commit → reviewer → decision
- Real Kimi coder + real Kimi reviewer with live API calls
- Deterministic safety checks before and after file changes
- Bounded fix-loop with `max_fix_attempts` and global attempt cap
- Multi-task sequential execution with state persistence
- Local commits only; push is disabled by default
- Separate opt-in PR helpers (draft, create, status, cleanup)
- Comprehensive operator documentation and evidence package
- 1739 tests / 102 suites / 0 failures

---

## Stage highlights

### Stage 6.15.2 — Full Multi-Scenario Fix-Loop Matrix Proof

- Scenario A (live): Real Kimi→Kimi with 2 failed attempts before acceptance.
- Scenario B (fake): `max_fix_attempts=2` exhaustion → task blocked.
- Scenario C (fake): `maxTotalAttemptsPerRun=2` global cap → loop stops safely, state resumable.
- Evidence: [`docs/STAGE6_15_2_FULL_FIX_LOOP_MATRIX_PROOF.md`](STAGE6_15_2_FULL_FIX_LOOP_MATRIX_PROOF.md)

### Stage 6.16 — Real Kimi Multi-Task Block with One Fix Loop

- 3-task autonomous block executed end-to-end with real Kimi coder + real Kimi reviewer.
- Task doc-1 accepted on first attempt.
- Task doc-2 went through fix-loop: `pending → checks_failed → accepted`.
- Task doc-3 accepted on first attempt.
- Final block status: `completed`.
- Evidence: [`docs/STAGE6_16_REAL_MULTITASK_BLOCK_PROOF.md`](STAGE6_16_REAL_MULTITASK_BLOCK_PROOF.md)

### Stage 6.17 — Operator-Ready Runbook and Demo Package

- Documentation-only stage.
- Created operator runbook, demo package, command cookbook, and safety invariants.
- Updated README, PHASE4_PLAN, and TESTING_SUMMARY.
- Purpose: package proven MVP so operators can run and verify without prior knowledge.

### Stage 6.22 — GitHub CI Workflow for Mini-MVP Checks

- Added `.github/workflows/ci.yml` with automated typecheck, build, and test on PR/push.
- Runs on `ubuntu-latest` with Node.js 20.
- No secrets, no provider calls, no merge/deployment actions.
- Evidence: `docs/STAGE6_22_GITHUB_CI_WORKFLOW.md`.
- **Status:** Workflow added; CI pass pending first successful run.

### Stage 6.18 — Mini-MVP Release Candidate Audit

- Final release-candidate audit of documentation and evidence package.
- Verified no placeholders remain.
- Verified no raw secrets in docs.
- Verified command cookbook safety.
- Verified stage hashes and proof claims.
- Audit status: **PASS**.

---

## Security and safety notes

- No automatic merge.
- No automatic `main` touch.
- No force push.
- No `git reset --hard`.
- No `git add -A`.
- No GitHub API usage by `block-run`.
- PR helpers are separate, opt-in, and draft-only by default.
- API keys live in environment only; never written to files, logs, or state.
- Secrets are redacted from all reviewer/fix context.

---

## Limitations

- GitHub CI is not verified; workflow runs are empty.
- Demos use small doc/check tasks; large TypeScript refactors are not yet demoed live.
- Real provider behavior varies with API latency, quota, and output quality.
- Check design quality directly impacts fix-loop behavior.
- Push and merge remain manual human decisions.

---

## Next engineering candidates (future work, not done)

1. **Real sandbox isolation hardening** — run block execution inside an isolated container or temp repo copy with stronger guarantees.
2. **CI workflow setup** — enable and verify GitHub Actions workflow runs on `feature/mvp-skeleton`.
3. **Stronger reviewer evidence schema** — structured evidence formats, reviewer accuracy metrics, false accept/reject tracking.
4. **UI / operator dashboard** — web or TUI interface for block status, logs, and human decision points.
5. **Resumable block command UX** — `block-resume`, `block-pause`, and interactive task inspection.
6. **Provider abstraction expansion** — wire Claude, DeepSeek, OpenAI as alternative coders/reviewers.
7. **Real code-edit proof beyond docs/check demos** — autonomous edit of a real TypeScript module with compile + test checks.
