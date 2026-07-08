# Agent Access for `diagnose-ci`

The `diagnose-ci` command is a **read-only** diagnostic tool. It reads GitHub
Actions workflow metadata, job lists, and logs to classify CI failures and
produce reports. It never writes to the target repository.

## Why agents need log access

To triage CI failures without human intervention, an agent must be able to:

- Read workflow run metadata (status, conclusion, branch, commit).
- Read job and step outcomes.
- Download plain-text job logs.
- Inspect the logs for failing tests, stale `TESTING_SUMMARY.md` locks,
  type-check/build failures, and timeouts.

## Required token permissions

When `mode` is `github`, provide a classic or fine-grained personal access token
via the environment variable named by `token_env` (default: `GITHUB_TOKEN`).

Minimum permissions:

| Permission | Level | Used for |
|------------|-------|----------|
| `Actions` | read | list runs, fetch run details and jobs |
| `Pull requests` | read | resolve PR number to head SHA |
| `Contents` | read | verify repository context (indirectly via metadata) |
| `Metadata` | read | basic repository metadata |

No write permissions are required or used.

## Running the command

Fake mode (no token, deterministic fixture):

```bash
npx tsx src/cli.ts diagnose-ci configs/diagnose-ci.example.json
```

Real GitHub mode:

```bash
export GITHUB_TOKEN="ghp_..."
npx tsx src/cli.ts diagnose-ci configs/diagnose-ci.example.json
# or with a custom env var name:
export MY_GH_TOKEN="ghp_..."
npx tsx src/cli.ts diagnose-ci my-config.json
```

## Verdicts and exit codes

| Verdict | Meaning | Exit code |
|---------|---------|-----------|
| `DIAGNOSE_CI_GREEN` | Workflow succeeded. | 0 |
| `DIAGNOSE_CI_RED` | Workflow failed; a classification was produced. | 0 |
| `DIAGNOSE_CI_NEEDS_TOKEN` | GitHub mode was used without a token. | non-zero |
| `DIAGNOSE_CI_ACCESS_ERROR` | Token rejected or lacks permissions. | non-zero |
| `DIAGNOSE_CI_NOT_FOUND` | Target workflow run or PR could not be found. | non-zero |
| `DIAGNOSE_CI_FAILED` | Config/runtime error. | non-zero |

## Security rules

- Tokens are read **only** from environment variables.
- All console output, reports, JSON artifacts, and errors are redacted.
- The command never calls a GitHub write endpoint (`POST`, `PATCH`, `PUT`,
  `DELETE`).
- `allow_github_write` must remain `false`; the command will fail if set to
  `true`.

## Limitations

- Only public or accessible private repositories can be diagnosed.
- Very large logs are truncated to `max_log_excerpt_chars` unless
  `include_raw_logs` is enabled.
- Classification is heuristic; manual review is recommended for
  `UNKNOWN_FAILURE` or `WORKFLOW_INFRA_FAILURE`.

## Autopilot

`diagnose-ci` is used by the `autopilot-run` command to turn CI observations into repair tasks. See `docs/AUTOPILOT_RUN.md`.
