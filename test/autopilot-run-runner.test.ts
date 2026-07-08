import { describe, test } from 'node:test';
import assert from 'node:assert';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { SpawnSyncReturns } from 'node:child_process';
import { join } from 'node:path';
import { runAutopilotRun } from '../src/autopilot-run/runner.js';
import type { AutopilotRunConfig } from '../src/autopilot-run/types.js';
import type { MvpRunResult } from '../src/mvp-run/types.js';
import type { DiagnoseCiResult, DiagnoseCiReportPaths } from '../src/diagnose-ci/types.js';

let counter = 0;

function tmpDir(): string {
  const id = `${Date.now()}-${counter++}`;
  const base = join(process.cwd(), 'tmp');
  if (!existsSync(base)) {
    mkdirSync(base);
  }
  return mkdtempSync(join(base, `autopilot-runner-${id}-`));
}

function baseConfig(overrides: Partial<AutopilotRunConfig> = {}): AutopilotRunConfig {
  const reportDir = tmpDir();
  return {
    mode: 'fake',
    run_id: `autopilot-test-${Date.now()}`,
    repo_slug: 'owner/repo',
    base_branch: 'main',
    work_branch: 'autopilot-test',
    mvp_config_path: 'configs/mvp-run.example.json',
    diagnose_config: {
      token_env: 'GITHUB_TOKEN',
      include_raw_logs: false,
      max_log_excerpt_chars: 4000,
    },
    ci: {
      enabled: false,
      wait_for_ci: false,
      poll_interval_seconds: 1,
      timeout_seconds: 5,
    },
    repair: {
      enabled: false,
      max_attempts: 2,
      provider: 'mock',
      allow_real_provider: false,
      allow_apply: false,
      allow_commit: false,
      allow_push: false,
      denied_files: ['.env*'],
    },
    github: {
      allow_pr_create: false,
      allow_pr_update: false,
      allow_actions_read: false,
      allow_write: false,
    },
    report_dir: reportDir,
    ...overrides,
  };
}

function fakeMvpResult(overrides: Partial<MvpRunResult> = {}): MvpRunResult {
  return {
    config: {} as MvpRunResult['config'],
    command: 'test',
    config_path: '/tmp/mvp.json',
    started_at: new Date().toISOString(),
    finished_at: new Date().toISOString(),
    duration_ms: 100,
    verdict: 'MVP_RUN_PASSED',
    reason: 'All tasks passed',
    preflight: {} as MvpRunResult['preflight'],
    task_results: [],
    tasks_total: 1,
    tasks_passed: 1,
    tasks_failed: 0,
    tasks_blocked: 0,
    tasks_skipped: 0,
    tasks_caveats: 0,
    commits: [],
    branch: 'autopilot-test',
    pushed: false,
    caveats: [],
    report_dir: '/tmp/mvp-report',
    ...overrides,
  };
}

function fakeDiagnoseResult(overrides: Partial<DiagnoseCiResult> = {}): DiagnoseCiResult {
  return {
    verdict: 'DIAGNOSE_CI_GREEN',
    run_id: 123456789,
    classification: 'CI_GREEN',
    confidence: 'high',
    report_paths: null,
    reason: 'All green',
    ...overrides,
  };
}

function fakeReportPaths(reportDir: string): DiagnoseCiReportPaths {
  const fixTaskMd = join(reportDir, 'fix-task.md');
  const fixTaskJson = join(reportDir, 'fix-task.json');
  writeFileSync(fixTaskMd, '# CI Fix Task\n', 'utf-8');
  writeFileSync(
    fixTaskJson,
    JSON.stringify({
      run_id: 123456789,
      classification: 'TEST_FAILURE',
      failing_tests: [{ file: 'test/broken.test.ts' }],
    }),
    'utf-8'
  );
  return {
    report_dir: reportDir,
    report_md: join(reportDir, 'report.md'),
    report_json: join(reportDir, 'report.json'),
    fix_task_md: fixTaskMd,
    fix_task_json: fixTaskJson,
  };
}

