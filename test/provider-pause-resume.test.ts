import { describe, test } from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runRealRepoRunAICandidateFlow } from '../src/real-repo-run-ai-candidate.js';
import { loadState } from '../src/state-manager.js';
import { parseFakeProviderErrorDirective } from '../src/fake-provider-directive.js';
import type { FetchFn } from '../src/provider-call.js';
import type { Task } from '../src/types.js';
import { buildMissionFromGoal } from '../src/autopilot-one-click/mission-builder.js';
import { runAutopilotPlan } from '../src/autopilot-plan/runner.js';
import { runMultitaskMission } from '../src/autopilot-one-click/multitask/runner.js';
import { loadMissionState, getMissionRunDir } from '../src/autopilot-one-click/multitask/state-manager.js';
import type { AutopilotRunResult } from '../src/autopilot-run/types.js';
import type { MvpRunResult } from '../src/mvp-run/types.js';

const ENV_KEYS = [
  'KIMI_FAKE_RESPONSE',
  'KIMI_FAKE_RESPONSES',
  'REAL_REPO_REVIEWER_FAKE_RESPONSE',
  'REAL_REPO_REVIEWER_SECOND_FAKE_RESPONSE',
  'REAL_REPO_REVIEWER_SECOND_FAKE_RESPONSES',
  'REAL_REPO_REVIEWER_FIX_TASK_KIMI_FAKE_RESPONSE',
  'REAL_REPO_REVIEWER_FIX_TASK_KIMI_FAKE_RESPONSES',
  'REAL_PROVIDER_MAX_ATTEMPTS',
  'REAL_PROVIDER_RETRY_BASE_MS',
  'REAL_PROVIDER_RETRY_MAX_MS',
] as const;

function snapshotEnv(): Map<string, string | undefined> {
  const snap = new Map<string, string | undefined>();
  for (const key of ENV_KEYS) {
    snap.set(key, process.env[key]);
  }
  return snap;
}

function restoreEnv(snap: Map<string, string | undefined>): void {
  for (const [key, value] of snap) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

function fastRetries(): void {
  process.env.REAL_PROVIDER_RETRY_BASE_MS = '0';
  process.env.REAL_PROVIDER_RETRY_MAX_MS = '0';
}

function git(args: string[], cwd: string): { status: number; stdout: string; stderr: string } {
  const result = spawnSync('git', args, { cwd, encoding: 'utf-8', shell: false });
  return {
    status: result.status ?? 1,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
  };
}

function makeTempRepo(name: string): { path: string; baseSha: string; remotePath: string } {
  const root = mkdtempSync(join(tmpdir(), `pause-test-${name}-`));
  const repoPath = join(root, 'repo');
  const remotePath = join(root, 'remote.git');
  mkdirSync(repoPath, { recursive: true });
  mkdirSync(remotePath, { recursive: true });

  git(['init', '--bare'], remotePath);

  git(['init'], repoPath);
  git(['config', 'user.email', 'test@example.com'], repoPath);
  git(['config', 'user.name', 'Test'], repoPath);
  writeFileSync(join(repoPath, 'README.md'), '# base\n', 'utf-8');
  git(['add', 'README.md'], repoPath);
  git(['commit', '-m', 'base'], repoPath);
  git(['remote', 'add', 'origin', remotePath], repoPath);
  git(['push', 'origin', 'HEAD:main'], repoPath);

  const rev = git(['rev-parse', 'HEAD'], repoPath);
  if (rev.status !== 0) throw new Error('Failed to read base sha');
  const baseSha = rev.stdout.trim();
  git(['checkout', '-b', 'mission-pause', baseSha], repoPath);
  git(['push', 'origin', 'HEAD:mission-pause'], repoPath);
  git(['checkout', 'main'], repoPath);

  return { path: repoPath, baseSha, remotePath };
}

function makeTask(repoPath: string): Task {
  return {
    id: 'pause-task',
    title: 'Pause task',
    repo_path: repoPath,
    base_branch: 'main',
    work_branch: 'mission-pause',
    goal: 'Add docs/pause.md',
    context_files: [],
    checks: [],
    guardrails: {
      allow_modify: ['docs/pause.md'],
      deny_modify: ['.env'],
      auto_commit: true,
      auto_push: true,
    },
  };
}

function httpErrorFetch(status: number, body: string): FetchFn {
  return async () => ({
    ok: false,
    status,
    json: async () => ({}),
    text: async () => body,
  });
}

function successFetch(content: string, counter?: { calls: number }): FetchFn {
  return async () => {
    if (counter) counter.calls += 1;
    return {
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content } }] }),
    };
  };
}

