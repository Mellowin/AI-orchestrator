import { describe, test } from 'node:test';
import assert from 'node:assert';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ReliabilityCampaignState, ReliabilityConfig, ReliabilityScenarioConfig } from '../src/reliability/types.js';
import {
  buildGitHubTokenRemoteUrl,
  closePullRequest,
  getChangedFilesSinceSha,
  loadCampaignState,
  parseRepoSlug,
  pollGitHubActionsRun,
  pushBranchWithToken,
  runGitHubScenario,
  saveCampaignState,
  validateFinalRepairScope,
} from '../src/reliability/runner-helpers.js';

function makeTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

describe('reliability github runner helpers', () => {
  test('parseRepoSlug splits owner and repo', () => {
    const parsed = parseRepoSlug('Mellowin/AI-orchestrator');
    assert.strictEqual(parsed.owner, 'Mellowin');
    assert.strictEqual(parsed.repo, 'AI-orchestrator');
  });

  test('parseRepoSlug throws on invalid slug', () => {
    assert.throws(() => parseRepoSlug('invalid'), /Invalid repo_slug/);
  });

  test('buildGitHubTokenRemoteUrl uses x-access-token scheme', () => {
    const url = buildGitHubTokenRemoteUrl('owner', 'repo', 'ghp_test_token_value');
    assert.strictEqual(url, 'https://x-access-token:ghp_test_token_value@github.com/owner/repo.git');
  });

  test('saveCampaignState and loadCampaignState roundtrip', () => {
    const dir = makeTempDir('rel-state-');
    const state: ReliabilityCampaignState = {
      run_id: 'run-1',
      mode: 'github',
      started_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
      scenarios: [
        {
          scenario_id: 'missing-github-token',
          status: 'done',
          branch: 'reliability-missing-github-token-123',
          pr_number: 7,
          pr_url: 'https://github.com/owner/repo/pull/7',
          setup_sha: 'setupsha001',
          repair_shas: [],
          original_ci_run_id: 101,
          original_ci_conclusion: 'failure',
          final_ci_run_id: 102,
          final_ci_conclusion: 'success',
        },
      ],
    };
    saveCampaignState(dir, state);
    const loaded = loadCampaignState(dir);
    assert.deepStrictEqual(loaded, state);
  });

  test('pushBranchWithToken sets authenticated origin, pushes, and restores original url', async () => {
    const repoDir = makeTempDir('rel-repo-');
    // Initialize a real git repo so getGitRemoteUrl has something to read.
    spawnSync('git', ['init'], { cwd: repoDir, encoding: 'utf-8', shell: false });
    spawnSync('git', ['remote', 'add', 'origin', 'https://github.com/original/remote.git'], {
      cwd: repoDir,
      encoding: 'utf-8',
      shell: false,
    });

    const commands: string[][] = [];
    const fakeSpawn = ((cmd: string, args: string[], opts?: { cwd?: string; encoding?: string; shell?: boolean; timeout?: number }) => {
      commands.push([cmd, ...args]);
      const cwd = opts?.cwd ?? process.cwd();
      if (cmd === 'git' && args[0] === 'rev-parse' && args[1] === 'HEAD') {
        return { status: 0, stdout: 'pushed-sha-001', stderr: '' } as SpawnSyncReturns<string>;
      }
      return { status: 0, stdout: '', stderr: '' } as SpawnSyncReturns<string>;
    }) as typeof spawnSync;

    const result = await pushBranchWithToken(repoDir, 'rel-test-branch', 'ghp_token_123', 'owner', 'repo', fakeSpawn);

    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.sha, 'pushed-sha-001');

    const setUrlCalls = commands.filter((c) => c[0] === 'git' && c[1] === 'remote' && c[2] === 'set-url');
    assert.ok(setUrlCalls.length >= 1, 'should set origin url');
    const tokenUrlCall = setUrlCalls.find((c) => c[4]?.includes('x-access-token:'));
    assert.ok(tokenUrlCall, 'token url should use x-access-token');
    assert.ok(tokenUrlCall![4].includes('github.com/owner/repo.git'), 'token url should target repo');

    const pushCall = commands.find((c) => c[0] === 'git' && c[1] === 'push');
    assert.ok(pushCall, 'should push branch');
    assert.deepStrictEqual(pushCall!.slice(2, 4), ['origin', 'rel-test-branch']);

    // Original url should be restored after push.
    const remoteUrl = spawnSync('git', ['remote', 'get-url', 'origin'], {
      cwd: repoDir,
      encoding: 'utf-8',
      shell: false,
    });
    assert.strictEqual(remoteUrl.stdout.trim(), 'https://github.com/original/remote.git');
  });

  test('pushBranchWithToken redacts token from error messages', async () => {
    const repoDir = makeTempDir('rel-repo-');
    const token = 'ghp_super_secret_token_12345';
    const fakeSpawn = (() =>
      ({
        status: 1,
        stdout: '',
        stderr: `remote: Invalid username or password. fatal: Authentication failed for https://x-access-token:${token}@github.com/owner/repo.git/`,
      } as SpawnSyncReturns<string>)) as typeof spawnSync;

    const result = await pushBranchWithToken(repoDir, 'branch', token, 'owner', 'repo', fakeSpawn);
    assert.strictEqual(result.ok, false);
    assert.ok(result.message);
    assert.ok(!result.message!.includes(token), 'error message should not contain raw token');
  });

  test('pollGitHubActionsRun returns completed run info', async () => {
    const fakeFetch = async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      assert.ok(url.includes('/actions/runs'), 'should poll actions runs endpoint');
      assert.ok(url.includes('head_sha=abc123'), 'should filter by head sha');
      return {
        ok: true,
        status: 200,
        json: async () => ({
          workflow_runs: [{ id: 42, status: 'completed', conclusion: 'failure' }],
        }),
      } as Response;
    };

    const config: ReliabilityConfig = {
      run_id: 'r',
      mode: 'github',
      repo_slug: 'owner/repo',
      repo_path: makeTempDir('rel-src-'),
      base_branch: 'main',
      scenario_dir: makeTempDir('rel-scen-'),
      max_repair_attempts: 2,
      real_github: true,
      real_provider: false,
      report_dir: makeTempDir('rel-report-'),
      ci_timeout_seconds: 1,
      ci_poll_interval_seconds: 1,
    };

    const run = await pollGitHubActionsRun('owner', 'repo', 'abc123', 'token', config, fakeFetch, Date.now);
    assert.ok(run);
    assert.strictEqual(run!.run_id, 42);
    assert.strictEqual(run!.conclusion, 'failure');
  });

  test('pollGitHubActionsRun returns null on timeout', async () => {
    let calls = 0;
    const fakeFetch = async () => {
      calls += 1;
      return {
        ok: true,
        status: 200,
        json: async () => ({ workflow_runs: [{ id: 1, status: 'in_progress', conclusion: null }] }),
      } as Response;
    };

    const config: ReliabilityConfig = {
      run_id: 'r',
      mode: 'github',
      repo_slug: 'owner/repo',
      repo_path: makeTempDir('rel-src-'),
      base_branch: 'main',
      scenario_dir: makeTempDir('rel-scen-'),
      max_repair_attempts: 2,
      real_github: true,
      real_provider: false,
      report_dir: makeTempDir('rel-report-'),
      ci_timeout_seconds: 1,
      ci_poll_interval_seconds: 1,
    };

    const run = await pollGitHubActionsRun('owner', 'repo', 'abc123', 'token', config, fakeFetch, Date.now);
    assert.strictEqual(run, null);
    assert.ok(calls >= 1, 'should have polled at least once');
  });

  test('closePullRequest sends PATCH with state closed', async () => {
    let capturedUrl: string | undefined;
    let capturedBody: string | undefined;
    const fakeFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      capturedUrl = typeof input === 'string' ? input : input.toString();
      capturedBody = init?.body ? String(init.body) : undefined;
      return { ok: true, status: 200, json: async () => ({}) } as Response;
    };

    const closed = await closePullRequest('owner', 'repo', 42, 'token', fakeFetch);
    assert.strictEqual(closed, true);
    assert.ok(capturedUrl);
    assert.ok(capturedUrl!.includes('/repos/owner/repo/pulls/42'), `got ${capturedUrl}`);
    assert.strictEqual(capturedBody, JSON.stringify({ state: 'closed' }));
  });
});

