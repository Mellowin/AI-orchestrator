# Stage 6.8 Safety Checklist

This document lists the safety invariants enforced during the Stage 6.8 live run.

## Invariants

1. **Task Volume Limit**: `maxTasksPerRun` must be less than or equal to `3`.
2. **Auto-Push Disabled**: Automatic pushing of commits is disabled.
3. **Protected Operations Blocked**: No pull requests, merges to `main`, branch checkouts, or force-pushes are permitted.
4. **Credential Isolation**: Provider credentials are sourced exclusively from environment variables.
5. **Credential Hygiene**: No credential strings are stored in logs, state files, or documentation.
