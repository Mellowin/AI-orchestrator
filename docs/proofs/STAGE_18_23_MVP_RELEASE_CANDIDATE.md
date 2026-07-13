# Stage 18.23 — Working One-Click MVP Release Candidate

This document records the release-candidate proof for Stage 18.23.

## Landed product stack

All required product stages were merged into `main` using merge commits.

| PR | Stage | Head SHA | Merge SHA |
|---|---|---|---|
| #10 | Stage 18.18 — CI diagnostics | `1db42ff0509c148a588c371764732db7913b813c` | `29e9e4c` |
| #11 | Stage 18.19 — Autonomous CI observation/repair loop | `5820bb02645f1aeba9a27149adb49631b8279cee` | `1acbbba` |
| #12 | Stage 18.20 — Mission intake and autopilot config generation | `ea67ab2149b74b3b9d93d256ac4d98c2cf73e374` | `bdf09c7` |
| #13 | Stage 18.21 — Raw goal one-click UX | `08605a92fe195cd87eaabbe8fd524b79d2b55283` | `e099a0a` |
| #16 | Stage 18.22 — Real raw-goal one-click proof and fixes | `fb145ab4ee32470eaaa8d0545fd234dbb18d0561` | `8b5ab61` |

PR #15 (`mission-mission-20260709-030137-create-a-docs-proofs`) is a proof-only autopilot-generated PR and was not merged.

- **Final main SHA after landing:** `8b5ab61bf935190c07fa1be34ead0d7750b3f848`
- **Main CI run:** `29236126850` — `success`
- **Release-candidate branch:** `stage-18-23-mvp-release-candidate`

## Release-candidate hardening

- Added `npm run one-click` alias (`tsx src/cli.ts autopilot-one-click`).
- Added `npm run doctor` environment preflight.
- Added `docs/QUICKSTART.md`.
- Refreshed `README.md` top section with one-command safe/real examples and link to QUICKSTART.
- Added targeted tests:
  - `test/cli-doctor.test.ts`
  - `test/one-click-package-script.test.ts`
  - `test/clean-clone-smoke.test.ts`

## Clean-clone safe proof

Commands run from a fresh clone at `C:\tmp\ai-orchestrator-rc`:

```bash
npm ci
npm run typecheck
npm run build
npm run doctor
npm run one-click -- "Add a documentation note proving the clean-clone one-click MVP works" --yes
```

- **Doctor verdict:** `DOCTOR_READY_WITH_CAVEATS` (no tokens present; safe mode ready)
- **Safe run id:** `mission-20260713-122218-add-a-documentation-`
- **Mode:** fake
- **Preset:** safe
- **Plan verdict:** `AUTOPILOT_PLAN_READY_WITH_CAVEATS`
- **Autopilot verdict:** `AUTOPILOT_MVP_DONE_CI_NOT_OBSERVED`
- **One-click final verdict:** `ONE_CLICK_DONE_WITH_CAVEATS`
- **Generated artifacts:**
  - `reports\autopilot-plans\mission-20260713-122218-add-a-documentation-\mission.json`
  - `reports\autopilot-plans\mission-20260713-122218-add-a-documentation-\plan.json`
  - `reports\autopilot-plans\mission-20260713-122218-add-a-documentation-\autopilot.config.json`
  - `reports\autopilot-plans\mission-20260713-122218-add-a-documentation-\mvp-run.config.json`
  - `reports\autopilot-plans\mission-20260713-122218-add-a-documentation-\one-click-report.md`
- **No repository commit or push was performed.**
- **No GitHub write occurred.**

## Clean-clone real proof

After setting `KIMI_API_KEY` and `GITHUB_TOKEN` in the environment:

```bash
npm run doctor
npm run one-click -- \
  "Create docs/proofs/STAGE_18_23_CLEAN_CLONE_REAL.md with a short proof note" \
  --preset real-pr \
  --mode github \
  --repo-slug Mellowin/AI-orchestrator \
  --base-branch main \
  --allowed-files docs/proofs/STAGE_18_23_CLEAN_CLONE_REAL.md \
  --yes
```

- **Doctor verdict with tokens:** `DOCTOR_READY_REAL_REPAIR`
- **Real run id:** `mission-20260713-122228-create-docs-proofs-s`
- **Generated work branch:** `mission-mission-20260713-122228-create-docs-proofs-s`
- **Plan verdict:** `AUTOPILOT_PLAN_READY_WITH_CAVEATS`
- **Autopilot verdict:** `AUTOPILOT_MVP_FAILED`
- **One-click final verdict:** `ONE_CLICK_AUTOPILOT_FAILED`
- **Generated artifacts:**
  - `reports\autopilot-plans\mission-20260713-122228-create-docs-proofs-s\mission.json`
  - `reports\autopilot-plans\mission-20260713-122228-create-docs-proofs-s\plan.json`
  - `reports\autopilot-plans\mission-20260713-122228-create-docs-proofs-s\autopilot.config.json`
  - `reports\autopilot-plans\mission-20260713-122228-create-docs-proofs-s\mvp-run.config.json`
  - `reports\autopilot-plans\mission-20260713-122228-create-docs-proofs-s\one-click-report.md`

### External blocker

The real flow reached the push step and was blocked by the GitHub token permissions:

```
remote: Permission to Mellowin/AI-orchestrator.git denied to Mellowin.
fatal: unable to access 'https://github.com/Mellowin/AI-orchestrator.git/': The requested URL returned error: 403
```

The token lacks `contents: write` permission, so the product cannot push the work branch or create a PR. Because the push failed, the local changes were rolled back and no PR was created.

Steps completed before the blocker:

1. Raw goal intake
2. Mission generation
3. Plan generation
4. Autopilot/MVP config generation
5. Real provider readiness confirmed
6. Guardrails and safety rules loaded
7. Push attempted (blocked)

Steps not reached due to the blocker:

- Remote branch push
- PR creation/detect
- CI observation

## Remaining real product limitations

- Real PR/repair modes require a GitHub token with `contents: write`, `pull_requests: write`, and `actions: read`.
- The tool never merges, force-pushes, reruns workflows, or deletes branches.
- CI observation requires the GitHub token to have `actions: read`.
- Repair mode is bounded; it stops for human review when the root cause is outside the generated plan.

## Overall verdict

`MVP_RC_READY_WITH_EXTERNAL_PERMISSION_CAVEAT` — the one-click MVP is landed in `main`, the release-candidate branch adds the final UX hardening, safe mode works from a clean clone, and real mode reaches the push step. The only blocker is the GitHub token lacking write access to the repository.
