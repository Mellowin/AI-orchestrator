# Autonomous Workflow — Documentation Entry Point

This directory documents the autonomous multitask AI Orchestrator end to end, grounded in the actual implementation (`src/cli.ts`, `src/autopilot-one-click/`, `src/reviewer/`, `src/ai-safety-policy.ts`, `src/guardrails.ts`). Read the documents in order; each builds on the previous ones.

## The full workflow at a glance

```
  one-click launch (goal or mission JSON, env-var credentials only)
        |
        v
  repo bootstrap + base-branch resolution + mission branch mission-<run_id>
        |
        v
  plan generation (immutable plan snapshot persisted for resume)
        |
        v
  +---------------------- per task ----------------------------------+
  | task_base_sha -> candidate workspace (allowed_files only)        |
  |   -> coder -> staging + checks -> deterministic reviewer gate    |
  |   -> model reviewer -> fix loop (fix_commit_sha) -> acceptance   |
  |      (commit_sha on mission branch; task never pushes)           |
  +------------------------------------------------------------------+
        |
        v
  integrated validation -> finalization repair (REPAIRABLE only)
        |
        v
  mission final review (deterministic gate overrides the model)
        |   \-- rejection -> local rollback of mission commits (never pushed)
        v
  push branch -> create/update PR -> observe CI

  pause (provider/git-auth) -> fix external cause -> rerun with --resume
  (plan hash, base SHA, and accepted-commit ancestry re-verified first)
```

## Documents

### [01 — Canonical One-Click Launch](01-one-click.md)

How to launch a mission with a single command (`npx tsx src/cli.ts autopilot-one-click "<goal>" --preset real-multitask --repo owner/repo`, or a prepared mission JSON). Covers the only one-time configuration (env-var credentials: `KIMI_API_KEY` for real providers, `GITHUB_TOKEN` for github-mode push/PR/CI), the three accepted `--repo` forms (slug, GitHub URL, local path), automatic repo bootstrap into an isolated workspace, base-branch resolution order, mission branch naming (`mission-<run_id>`), presets and the `--yes` confirmation rule (`real-multitask` auto-confirms; other remote-write presets require it), the non-mutating git write-auth preflight that runs before any provider call, and resume semantics (same command plus `--resume` and the original `--run-id`; the persisted plan snapshot is reused with zero planner calls).

### [02 — Lifecycle of a Single Task](02-task-lifecycle.md)

What happens to one task inside a mission. Traces the states (`pending → running → accepted | fixed_and_accepted | failed | blocked | needs_human | paused_provider | paused_git_auth`, plus `skipped` / `skipped_safe_mode`) through the lifecycle steps: per-task `task_base_sha` resolution, the isolated candidate workspace confined to `allowed_files`, the coder (with read-only dependency evidence from accepted ancestors), staging/checks/budget enforcement, the reviewer (deterministic gate overrides model approval), the fix loop (fix commits recorded as `fix_commit_sha`), and terminal acceptance as individual commits on the mission branch. Tasks never push: push happens only at mission level after all required tasks are accepted, integrated validation, and final review. Includes failure/skip semantics and per-task invariants.

### [03 — Reviewer/Fix Loop, Dependency Evidence, and Crash/Resume Reconciliation](03-review-and-recovery.md)

How review and recovery actually work. Details the reviewer gate order (deterministic checks first — scope, secrets, clean tree, not on `main`; severe findings block for a human without any model call; the schema-validated model reviewer runs only after both deterministic layers pass), the mission-level final review (`computeMandatoryGaps` rejects unauthorized files and unaccepted tasks; `buildGateRejectedReview` overrides a model "approved" verdict), authorized finalization maintenance (repair only for `REPAIRABLE_REPOSITORY_FAILURE`, files restricted to validator-approved maintenance files, fail-closed otherwise), the read-only `DependencyEvidencePackage` built exclusively from accepted ancestor artifacts, the accepted-only branch history (tracked newest-first reverts, no double-rollback, rollback stays local), and crash/resume reconciliation (fail-closed plan-hash and base-SHA identity checks, accepted-commit ancestry verification via `git merge-base --is-ancestor`, terminal-result replay, stage-aware continuation without repeated provider calls).

### [04 — Safety Model: Hard Safety vs. Advisory Quality Policy](04-safety-model.md)

The distinction between the two kinds of rules. **Hard safety** — enforced by deterministic code, fails closed, never waivable by any flag or model verdict: `main` protection (no checkout/commit/merge; plain push only; no force push or `reset --hard`), path safety (writes only within `allowed_files`, `denied_files` rejected, no traversal or repo escape), sensitive files and secrets (`.env`/`.git`/`node_modules` always denied, secret-exfiltration and secret-in-diff scanning, redaction, keys only in env vars), and test weakening (no `.only`/`.skip`, gutted assertions, or `continue-on-error`). **Advisory quality policy** — `max_lines_changed` is a planning estimate and review signal, never a hard limit: correctness and safety must never be compromised to fit it, and legitimate larger changes are made with an explanatory note. Includes the hard-vs-advisory summary table.

## Key invariants (across all documents)

1. The deterministic gate — never the model — is the final authority on scope, secrets, branch protection, acceptance, and maintenance authorization.
2. `main` is never touched; rollback is local; push/PR/CI happen only after final-review approval; the human retains the final merge decision.
3. Dependency evidence is read-only and comes exclusively from accepted ancestor tasks; a task's `allowed_files` is its only writable scope.
4. Every resume re-verifies plan hash, base SHA, and accepted-commit ancestry before trusting persisted state.
5. `max_lines_changed` is advisory only — never a hard limit and never a reason to compromise correctness or safety.
