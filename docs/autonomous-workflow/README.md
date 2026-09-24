# Autonomous Multitask Workflow — Documentation Entry Point

This directory documents the autonomous multitask workflow: a one-click
command that turns a plain-language goal into a reviewed, validated pull
request, without ever touching `main`, without destructive git operations,
and without ever letting the model override a deterministic safety gate.

## Documents

The documentation is organized as four numbered documents. They build on
each other in order, but each stands alone:

1. **[01 — One-Click Launch](01-one-click.md)** — The canonical entry point.
   The `autopilot-one-click` command (`npx tsx src/cli.ts autopilot-one-click
   "<goal>" --repo owner/repo`), its exact flag set, the three accepted
   `--repo` forms (slug, GitHub URL, local path), automatic repository
   bootstrap into an isolated mission workspace (github mode), base branch
   resolution order, mission branch naming (`autopilot-<runId>`), and the
   durable one-time setup (`GITHUB_TOKEN`, `KIMI_API_KEY`, a way to clone).
   Covers confirmation/`--yes` semantics, fail-closed `--resume` rules for
   raw goals (original `--run-id` required), the hard forbidden-capability
   list (`github.merge`, `git.force_push`, `github.actions.rerun`,
   `repo.delete_branch`), and where reports land
   (`reports/autopilot-plans/<run_id>/`).

2. **[02 — Task Lifecycle](02-task-lifecycle.md)** — How a single task moves
   from `pending` to `accepted` (or a terminal failure state). DAG
   scheduling with transitive `skipped` marking on failed dependencies,
   `task_base_sha` pinning, candidate workspace creation (never the user's
   checkout), coder execution bounded by per-task file guardrails, checks,
   the committed-task reviewer gate (deterministic evidence built from real
   git commands first, then the reviewer model), the fix loop
   (`fixed_and_accepted`, `fix_commit_sha`), one commit per accepted task
   (`mission_commits` from `git log <base>..<head>`), and mission-scoped
   push — never per-task, never force. Also covers the mission-level gates
   that wrap every task (all-required-accepted, integrated validation,
   mission final review, PR/CI stages) and atomic state persistence to
   `multitask-mission-state.json`.

3. **[03 — Review and Recovery](03-review-and-recovery.md)** — The
   reviewer/fix loop, dependency evidence, and crash/resume reconciliation.
   Every review is deterministic-first: the model is never consulted on a
   deterministic failure, and a model "approve" is overridden to `rejected`
   whenever gaps or unauthorized files exist. Covers the per-task
   deterministic checks (SHA validity, allowed/denied files, clean tree,
   no-secret patterns, no conflict markers), the bounded mission
   finalization-repair loop (`REPAIRABLE_REPOSITORY_FAILURE` vs.
   `EXTERNAL_BLOCKER`), rollback of rejected commits (local
   `git revert --no-edit`, newest first), read-only dependency evidence from
   accepted ancestor tasks (`buildMissionDependencyEvidence`), and the
   strict fail-closed resume order: identity checks (plan hash, base SHA),
   terminal-result replay, ancestry gate (`isAncestor` on every accepted
   commit), stage-aware re-entry, and concrete `next_human_action` /
   `resume_command` output for paused verdicts.

4. **[04 — Safety Model](04-safety-model.md)** — The boundary between
   **hard safety** (fail-closed invariants enforced by deterministic code,
   never overridable by the model) and **advisory policy** (signals that
   guide reviewability, not security boundaries). Hard safety includes
   deny-by-default capability flags, multi-layer `main` branch protection,
   path safety (no absolute paths, `..`, or backslashes; content-level
   dangerous-path rejection), denied paths (`.env`, `.git`, `node_modules`,
   protected workflow files), secret-exfiltration scanning with redacted
   output, and test-weakening detection (no `.only`/`.skip`, no neutered
   assertions, no CI failure-suppression). Advisory policy covers
   `max_lines_changed` and size budgets: surface overruns to a human with
   an explanation, never silently enforce an estimate as if it were safety.
   Ends at the human boundary: no merge, no auto-merge, no branch deletion —
   the human decides.

## The complete workflow at a glance

```
Goal (plain language)
  │
  ▼
[01] autopilot-one-click ── parse goal ── build mission (default preset
  │    real-multitask) ── clone repo into isolated workspace (github mode)
  │    ── resolve base branch ── create work branch autopilot-<runId>
  │    ── plan tasks (autopilot-plan)
  ▼
[02] Multitask mission runner ── per task, in DAG order:
  │      schedule → pin task_base_sha → candidate workspace → coder →
  │      checks → reviewer gate ──┬─ approve → accepted (commit recorded)
  │                               └─ needs-changes → fix loop →
  │                                  fixed_and_accepted, else
  │                                  failed/blocked/needs_human
  │                                  (descendants skipped, commits reverted)
  ▼
[03] Mission-level gates ── all-required-accepted → integrated validation
  │    (bounded finalization-repair loop) → mission final review
  │    (deterministic gaps/unauthorized files override model approval;
  │    rejection → local rollback, newest first)
  ▼
[01/02] Create PR → observe CI (bounded ci_repair) → status report
  │
  ▼
[04] STOP. Human authority: merge, reject, request changes, or clean up.
     No merge, no force push, no branch deletion, ever.
```

Pause/resume runs across the whole flow: provider or git-auth interruptions
pause the mission resumably with zero wasted provider calls, state is saved
atomically at every stage, and `--resume --run-id <id>` re-enters at the
last persisted stage after plan-hash, base-SHA, and commit-ancestry
validation — accepted work is never re-executed.

## Where to start

- **Just want to run it?** Read [01 — One-Click Launch](01-one-click.md).
- **Want to understand what happens to each task?** Read
  [02 — Task Lifecycle](02-task-lifecycle.md).
- **Want to trust the review and recovery guarantees?** Read
  [03 — Review and Recovery](03-review-and-recovery.md).
- **Want to know what can and cannot happen?** Read
  [04 — Safety Model](04-safety-model.md).