describe('reliability github scenario runner', () => {
  function buildSourceRepo(): string {
    const dir = makeTempDir('rel-src-');
    writeFileSync(join(dir, 'src.txt'), 'good content\n', 'utf-8');
    return dir;
  }

  function buildScenario(): ReliabilityScenarioConfig {
    return {
      id: 'fake-fix',
      category: 'fixable',
      classification: 'TEST_ASSERTION_FAILURE',
      fixable: true,
      repair_strategy: 'apply_fix_patch',
      allowed_files: ['src.txt'],
      setup: [{ path: 'src.txt', search: 'good', replace: 'bad' }],
      fix: [{ path: 'src.txt', search: 'bad', replace: 'good' }],
      expected_verdict: 'REPAIRED',
    };
  }

  function buildConfig(sourceRepo: string, reportDir: string, tokenEnvName: string): ReliabilityConfig {
    return {
      run_id: 'github-test-run',
      mode: 'github',
      repo_slug: 'owner/repo',
      repo_path: sourceRepo,
      base_branch: 'main',
      scenario_dir: join(sourceRepo, 'scenarios'),
      max_repair_attempts: 2,
      real_github: true,
      real_provider: false,
      report_dir: reportDir,
      github_token_env: tokenEnvName,
      ci_timeout_seconds: 1,
      ci_poll_interval_seconds: 1,
    };
  }

  test('runGitHubScenario returns EXTERNAL_BLOCKER for external scenario without pushing', async () => {
    const sourceRepo = buildSourceRepo();
    const reportDir = makeTempDir('rel-report-');
    const envName = 'RELIABILITY_TEST_TOKEN_EXTERNAL';
    process.env[envName] = 'ghp_test_token';

    const scenario: ReliabilityScenarioConfig = {
      id: 'missing-github-token',
      category: 'external',
      classification: 'GITHUB_ACCESS_FAILURE',
      fixable: false,
      allowed_files: [],
      setup: [],
      fix: [],
      expected_verdict: 'EXTERNAL_BLOCKER',
    };

    let fetchCalls = 0;
    let spawnCalls = 0;
    const fakeFetch = (() => {
      fetchCalls += 1;
      return Promise.resolve({ ok: false, status: 500, json: async () => ({}) } as Response);
    }) as unknown as typeof globalThis.fetch;
    const fakeSpawn = ((..._args: unknown[]) => {
      spawnCalls += 1;
      return { status: 0, stdout: '', stderr: '' } as SpawnSyncReturns<string>;
    }) as typeof spawnSync;

    const state: ReliabilityCampaignState = {
      run_id: 'github-test-run',
      mode: 'github',
      started_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      scenarios: [],
    };

    const result = await runGitHubScenario(
      scenario,
      buildConfig(sourceRepo, reportDir, envName),
      reportDir,
      { fetchFn: fakeFetch, spawnFn: fakeSpawn },
      state,
      () => {}
    );

    assert.strictEqual(result.verdict, 'EXTERNAL_BLOCKER');
    assert.strictEqual(fetchCalls, 0, 'should not call GitHub API for external blocker');
    assert.strictEqual(spawnCalls, 0, 'should not invoke git for external blocker');
  });

  test('runGitHubScenario creates PR, polls CI, pushes repair, and closes PR', async () => {
    const sourceRepo = buildSourceRepo();
    const reportDir = makeTempDir('rel-report-');
    const envName = 'RELIABILITY_TEST_TOKEN_FIX';
    process.env[envName] = 'ghp_test_token';

    const scenario = buildScenario();
    const config = buildConfig(sourceRepo, reportDir, envName);

    let commitCount = 0;
    let branchName = '';
    const commands: string[][] = [];

    const fakeSpawn = ((cmd: string, args: string[], opts?: { cwd?: string; encoding?: string; shell?: boolean; timeout?: number }) => {
      commands.push([cmd, ...args]);
      if (cmd === 'git' && args[0] === 'clone') {
        const target = args[2];
        mkdirSync(target, { recursive: true });
        writeFileSync(join(target, 'src.txt'), readFileSync(join(sourceRepo, 'src.txt')), 'utf-8');
        return { status: 0, stdout: '', stderr: '' } as SpawnSyncReturns<string>;
      }
      if (cmd === 'git' && args[0] === 'checkout' && args[1] === '-b') {
        branchName = args[2];
        return { status: 0, stdout: '', stderr: '' } as SpawnSyncReturns<string>;
      }
      if (cmd === 'git' && args[0] === 'commit') {
        commitCount += 1;
        return { status: 0, stdout: '', stderr: '' } as SpawnSyncReturns<string>;
      }
      if (cmd === 'git' && args[0] === 'rev-parse' && args[1] === 'HEAD') {
        const sha = commitCount === 1 ? 'setup-sha-001' : 'repair-sha-001';
        return { status: 0, stdout: sha, stderr: '' } as SpawnSyncReturns<string>;
      }
      if (cmd === 'git' && args[0] === 'diff' && args[1] === '--cached') {
        return { status: 1, stdout: '', stderr: '' } as SpawnSyncReturns<string>;
      }
      return { status: 0, stdout: '', stderr: '' } as SpawnSyncReturns<string>;
    }) as typeof spawnSync;

    let prCreated = false;
    let prClosed = false;
    let setupPolled = false;
    let repairPolled = false;

    const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (init?.method === 'POST' && url.includes('/pulls')) {
        prCreated = true;
        return {
          ok: true,
          status: 201,
          json: async () => ({
            html_url: 'https://github.com/owner/repo/pull/7',
            number: 7,
            draft: true,
            base: { ref: 'main' },
            head: { ref: branchName },
          }),
        } as Response;
      }
      if (init?.method === 'GET' && url.includes('/actions/runs')) {
        const sha = new URL(url).searchParams.get('head_sha');
        if (sha === 'setup-sha-001') {
          setupPolled = true;
          return {
            ok: true,
            status: 200,
            json: async () => ({ workflow_runs: [{ id: 101, status: 'completed', conclusion: 'failure' }] }),
          } as Response;
        }
        if (sha === 'repair-sha-001') {
          repairPolled = true;
          return {
            ok: true,
            status: 200,
            json: async () => ({ workflow_runs: [{ id: 102, status: 'completed', conclusion: 'success' }] }),
          } as Response;
        }
        return { ok: true, status: 200, json: async () => ({ workflow_runs: [] }) } as Response;
      }
      if (init?.method === 'PATCH' && url.includes('/pulls/')) {
        prClosed = true;
        return { ok: true, status: 200, json: async () => ({}) } as Response;
      }
      return { ok: false, status: 404, text: async () => 'not found' } as Response;
    }) as unknown as typeof globalThis.fetch;

    const state: ReliabilityCampaignState = {
      run_id: 'github-test-run',
      mode: 'github',
      started_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      scenarios: [],
    };

    const result = await runGitHubScenario(
      scenario,
      config,
      reportDir,
      { fetchFn: fakeFetch, spawnFn: fakeSpawn },
      state,
      (s) => saveCampaignState(reportDir, s)
    );

    assert.strictEqual(result.verdict, 'REPAIRED');
    assert.strictEqual(result.pr_number, 7);
    assert.strictEqual(result.pr_url, 'https://github.com/owner/repo/pull/7');
    assert.strictEqual(result.original_ci_run_id, 101);
    assert.strictEqual(result.original_ci_conclusion, 'failure');
    assert.strictEqual(result.final_ci_run_id, 102);
    assert.strictEqual(result.final_ci_conclusion, 'success');
    assert.strictEqual(prCreated, true);
    assert.strictEqual(prClosed, true);
    assert.strictEqual(setupPolled, true);
    assert.strictEqual(repairPolled, true);

    const persisted = loadCampaignState(reportDir);
    assert.ok(persisted);
    const scenarioState = persisted!.scenarios.find((s) => s.scenario_id === scenario.id);
    assert.ok(scenarioState);
    assert.strictEqual(scenarioState!.pr_number, 7);
    assert.strictEqual(scenarioState!.original_ci_conclusion, 'failure');
    assert.strictEqual(scenarioState!.final_ci_conclusion, 'success');
  });

  test('runGitHubScenario resumes from repair_pushed without creating duplicate PR', async () => {
    const sourceRepo = buildSourceRepo();
    const reportDir = makeTempDir('rel-report-');
    const envName = 'RELIABILITY_TEST_TOKEN_RESUME';
    process.env[envName] = 'ghp_test_token';

    const scenario = buildScenario();
    const config = buildConfig(sourceRepo, reportDir, envName);

    const state: ReliabilityCampaignState = {
      run_id: 'github-test-run',
      mode: 'github',
      started_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      scenarios: [
        {
          scenario_id: scenario.id,
          status: 'repair_pushed',
          branch: 'reliability-fake-fix-resume',
          pr_number: 7,
          pr_url: 'https://github.com/owner/repo/pull/7',
          setup_sha: 'setup-sha-001',
          original_ci_run_id: 101,
          original_ci_conclusion: 'failure',
          repair_shas: ['repair-sha-001'],
        },
      ],
    };

    let prCreated = false;
    let prClosed = false;
    let repairPolled = false;

    const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (init?.method === 'POST' && url.includes('/pulls')) {
        prCreated = true;
        return { ok: true, status: 201, json: async () => ({ number: 99 }) } as Response;
      }
      if (init?.method === 'GET' && url.includes('/actions/runs')) {
        const sha = new URL(url).searchParams.get('head_sha');
        if (sha === 'repair-sha-001') {
          repairPolled = true;
          return {
            ok: true,
            status: 200,
            json: async () => ({ workflow_runs: [{ id: 102, status: 'completed', conclusion: 'success' }] }),
          } as Response;
        }
        return { ok: true, status: 200, json: async () => ({ workflow_runs: [] }) } as Response;
      }
      if (init?.method === 'PATCH' && url.includes('/pulls/')) {
        prClosed = true;
        return { ok: true, status: 200, json: async () => ({}) } as Response;
      }
      return { ok: false, status: 404, text: async () => 'not found' } as Response;
    }) as unknown as typeof globalThis.fetch;

    const fakeSpawn = (() => ({ status: 0, stdout: '', stderr: '' } as SpawnSyncReturns<string>)) as typeof spawnSync;

    const result = await runGitHubScenario(
      scenario,
      config,
      reportDir,
      { fetchFn: fakeFetch, spawnFn: fakeSpawn },
      state,
      (s) => saveCampaignState(reportDir, s)
    );

    assert.strictEqual(result.verdict, 'REPAIRED');
    assert.strictEqual(result.pr_number, 7, 'should reuse existing PR number');
    assert.strictEqual(prCreated, false, 'should not create a new PR on resume');
    assert.strictEqual(prClosed, true);
    assert.strictEqual(repairPolled, true);
  });
});


