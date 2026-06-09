# Stage 6.14.1 — Fix Loop Attempt Enforcement and Redaction Hardening

**Commit:** `d67c4845ba1fbe79d53b48592150f41cc7d1cacc`

---

## Design Decision: One-Task Loop = Exactly One Attempt

`block-run-one <blockJsonPath>` runs **a single coder→reviewer cycle** for the current task.

- It does **not** contain an internal retry loop.
- It does **not** read `BLOCK_RUN_ONE_MAX_ATTEMPTS`.
- After one pass, it returns the result (`accepted`, `fix_required`, `checks_failed`, `blocked`) and stops.

This keeps the one-task loop simple, predictable, and safe. The caller decides whether to invoke it again.

---

## Design Decision: Multi-Task Loop Owns the Autonomous Fix Loop

`block-run <blockJsonPath>` is the **orchestrator** that calls `runOneTaskLoop` repeatedly.

- It stops on `accepted` and advances to the next task.
- It retries the **same task** on `fix_required` or `checks_failed` while `fix_attempts < max_fix_attempts`.
- It stops on `blocked` (including when `max_fix_attempts` is reached).
- It respects `BLOCK_RUN_MAX_TOTAL_ATTEMPTS` as a global runaway guard.

This separation of concerns means:
- `block-run-one` = single atomic unit of work.
- `block-run` = policy layer that sequences atomic units.

---

## Check Failures and Reviewer Fix Requests Both Retry the Same Task

There are two paths that can send a task back to the coder:

1. **Reviewer fix request** (`rejected` → `fix_required`)
   - `markTaskFixRequired` increments `fix_attempts`.
   - If under limit, status becomes `fix_required`.
   - Next loop iteration calls `runFix` with reviewer feedback.

2. **Guardrails / deterministic check failure** (`checks_failed`)
   - `markTaskChecksFailed` increments `fix_attempts`.
   - If under limit, status becomes `checks_failed`.
   - Next loop iteration calls `runFix` with check failure summary.

Both paths share the same `fix_attempts` counter and the same `max_fix_attempts` limit. Either path can block the task when the limit is reached.

---

## Fix Context Redaction Before Coder Prompt

When a task is retried, the coder receives previous failure/reviewer feedback in its `repo_context`. This feedback may contain secrets leaked by the previous attempt (e.g., a token in a test error message).

`buildCoderInputFromBlockTask` applies redaction to all fix-context fields before building the prompt:

- `reviewerSummary` → `redactReviewerText`
- `fixTask` → `redactReviewerText`
- `blockingIssues` → `redactReviewerList`
- `checkFailureSummary` → `redactReviewerText`

Redaction covers:
- `sk-` tokens
- `Bearer` tokens
- API key assignments (`KIMI_API_KEY=`, `OPENAI_API_KEY=`, `ANTHROPIC_API_KEY=`)
- `GITHUB_TOKEN=` and generic GitHub PATs (`ghp_`, `github_pat_`)
- `.env`-like secret patterns

This prevents secrets from circulating in the autonomous fix loop.

---

## Fake Provider Sequential Response Indexes

Fake mode tests use `taskResponses` / `fixResponses` / `decisions` arrays to simulate multiple provider outputs.

Because `resolveCoderAndReviewerProviders` creates a **new provider instance** on every `runOneTaskLoop` call, local counters inside the provider would reset. The fix stores mutable counters on the shared `options` object:

- `fakeCoderOptions.taskResponseIndex`
- `fakeCoderOptions.fixResponseIndex`
- `fakeReviewerOptions.decisionIndex`

This ensures multi-task loops consume responses in the expected order across iterations.

---

## Safety Guarantees

- No endless retry loops: `max_fix_attempts` is bounded (1–5) and enforced for both check failures and reviewer fix requests.
- No secret propagation: fix context is redacted before every coder call.
- No main touch, no merge, no auto-push, no GitHub API calls in fake mode.