function throwingFetch(): FetchFn {
  return async () => {
    throw new Error('fetch must not be called');
  };
}

const CODER_OUTPUT = JSON.stringify({
  mode: 'file_update',
  files: [{ path: 'docs/pause.md', content: '# v1\n' }],
});

const FIX_CODER_OUTPUT = JSON.stringify({
  mode: 'file_update',
  files: [{ path: 'docs/pause.md', content: '# v2\nmore detail\n' }],
});

const FIX_REQUIRED_REVIEWER = JSON.stringify({
  decision: 'reject',
  confidence: 'high',
  blockingIssues: ['Document needs more detail'],
  nonBlockingIssues: [],
  reviewSummary: 'Please expand the document.',
  nextAction: 'fix',
  fixTask: 'Expand docs/pause.md with more detail.',
});

const ACCEPT_REVIEWER = JSON.stringify({
  decision: 'accept',
  confidence: 'high',
  blockingIssues: [],
  nonBlockingIssues: [],
  reviewSummary: 'Looks good.',
  nextAction: 'continue',
});

interface FlowSetup {
  repo: { path: string; baseSha: string; remotePath: string };
  task: Task;
  candidatePath: string;
  runsDir: string;
}

function makeFlowSetup(name: string): FlowSetup {
  const repo = makeTempRepo(name);
  const task = makeTask(repo.path);
  const candidatePath = join(tmpdir(), `pause-candidate-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
  const runsDir = mkdtempSync(join(tmpdir(), `pause-runs-${name}-`));
  return { repo, task, candidatePath, runsDir };
}

function cleanupFlowSetup(setup: FlowSetup): void {
  rmSync(setup.runsDir, { recursive: true, force: true });
  rmSync(setup.candidatePath, { recursive: true, force: true });
  rmSync(join(setup.repo.path, '..'), { recursive: true, force: true });
}

async function runFlow(
  setup: FlowSetup,
  opts: { isResume: boolean; fetchFn: FetchFn; apiKey?: string }
) {
  return runRealRepoRunAICandidateFlow({
    task: setup.task,
    taskBaseSha: setup.repo.baseSha,
    candidatePath: setup.candidatePath,
    runId: `run-${Date.now()}`,
    isResume: opts.isResume,
    maxAttempts: 1,
    reviewerMaxFixAttempts: 1,
    reviewerParseRetries: 1,
    apiKey: opts.apiKey ?? 'sk-test',
    baseUrl: 'https://api.example.com',
    model: 'kimi-k2.6',
    fetchFn: opts.fetchFn,
    runsDir: setup.runsDir,
  });
}

describe('parseFakeProviderErrorDirective', () => {
  test('parses bare and parameterized directives', () => {
    assert.deepStrictEqual(parseFakeProviderErrorDirective('__FETCH_ERROR__'), {
      kind: 'http',
      status: 500,
      body: '',
    });
    assert.deepStrictEqual(
      parseFakeProviderErrorDirective('__FETCH_ERROR__:403:{"error":{"code":"insufficient_quota"}}'),
      { kind: 'http', status: 403, body: '{"error":{"code":"insufficient_quota"}}' }
    );
    assert.deepStrictEqual(parseFakeProviderErrorDirective('__FETCH_TIMEOUT__'), { kind: 'timeout' });
  });

  test('returns null for non-directives and invalid statuses', () => {
    assert.strictEqual(parseFakeProviderErrorDirective('{"mode":"file_update"}'), null);
    assert.strictEqual(parseFakeProviderErrorDirective('__FETCH_ERROR__:abc:x'), null);
    assert.strictEqual(parseFakeProviderErrorDirective('__FETCH_ERROR__:99:x'), null);
    assert.strictEqual(parseFakeProviderErrorDirective(''), null);
  });
});

describe('provider pause in candidate flow', () => {
  test('401 on coder pauses at generating and non-resume rerun refuses to restart', async () => {
    const envSnap = snapshotEnv();
    const setup = makeFlowSetup('auth');
    fastRetries();
    try {
      const result = await runFlow(setup, {
        isResume: false,
        fetchFn: httpErrorFetch(401, '{"error":{"code":"invalid_api_key","message":"Invalid authentication credentials"}}'),
      });

      assert.strictEqual(result.exitCode, 1);
      assert.strictEqual(result.state.status, 'paused_provider');
      assert.strictEqual(result.state.task_phase, 'generating');
      assert.strictEqual(result.state.provider_failure?.http_status, 401);
      assert.strictEqual(result.state.provider_failure?.failure_kind, 'AUTH_INVALID');
      assert.strictEqual(result.state.provider_failure?.pause_recommended, true);
      assert.strictEqual(result.state.credential_source, 'KIMI_API_KEY');
      assert.strictEqual(result.state.resume_supported, true);
      assert.strictEqual(result.state.reviewer_round, 0);

      const persisted = loadState(setup.task.id, setup.runsDir);
      assert.strictEqual(persisted?.status, 'paused_provider');

      // A non-resume invocation must not silently restart the paused task.
      const rerun = await runFlow(setup, { isResume: false, fetchFn: throwingFetch() });
      assert.strictEqual(rerun.exitCode, 1);
      assert.strictEqual(rerun.state.status, 'paused_provider');
      assert.strictEqual(rerun.state.task_phase, 'generating');
    } finally {
      restoreEnv(envSnap);
      cleanupFlowSetup(setup);
    }
  });

  test('400 on coder keeps the existing failed behavior (no pause)', async () => {
    const envSnap = snapshotEnv();
    const setup = makeFlowSetup('badreq');
    fastRetries();
    try {
      const result = await runFlow(setup, {
        isResume: false,
        fetchFn: httpErrorFetch(400, '{"error":{"message":"bad request"}}'),
      });

      assert.strictEqual(result.exitCode, 1);
      assert.strictEqual(result.state.status, 'failed');
      assert.strictEqual(result.state.task_phase, 'failed');
      assert.strictEqual(result.state.provider_failure, undefined);
    } finally {
      restoreEnv(envSnap);
      cleanupFlowSetup(setup);
    }
  });

  test('persistent 429 on coder pauses as RATE_LIMITED after retry exhaustion', async () => {
    const envSnap = snapshotEnv();
    const setup = makeFlowSetup('ratelimit');
    fastRetries();
    process.env.REAL_PROVIDER_MAX_ATTEMPTS = '2';
    try {
      const result = await runFlow(setup, {
        isResume: false,
        fetchFn: httpErrorFetch(429, '{"error":{"message":"Rate limit reached"}}'),
      });

      assert.strictEqual(result.exitCode, 1);
      assert.strictEqual(result.state.status, 'paused_provider');
      assert.strictEqual(result.state.task_phase, 'generating');
      assert.strictEqual(result.state.provider_failure?.failure_kind, 'RATE_LIMITED');
      assert.strictEqual(result.state.provider_failure?.http_status, 429);
      assert.strictEqual(result.state.provider_failure?.retryable, false);
      assert.strictEqual(result.state.provider_failure?.pause_recommended, true);
    } finally {
      restoreEnv(envSnap);
      cleanupFlowSetup(setup);
    }
  });

  test('timeout on coder pauses as TRANSIENT_NETWORK after retry exhaustion', async () => {
    const envSnap = snapshotEnv();
    const setup = makeFlowSetup('timeout');
    fastRetries();
    process.env.REAL_PROVIDER_MAX_ATTEMPTS = '2';
    try {
      const result = await runFlow(setup, {
        isResume: false,
        fetchFn: async () => {
          throw new Error('Provider request timed out after 5000 ms');
        },
      });

      assert.strictEqual(result.exitCode, 1);
      assert.strictEqual(result.state.status, 'paused_provider');
      assert.strictEqual(result.state.provider_failure?.failure_kind, 'TRANSIENT_NETWORK');
      assert.strictEqual(result.state.provider_failure?.http_status, null);
      assert.strictEqual(result.state.provider_failure?.pause_recommended, true);
    } finally {
      restoreEnv(envSnap);
      cleanupFlowSetup(setup);
    }
  });

  test('429 directive on first reviewer pauses at reviewer_pending round 0', async () => {
    const envSnap = snapshotEnv();
    const setup = makeFlowSetup('rev429');
    fastRetries();
    process.env.REAL_REPO_REVIEWER_FAKE_RESPONSE =
      '__FETCH_ERROR__:429:{"error":{"message":"Rate limit reached"}}';
    try {
      const result = await runFlow(setup, {
        isResume: false,
        fetchFn: successFetch(CODER_OUTPUT),
      });

      assert.strictEqual(result.exitCode, 1);
      assert.strictEqual(result.state.status, 'paused_provider');
      assert.strictEqual(result.state.task_phase, 'reviewer_pending');
      assert.strictEqual(result.state.reviewer_round, 0);
      assert.strictEqual(result.state.provider_failure?.failure_kind, 'RATE_LIMITED');
      assert.strictEqual(result.state.provider_failure?.http_status, 429);
      assert.strictEqual(result.state.resume_supported, true);
    } finally {
      restoreEnv(envSnap);
      cleanupFlowSetup(setup);
    }
  });

  test('timeout directive on first reviewer pauses as TRANSIENT_NETWORK', async () => {
    const envSnap = snapshotEnv();
    const setup = makeFlowSetup('revtimeout');
    fastRetries();
    process.env.REAL_REPO_REVIEWER_FAKE_RESPONSE = '__FETCH_TIMEOUT__';
    try {
      const result = await runFlow(setup, {
        isResume: false,
        fetchFn: successFetch(CODER_OUTPUT),
      });

      assert.strictEqual(result.exitCode, 1);
      assert.strictEqual(result.state.status, 'paused_provider');
      assert.strictEqual(result.state.task_phase, 'reviewer_pending');
      assert.strictEqual(result.state.provider_failure?.failure_kind, 'TRANSIENT_NETWORK');
      assert.strictEqual(result.state.provider_failure?.http_status, null);
    } finally {
      restoreEnv(envSnap);
      cleanupFlowSetup(setup);
    }
  });

  test('bare __FETCH_ERROR__ directive keeps legacy 500 semantics and pauses after exhaustion', async () => {
    const envSnap = snapshotEnv();
    const setup = makeFlowSetup('rev500');
    fastRetries();
    process.env.REAL_REPO_REVIEWER_FAKE_RESPONSE = '__FETCH_ERROR__';
    try {
      const result = await runFlow(setup, {
        isResume: false,
        fetchFn: successFetch(CODER_OUTPUT),
      });

      assert.strictEqual(result.exitCode, 1);
      assert.strictEqual(result.state.status, 'paused_provider');
      assert.strictEqual(result.state.provider_failure?.failure_kind, 'PROVIDER_5XX');
      assert.strictEqual(result.state.provider_failure?.http_status, 500);
      assert.strictEqual(result.state.provider_failure?.pause_recommended, true);
    } finally {
      restoreEnv(envSnap);
      cleanupFlowSetup(setup);
    }
  });

  test('403 quota at second reviewer pauses mid-loop; resume continues without redoing coder or fix', async () => {
    const envSnap = snapshotEnv();
    const setup = makeFlowSetup('quota');
    fastRetries();
    process.env.REAL_REPO_REVIEWER_FAKE_RESPONSE = FIX_REQUIRED_REVIEWER;
    process.env.REAL_REPO_REVIEWER_FIX_TASK_KIMI_FAKE_RESPONSE = FIX_CODER_OUTPUT;
    process.env.REAL_REPO_REVIEWER_SECOND_FAKE_RESPONSE =
      '__FETCH_ERROR__:403:{"error":{"code":"insufficient_quota","message":"You exceeded your current quota"}}';

    const coderCalls = { calls: 0 };
    try {
      const paused = await runFlow(setup, {
        isResume: false,
        fetchFn: successFetch(CODER_OUTPUT, coderCalls),
      });

      assert.strictEqual(paused.exitCode, 1);
      assert.strictEqual(paused.state.status, 'paused_provider');
      assert.strictEqual(paused.state.task_phase, 'second_review_pending');
      assert.strictEqual(paused.state.reviewer_round, 1);
      assert.strictEqual(paused.state.provider_failure?.failure_kind, 'QUOTA_EXHAUSTED');
      assert.strictEqual(paused.state.provider_failure?.http_status, 403);
      assert.strictEqual(paused.state.provider_failure?.provider_error_code, 'insufficient_quota');
      assert.strictEqual(paused.state.resume_supported, true);
      assert.strictEqual(paused.state.credential_source, 'KIMI_API_KEY');
      assert.ok(
        typeof paused.state.paused_candidate_package_hash === 'string' &&
          paused.state.paused_candidate_package_hash.length === 64,
        'pause must record the candidate package hash'
      );

      const attempts = paused.state.provider_attempts ?? [];
      assert.strictEqual(attempts.filter((a) => a.type === 'initial_coder').length, 1);
      assert.strictEqual(attempts.filter((a) => a.type === 'reviewer').length, 1);
      assert.strictEqual(attempts.filter((a) => a.type === 'reviewer_fix_coder').length, 1);
      assert.strictEqual(attempts.filter((a) => a.type === 'second_reviewer').length, 1);

      // Resume with a rotated credential: reviewer#1 must not be re-called
      // (poisoned response would parse-fail), the fix coder must not be re-applied
      // (no fix fake left and fetch throws), and the reviewer loop resumes at
      // round 1 with the same candidate package hash.
      process.env.REAL_REPO_REVIEWER_FAKE_RESPONSE = '{"decision": broken';
      delete process.env.REAL_REPO_REVIEWER_FIX_TASK_KIMI_FAKE_RESPONSE;
      delete process.env.REAL_REPO_REVIEWER_FIX_TASK_KIMI_FAKE_RESPONSES;
      process.env.REAL_REPO_REVIEWER_SECOND_FAKE_RESPONSE = ACCEPT_REVIEWER;

      const resumed = await runFlow(setup, {
        isResume: true,
        fetchFn: throwingFetch(),
        apiKey: 'sk-rotated-key',
      });

      assert.strictEqual(coderCalls.calls, 1, 'coder must not be re-called on resume');
      assert.strictEqual(resumed.exitCode, 0, `resume must succeed, got: ${resumed.state.safety_note ?? ''}`);
      assert.strictEqual(resumed.state.status, 'pushed');
      assert.strictEqual(resumed.state.task_phase, 'pushed');
      assert.strictEqual(resumed.state.fixed_and_accepted, true);
      assert.ok(typeof resumed.state.commit_sha === 'string' && /^[0-9a-f]{40}$/.test(resumed.state.commit_sha));
      assert.strictEqual(resumed.state.provider_failure, undefined, 'pause fields must be cleared on success');
      assert.strictEqual(resumed.state.reviewer_round, undefined);

      const persisted = loadState(setup.task.id, setup.runsDir);
      assert.strictEqual(persisted?.status, 'pushed');
      assert.strictEqual(persisted?.provider_failure, undefined);

      const branchHead = git(['rev-parse', 'mission-pause'], setup.repo.path);
      assert.strictEqual(branchHead.stdout.trim(), resumed.state.commit_sha);
    } finally {
      restoreEnv(envSnap);
      cleanupFlowSetup(setup);
    }
  });

  test('tampered candidate content fails closed on resume and stays paused', async () => {
    const envSnap = snapshotEnv();
    const setup = makeFlowSetup('tamper');
    fastRetries();
    process.env.REAL_REPO_REVIEWER_FAKE_RESPONSE = FIX_REQUIRED_REVIEWER;
    process.env.REAL_REPO_REVIEWER_FIX_TASK_KIMI_FAKE_RESPONSE = FIX_CODER_OUTPUT;
    process.env.REAL_REPO_REVIEWER_SECOND_FAKE_RESPONSE =
      '__FETCH_ERROR__:403:{"error":{"code":"insufficient_quota","message":"quota exceeded"}}';
    try {
      const paused = await runFlow(setup, {
        isResume: false,
        fetchFn: successFetch(CODER_OUTPUT),
      });
      assert.strictEqual(paused.state.status, 'paused_provider');

      // Tamper with the staged candidate content after the pause.
      writeFileSync(join(setup.candidatePath, 'docs/pause.md'), '# tampered\n', 'utf-8');
      git(['add', 'docs/pause.md'], setup.candidatePath);

      process.env.REAL_REPO_REVIEWER_SECOND_FAKE_RESPONSE = ACCEPT_REVIEWER;
      const resumed = await runFlow(setup, {
        isResume: true,
        fetchFn: throwingFetch(),
      });

      assert.strictEqual(resumed.exitCode, 1);
      assert.strictEqual(resumed.state.status, 'paused_provider');
      assert.ok(
        (resumed.state.safety_note ?? '').includes('hash changed'),
        `expected hash-mismatch refusal, got: ${resumed.state.safety_note ?? ''}`
      );
      assert.strictEqual(resumed.state.resume_supported, true);

      const persisted = loadState(setup.task.id, setup.runsDir);
      assert.strictEqual(persisted?.status, 'paused_provider');
    } finally {
      restoreEnv(envSnap);
      cleanupFlowSetup(setup);
    }
  });
});

describe('multitask mission provider pause', () => {
  function fakeGitExec(acceptedCommits: string[] = []) {
    return (args: string[], _options?: { cwd?: string }) => {
      const command = args[0];
      if (command === 'rev-parse' && args[1] === 'main') {
        return { status: 0, stdout: 'base-sha-1234567890abcdef\n', stderr: '' };
      }
      if (command === 'merge-base' && args[1] === '--is-ancestor') {
        return { status: acceptedCommits.includes(args[2]) ? 0 : 1, stdout: '', stderr: '' };
      }
      if (command === 'merge-base') {
        return { status: 0, stdout: 'base-sha-1234567890abcdef\n', stderr: '' };
      }
      if (command === 'rev-parse' && args[1] === '--verify') {
        return { status: 1, stdout: '', stderr: 'unknown revision' };
      }
      return { status: 0, stdout: '', stderr: '' };
    };
  }

  function fakeAutopilotResult(
    planResult: Awaited<ReturnType<typeof runAutopilotPlan>>,
    taskId: string,
    status: 'passed' | 'paused_provider',
    commitSha?: string
  ): AutopilotRunResult {
    const paused = status === 'paused_provider';
    const configPath = planResult.generated_files.find((p) => p.endsWith('autopilot.config.json'))!;
    const mvpConfigPath = planResult.generated_files.find((p) => p.endsWith('mvp-run.config.json'))!;
    const mvpResult: MvpRunResult = {
      config: {} as MvpRunResult['config'],
      command: 'mvp',
      config_path: mvpConfigPath,
      started_at: new Date().toISOString(),
      finished_at: new Date().toISOString(),
      duration_ms: 50,
      verdict: paused ? 'MVP_RUN_PAUSED_PROVIDER' : 'MVP_RUN_PASSED',
      reason: paused ? 'Task paused on provider interruption' : 'Fake MVP',
      preflight: {} as MvpRunResult['preflight'],
      task_results: [
        {
          id: taskId,
          title: `Task ${taskId}`,
          status,
          provider_attempts: 1,
          recovery_attempts: 0,
          ...(commitSha !== undefined ? { commit_sha: commitSha } : {}),
          ...(paused
            ? {
                resume_supported: true,
                task_phase: 'second_review_pending',
                provider_failure: {
                  provider: 'kimi',
                  role: 'reviewer' as const,
                  http_status: 403,
                  failure_kind: 'QUOTA_EXHAUSTED' as const,
                  retryable: false,
                  pause_recommended: true,
                  sanitized_message: 'You exceeded your current quota',
                  provider_error_code: 'insufficient_quota',
                },
              }
            : {}),
        },
      ],
      tasks_total: 1,
      tasks_passed: paused ? 0 : 1,
      tasks_failed: 0,
      tasks_blocked: 0,
      tasks_skipped: 0,
      tasks_caveats: 0,
      commits: commitSha !== undefined ? [commitSha] : [],
      branch: 'mission-branch',
      pushed: false,
      caveats: [],
      report_dir: join(planResult.run_dir, 'mvp-run-reports'),
      ...(paused ? { resume_supported: true } : {}),
    };
    return {
      config: {} as AutopilotRunResult['config'],
      command: 'test',
      config_path: configPath,
      started_at: new Date().toISOString(),
      finished_at: new Date().toISOString(),
      duration_ms: 100,
      verdict: paused ? 'AUTOPILOT_PAUSED_PROVIDER' : 'AUTOPILOT_GREEN',
      reason: paused ? 'MVP run paused on provider interruption' : 'Fake autopilot',
      repair_attempts: 0,
      report_dir: planResult.run_dir,
      exit_code: paused ? 1 : 0,
      mvp_result: mvpResult,
    };
  }

  test('paused provider interruption pauses the mission and resume completes it', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'pause-mission-out-'));
    const tmpRepo = mkdtempSync(join(tmpdir(), 'pause-mission-repo-'));
    const runId = `pause-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    try {
      const mission = buildMissionFromGoal('Add docs note', {
        preset: 'multitask-safe',
        repo_path: tmpRepo,
        output_dir: tmpDir,
        run_id: runId,
      });
      mission.capabilities.allow_repo_apply = true;
      mission.capabilities.allow_repo_commit = true;
      mission.capabilities.allow_repo_push = true;
      const planResult = await runAutopilotPlan(mission, { command: 'test' });
      const taskId = planResult.plan.tasks[0].id;

      const pausedResult = await runMultitaskMission(mission, planResult, {
        command: 'test-cmd',
        runAutopilotRunFn: async () => fakeAutopilotResult(planResult, taskId, 'paused_provider'),
        gitExecFn: fakeGitExec(),
        collectDiffFn: () => '',
      });

      assert.strictEqual(pausedResult.verdict, 'MULTITASK_MISSION_PAUSED_PROVIDER');
      assert.strictEqual(pausedResult.exit_code, 1);
      assert.strictEqual(pausedResult.resume_supported, true);
      assert.strictEqual(pausedResult.resume_command, `test-cmd --run-id ${runId} --resume`);
      assert.strictEqual(pausedResult.provider_failure?.failure_kind, 'QUOTA_EXHAUSTED');
      const pausedTaskState = pausedResult.task_states?.find((s) => s.task_id === taskId);
      assert.strictEqual(pausedTaskState?.status, 'paused_provider');
      assert.strictEqual(
        pausedResult.task_results.find((t) => t.task_id === taskId)?.status,
        'paused_provider'
      );

      // Mission state must stay in the executing stage so resume re-runs.
      const runDir = getMissionRunDir(tmpDir, runId);
      const persisted = loadMissionState(runDir);
      assert.strictEqual(persisted?.stage, 'executing_tasks');

      // Resume with the provider restored: the mission must run to completion,
      // not replay the paused result as terminal.
      const commitSha = 'a'.repeat(40);
      const resumedResult = await runMultitaskMission(mission, planResult, {
        command: 'test-cmd --resume',
        resume: true,
        runAutopilotRunFn: async () => fakeAutopilotResult(planResult, taskId, 'passed', commitSha),
        gitExecFn: fakeGitExec([commitSha]),
        collectDiffFn: () => 'diff --git a/docs/AUTOPILOT_PLAN.md b/docs/AUTOPILOT_PLAN.md\n+line',
      });

      assert.strictEqual(resumedResult.verdict, 'MULTITASK_MISSION_DONE');
      assert.strictEqual(resumedResult.exit_code, 0);
      assert.strictEqual(resumedResult.task_states?.find((s) => s.task_id === taskId)?.status, 'accepted');
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
      rmSync(tmpRepo, { recursive: true, force: true });
    }
  });
});
