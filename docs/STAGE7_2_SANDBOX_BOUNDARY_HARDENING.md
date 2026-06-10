# Stage 7.2 — Sandbox Boundary Hardening

**Date:** 2026-06-11
**Branch:** `main`
**Commit:** `pending final commit hash`

---

## Purpose

Harden the `block-sandbox` command with stricter path validation, worktree registration verification, main repo HEAD tracking, expanded secret redaction, and additional safety report fields.

---

## Changes

### Path validation (`validateSandboxPath`)

- **Repository root:** sandbox path equal to repo root is rejected
- **Inside source repo:** sandbox path inside the source repository is rejected
- **Inside `.git`:** sandbox path inside `.git` directory is rejected (checked before generic repo check)
- **Outside project directory:** sandbox path outside `process.cwd()` is rejected unless explicitly provided as a custom path (`sandboxPath` input is set)

### Cleanup safety

- Before removing a worktree, verify it is still registered via `git worktree list --porcelain`
- Refuse to remove unregistered paths (never fall back to `rm -rf`)
- After successful removal, verify the worktree no longer appears in `git worktree list --porcelain`
- Only `git worktree remove` is used for cleanup

### Main repo protection

- Record main repo HEAD before running sandbox checks (`main_head_before`)
- Record main repo HEAD after running sandbox checks (`main_head_after`)
- Detect HEAD change as a **blocking issue**
- Detect dirty working tree after sandbox as a **safety finding**

### Expanded redaction

Patterns added or reinforced in `redact()`:

| Pattern | Example |
|---|---|
| `ghp_` | `ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx` |
| `github_pat_` | `github_pat_xxxxxxxxxxxxxxxxxxxxxxxx` |
| `sk-` | `sk-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx` |
| `Bearer` | `Bearer xxxxxxxx` |
| `GITHUB_TOKEN=` | `GITHUB_TOKEN=xxxxxx` |
| `KIMI_API_KEY=` | `KIMI_API_KEY=xxxxxx` |
| `*_TOKEN=` | `MY_SERVICE_TOKEN=xxxxxx` |
| `*_API_KEY=` | `MY_API_KEY=xxxxxx` |

### Report additions

New fields in `BlockSandboxResult` and CLI output:

- `main_head_before` / `main_head_after`
- `path_validation` (`pass` / `fail`)
- `worktree_registered` (`true` / `false`)
- `cleanup_verified` (`true` / `false`)
- `redaction_applied` (`true`)

---

## Command

```bash
npx tsx src/cli.ts block-sandbox <blockJsonPath>
```

### Environment variables

Same as Stage 7.1:

| Variable | Default | Description |
|---|---|---|
| `ALLOW_BLOCK_SANDBOX` | `false` | **Required** to enable real execution |
| `BLOCK_SANDBOX_PATH` | `tmp/block-sandbox/<block-id>` | Custom sandbox path |
| `BLOCK_SANDBOX_BASE` | current branch | Base ref (branch or SHA) |
| `BLOCK_SANDBOX_KEEP` | `false` | Keep sandbox after execution |
| `BLOCK_SANDBOX_OUTPUT` | `runs/blocks/<block-id>/sandbox/sandbox-report.md` | Report path |

---

## Safety rules

| Rule | Status |
|---|---|
| Main working tree must be clean before sandbox | enforced |
| Sandbox path must not be the repository root | enforced |
| Sandbox path must not be inside source repo | enforced |
| Sandbox path must not be inside `.git` | enforced |
| Sandbox path outside project directory requires explicit custom path | enforced |
| Worktree registration verified before removal | enforced |
| No `rm -rf` for cleanup | enforced |
| Main HEAD change detected as blocking issue | enforced |
| Secrets redacted from logs | enforced |
| Report written only inside `runs/` | enforced |

---

## Tests

- 26 block-sandbox unit tests (14 new/extended since Stage 7.1)
- 3 CLI block-sandbox integration tests
- All tests use mocked command runner — no real destructive git operations

---

## Known limitations

- AI provider calls are not yet implemented inside sandbox (check-only)
- Sandbox requires `git worktree` support (Git 2.5+)
- Custom sandbox path must pass all validation rules even when explicitly provided
