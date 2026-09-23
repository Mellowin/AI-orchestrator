# Autonomous Workflow Documentation

This directory documents the autonomous multitask mission workflow: how a single command launches a mission, how each task inside it is executed and reviewed, how mission-level review and crash recovery keep accepted work safe, and which safety rules are hard boundaries versus advisory policy.

The documentation is grounded in the behavior implemented in `src/cli.ts`, `src/autopilot-one-click/` (including `multitask/`), `src/block/`, and `src/reviewer/`.

## End-to-end workflow at a glance

```text
one command (goal + --repo)
  -> workspace bootstrap (isolated clone, base-branch detection, mission branch mission-<run_id>)
  -> plan tasks in dependency order
  -> per task: pin task_base_sha -> coder -> staging + deterministic checks -> reviewer gate
       -> bounded fix loop -> accepted / fixed_and_accepted -> single commit
  -> integrated validation + mission-level final review (deterministic gaps gate the model)
  -> rollback of rejected work; push work branch; draft PR; CI observation
  -> STOP: the human decides whether to merge
```

Provider outages and git-auth failures pause the mission resumably at any point; `--resume` replays accepted work from persisted state without consuming new AI calls.

## Documents

### 1. [One-Click Autonomous Multitask Workflow](01-one-click.md)

How to launch a mission from a single command. Covers:

- The canonical command (`npx tsx src/cli.ts autopilot-one-click "<goal>" --repo owner/repo`) and its npm script equivalents.
- The three `--repo` forms (`owner/repo` slug, GitHub URL, local git path) and the automatic bootstrap of an isolated execution workspace via clone.
- Base branch auto-detection (`origin/HEAD` symbolic ref, then `git remote show origin`, then `main`) and creation of the mission work branch `mission-<run_id>`.
- One-time environment credentials (`KIMI_API_KEY`, `GITHUB_TOKEN`, `OPENAI_API_KEY`) and the non-mutating git write-auth preflight that pauses resumably with zero provider calls consumed if the token cannot push.
- Capability presets (`safe`, `multitask-safe`, `read-ci`, `real-pr`, `real-repair`, `real-multitask` — the default for raw goals, which auto-enables `--yes`).
- Run ids, report layout under `<output-dir>/<run_id>/`, pause/resume semantics, and the full flags reference.

### 2. [Task Lifecycle](02-task-lifecycle.md)

The lifecycle of a single task inside a mission, from pinned base commit to accepted commit:

- `task_base_sha` pinning per task (and ancestry validation on resume) so every task is a reproducible diff from a known commit.
- The isolated candidate workspace, the structured coder input (`allowed_files`/`denied_files` guardrails with `auto_commit`/`auto_push`/`auto_merge` disabled), and mode-dependent provider selection.
- Staging with path-traversal rejection, scope enforcement (`assertNoUnrelatedChanges`), and plan-defined deterministic checks.
- The two-layer reviewer gate: deterministic checks first (severe safety findings block for a human without any AI call), then the schema-validated reviewer provider.
- The bounded fix loop (`FixContext`, `fixed_and_accepted` with `fix_commit_sha`), the full task status taxonomy, rollback of rejected task commits via `git revert --no-edit`, and the mission-level, capability-gated push.
- How each transition is persisted in `multitask-mission-state.json` so the flow is resumable.

### 3. [Review, Recovery, and Resume](03-review-and-recovery.md)

What happens after all tasks finish, and how crashes are survived:

- The mission-level final review: mandatory deterministic gap computation (unauthorized files from the integrated diff, acceptance gaps), dependency evidence build, reviewer call or deterministic fallback, and the deterministic gate that downgrades any model approval when gaps exist — model approval is not a security boundary.
- Real reviewer providers: OpenAI first (`OPENAI_API_KEY`, `gpt-4o` default), Kimi fallback (`KIMI_API_KEY`), retry-wrapped with timeouts, secrets redacted from errors; reviewer failures map to clean `needs_human` / `external_blocker` verdicts.
- Dependency evidence: accepted-only, content-addressed (`content_sha256`, bytes, lines), bounded with truncation markers, and read-only by contract.
- Accepted-only history: rollback of rejected task commits and full mission-level rollback over the tracked `mission_commits` set, newest first, with `rolled_back_commits` preventing double-reverts.
- Crash/resume reconciliation: atomic state writes, defensive loads, canonicalized plan hash, identity gates (plan hash, base SHA), accepted-commit ancestry checks, stage-aware re-entry that skips already-completed stages, and resumable pause verdicts with printed resume commands.

### 4. [Safety Model: Hard Safety vs Advisory Policy](04-safety-model.md)

The two-tier rule system that governs everything above:

- **Hard safety invariants** — deterministic, non-overridable boundaries: main protection (work only on `mission-<run_id>`; no merge, force-push, reset, or rebase; `git checkout` only for the one-time work-branch creation), path safety (no absolute paths, `..` traversal, or backslashes; allow/deny list enforcement), sensitive-file and secret protections (denied paths, diff secret scanning, redaction, no credential persistence), test/CI-weakening blocks, and deny-by-default opt-in capability flags checked before any git or filesystem call.
- **Advisory policy** — non-binding guidance: the `max_lines_changed` size budget (a planning estimate, never a reason to weaken correctness), preferring tests with changes, justifying `any` casts, and keeping commits scoped.
- A summary table assigning each rule to its tier, and the human boundary: the system never merges, never force-pushes, and never deletes branches — after the PR and CI are reported, the human decides.

## Reading order

Read the documents in numeric order. Each builds on the previous: document 01 explains how a mission starts, 02 what each task does, 03 how the mission is reviewed and recovered, and 04 why the boundaries enforced throughout are trustworthy.

## The core invariant

Only reviewed, accepted, in-scope commits ever survive on the mission branch — and no crash, resume, or model decision can smuggle in work that was never accepted.