describe('reliability initial CI conclusion handling', () => {
  function buildSourceRepo(): string {
    const dir = makeTempDir('rel-src-');
    writeFileSync(join(dir, 'src.txt'), 'good content\n', 'utf-8');
    return dir;
  }

  function buildScenario(): ReliabilityScenarioConfig {
    return {
      id: 'fake-fix',
      category: 'fixable',
      classification: 'TEST_ASSERTION_FAILURE',
      fixable: true,
      repair_strategy: 'apply_fix_patch',
      allowed_files: ['src.txt'],
      setup: [{ path: 'src.txt', search: 'good', replace: 'bad' }],
      fix: [{ path: 'src.txt', search: 'bad', replace: 'good' }],
      expected_verdict: 'REPAIRED',
    };
  }

  function buildConfig(sourceRepo: string, reportDir: string, tokenEnvName: string): ReliabilityConfig {
    return {
      run_id: 'github-test-run',
      mode: 'github',
      repo_slug: 'owner/repo',
      repo_path: sourceRepo,
      base_branch: 'main',
      scenario_dir: join(sourceRepo, 'scenarios'),
      max_repair_attempts: 2,
      real_github: true,
      real_provider: false,
      report_dir: reportDir,
      github_token_env: tokenEnvName,
      ci_timeout_seconds: 1,
      ci_poll_interval_seconds: 1,
    };
  }

  test('initial green CI run is rejected as false green', async () => {
    const sourceRepo = buildSourceRepo();
    const reportDir = makeTempDir('rel-report-');
    const envName = 'RELIABILITY_TEST_TOKEN_GREEN';
    process.env[envName] = 'ghp_test_token';

    const scenario = buildScenario();
    const config = buildConfig(sourceRepo, reportDir, envName);

    let pushCount = 0;
    let prClosed = false;

    const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (init?.method === 'POST' && url.includes('/pulls')) {
        return {
          ok: true,
          status: 201,
          json: async () => ({ html_url: 'https://github.com/owner/repo/pull/8', number: 8, draft: true }),
        } as Response;
      }
      if (init?.method === 'GET' && url.includes('/actions/runs')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ workflow_runs: [{ id: 101, status: 'completed', conclusion: 'success' }] }),
        } as Response;
      }
      if (init?.method === 'PATCH' && url.includes('/pulls/')) {
        prClosed = true;
        return { ok: true, status: 200, json: async () => ({}) } as Response;
      }
      return { ok: false, status: 404, text: async () => 'not found' } as Response;
    }) as unknown as typeof globalThis.fetch;

    const fakeSpawn = ((cmd: string, args: string[]) => {
      if (cmd === 'git' && args[0] === 'clone') {
        const target = args[2];
        mkdirSync(target, { recursive: true });
        writeFileSync(join(target, 'src.txt'), readFileSync(join(sourceRepo, 'src.txt')), 'utf-8');
      }
      if (cmd === 'git' && args[0] === 'push') {
        pushCount += 1;
      }
      if (cmd === 'git' && args[0] === 'rev-parse' && args[1] === 'HEAD') {
        return { status: 0, stdout: 'setup-sha-green', stderr: '' } as SpawnSyncReturns<string>;
      }
      return { status: 0, stdout: '', stderr: '' } as SpawnSyncReturns<string>;
    }) as typeof spawnSync;

    const state: ReliabilityCampaignState = {
      run_id: 'github-test-run',
      mode: 'github',
      started_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      scenarios: [],
    };

    const result = await runGitHubScenario(
      scenario,
      config,
      reportDir,
      { fetchFn: fakeFetch, spawnFn: fakeSpawn },
      state,
      () => {}
    );

    assert.strictEqual(result.verdict, 'FALSE_GREEN_REJECTED');
    assert.strictEqual(result.original_ci_conclusion, 'success');
    assert.strictEqual(result.original_ci_run_id, 101);
    assert.strictEqual(pushCount, 1, 'only the setup push should occur');
    assert.strictEqual(prClosed, true, 'should still close the PR safely');
    assert.strictEqual(result.repair_attempts, 0);
  });

  test('initial cancelled CI run is classified as external blocker', async () => {
    const sourceRepo = buildSourceRepo();
    const reportDir = makeTempDir('rel-report-');
    const envName = 'RELIABILITY_TEST_TOKEN_CANCELLED';
    process.env[envName] = 'ghp_test_token';

    const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (init?.method === 'POST' && url.includes('/pulls')) {
        return { ok: true, status: 201, json: async () => ({ number: 9, draft: true }) } as Response;
      }
      if (init?.method === 'GET' && url.includes('/actions/runs')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ workflow_runs: [{ id: 102, status: 'completed', conclusion: 'cancelled' }] }),
        } as Response;
      }
      if (init?.method === 'PATCH' && url.includes('/pulls/')) {
        return { ok: true, status: 200, json: async () => ({}) } as Response;
      }
      return { ok: false, status: 404, text: async () => 'not found' } as Response;
    }) as unknown as typeof globalThis.fetch;

    const fakeSpawn = ((cmd: string, args: string[]) => {
      if (cmd === 'git' && args[0] === 'clone') {
        const target = args[2];
        mkdirSync(target, { recursive: true });
        writeFileSync(join(target, 'src.txt'), readFileSync(join(sourceRepo, 'src.txt')), 'utf-8');
      }
      if (cmd === 'git' && args[0] === 'rev-parse' && args[1] === 'HEAD') {
        return { status: 0, stdout: 'setup-sha-cancelled', stderr: '' } as SpawnSyncReturns<string>;
      }
      return { status: 0, stdout: '', stderr: '' } as SpawnSyncReturns<string>;
    }) as typeof spawnSync;

    const state: ReliabilityCampaignState = {
      run_id: 'github-test-run',
      mode: 'github',
      started_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      scenarios: [],
    };

    const result = await runGitHubScenario(
      buildScenario(),
      buildConfig(sourceRepo, reportDir, envName),
      reportDir,
      { fetchFn: fakeFetch, spawnFn: fakeSpawn },
      state,
      () => {}
    );

    assert.strictEqual(result.verdict, 'EXTERNAL_BLOCKER');
    assert.strictEqual(result.repair_attempts, 0);
  });
});

