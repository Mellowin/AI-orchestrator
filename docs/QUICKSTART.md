# Quickstart — One-Click MVP

Install dependencies:

```bash
npm ci
```

Check the environment:

```bash
npm run doctor
```

## Safe mode (no tokens, no GitHub writes)

```bash
npm run one-click -- "Add a documentation note"
```

Expected verdict: `ONE_CLICK_DONE` or `ONE_CLICK_DONE_WITH_CAVEATS`.

Safe mode:

- requires no `KIMI_API_KEY`
- requires no `GITHUB_TOKEN`
- makes no repository commits or pushes
- makes no GitHub API calls
- generates mission, plan, configs and reports locally

## Real PR mode

```bash
export KIMI_API_KEY="sk-..."
export GITHUB_TOKEN="github_pat_..."

npm run one-click -- \
  "Add a small safe documentation change" \
  --preset real-pr \
  --yes
```

Real PR mode may:

- call the Kimi API
- apply file changes
- create a commit
- push a work branch
- open a draft PR
- observe CI

It never merges, force-pushes, reruns workflows or deletes branches.

## Real repair mode

```bash
npm run one-click -- \
  "Implement a small feature with tests" \
  --preset real-repair \
  --yes
```

Real repair mode adds bounded CI diagnosis and repair attempts on top of real PR mode.

## Required environment variables

- `KIMI_API_KEY` — needed for real provider calls
- `GITHUB_TOKEN` — needed for real PR/repair modes

Never commit these values.

## Minimum GitHub token access

- **Metadata:** read
- **Contents:** read/write (for real PR mode)
- **Pull requests:** read/write
- **Actions:** read (for CI observation and repair)

## Current limitations

- The tool never merges or force-pushes.
- Workflow reruns are not supported unless an explicit capability is added later.
- Real repair is bounded: it diagnoses red CI and attempts small fixes, but stops for human review if the root cause is outside the generated plan.