function fakeSuccessSpawn(
  command: string,
  args: string[]
): SpawnSyncReturns<string> {
  const stdout = command === 'git' && args[0] === 'rev-parse' ? 'abc123def456789012345678901234567890abcd\n' : '';
  return {
    status: 0,
    signal: null,
    output: [null, stdout, ''],
    stdout,
    stderr: '',
    pid: 0,
  } as SpawnSyncReturns<string>;
}

function makeGithubFetch(
  conclusion: 'success' | 'failure' | 'in_progress',
  runId = 123456789
): typeof globalThis.fetch {
  const fetchFn: typeof globalThis.fetch = async (url, _init) => {
    const urlString = url.toString();

    if (urlString.includes('/actions/runs?')) {
      return new Response(
        JSON.stringify({
          workflow_runs: [
            {
              id: runId,
              run_number: 1,
              name: 'CI',
              event: 'pull_request',
              head_branch: 'autopilot-test',
              head_sha: 'abc123def456789012345678901234567890abcd',
              status: conclusion === 'in_progress' ? 'in_progress' : 'completed',
              conclusion,
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }

    if (urlString.includes(`/actions/runs/${runId}`) && !urlString.includes('/jobs')) {
      return new Response(
        JSON.stringify({
          id: runId,
          run_number: 1,
          name: 'CI',
          event: 'pull_request',
          head_branch: 'autopilot-test',
          head_sha: 'abc123def456789012345678901234567890abcd',
          status: conclusion === 'in_progress' ? 'in_progress' : 'completed',
          conclusion,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }

    return new Response(JSON.stringify({ message: 'not found' }), {
      status: 404,
      headers: { 'content-type': 'application/json' },
    });
  };
  return fetchFn;
}

function cleanup(config: AutopilotRunConfig): void {
  if (existsSync(config.report_dir)) {
    rmSync(config.report_dir, { recursive: true, force: true });
  }
}

describe('autopilot-run runner', () => {
  test('missing config gives AUTOPILOT_CONFIG_ERROR', async () => {
    const config = baseConfig({ mvp_config_path: 'nonexistent/mvp-config.json' });
    try {
      const result = await runAutopilotRun(config, '/tmp/autopilot.json');
      assert.strictEqual(result.verdict, 'AUTOPILOT_CONFIG_ERROR');
      assert.ok(
        result.reason.includes('not found') ||
          result.reason.includes('unreadable') ||
          result.reason.includes('config') ||
          result.reason.includes('MVP'),
        `expected config-related reason, got: ${result.reason}`
      );
    } finally {
      cleanup(config);
    }
  });

  test('MVP failure returns AUTOPILOT_MVP_FAILED', async () => {
    const config = baseConfig();
    try {
      const result = await runAutopilotRun(config, '/tmp/autopilot.json', {
        runMvpRunFn: async () => fakeMvpResult({ verdict: 'MVP_RUN_FAILED', reason: 'Task failed' }),
      });
      assert.strictEqual(result.verdict, 'AUTOPILOT_MVP_FAILED');
      assert.ok(result.reason.includes('MVP_RUN_FAILED'));
    } finally {
      cleanup(config);
    }
  });

  test('safe fake mode runs without GitHub token', async () => {
    const config = baseConfig();
    delete process.env.GITHUB_TOKEN;
    try {
      const result = await runAutopilotRun(config, '/tmp/autopilot.json', {
        runMvpRunFn: async () => fakeMvpResult(),
      });
      assert.strictEqual(result.verdict, 'AUTOPILOT_MVP_DONE_CI_NOT_OBSERVED');
      assert.strictEqual(result.exit_code, 0);
    } finally {
      cleanup(config);
    }
  });

  test('safe fake mode writes report and timeline', async () => {
    const config = baseConfig();
    try {
      const result = await runAutopilotRun(config, '/tmp/autopilot.json', {
        runMvpRunFn: async () => fakeMvpResult(),
      });
      assert.strictEqual(result.verdict, 'AUTOPILOT_MVP_DONE_CI_NOT_OBSERVED');
      assert.ok(existsSync(join(result.report_dir, 'report.md')));
      assert.ok(existsSync(join(result.report_dir, 'report.json')));
      assert.ok(existsSync(join(result.report_dir, 'timeline.json')));

      const timeline = JSON.parse(readFileSync(join(result.report_dir, 'timeline.json'), 'utf-8')) as Array<{ event: string }>;
      const events = timeline.map((t) => t.event);
      assert.ok(events.includes('preflight'));
      assert.ok(events.includes('mvp_started'));
      assert.ok(events.includes('mvp_completed'));
    } finally {
      cleanup(config);
    }
  });

  test('missing token with ci enabled gives AUTOPILOT_NEEDS_TOKEN', async () => {
    const config = baseConfig({
      mode: 'github',
      ci: { enabled: true, wait_for_ci: true, poll_interval_seconds: 1, timeout_seconds: 2 },
    });
    delete process.env.GITHUB_TOKEN;
    try {
      const result = await runAutopilotRun(config, '/tmp/autopilot.json', {
        runMvpRunFn: async () => fakeMvpResult(),
      });
      assert.strictEqual(result.verdict, 'AUTOPILOT_NEEDS_TOKEN');
      assert.strictEqual(result.exit_code, 1);
    } finally {
      cleanup(config);
    }
  });

  test('CI green path returns AUTOPILOT_GREEN', async () => {
    const config = baseConfig({
      mode: 'github',
      ci: { enabled: true, wait_for_ci: true, poll_interval_seconds: 1, timeout_seconds: 5 },
    });
    process.env.GITHUB_TOKEN = 'ghp_faketesttoken';
    try {
      const result = await runAutopilotRun(config, '/tmp/autopilot.json', {
        runMvpRunFn: async () => fakeMvpResult(),
        fetchFn: makeGithubFetch('success'),
        spawnFn: fakeSuccessSpawn,
      });
      assert.strictEqual(result.verdict, 'AUTOPILOT_GREEN');
      assert.strictEqual(result.exit_code, 0);
      assert.strictEqual(result.ci_conclusion, 'success');
    } finally {
      delete process.env.GITHUB_TOKEN;
      cleanup(config);
    }
  });

  test('CI timeout returns AUTOPILOT_CI_TIMEOUT', async () => {
    const config = baseConfig({
      mode: 'github',
      ci: { enabled: true, wait_for_ci: true, poll_interval_seconds: 1, timeout_seconds: 1 },
    });
    process.env.GITHUB_TOKEN = 'ghp_faketesttoken';
    try {
      const result = await runAutopilotRun(config, '/tmp/autopilot.json', {
        runMvpRunFn: async () => fakeMvpResult(),
        fetchFn: makeGithubFetch('in_progress'),
        spawnFn: fakeSuccessSpawn,
      });
      assert.strictEqual(result.verdict, 'AUTOPILOT_CI_TIMEOUT');
      assert.strictEqual(result.exit_code, 1);
    } finally {
      delete process.env.GITHUB_TOKEN;
      cleanup(config);
    }
  });

  test('CI red with repair disabled returns AUTOPILOT_CI_RED_DIAGNOSED', async () => {
    const config = baseConfig({
      mode: 'github',
      ci: { enabled: true, wait_for_ci: true, poll_interval_seconds: 1, timeout_seconds: 5 },
      repair: { enabled: false, max_attempts: 2, provider: 'mock', allow_real_provider: false, allow_apply: false, allow_commit: false, allow_push: false, denied_files: ['.env*'] },
    });
    process.env.GITHUB_TOKEN = 'ghp_faketesttoken';

    const reportDir = tmpDir();
    const paths = fakeReportPaths(reportDir);

    try {
      const result = await runAutopilotRun(config, '/tmp/autopilot.json', {
        runMvpRunFn: async () => fakeMvpResult(),
        runDiagnoseCiFn: async () =>
          fakeDiagnoseResult({
            verdict: 'DIAGNOSE_CI_RED',
            classification: 'TEST_FAILURE',
            confidence: 'high',
            report_paths: paths,
            reason: 'Test failed',
          }),
        fetchFn: makeGithubFetch('failure'),
        spawnFn: fakeSuccessSpawn,
      });
      assert.strictEqual(result.verdict, 'AUTOPILOT_CI_RED_DIAGNOSED');
      assert.strictEqual(result.exit_code, 0);
      assert.ok(existsSync(join(result.report_dir, 'latest-fix-task.md')));
      assert.ok(existsSync(join(result.report_dir, 'latest-diagnosis.json')));
    } finally {
      delete process.env.GITHUB_TOKEN;
      cleanup(config);
      rmSync(reportDir, { recursive: true, force: true });
    }
  });

  test('repair loop stops after max_attempts', async () => {
    const config = baseConfig({
      mode: 'github',
      ci: { enabled: true, wait_for_ci: true, poll_interval_seconds: 1, timeout_seconds: 5 },
      repair: {
        enabled: true,
        max_attempts: 2,
        provider: 'mock',
        allow_real_provider: false,
        allow_apply: true,
        allow_commit: true,
        allow_push: true,
        allowed_files: ['src/fix.ts'],
        denied_files: ['.env*'],
      },
    });
    process.env.GITHUB_TOKEN = 'ghp_faketesttoken';

    const reportDir = tmpDir();
    const paths = fakeReportPaths(reportDir);

    const gitCalls: Array<{ command: string; args: string[] }> = [];
    const spawnFn = (command: string, args: string[]) => {
      gitCalls.push({ command, args });
      if (command === 'git' && args[0] === 'rev-parse') {
        return fakeSuccessSpawn(command, args);
      }
      return {
        status: 0,
        signal: null,
        output: [null, '', ''],
        stdout: '',
        stderr: '',
        pid: 0,
      } as SpawnSyncReturns<string>;
    };

    try {
      const result = await runAutopilotRun(config, '/tmp/autopilot.json', {
        runMvpRunFn: async () => fakeMvpResult(),
        runDiagnoseCiFn: async () =>
          fakeDiagnoseResult({
            verdict: 'DIAGNOSE_CI_RED',
            classification: 'TEST_FAILURE',
            confidence: 'high',
            report_paths: paths,
            reason: 'Test failed',
          }),
        fetchFn: makeGithubFetch('failure'),
        spawnFn,
      });
      assert.strictEqual(result.verdict, 'AUTOPILOT_REPAIR_EXHAUSTED');
      assert.strictEqual(result.repair_attempts, 2);
      assert.strictEqual(result.exit_code, 1);

      const pushes = gitCalls.filter((c) => c.command === 'git' && c.args[0] === 'push');
      assert.strictEqual(pushes.length, 2, 'expected push after each repair attempt');
      const merges = gitCalls.filter((c) => c.command === 'git' && c.args.includes('merge'));
      assert.strictEqual(merges.length, 0, 'no merge should be performed');
    } finally {
      delete process.env.GITHUB_TOKEN;
      cleanup(config);
      rmSync(reportDir, { recursive: true, force: true });
    }
  });

  test('provider bad output is classified safely', async () => {
    const config = baseConfig({
      mode: 'github',
      ci: { enabled: true, wait_for_ci: true, poll_interval_seconds: 1, timeout_seconds: 5 },
      repair: {
        enabled: true,
        max_attempts: 1,
        provider: 'mock',
        allow_real_provider: false,
        allow_apply: true,
        allow_commit: false,
        allow_push: false,
        allowed_files: ['src/fix.ts'],
        denied_files: ['.env*'],
      },
    });
    process.env.GITHUB_TOKEN = 'ghp_faketesttoken';
    process.env.AUTOPILOT_REPAIR_MOCK_RESPONSE = 'not-valid-json';

    const reportDir = tmpDir();
    const paths = fakeReportPaths(reportDir);

    try {
      const result = await runAutopilotRun(config, '/tmp/autopilot.json', {
        runMvpRunFn: async () => fakeMvpResult(),
        runDiagnoseCiFn: async () =>
          fakeDiagnoseResult({
            verdict: 'DIAGNOSE_CI_RED',
            classification: 'TEST_FAILURE',
            confidence: 'high',
            report_paths: paths,
            reason: 'Test failed',
          }),
        fetchFn: makeGithubFetch('failure'),
        spawnFn: fakeSuccessSpawn,
      });
      assert.strictEqual(result.verdict, 'AUTOPILOT_REPAIR_FAILED');
      assert.ok(result.reason.includes('parse') || result.reason.includes('Provider'));
      assert.strictEqual(result.exit_code, 1);
    } finally {
      delete process.env.GITHUB_TOKEN;
      delete process.env.AUTOPILOT_REPAIR_MOCK_RESPONSE;
      cleanup(config);
      rmSync(reportDir, { recursive: true, force: true });
    }
  });

  test('forbidden write actions are not called unless enabled', async () => {
    const config = baseConfig({
      mode: 'github',
      ci: { enabled: true, wait_for_ci: true, poll_interval_seconds: 1, timeout_seconds: 5 },
      repair: {
        enabled: true,
        max_attempts: 1,
        provider: 'mock',
        allow_real_provider: false,
        allow_apply: false,
        allow_commit: false,
        allow_push: false,
        allowed_files: ['src/fix.ts'],
        denied_files: ['.env*'],
      },
    });
    process.env.GITHUB_TOKEN = 'ghp_faketesttoken';

    const reportDir = tmpDir();
    const paths = fakeReportPaths(reportDir);

    const gitCalls: Array<{ command: string; args: string[] }> = [];
    const spawnFn = (command: string, args: string[]) => {
      gitCalls.push({ command, args });
      return fakeSuccessSpawn(command, args);
    };

    try {
      const result = await runAutopilotRun(config, '/tmp/autopilot.json', {
        runMvpRunFn: async () => fakeMvpResult(),
        runDiagnoseCiFn: async () =>
          fakeDiagnoseResult({
            verdict: 'DIAGNOSE_CI_RED',
            classification: 'TEST_FAILURE',
            confidence: 'high',
            report_paths: paths,
            reason: 'Test failed',
          }),
        fetchFn: makeGithubFetch('failure'),
        spawnFn,
      });
      assert.strictEqual(result.verdict, 'AUTOPILOT_REPAIR_EXHAUSTED');
      const commits = gitCalls.filter((c) => c.command === 'git' && c.args[0] === 'commit');
      const pushes = gitCalls.filter((c) => c.command === 'git' && c.args[0] === 'push');
      assert.strictEqual(commits.length, 0, 'commit should not be called when disabled');
      assert.strictEqual(pushes.length, 0, 'push should not be called when disabled');
    } finally {
      delete process.env.GITHUB_TOKEN;
      cleanup(config);
      rmSync(reportDir, { recursive: true, force: true });
    }
  });

  test('no merge or force-push workflow action called', async () => {
    const config = baseConfig({
      mode: 'github',
      ci: { enabled: true, wait_for_ci: true, poll_interval_seconds: 1, timeout_seconds: 5 },
    });
    process.env.GITHUB_TOKEN = 'ghp_faketesttoken';

    const calls: Array<{ url: string; method?: string }> = [];
    const fetchFn = async (url: string | URL | Request, init?: RequestInit) => {
      const urlString = url.toString();
      const method = init?.method ?? 'GET';
      calls.push({ url: urlString, method });
      return makeGithubFetch('success')(url, init);
    };

    try {
      const result = await runAutopilotRun(config, '/tmp/autopilot.json', {
        runMvpRunFn: async () => fakeMvpResult(),
        fetchFn,
        spawnFn: fakeSuccessSpawn,
      });
      assert.strictEqual(result.verdict, 'AUTOPILOT_GREEN');
      for (const call of calls) {
        assert.strictEqual(call.method, 'GET', `expected only GET calls, got ${call.method} ${call.url}`);
        assert.ok(!call.url.includes('/merge'), `merge endpoint called: ${call.url}`);
        assert.ok(!call.url.includes('/rerun'), `rerun endpoint called: ${call.url}`);
        assert.ok(!call.url.includes('force'), `force-push signal in URL: ${call.url}`);
      }
    } finally {
      delete process.env.GITHUB_TOKEN;
      cleanup(config);
    }
  });
});
