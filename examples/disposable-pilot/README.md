# Disposable Pilot Demo

This directory contains a **golden demo kit** for the `real-block-disposable-pilot` command.

## What this demo proves

- A fully autonomous AI developer flow can be started from a single block JSON.
- The flow validates the block, runs read-only preflight + task probes, optionally runs real code changes, and produces a final report.
- All mutations are isolated to a **throw-away repository** created under the system temp directory.
- The project repository (`ai-orchestrator`) is never touched.

## What this demo does NOT prove

- It does not call live Kimi by default.
- It does not push to a public remote.
- It does not modify your current project, `main`, or GitHub state.

## Safe default behavior

Running the demo script without real-provider opt-ins will:

1. Create a disposable git repo under `%TEMP%` / `/tmp`.
2. Add `README.md` and `metadata.yml`.
3. Create a local bare remote and push `main`.
4. Create a work branch `ai-demo-branch`.
5. Generate a block JSON pointing at the disposable repo.
6. Print the exact command you can run to start the real pilot.
7. Exit with code `0`.

No network calls are made.

## Required environment for live Kimi run

To actually run the pilot against the disposable repo, export all required opt-ins:

```bash
export ALLOW_REAL_PROVIDER=true
export ALLOW_KIMI_REVIEWER=true
export REAL_BLOCK_RUN_AI=1
export ALLOW_REAL_REPO_APPLY=true
export ALLOW_REAL_REPO_COMMIT=true
export ALLOW_REAL_REPO_PUSH=true
export KIMI_API_KEY="your-key"
```

Then run:

```bash
npm run demo:disposable-pilot
```

The script will invoke:

```bash
npx tsx src/cli.ts real-block-disposable-pilot <temp-block.json> --provider kimi --timeout-ms 120000
```

## Files

- `block.json` — template block definition. `repo_path` is replaced at demo-time with the actual disposable repo location.
