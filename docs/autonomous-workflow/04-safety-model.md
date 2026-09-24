# 04 — Safety Model: Hard Safety vs. Advisory Quality Policy

This document describes the safety model of the autonomous multitask AI Orchestrator, building on `01-one-click.md` (launch, branch setup), `02-task-lifecycle.md` (per-task lifecycle), and `03-review-and-recovery.md` (reviewer/fix loop, rollback, resume). It is grounded in the actual enforcement code: `src/ai-safety-policy.ts`, `src/guardrails.ts`, `src/real-repo-apply-safety.ts`, `src/block/block-real-mode-safety.ts`, and the deterministic review gate in `src/reviewer/deterministic-review-checks.ts`.

The most important distinction in this document is between two very different kinds of rules:

- **Hard safety rules** are enforced by deterministic code. They reject, block, or fail closed regardless of what any model says. They exist to protect the repository, credentials, and history.
- **Advisory quality policy** exists to guide planning and human review. It is a planning estimate and a review signal, not a hard limit, and it never overrides correctness.

Confusing the two is dangerous in both directions: treating advisory budgets as safety walls gives false confidence, and treating hard safety rules as negotiable guidelines invites real damage.

## 1. Hard safety: main protection

The default branch is untouchable by design. Enforcement is deterministic and multi-layered:

- `validateRealRepoApplySafety` rejects any mutation when `currentBranch === 'main'` or when `work_branch` is `main`, and requires the current branch to exactly equal `work_branch`.
- `validateRealOneTaskModeSafety` additionally rejects detached `HEAD` state and a dirty working tree before any mutation.
- The mission work happens only on the dedicated mission branch (`mission-<run_id>`); no command checks out, switches to, commits to, or merges into `main`.
- Merge is never performed by any command. Push is a plain `git push origin <branch>` — no force, no tags, no `--all`, no `--mirror`. `git reset --hard` is never used; rollback is file-level or via explicit, tracked revert commits (see `03-review-and-recovery.md`).
- The deterministic reviewer gate treats a main-branch violation as a **severe** finding that routes to `block_for_human` immediately, without ever calling the model reviewer.

These are hard rules: there is no flag, preset, or model verdict that can waive them.

## 2. Hard safety: path safety

File scope is enforced deterministically, never by the model:

- **Writable scope** — a task may only modify files matching its `allowed_files`; anything matching `denied_files` is rejected (`validateFileList`, `checkPathEscape`). Model approval is not a scope boundary: the deterministic gate overrides an "approved" verdict when unauthorized files appear (see `03-review-and-recovery.md`, §1).
- **Traversal and escape** — absolute paths, `..` parent references, and backslash paths are rejected. Every candidate path is resolved and verified to stay inside the repository root (`isInsideRepo`).
- **Unrelated changes** — the working tree must be clean before mutation, and post-apply checks stop if unapproved files appear in the tree.
- **Content-level path operations** — in code-like files (`*.js`, `*.ts`, `*.sh`, workflows, `package.json`), the safety policy scans for file-system or child-process operations that target dangerous absolute/system paths (`/etc/`, `/tmp/`, drive-letter roots, `..` escapes) and rejects them (`checkContentLevelPathOperations`).

## 3. Hard safety: sensitive files and secrets

- **Denied by structure** — `.env`, `.env.local`, `.git`, and `node_modules` path segments are always denied (`isDeniedPath`), independent of any task configuration.
- **Secret exfiltration patterns** — proposed content is scanned for `process.env` access to secret-looking variables (`KIMI_API_KEY`, `*_API_KEY`, `SECRET`, `TOKEN`, `PASSWORD`, including bracket notation), logging or serializing `process.env`, loading `dotenv`, and reading `.env` files (`checkSecretExfiltration`). Inert documentation files (`*.md`, `*.txt`, etc.) are exempt, since naming a variable in prose is not credential access.
- **Secrets in diffs** — the deterministic reviewer gate rejects diffs containing secret patterns (`sk-`, `Bearer`, API-key assignments, `.env`) as severe findings; no AI review is invoked. Detection runs on the raw diff, but reported issues use generic labels — raw secret values are never echoed.
- **Redaction** — any dynamic tool output (check logs, reviewer text, fix context) is redacted before it enters prompts, reports, or CLI output. API keys live only in environment variables and are never persisted to state, logs, or commit messages.

## 4. Hard safety: test weakening

Proposed changes to test files are screened so a task cannot "pass" by gutting its own verification (`checkTestWeakening`):

- `.only` / `.skip` selectors are rejected.
- Emptying a test file is rejected.
- Commented-out assertions (`// assert`, `# expect`, commented `throw new Error`, `process.exit(1)`) are rejected.
- A test file with no assertions that only prints `ok` is rejected.

Related hard rules: `continue-on-error` in CI workflow files is rejected (`checkCiWeakening`), and when a task declares `require_tests`, the change set must actually contain `.test.`/`.spec.` files (`validateTestsPresent`).

## 5. Advisory policy: `max_lines_changed` is a budget, not a hard limit

`max_lines_changed` belongs to a different category than everything above. It is an **advisory quality budget**: a planning estimate that keeps individual task diffs small enough to review meaningfully, and a signal to reviewers that a change may be doing more than its goal states.

Concretely, this means:

- **It is not a hard limit.** It should never be described as one. Unlike scope, secrets, main protection, or test weakening, exceeding the advisory budget is not a safety violation.
- **It never compromises correctness or safety.** If a task legitimately requires a larger change — a new file whose full content exceeds the estimate, a broad mechanical rename — the correct behavior is to make the change and **explain why**, not to truncate, omit tests, or split the change into an incoherent state to fit the number.
- **It informs review, not enforcement.** In the autonomous workflow the budget feeds planning and reviewer context; the deterministic gate treats it as advisory only. A diff over budget is a prompt for a human (or reviewer) to look more closely, not an automatic rejection.
- **It is per-file and delta-based.** The budget applies to the line delta of a single file; for a newly created file it is a planning estimate for the full file length.

By contrast, everything in §1–§4 is hard safety: enforced by code, failing closed, and entirely independent of model judgment.

## 6. Summary table

| Rule | Category | Enforcement | Can a model override it? |
|---|---|---|---|
| Never touch `main`; no merge, force push, or `reset --hard` | Hard safety | Branch/git validation, deterministic gate | No |
| Writes only within `allowed_files`, never `denied_files` | Hard safety | `validateFileList`, deterministic gate | No |
| No path traversal, absolute paths, or repo escape | Hard safety | `checkPathEscape`, `isInsideRepo` | No |
| `.env` / `.git` / `node_modules` denied; no secret exfiltration or persistence | Hard safety | `isDeniedPath`, `checkSecretExfiltration`, redaction | No |
| No test weakening (`.only`/`.skip`, gutted assertions), no `continue-on-error` | Hard safety | `checkTestWeakening`, `checkCiWeakening` | No |
| `max_lines_changed` | **Advisory quality policy** | Planning/review signal; never a hard limit | N/A — it is guidance, not a gate |

## Invariants

1. Hard safety is enforced by deterministic code and fails closed; the model is never the final authority on scope, secrets, branch protection, or test integrity.
2. `max_lines_changed` is advisory only — a planning estimate and review signal. It is never a hard limit, and correctness or safety must never be compromised to fit it; larger legitimate changes are made with an explanatory note.
3. Severe findings (secrets, main branch, conflict markers, denied files, invalid SHA) block for a human without any model call; the human operator retains the final merge decision.
