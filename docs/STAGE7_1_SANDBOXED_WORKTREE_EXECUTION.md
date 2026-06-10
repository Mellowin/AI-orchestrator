# Stage 7.1 — Sandboxed Worktree Execution

**Date:** 2026-06-11
**Branch:** `main`
**Commit:** `f044d10b8f3b6dcf8821b184f7fd1d8ed1142c0b`

---

## Purpose

Add a sandboxed execution layer so AI/block runs happen in an isolated temporary git worktree instead of directly modifying the main working directory.

---

## Why sandbox is needed

- Main repo working tree stays clean during execution
- Failed runs do not pollute the main checkout
- Multiple blocks can be prepared concurrently without branch conflicts
- Operator can inspect sandbox before applying changes

---

## Command

```bash
npx tsx src/cli.ts block-sandbox <blockJsonPath>
```

### Environment variables

| Variable | Default | Description |
|---|---|---|
| `ALLOW_BLOCK_SANDBOX` | `false` | **Required** to enable real execution |
| `BLOCK_SANDBOX_PATH` | `tmp/block-sandbox/<block-id>` | Custom sandbox path |
| `BLOCK_SANDBOX_BASE` | current branch | Base ref (branch or SHA) |
| `BLOCK_SANDBOX_KEEP` | `false` | Keep sandbox after execution |
| `BLOCK_SANDBOX_OUTPUT` | `runs/blocks/<block-id>/sandbox/sandbox-report.md` | Report path |

---

## Examples

### Dry run (blocked by default)

```bash
npx tsx src/cli.ts block-sandbox docs/block-example.json
```

Output:

```text
[block-sandbox] Error: Sandbox execution is blocked. Set ALLOW_BLOCK_SANDBOX=true to enable.
```

### Successful sandbox

```bash
ALLOW_BLOCK_SANDBOX=true \
  npx tsx src/cli.ts block-sandbox docs/block-example.json
```

Output:

```text
[block-sandbox] Block: example-block
[block-sandbox] Base branch: main
[block-sandbox] Base commit: 73294932caa2f4fdc927a0d3d1684187af169ab9
[block-sandbox] Sandbox path: /path/to/tmp/block-sandbox/example-block
[block-sandbox] Type check: pass
[block-sandbox] Build: pass
[block-sandbox] Tests: pass
[block-sandbox] Main status before: clean
[block-sandbox] Main status after: clean
[block-sandbox] Sandbox status: clean
[block-sandbox] Cleanup: success
[block-sandbox] Report: runs/blocks/example-block/sandbox/sandbox-report.md
[block-sandbox] No merge was performed
[block-sandbox] No checkout was performed
[block-sandbox] No provider call was made
```

---

## Safety rules

| Rule | Status |
|---|---|
| Main working tree must be clean before sandbox | enforced |
| Sandbox path must not be inside source repo | enforced |
| No `git reset --hard` in main repo | enforced |
| No checkout/switch in main repo | enforced |
| Report written only inside `runs/` | enforced |
| Secrets redacted from logs | enforced |

---

## Known limitations

- AI provider calls are not yet implemented inside sandbox (this stage is check-only)
- Sandbox requires `git worktree` support (Git 2.5+)
- Custom sandbox path must be outside the source repository