describe('reliability final repair scope validation', () => {
  test('validateFinalRepairScope flags files outside allowed_files', () => {
    const repoDir = makeTempDir('rel-scope-');
    spawnSync('git', ['init'], { cwd: repoDir, encoding: 'utf-8', shell: false });
    spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoDir, encoding: 'utf-8', shell: false });
    spawnSync('git', ['config', 'user.name', 'Test'], { cwd: repoDir, encoding: 'utf-8', shell: false });
    writeFileSync(join(repoDir, 'allowed.txt'), 'allowed\n', 'utf-8');
    writeFileSync(join(repoDir, 'secret.txt'), 'secret\n', 'utf-8');
    spawnSync('git', ['add', '-A'], { cwd: repoDir, encoding: 'utf-8', shell: false });
    spawnSync('git', ['commit', '-m', 'base'], { cwd: repoDir, encoding: 'utf-8', shell: false });
    const baseResult = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repoDir, encoding: 'utf-8', shell: false });
    const baseSha = baseResult.stdout.trim();

    writeFileSync(join(repoDir, 'allowed.txt'), 'allowed modified\n', 'utf-8');
    writeFileSync(join(repoDir, 'secret.txt'), 'secret modified\n', 'utf-8');
    spawnSync('git', ['add', '-A'], { cwd: repoDir, encoding: 'utf-8', shell: false });
    spawnSync('git', ['commit', '-m', 'repair'], { cwd: repoDir, encoding: 'utf-8', shell: false });

    const scope = validateFinalRepairScope(repoDir, baseSha, ['allowed.txt'], spawnSync);
    assert.strictEqual(scope.ok, false);
    assert.deepStrictEqual(scope.unauthorized, ['secret.txt']);
  });

  test('validateFinalRepairScope allows explicitly listed TESTING_SUMMARY.md', () => {
    const repoDir = makeTempDir('rel-scope-summary-');
    spawnSync('git', ['init'], { cwd: repoDir, encoding: 'utf-8', shell: false });
    spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoDir, encoding: 'utf-8', shell: false });
    spawnSync('git', ['config', 'user.name', 'Test'], { cwd: repoDir, encoding: 'utf-8', shell: false });
    writeFileSync(join(repoDir, 'TESTING_SUMMARY.md'), '# Summary\n', 'utf-8');
    spawnSync('git', ['add', '-A'], { cwd: repoDir, encoding: 'utf-8', shell: false });
    spawnSync('git', ['commit', '-m', 'base'], { cwd: repoDir, encoding: 'utf-8', shell: false });
    const baseResult = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repoDir, encoding: 'utf-8', shell: false });
    const baseSha = baseResult.stdout.trim();

    writeFileSync(join(repoDir, 'TESTING_SUMMARY.md'), '# Summary Updated\n', 'utf-8');
    spawnSync('git', ['add', '-A'], { cwd: repoDir, encoding: 'utf-8', shell: false });
    spawnSync('git', ['commit', '-m', 'summary update'], { cwd: repoDir, encoding: 'utf-8', shell: false });

    const scope = validateFinalRepairScope(repoDir, baseSha, ['TESTING_SUMMARY.md'], spawnSync);
    assert.strictEqual(scope.ok, true);
    assert.deepStrictEqual(scope.unauthorized, []);
  });

  test('runGitHubScenario rejects repair when final scope includes unauthorized file', async () => {
    const sourceRepo = makeTempDir('rel-src-');
    writeFileSync(join(sourceRepo, 'src.txt'), 'good content\n', 'utf-8');
    const reportDir = makeTempDir('rel-report-');
    const envName = 'RELIABILITY_TEST_TOKEN_SCOPE';
    process.env[envName] = 'ghp_test_token';

    const scenario: ReliabilityScenarioConfig = {
      id: 'scope-violation',
      category: 'fixable',
      classification: 'TEST_ASSERTION_FAILURE',
      fixable: true,
      repair_strategy: 'apply_fix_patch',
      allowed_files: ['src.txt'],
      setup: [{ path: 'src.txt', search: 'good', replace: 'bad' }],
      fix: [{ path: 'src.txt', search: 'bad', replace: 'good' }],
      expected_verdict: 'REPAIRED',
    };

    const config: ReliabilityConfig = {
      run_id: 'github-test-run',
      mode: 'github',
      repo_slug: 'owner/repo',
      repo_path: sourceRepo,
      base_branch: 'main',
      scenario_dir: join(sourceRepo, 'scenarios'),
      max_repair_attempts: 2,
      real_github: true,
      real_provider: false,
      report_dir: reportDir,
      github_token_env: envName,
      ci_timeout_seconds: 1,
      ci_poll_interval_seconds: 1,
    };

    let pushCount = 0;

    const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (init?.method === 'POST' && url.includes('/pulls')) {
        return { ok: true, status: 201, json: async () => ({ number: 10, draft: true }) } as Response;
      }
      if (init?.method === 'GET' && url.includes('/actions/runs')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ workflow_runs: [{ id: 103, status: 'completed', conclusion: 'failure' }] }),
        } as Response;
      }
      if (init?.method === 'PATCH' && url.includes('/pulls/')) {
        return { ok: true, status: 200, json: async () => ({}) } as Response;
      }
      return { ok: false, status: 404, text: async () => 'not found' } as Response;
    }) as unknown as typeof globalThis.fetch;

    const fakeSpawn = ((cmd: string, args: string[], opts?: { cwd?: string }) => {
      const cwd = opts?.cwd ?? process.cwd();
      if (cmd === 'git' && args[0] === 'clone') {
        const target = args[2];
        mkdirSync(target, { recursive: true });
        writeFileSync(join(target, 'src.txt'), readFileSync(join(sourceRepo, 'src.txt')), 'utf-8');
      }
      if (cmd === 'git' && args[0] === 'push') {
        pushCount += 1;
      }
      if (cmd === 'git' && args[0] === 'rev-parse' && args[1] === 'HEAD') {
        return { status: 0, stdout: 'setup-sha-scope', stderr: '' } as SpawnSyncReturns<string>;
      }
      if (cmd === 'git' && args[0] === 'diff' && args[1] === '--name-only') {
        return { status: 0, stdout: 'src.txt\nextra.txt\n', stderr: '' } as SpawnSyncReturns<string>;
      }
      return { status: 0, stdout: '', stderr: '' } as SpawnSyncReturns<string>;
    }) as typeof spawnSync;

    const state: ReliabilityCampaignState = {
      run_id: 'github-test-run',
      mode: 'github',
      started_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      scenarios: [],
    };

    const result = await runGitHubScenario(
      scenario,
      config,
      reportDir,
      { fetchFn: fakeFetch, spawnFn: fakeSpawn },
      state,
      () => {}
    );

    assert.strictEqual(result.verdict, 'UNSAFE_PATCH_REJECTED');
    assert.deepStrictEqual(result.unauthorized_files, ['extra.txt']);
    assert.strictEqual(pushCount, 1, 'only the setup push should occur');
  });
});

  test('validateFinalRepairScope rejects TESTING_SUMMARY.md when not explicitly scoped', () => {
    const repoDir = makeTempDir('rel-scope-summary-denied-');
    spawnSync('git', ['init'], { cwd: repoDir, encoding: 'utf-8', shell: false });
    spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoDir, encoding: 'utf-8', shell: false });
    spawnSync('git', ['config', 'user.name', 'Test'], { cwd: repoDir, encoding: 'utf-8', shell: false });
    writeFileSync(join(repoDir, 'src.txt'), 'src\n', 'utf-8');
    writeFileSync(join(repoDir, 'TESTING_SUMMARY.md'), '# Summary\n', 'utf-8');
    spawnSync('git', ['add', '-A'], { cwd: repoDir, encoding: 'utf-8', shell: false });
    spawnSync('git', ['commit', '-m', 'base'], { cwd: repoDir, encoding: 'utf-8', shell: false });
    const baseResult = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repoDir, encoding: 'utf-8', shell: false });
    const baseSha = baseResult.stdout.trim();

    writeFileSync(join(repoDir, 'TESTING_SUMMARY.md'), '# Summary Updated\n', 'utf-8');
    spawnSync('git', ['add', '-A'], { cwd: repoDir, encoding: 'utf-8', shell: false });
    spawnSync('git', ['commit', '-m', 'summary update'], { cwd: repoDir, encoding: 'utf-8', shell: false });

    const scope = validateFinalRepairScope(repoDir, baseSha, ['src.txt'], spawnSync);
    assert.strictEqual(scope.ok, false);
    assert.deepStrictEqual(scope.unauthorized, ['TESTING_SUMMARY.md']);
  });
