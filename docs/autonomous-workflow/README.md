# Autonomous Workflow

This directory documents the end-to-end autonomous workflow: from a one-click
launch, through the per-task lifecycle and review/fix machinery, to the safety
model that bounds everything. Each document is grounded in the actual code and
describes only commands, flags, and behaviors that exist.

## Documents

| Document | What it covers |
|---|---|
| [01 — Canonical One-Click Launch](./01-one-click.md) | The `autopilot-one-click` command, its real flags, presets and capabilities, repo targeting (`--repo-slug` / `--repo-path`), automatic bootstrap, branch naming, one-time operator setup (tokens, clone), and one-click verdicts / exit codes. |
| [02 — Single Task Lifecycle](./02-task-lifecycle.md) | The multitask mission runner: base-SHA anchoring, the `mission-<run_id>` work branch, DAG scheduling, coder/staging/checks, the two-stage reviewer gate, the fix loop, accepted-only commits, capability-gated push/PR creation, rollback of rejected tasks, and mission verdicts. |
| [03 — Review, Fix Loop, and Crash Recovery](./03-review-and-recovery.md) | The mission final review (deterministic mandatory gate that can downgrade model approvals), reviewer providers and secret redaction, the fix-task runner and real fix executor (checkpoint → apply → checks → rollback), dependency evidence derived from git, accepted-only history, and atomic state + crash/resume reconciliation. |
| [04 — Safety Model](./04-safety-model.md) | The two-layer model: hard safety (main/branch protection, clean-tree and opt-in flags, path escape and deny-list checks, sensitive-file/secret blocks, test/CI weakening detection — all blocking with no override) versus advisory quality policy (`max_lines_changed` as a planning budget, never a reason to compromise correctness or safety). |

## End-to-end workflow

```text
                ┌─────────────────────────────────────────────┐
                │  01 · One-Click Launch                       │
                │  autopilot-one-click <mission.json | goal>   │
                │  preset + mode select capabilities           │
                └──────────────────────┬──────────────────────┘
                                       │ mission → plan → autopilot
                                       ▼
                ┌─────────────────────────────────────────────┐
                │  02 · Task Lifecycle (multitask runner)      │
                │  base_sha anchor → mission-<run_id> branch   │
                │  DAG schedule → coder → checks → reviewer    │
                └──────────────────────┬──────────────────────┘
                                       │ per task
                                       ▼
                ┌─────────────────────────────────────────────┐
                │  03 · Review, Fix Loop, Recovery             │
                │  deterministic gate → LLM review → fix loop  │
                │  accepted-only history · atomic state/resume │
                └──────────────────────┬──────────────────────┘
                                       │ final review of integrated diff
                                       ▼
                  verdict: DONE / DONE_WITH_CAVEATS / FAILED /
                           NEEDS_HUMAN / EXTERNAL_BLOCKER

   All of it bounded by 04 · Safety Model:
   never merge, never force-push, never rerun Actions, never delete branches,
   never touch main, never escape the repo, never leak credentials,
   never weaken tests or CI. Humans own the final merge.
```

## Reading path

Start with [01-one-click.md](./01-one-click.md) to launch a run, then
[02-task-lifecycle.md](./02-task-lifecycle.md) for what happens to each task,
[03-review-and-recovery.md](./03-review-and-recovery.md) for how review, fixes,
and resumes stay trustworthy, and [04-safety-model.md](./04-safety-model.md) for
the guarantees that hold across all of the above.

Reports for each run live under `<output-dir>/<run-id>/` (default
`reports/autopilot-plans/<run-id>/`); multitask mission state and reports live
under `<output-dir>/missions/<run-id>/`.
