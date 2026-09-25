import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { runAutopilotRemoteFinalization } from '../src/autopilot-run/runner.js';
import type { AutopilotRunConfig } from '../src/autopilot-run/types.js';
import type { MvpRunConfig } from '../src/mvp-run/types.js';

/**
 * Stage 18.26h — exact autonomous CI-repair regression (fakes/seams only):
 *
 *   PR CI red (checks green, smoke job failed: npm script missing)
 *   → diagnosis = MISSING_NPM_SCRIPT
 *   → deterministic maintenance scope authorized (package.json + scripts/**)
 *   → provider attempt 1 proposes .github/workflows/ci.yml → REJECTED by guardrails
 *   → provider attempt 2 proposes package.json + scripts target → allowed
 *   → local checks run through absolute Node/npm execution (fake spawn)
 *   → CI contract re-validation passes on the really-applied files
 *   → repair committed and pushed (fake git)
 *   → new CI observed → green → AUTOPILOT_GREEN
 *
 * No real GitHub mutation: fetch is fully faked.
 */
let counter = 0;

function tmpDir(): string {
  counter += 1;
  const base = join(process.cwd(), 'tmp');
  if (!existsSync(base)) {
    mkdirSync(base);
  }
  return mkdtempSync(join(base, `ci-repair-chain-${Date.now()}-${counter}-`));
}

function findRealNpmCli(): string | undefined {
  const candidates = [
    process.env.npm_execpath,
    join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ];
  for (const candidate of candidates) {
    if (
      typeof candidate === 'string' &&
      candidate.length > 0 &&
      isAbsolute(candidate) &&
      /\.(?:js|mjs|cjs)$/i.test(candidate) &&
      existsSync(candidate)
    ) {
      return candidate;
    }
  }
  return undefined;
}

const SHA_BEFORE = 'a'.repeat(40);
const SHA_AFTER = 'b'.repeat(40);

function makeConfig(reportDir: string): AutopilotRunConfig {
  return {
    mode: 'github',
    run_id: 'ci-repair-chain-test',
    repo_slug: 'owner/repo',
    base_branch: 'main',
    work_branch: 'mission-test',
    mvp_config_path: 'mvp.json',
    diagnose_config: { token_env: 'GITHUB_TOKEN', include_raw_logs: false, max_log_excerpt_chars: 4000 },
    ci: { enabled: true, wait_for_ci: true, poll_interval_seconds: 1, timeout_seconds: 30 },
    repair: {
      enabled: true,
      max_attempts: 2,
      provider: 'mock',
      allow_real_provider: false,
      allow_apply: true,
      allow_commit: true,
      allow_push: true,
      // Task writable scope: only an unrelated docs file.
      allowed_files: ['docs/task-result.md'],
      denied_files: ['.env*'],
    },
    github: {
      allow_pr_create: false,
      allow_pr_update: false,
      allow_actions_read: false,
      allow_write: false,
    },
    report_dir: reportDir,
  };
}

