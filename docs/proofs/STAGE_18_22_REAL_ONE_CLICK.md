# Stage 18.22 — Real Raw-Goal One-Click Proof

This document records the real-mode proof of the raw-goal one-click autopilot.

## Command used

```bash
npx tsx src/cli.ts autopilot-one-click \
  "Create a docs/proofs note that real raw-goal one-click works" \
  --preset real-pr \
  --mode github \
  --repo-slug Mellowin/AI-orchestrator \
  --repo-path tmp/stage-18-22-repo \
  --base-branch stage-18-21-raw-goal-one-click-ux \
  --yes
```

No tokens are shown in this document.

## Run metadata

- **Run id:** `mission-20260709-030137-create-a-docs-proofs`
- **Generated plan:** `reports/autopilot-one-click/mission-20260709-030137-create-a-docs-proofs/plan.json`
- **Generated autopilot config:** `reports/autopilot-one-click/mission-20260709-030137-create-a-docs-proofs/autopilot.config.json`
- **Generated MVP config:** `reports/autopilot-one-click/mission-20260709-030137-create-a-docs-proofs/mvp-run.config.json`
- **Plan verdict:** `AUTOPILOT_PLAN_READY_WITH_CAVEATS`
- **MVP verdict:** `MVP_RUN_PASSED`
- **Branch created by autopilot:** `mission-mission-20260709-030137-create-a-docs-proofs`
- **Commit created by autopilot:** `a31db1339450e8e12cd5ed1939b98be5d41a41f3`
- **PR created/detected by autopilot:** https://github.com/Mellowin/AI-orchestrator/pull/15
- **CI workflow run id:** `28984214150`
- **CI workflow name:** `Mini-MVP CI`
- **CI status:** `completed`/`failure`
- **Files changed by the autopilot proof:** `docs/proofs/STAGE_18_22_REAL_ONE_CLICK.md`

## What was verified automatically

1. Raw goal accepted and parsed into a mission with `preset=real-pr`, `mode=github`.
2. `autopilot-plan` generated a single-task plan targeting only `docs/proofs/STAGE_18_22_REAL_ONE_CLICK.md`.
3. `autopilot-run` executed the plan through `mvp-run` with real Kimi provider.
4. The real provider produced the marker file content.
5. Guardrails allowed only the permitted file.
6. Local checks passed.
7. A commit was created and pushed to the work branch on GitHub.
8. A draft PR was opened from the work branch to the base branch.
9. CI was triggered and completed; the failure was caused by the `TESTING_SUMMARY.md` lock pointing to an older commit than the PR head (expected before the Stage 18.22 summary refresh).

## Caveats and limitations

- The interactive shell timeout (300 s) interrupted the command while `autopilot-run` was polling for the CI workflow run, so the CLI did not print a final `ONE_CLICK_DONE*` verdict. The preceding stages all succeeded and the PR exists.
- The CI workflow run concluded `failure` because `TESTING_SUMMARY.md` listed a `Last verified commit` that was not an ancestor of the PR head (the PR added new code and the proof doc, but not the summary refresh). This is addressed by the Stage 18.22 summary update commit.
- The proof was run against a disposable clone (`tmp/stage-18-22-repo`) so the working branch in the orchestrator repo itself was not modified by the real run.

## Verdict

`REAL_RAW_GOAL_ONE_CLICK_READY_WITH_CAVEATS` — the real raw-goal one-click path created a mission, plan, commit, branch, push, and PR. CI observation completed; the failure is attributable to the expected TESTING_SUMMARY lock mismatch before the stage summary refresh.
