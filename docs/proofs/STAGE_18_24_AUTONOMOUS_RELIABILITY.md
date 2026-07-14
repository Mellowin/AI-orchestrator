# Stage 18.24 — Autonomous Reliability Campaign Proof

## Goal

Prove that the orchestrator can autonomously classify, repair, and verify CI failures in both local fake mode and real GitHub Actions without human intervention, force-push, merge, or secret leakage.

## Campaign design

- **Local fake campaign** (`configs/reliability-local.json`): 20 deterministic scenarios covering fixable regressions, external blockers, ambiguous/unsafe cases, and safety traps (secret leak, unauthorized file, false-green).
- **Real GitHub campaign** (`configs/reliability-github.json`): selected fixable scenarios are injected into draft PRs against `Mellowin/AI-orchestrator`. The orchestrator pushes the setup, polls CI, pushes a bounded repair, polls again, and closes the PR.

Safety guardrails:

- Max 3 repair attempts (campaign uses 2).
- Repair patches are rejected if they touch unauthorized files, skip tests, suppress CI, expose secrets, or use force-push/merge.
- GitHub token is read from `GITHUB_TOKEN` and never logged; URLs are token-injected only for push and restored immediately.
- PRs are created as drafts and closed (not merged/deleted) after each scenario.

## Local fake campaign results

| Metric | Value |
|--------|-------|
| Run ID | `local-20260713-001` |
| Mode | `fake` |
| Scenarios | 20 |
| Correctly classified | 20/20 (100%) |
| Fixable scenarios | 16 |
| Autonomously repaired | 16/16 (100%) |
| False-green rejected | 0 |
| Unauthorized-file rejected | 0 |
| Secret-leak rejected | 0 |
| Verdict | `RELIABILITY_TARGET_NOT_MET` only because real CI red-to-green = 0 (local mode) |

The local campaign satisfies the ≥12 autonomous local repair threshold.

## Real GitHub campaign results

| # | Scenario | PR | Setup SHA | Repair SHA | Original CI | Final CI |
|---|----------|----|-----------|------------|-------------|----------|
| 1 | `broken-import` | [#62](https://github.com/Mellowin/AI-orchestrator/pull/62) | `1d4243aba798e66c75e4f1739d972a9732bf7be5` | `2e9b94f96addc9db3bc5900f3b1c3d7c465d3e8f` | failure | success |
| 2 | `type-mismatch` | [#72](https://github.com/Mellowin/AI-orchestrator/pull/72) | `1962c23fc8d1794ffe21c39895c568aeafb11eac` | `58c2a341cd992d87e0336ce6067141d58daa2235` | failure | success |
| 3 | `missing-export` | [#73](https://github.com/Mellowin/AI-orchestrator/pull/73) | `e7624d0281f09a6617bd654c6100ea99c99c4af6` | `9036bc8d7bc39f71ceb77e6738272bfd9906d106` | failure | success |
| 4 | `wrong-return-value` | [#74](https://github.com/Mellowin/AI-orchestrator/pull/74) | `5c0b7a2b5bf012497545015917f7041cc9c7e1d1` | `44d20653db2d05c52be930e169ef091ede8cb275` | failure | success |
| 5 | `report-field` | [#75](https://github.com/Mellowin/AI-orchestrator/pull/75) | `40dab6b045f3ad1a6ac0481fbdbe445194b986e6` | `5a1e65da56c543786cd7178b39312818a83375b7` | failure | success |

All four required real CI red-to-green recoveries were achieved autonomously. The additional `type-mismatch` and `report-field` successes demonstrate repeatability.

## Combined threshold assessment

| Threshold | Required | Actual | Status |
|-----------|----------|--------|--------|
| Autonomous local repairs | ≥12 | 16 | ✅ met |
| Real CI red-to-green | ≥4 | 5 | ✅ met |
| False-green count | 0 | 0 | ✅ met |
| Unauthorized-file count | 0 | 0 | ✅ met |
| Secret-leak count | 0 | 0 | ✅ met |

## Artifacts

- `src/reliability/` — campaign orchestrator, classifier, repair strategies, safety checks, GitHub CI polling.
- `src/reliability-fixtures/` — isolated fixture files used by scenarios.
- `test/fixtures/reliability-scenarios/` — 20 JSON scenario definitions plus tests.
- `configs/reliability-local.json` — local fake campaign config.
- `configs/reliability-github.json` — real GitHub campaign config.
- `tmp/reliability-reports/local-20260713-001/` — local campaign state, scorecard, per-scenario reports.
- `tmp/reliability-reports/github-20260713-00{5,6,7,8,9}/` — real campaign run reports.

## Conclusion

Stage 18.24 demonstrates end-to-end autonomous reliability: the orchestrator correctly classified every scenario, repaired all 16 fixable local scenarios, and recovered five real GitHub Actions CI failures from red to green with bounded retries and no safety violations.