function makeFakeFetch(): { fetchFn: typeof globalThis.fetch; calls: string[] } {
  const calls: string[] = [];
  const fetchFn: typeof globalThis.fetch = async (url) => {
    const urlString = url.toString();
    calls.push(urlString);

    if (urlString.includes('/actions/runs?')) {
      const runId = urlString.includes(SHA_AFTER) ? 222 : 111;
      return new Response(
        JSON.stringify({
          workflow_runs: [
            {
              id: runId,
              run_number: runId === 222 ? 2 : 1,
              name: 'Mini-MVP CI',
              event: 'pull_request',
              head_branch: 'mission-test',
              head_sha: urlString.includes(SHA_AFTER) ? SHA_AFTER : SHA_BEFORE,
              status: 'completed',
              conclusion: runId === 222 ? 'success' : 'failure',
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }

    if (urlString.includes('/actions/runs/222')) {
      return new Response(
        JSON.stringify({
          id: 222,
          run_number: 2,
          name: 'Mini-MVP CI',
          event: 'pull_request',
          head_branch: 'mission-test',
          head_sha: SHA_AFTER,
          status: 'completed',
          conclusion: 'success',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }

    if (urlString.includes('/actions/runs/111')) {
      return new Response(
        JSON.stringify({
          id: 111,
          run_number: 1,
          name: 'Mini-MVP CI',
          event: 'pull_request',
          head_branch: 'mission-test',
          head_sha: SHA_BEFORE,
          status: 'completed',
          conclusion: 'failure',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }

    return new Response(JSON.stringify({ message: 'not found' }), {
      status: 404,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { fetchFn, calls };
}

describe('autopilot CI repair chain (stage 18.26h)', () => {
  test('missing npm script: workflow proposal rejected, bounded repair green', async () => {
    const npmCli = findRealNpmCli();
    assert.ok(npmCli, 'test requires an absolute npm CLI (run tests under npm)');
    const savedExecPath = process.env.npm_execpath;
    process.env.npm_execpath = npmCli;
    const savedToken = process.env.GITHUB_TOKEN;
    process.env.GITHUB_TOKEN = 'fake-token-for-faked-fetch';

    const reportDir = tmpDir();
    const repoPath = tmpDir();
    const diagnosisDir = tmpDir();
    try {
      // Repository with a BROKEN CI contract: the workflow references a
      // script that does not exist.
      mkdirSync(join(repoPath, '.github', 'workflows'), { recursive: true });
      mkdirSync(join(repoPath, 'scripts'));
      mkdirSync(join(repoPath, 'docs'));
      writeFileSync(
        join(repoPath, 'package.json'),
        JSON.stringify(
          {
            name: 'target-repo',
            version: '0.0.1',
            scripts: { typecheck: 'tsc --noEmit', build: 'tsc' },
          },
          null,
          2
        ),
        'utf-8'
      );
      writeFileSync(
        join(repoPath, '.github', 'workflows', 'ci.yml'),
        'name: CI\non:\n  pull_request:\njobs:\n  smoke:\n    runs-on: ubuntu-latest\n    steps:\n      - name: Drill smoke\n        run: npm run demo:restored-drill\n',
        'utf-8'
      );
      writeFileSync(join(repoPath, 'docs', 'task-result.md'), '# accepted task output\n', 'utf-8');

      // Fake diagnosis artifacts: MISSING_NPM_SCRIPT with exact script name.
      const fixTaskMd = join(diagnosisDir, 'fix-task.md');
      const fixTaskJson = join(diagnosisDir, 'fix-task.json');
      writeFileSync(
        fixTaskMd,
        '# CI Fix Task\n\n## Failed Jobs / Steps\n\n- **Job:** smoke (conclusion=failure)\n  - **Failed step:** Drill smoke\n\n## Missing npm Scripts\n\n- `demo:restored-drill`\n',
        'utf-8'
      );
      writeFileSync(
        fixTaskJson,
        JSON.stringify({
          run_id: 111,
          classification: 'MISSING_NPM_SCRIPT',
          missing_npm_scripts: ['demo:restored-drill'],
          failed_jobs: [
            {
              id: 1,
              name: 'smoke',
              conclusion: 'failure',
              failed_step: { name: 'Drill smoke', conclusion: 'failure', status: 'completed' },
              failed_steps: ['Drill smoke'],
              log_available: true,
              log_excerpt: 'npm error Missing script: "demo:restored-drill"',
            },
          ],
        }),
        'utf-8'
      );

      const runDiagnoseCiFn = (async () => ({
        verdict: 'DIAGNOSE_CI_RED' as const,
        run_id: 111,
        classification: 'MISSING_NPM_SCRIPT' as const,
        confidence: 'high' as const,
        report_paths: {
          report_dir: diagnosisDir,
          report_md: join(diagnosisDir, 'report.md'),
          report_json: join(diagnosisDir, 'report.json'),
          fix_task_md: fixTaskMd,
          fix_task_json: fixTaskJson,
        },
        reason: 'missing npm scripts: demo:restored-drill',
      })) as never;

      // Fake spawn: git rev-parse yields the two SHAs; everything else ok.
      let revParseCount = 0;
      const spawnCalls: Array<{ command: string; args: string[] }> = [];
      const spawnFn = ((command: string, args: string[]) => {
        spawnCalls.push({ command, args: [...args] });
        if (command === 'git' && args[0] === 'rev-parse') {
          revParseCount += 1;
          return { status: 0, stdout: revParseCount === 1 ? `${SHA_BEFORE}\n` : `${SHA_AFTER}\n`, stderr: '', error: null, signal: null };
        }
        return { status: 0, stdout: '', stderr: '', error: null, signal: null };
      }) as never;

      const { fetchFn } = makeFakeFetch();

      const repairedPackageJson = JSON.stringify(
        {
          name: 'target-repo',
          version: '0.0.1',
          scripts: {
            typecheck: 'tsc --noEmit',
            build: 'tsc',
            'demo:restored-drill': 'node scripts/run-restored-drill.mjs',
          },
        },
        null,
        2
      );

      // Attempt 1: provider tries to edit the workflow (must be rejected).
      const workflowProposal = JSON.stringify({
        mode: 'file_update',
        files: [
          {
            path: '.github/workflows/ci.yml',
            content: 'name: CI\non:\n  pull_request:\njobs: {}\n',
          },
        ],
        notes: 'Try removing the broken job',
      });
      // Attempt 2: bounded package.json + scripts repair (must be allowed).
      const boundedProposal = JSON.stringify({
        mode: 'file_update',
        files: [
          { path: 'package.json', content: repairedPackageJson },
          { path: 'scripts/run-restored-drill.mjs', content: '// restored drill\n' },
        ],
        notes: 'Restore the missing npm script',
      });

      const mvpConfig = { repo_path: repoPath } as MvpRunConfig;

      const result = await runAutopilotRemoteFinalization(makeConfig(reportDir), mvpConfig, {
        fetchFn,
        spawnFn: spawnFn as never,
        runDiagnoseCiFn,
        repairMockResponses: [workflowProposal, boundedProposal],
      });

      assert.strictEqual(result.verdict, 'AUTOPILOT_GREEN', `expected green: ${result.reason}`);
      assert.strictEqual(result.repair_attempts, 2);
      assert.strictEqual(result.ci_run_id, 222);
      // Guardrails rejected the workflow edit on attempt 1: the only git
      // mutations are from the successful bounded repair attempt.
      const gitCommits = spawnCalls.filter((c) => c.command === 'git' && c.args[0] === 'commit');
      assert.strictEqual(gitCommits.length, 1, 'exactly one repair commit expected');
      const gitPushes = spawnCalls.filter((c) => c.command === 'git' && c.args[0] === 'push');
      assert.strictEqual(gitPushes.length, 1, 'exactly one repair push expected');

      // The bounded repair was really applied to the repository.
      const pkg = JSON.parse(readFileSync(join(repoPath, 'package.json'), 'utf-8')) as {
        scripts: Record<string, string>;
      };
      assert.ok('demo:restored-drill' in pkg.scripts, 'missing script restored in package.json');
      assert.ok(existsSync(join(repoPath, 'scripts', 'run-restored-drill.mjs')));
      // The workflow file was NOT touched.
      const workflow = readFileSync(join(repoPath, '.github', 'workflows', 'ci.yml'), 'utf-8');
      assert.ok(workflow.includes('npm run demo:restored-drill'));

      // Deterministic post-repair validation evidence exists (typecheck, build,
      // contract revalidation is implicit, plus the restored smoke command).
      const evidencePath = join(reportDir, 'ci-repair-chain-test', 'repair-attempt-2', 'local-checks.json');
      assert.ok(existsSync(evidencePath), 'local check evidence must be persisted');
      const evidence = JSON.parse(readFileSync(evidencePath, 'utf-8')) as {
        checks: Array<{ check: string; ok: boolean }>;
      };
      const checkNames = evidence.checks.map((c) => c.check);
      assert.ok(checkNames.includes('typecheck'));
      assert.ok(checkNames.includes('build'));
      assert.ok(checkNames.includes('smoke:demo:restored-drill'));
      for (const check of evidence.checks) {
        assert.strictEqual(check.ok, true, `${check.check} must pass`);
      }

      // Latest fix task tells the repair story: missing scripts, not timeout.
      const diagnosis = JSON.parse(
        readFileSync(join(reportDir, 'ci-repair-chain-test', 'latest-diagnosis.json'), 'utf-8')
      ) as { classification: string; missing_npm_scripts: string[] };
      assert.strictEqual(diagnosis.classification, 'MISSING_NPM_SCRIPT');
      assert.deepStrictEqual(diagnosis.missing_npm_scripts, ['demo:restored-drill']);
    } finally {
      if (savedExecPath === undefined) {
        delete process.env.npm_execpath;
      } else {
        process.env.npm_execpath = savedExecPath;
      }
      if (savedToken === undefined) {
        delete process.env.GITHUB_TOKEN;
      } else {
        process.env.GITHUB_TOKEN = savedToken;
      }
      rmSync(reportDir, { recursive: true, force: true });
      rmSync(repoPath, { recursive: true, force: true });
      rmSync(diagnosisDir, { recursive: true, force: true });
    }
  });
});
