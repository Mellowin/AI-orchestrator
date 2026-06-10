# Stage 6.15.2 — Full Multi-Scenario Fix-Loop Matrix Proof

**Date:** 2026-06-09
**Branch:** `feature/mvp-skeleton`
**Setup commit:** `fa30b62bf2822c9c91101131ecc2dc18b69e0ab5`

---

## Scenario A — Real Kimi→Kimi multiple retries before success

### Setup

- **Block ID:** `stage-6-15-2-multi-retry-proof`
- **Mode:** `real_kimi_coder_kimi_reviewer`
- **Verifier:** `checks/stage-6-15-2-multi-retry-verify.mjs`
- **Max fix attempts:** 3
- **Phased verifier:** uses temp state file in `os.tmpdir()` to track fix phases
  - Phase 0: require file, fail if `FIRST_FIX_MARKER` present, request it
  - Phase 1: require `FIRST_FIX_MARKER`, fail if `SECOND_FIX_MARKER` present early, request it
  - Phase 2: require both markers + final markers, pass

### Execution

```text
Task doc-1: pending → checks_failed   (initial attempt, no FIRST_FIX_MARKER)
Task doc-1: checks_failed → checks_failed  (fix attempt 1, FIRST_FIX_MARKER added, no SECOND_FIX_MARKER yet)
Task doc-1: checks_failed → accepted   (fix attempt 2, both markers added, checks pass, reviewer accepts)
```

### Result

| Metric | Value |
|--------|-------|
| Final block status | `completed` |
| Final task status | `accepted` |
| Fix attempts | `2` |
| Current attempt | `3` |
| Reviewer decision | `accepted` |
| Commit SHA | `ff9ac654296c9774c1ec0aef24b964f8027e3fcc` |
| Pushed | `false` |

### Reviewer summary

> "The previous failure requested SECOND_FIX_MARKER for fix phase 2, and the diff shows it has been added exactly as requested alongside the previously required FIRST_FIX_MARKER."

### Proof file

`docs/live-stage-6-15-2-multi-retry-proof.md` contains:
- `Stage 6.15.2`
- `FULL_FIX_LOOP_MATRIX`
- `KIMI_CODER`
- `KIMI_REVIEWER`
- `FINAL_ACCEPTED`
- `## Multi-Retry Evidence`
- `FIRST_FIX_MARKER`
- `SECOND_FIX_MARKER`

---

## Scenario B — max_fix_attempts exhaustion (fake block-run)

### Setup

- **Block ID:** `stage-6-15-2-max-fix-blocking-proof`
- **Mode:** `fake`
- **Max fix attempts:** 2
- **Max total attempts:** 10
- **Fake reviewer:** always `rejected` with `send_fix_to_coder`

### Execution

Run via `tmp/run-scenario-b.mjs` (direct `runMultiTaskFakeLoop` call with configured fake options).

```text
Attempt 1: pending → fix_required (reviewer rejected)
Attempt 2: fix_required → blocked (max_fix_attempts reached)
```

### Result

| Metric | Value |
|--------|-------|
| Final block status | `blocked` |
| Final task status | `blocked` |
| Fix attempts | `2` |
| Max fix attempts | `2` |
| Task blocked | `1` |
| No infinite loop | ✅ |

---

## Scenario C — maxTotalAttemptsPerRun global cap (fake block-run)

### Setup

- **Block ID:** `stage-6-15-2-global-cap-proof`
- **Mode:** `fake`
- **Max fix attempts:** 5
- **Max total attempts:** 2
- **Fake reviewer:** always `rejected` with `send_fix_to_coder`

### Execution

Run via `tmp/run-scenario-c.mjs` (direct `runMultiTaskFakeLoop` call with configured fake options).

```text
Attempt 1: pending → fix_required (reviewer rejected)
Attempt 2: fix_required → checks_failed (guardrails on default fake file, cap reached)
Loop stopped by global cap
```

### Result

| Metric | Value |
|--------|-------|
| Final block status | `fixing` |
| Task status | `checks_failed` |
| Fix attempts | `2` |
| Max fix attempts | `5` (not reached) |
| Global cap reached | `2` attempts |
| Safety finding | `Stopped after 2 total attempts (maxTotalAttemptsPerRun reached)` |
| No infinite loop | ✅ |
| State resumable | ✅ (`current_task_id: doc-1`, status `checks_failed`) |

---

## Matrix summary

| Scenario | Proved | Live / Fake | Key result |
|----------|--------|-------------|------------|
| A — Multiple retries before success | ✅ | Live (real Kimi) | 2 failed attempts → accepted |
| B — max_fix_attempts exhaustion | ✅ | Fake (direct API) | Blocked at max attempts |
| C — Global cap stops loop | ✅ | Fake (direct API) | Stopped safely at cap, state resumable |

---

## Safety confirmations

| Check | Result |
|-------|--------|
| No PR created | ✅ |
| No GitHub API call | ✅ |
| No merge | ✅ |
| No auto-merge | ✅ |
| No `main` touch | ✅ |
| No checkout/switch by orchestrator | ✅ |
| No force push | ✅ |
| No `git reset --hard` | ✅ |
| No `git add -A` | ✅ |
| No token/API key leak | ✅ |
| Push disabled (`ALLOW_REAL_REPO_PUSH=false`) | ✅ |
| Source code unchanged for scenarios B/C | ✅ (used direct API scripts in `tmp/`) |

---

## Files created

| File | Purpose |
|------|---------|
| `docs/live-stage-6-15-2-multi-retry-proof.md` | Scenario A live proof artifact |
| `docs/live-stage-6-15-2-multi-retry-block.json` | Scenario A block definition |
| `checks/stage-6-15-2-multi-retry-verify.mjs` | Scenario A phased verifier |
| `docs/live-stage-6-15-2-blocking-block.json` | Scenario B block definition |
| `checks/stage-6-15-2-blocking-verify.mjs` | Scenario B always-fail verifier |
| `docs/live-stage-6-15-2-cap-block.json` | Scenario C block definition |
| `checks/stage-6-15-2-cap-verify.mjs` | Scenario C always-fail verifier |
| `tmp/run-scenario-b.mjs` | Scenario B runner script |
| `tmp/run-scenario-c.mjs` | Scenario C runner script |
