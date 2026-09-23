import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runRealRepoRunAICandidateFlow } from '../src/real-repo-run-ai-candidate.js';
import { loadState } from '../src/state-manager.js';
import { configureCandidateRemote } from '../src/candidate-workspace.js';
import { deriveTaskResult } from '../src/real-block-run-ai.js';
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
  'GITHUB_TOKEN',
] as const;

/**
 * Sentinel credential: a token-shaped value that must never survive anywhere
 * on disk (candidate .git/, state.json, run logs, reports).
 */
const FLOW_SENTINEL = 'ghp_SENTINELephemeralflow00000000000000';
/** base64("x-access-token:<FLOW_SENTINEL>") — the encoded Basic credential must never be persisted either. */
const FLOW_SENTINEL_BASIC = Buffer.from(`x-access-token:${FLOW_SENTINEL}`, 'utf-8').toString('base64');

/** Recursively scan a directory tree for the exact sentinel bytes. */
function findSentinelInTree(rootDir: string, sentinel: string): string[] {
  const hits: string[] = [];
  const needle = Buffer.from(sentinel, 'utf-8');
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile()) {
        const content = readFileSync(full);
        if (content.includes(needle)) {
          hits.push(full);
        }
      }
    }
  };
  walk(rootDir);
  return hits;
}

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

function git(args: string[], cwd: string): { status: number; stdout: string; stderr: string } {
  const result = spawnSync('git', args, { cwd, encoding: 'utf-8', shell: false });
  return {
    status: result.status ?? 1,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
  };
}

function makeTempRepo(name: string): { path: string; baseSha: string; remotePath: string } {
  const root = mkdtempSync(join(tmpdir(), `gitauth-test-${name}-`));
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
  git(['checkout', '-b', 'mission-gitauth', baseSha], repoPath);
  git(['push', 'origin', 'HEAD:mission-gitauth'], repoPath);
  git(['checkout', 'main'], repoPath);

  return { path: repoPath, baseSha, remotePath };
}

function makeTask(repoPath: string): Task {
  return {
    id: 'gitauth-task',
    title: 'Git auth pause task',
    repo_path: repoPath,
    base_branch: 'main',
    work_branch: 'mission-gitauth',
    goal: 'Add docs/gitauth.md',
    context_files: [],
    checks: [],
    guardrails: {
      allow_modify: ['docs/gitauth.md'],
      deny_modify: ['.env'],
      auto_commit: true,
      auto_push: true,
    },
  };
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

function throwingFetch(counter?: { calls: number }): FetchFn {
  return async () => {
    if (counter) counter.calls += 1;
    throw new Error('fetch must not be called');
  };
}

const CODER_OUTPUT = JSON.stringify({
  mode: 'file_update',
  files: [{ path: 'docs/gitauth.md', content: '# v1\n' }],
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
  const candidatePath = join(
    tmpdir(),
    `gitauth-candidate-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
  );
  const runsDir = mkdtempSync(join(tmpdir(), `gitauth-runs-${name}-`));
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

/**
 * Simulates a GitHub "Invalid username or token" push rejection against a local
 * bare remote: git prefixes hook stderr with "remote: ", which is exactly how
 * the real server-side rejection reaches the client. Removing the hook is the
 * local analog of rotating to a valid GITHUB_TOKEN.
 */
function installAuthRejectHook(remotePath: string): string {
  const hookPath = join(remotePath, 'hooks', 'pre-receive');
  writeFileSync(
    hookPath,
    [
      '#!/bin/sh',
      'echo "Invalid username or token." >&2',
      'echo "Password authentication is not supported for Git operations." >&2',
      'echo "Authentication failed for \'https://github.com/Mellowin/AI-orchestrator.git/\'" >&2',
      'exit 1',
      '',
    ].join('\n'),
    'utf-8'
  );
  chmodSync(hookPath, 0o755);
  return hookPath;
}

describe('configureCandidateRemote stores a credential-free origin', () => {
  test('a token-bearing URL is stripped before being persisted in .git/config', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gitauth-remote-cfg-'));
    const credSentinel = 'ghp_SENTINELconfigurecandidate0000000000';
    try {
      git(['init'], dir);
      git(['remote', 'add', 'origin', 'https://github.com/Mellowin/AI-orchestrator.git'], dir);
      const result = configureCandidateRemote(
        dir,
        `https://x-access-token:${credSentinel}@github.com/Mellowin/AI-orchestrator.git`
      );
      assert.strictEqual(result.ok, true);
      const stored = git(['remote', 'get-url', 'origin'], dir);
      assert.strictEqual(stored.stdout.trim(), 'https://github.com/Mellowin/AI-orchestrator.git');
      assert.deepStrictEqual(
        findSentinelInTree(join(dir, '.git'), credSentinel),
        [],
        '.git must not contain the stripped credential'
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('git auth pause/resume (flow level)', () => {
  test('push auth failure pauses with accepted commit preserved; rotated credential resumes push-only', async () => {
    const envSnap = snapshotEnv();
    const setup = makeFlowSetup('pause');
    process.env.REAL_REPO_REVIEWER_FAKE_RESPONSE = ACCEPT_REVIEWER;
    // A token-shaped sentinel is configured for the whole scenario; it must
    // never be persisted anywhere (regressions 1–6).
    process.env.GITHUB_TOKEN = FLOW_SENTINEL;
    const hookPath = installAuthRejectHook(setup.repo.remotePath);

    const coderCalls = { calls: 0 };
    try {
      const paused = await runFlow(setup, {
        isResume: false,
        fetchFn: successFetch(CODER_OUTPUT, coderCalls),
      });

      // Regression 10 (NEW behavior): paused_git_auth instead of failed.
      assert.strictEqual(paused.exitCode, 1);
      assert.strictEqual(paused.state.status, 'paused_git_auth');
      assert.strictEqual(paused.state.task_phase, 'committed');
      assert.strictEqual(paused.state.git_failure?.failure_kind, 'GIT_AUTH_INVALID');
      assert.strictEqual(paused.state.git_failure?.operation, 'push');
      assert.strictEqual(paused.state.git_failure?.pause_recommended, true);
      assert.strictEqual(paused.state.credential_source, 'GITHUB_TOKEN');
      assert.strictEqual(paused.state.resume_supported, true);
      assert.strictEqual(paused.state.committed, true);
      assert.strictEqual(paused.state.pushed, false);

      // Regression 7: the accepted local commit is preserved.
      const acceptedSha = paused.state.accepted_commit_sha;
      assert.ok(typeof acceptedSha === 'string' && /^[0-9a-f]{40}$/.test(acceptedSha));
      assert.strictEqual(paused.state.commit_sha, acceptedSha);
      assert.ok(
        typeof paused.state.paused_candidate_package_hash === 'string' &&
          paused.state.paused_candidate_package_hash.length === 64,
        'pause must record the accepted candidate package hash'
      );
      const candidateHead = git(['rev-parse', 'HEAD'], setup.candidatePath);
      assert.strictEqual(candidateHead.stdout.trim(), acceptedSha, 'candidate HEAD must be the accepted commit');
      const candidateParent = git(['rev-parse', `${acceptedSha}^`], setup.candidatePath);
      assert.strictEqual(
        candidateParent.stdout.trim(),
        setup.repo.baseSha,
        'accepted commit parent must be task_base_sha'
      );

      // No commit reached the remote before credential rotation (regression 13 negative).
      const remoteBefore = git(['ls-remote', 'origin', 'mission-gitauth'], setup.repo.path);
      assert.ok(remoteBefore.stdout.includes(setup.repo.baseSha));
      assert.ok(!remoteBefore.stdout.includes(acceptedSha), 'accepted commit must NOT be on the remote yet');

      // Regression 8: the single coder call happened once; nothing after the pause.
      assert.strictEqual(coderCalls.calls, 1);

      // Regressions 1/3/5/6: the paused candidate and all run artifacts must
      // contain NO credential. The persisted origin URL is credential-free.
      const pausedOrigin = git(['remote', 'get-url', 'origin'], setup.candidatePath);
      assert.ok(!pausedOrigin.stdout.includes(FLOW_SENTINEL), 'candidate origin must not contain the token');
      assert.ok(!pausedOrigin.stdout.includes('x-access-token'), 'candidate origin must not embed credentials');
      assert.deepStrictEqual(
        findSentinelInTree(join(setup.candidatePath, '.git'), FLOW_SENTINEL),
        [],
        'candidate .git/ must not contain the token after paused_git_auth'
      );
      assert.deepStrictEqual(
        findSentinelInTree(join(setup.candidatePath, '.git'), FLOW_SENTINEL_BASIC),
        [],
        'candidate .git/ must not contain the encoded Basic credential after paused_git_auth'
      );
      assert.deepStrictEqual(
        findSentinelInTree(setup.runsDir, FLOW_SENTINEL),
        [],
        'state/logs must not contain the token'
      );
      assert.deepStrictEqual(
        findSentinelInTree(setup.runsDir, FLOW_SENTINEL_BASIC),
        [],
        'state/logs must not contain the encoded Basic credential'
      );

      // Fresh (non-resume) rerun must refuse to restart over the paused state.
      const freshRerunCalls = { calls: 0 };
      const freshRerun = await runFlow(setup, {
        isResume: false,
        fetchFn: throwingFetch(freshRerunCalls),
      });
      assert.strictEqual(freshRerun.exitCode, 1);
      assert.strictEqual(freshRerun.state.status, 'paused_git_auth');
      assert.strictEqual(freshRerunCalls.calls, 0, 'fresh rerun must not invoke the provider');

      // "Rotate the credential": remove the rejecting hook.
      rmSync(hookPath, { force: true });

      // Regression 11: resume performs ZERO new AI calls (throwing fetch).
      const resumeAiCalls = { calls: 0 };
      const resumed = await runFlow(setup, {
        isResume: true,
        fetchFn: throwingFetch(resumeAiCalls),
      });

      assert.strictEqual(resumeAiCalls.calls, 0, 'resume must not invoke planner/coder/reviewer');
      assert.strictEqual(resumed.exitCode, 0, `resume must succeed: ${resumed.state.safety_note ?? ''}`);
      assert.strictEqual(resumed.state.status, 'pushed');
      // Regression 12: the SAME accepted SHA was pushed.
      assert.strictEqual(resumed.state.commit_sha, acceptedSha);
      assert.strictEqual(resumed.state.accepted_commit_sha, acceptedSha);
      // Regression 13: remote HEAD verified after push.
      const remoteAfter = git(['ls-remote', 'origin', 'mission-gitauth'], setup.repo.path);
      assert.ok(remoteAfter.stdout.includes(acceptedSha), 'remote HEAD must equal the accepted commit');
      const branchHead = git(['rev-parse', 'mission-gitauth'], setup.repo.path);
      assert.strictEqual(branchHead.stdout.trim(), acceptedSha, 'local mission branch fast-forwarded');
      // Pause bookkeeping cleared on success.
      assert.strictEqual(resumed.state.git_failure, undefined);
      assert.strictEqual(resumed.state.credential_source, undefined);
      assert.strictEqual(resumed.state.resume_supported, undefined);

      const persisted = loadState(setup.task.id, setup.runsDir);
      assert.strictEqual(persisted?.status, 'pushed');
      assert.strictEqual(persisted?.git_failure, undefined);

      // Regressions 2/4/5/6: after a successful resume-push, if the candidate
      // workspace is still on disk it must remain credential-free; run
      // artifacts must never contain the token.
      if (existsSync(join(setup.candidatePath, '.git'))) {
        const resumedOrigin = git(['remote', 'get-url', 'origin'], setup.candidatePath);
        assert.ok(!resumedOrigin.stdout.includes(FLOW_SENTINEL), 'origin must stay credential-free after resume');
        assert.ok(!resumedOrigin.stdout.includes('x-access-token'));
        assert.deepStrictEqual(
          findSentinelInTree(join(setup.candidatePath, '.git'), FLOW_SENTINEL),
          [],
          'candidate .git/ must not contain the token after resume'
        );
        assert.deepStrictEqual(
          findSentinelInTree(join(setup.candidatePath, '.git'), FLOW_SENTINEL_BASIC),
          [],
          'candidate .git/ must not contain the encoded Basic credential after resume'
        );
      }
      assert.deepStrictEqual(
        findSentinelInTree(setup.runsDir, FLOW_SENTINEL),
        [],
        'state/logs must not contain the token after resume'
      );
      assert.deepStrictEqual(
        findSentinelInTree(setup.runsDir, FLOW_SENTINEL_BASIC),
        [],
        'state/logs must not contain the encoded Basic credential after resume'
      );
    } finally {
      restoreEnv(envSnap);
      cleanupFlowSetup(setup);
    }
  });

  test('unexpected remote head stays fail-closed (no credential pause) (regression 5/6 flow level)', async () => {
    const envSnap = snapshotEnv();
    const setup = makeFlowSetup('conflict');
    process.env.REAL_REPO_REVIEWER_FAKE_RESPONSE = ACCEPT_REVIEWER;

    // Advance the remote mission branch with a foreign commit BEFORE the flow runs.
    const foreignClone = mkdtempSync(join(tmpdir(), 'gitauth-foreign-'));
    try {
      git(['clone', setup.repo.remotePath, foreignClone], tmpdir());
      git(['config', 'user.email', 'foreign@example.com'], foreignClone);
      git(['config', 'user.name', 'Foreign'], foreignClone);
      git(['checkout', 'mission-gitauth'], foreignClone);
      writeFileSync(join(foreignClone, 'foreign.txt'), 'foreign\n', 'utf-8');
      git(['add', 'foreign.txt'], foreignClone);
      git(['commit', '-m', 'foreign commit'], foreignClone);
      const pushResult = git(['push', 'origin', 'mission-gitauth'], foreignClone);
      assert.strictEqual(pushResult.status, 0, `foreign push failed: ${pushResult.stderr}`);

      const result = await runFlow(setup, {
        isResume: false,
        fetchFn: successFetch(CODER_OUTPUT),
      });

      assert.strictEqual(result.exitCode, 1);
      assert.strictEqual(result.state.status, 'failed', 'remote conflict must fail closed, not pause');
      assert.notStrictEqual(result.state.status, 'paused_git_auth');
      assert.strictEqual(result.state.git_failure?.pause_recommended === true, false);
      assert.match(result.state.safety_note ?? '', /unexpected|conflict|Reconcile/i);
    } finally {
      rmSync(foreignClone, { recursive: true, force: true });
      restoreEnv(envSnap);
      cleanupFlowSetup(setup);
    }
  });
});

describe('deriveTaskResult maps paused_git_auth (block level)', () => {
  test('paused_git_auth child state -> task result paused_git_auth with checks pass and git failure', () => {
    const acceptedSha = 'b'.repeat(40);
    const result = deriveTaskResult(
      { task_id: 't1', title: 'Task 1' } as never,
      {
        exitCode: 1,
        state: {
          status: 'paused_git_auth',
          task_phase: 'committed',
          commit_sha: acceptedSha,
          accepted_commit_sha: acceptedSha,
          pushed: false,
          committed: true,
          credential_source: 'GITHUB_TOKEN',
          resume_supported: true,
          git_failure: {
            remote: 'origin',
            operation: 'push',
            failure_kind: 'GIT_AUTH_INVALID',
            http_status: null,
            pause_recommended: true,
            sanitized_message: 'Invalid username or token',
          },
          safety_note: 'Git remote paused (GIT_AUTH_INVALID, push on origin): Invalid username or token',
        },
      }
    );

    assert.strictEqual(result.status, 'paused_git_auth');
    assert.strictEqual(result.finalStatus, 'paused_git_auth');
    assert.strictEqual(result.nextAction, 'wait');
    // Code was applied and checks passed — the pause happened at push time.
    assert.strictEqual(result.codeApplied, true);
    assert.strictEqual(result.checksResult, 'pass');
    assert.strictEqual(result.pushed, false);
    assert.strictEqual(result.gitFailure?.failure_kind, 'GIT_AUTH_INVALID');
    assert.strictEqual(result.taskPhase, 'committed');
  });
});

describe('multitask mission git auth pause', () => {
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

  type PlanResult = Awaited<ReturnType<typeof runAutopilotPlan>>;

  interface FakeTaskEntry {
    taskId: string;
    status: 'passed' | 'paused_git_auth';
    commitSha?: string;
  }

  function fakeAutopilotResult(
    planResult: PlanResult,
    entries: FakeTaskEntry[]
  ): AutopilotRunResult {
    const paused = entries.some((e) => e.status === 'paused_git_auth');
    const configPath = planResult.generated_files.find((p) => p.endsWith('autopilot.config.json'))!;
    const mvpConfigPath = planResult.generated_files.find((p) => p.endsWith('mvp-run.config.json'))!;
    const mvpResult: MvpRunResult = {
      config: {} as MvpRunResult['config'],
      command: 'mvp',
      config_path: mvpConfigPath,
      started_at: new Date().toISOString(),
      finished_at: new Date().toISOString(),
      duration_ms: 50,
      verdict: paused ? 'MVP_RUN_PAUSED_GIT_AUTH' : 'MVP_RUN_PASSED',
      reason: paused ? 'Task paused on Git auth interruption' : 'Fake MVP',
      preflight: {} as MvpRunResult['preflight'],
      task_results: entries.map((entry) => ({
        id: entry.taskId,
        title: `Task ${entry.taskId}`,
        status: entry.status,
        provider_attempts: 1,
        recovery_attempts: 0,
        ...(entry.commitSha !== undefined ? { commit_sha: entry.commitSha } : {}),
        ...(entry.status === 'paused_git_auth'
          ? {
              resume_supported: true,
              task_phase: 'committed',
              git_failure: {
                remote: 'origin',
                operation: 'push' as const,
                failure_kind: 'GIT_AUTH_INVALID' as const,
                http_status: null,
                pause_recommended: true,
                sanitized_message: 'Invalid username or token',
              },
            }
          : {}),
      })),
      tasks_total: entries.length,
      tasks_passed: entries.filter((e) => e.status === 'passed').length,
      tasks_failed: 0,
      tasks_blocked: 0,
      tasks_skipped: 0,
      tasks_caveats: 0,
      commits: entries.flatMap((e) => (e.commitSha !== undefined ? [e.commitSha] : [])),
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
      verdict: paused ? 'AUTOPILOT_PAUSED_GIT_AUTH' : 'AUTOPILOT_GREEN',
      reason: paused ? 'MVP run paused on Git auth interruption' : 'Fake autopilot',
      repair_attempts: 0,
      report_dir: planResult.run_dir,
      exit_code: paused ? 1 : 0,
      mvp_result: mvpResult,
    };
  }

  test('git auth pause pauses the mission, descendants stay pending, resume completes it', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'gitauth-mission-out-'));
    const tmpRepo = mkdtempSync(join(tmpdir(), 'gitauth-mission-repo-'));
    const runId = `gitauth-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
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

      // Extend the fake plan with a dependent second task.
      const task1 = planResult.plan.tasks[0];
      const task2 = {
        ...task1,
        id: 'task-2-dependent',
        title: 'Task 2 (depends on task 1)',
        depends_on: [task1.id],
        allowed_files: ['docs/SECOND.md'],
      };
      planResult.plan.tasks.push(task2);

      // First run: task-1 pauses on git auth; task-2 must stay pending.
      const pausedResult = await runMultitaskMission(mission, planResult, {
        command: 'test-cmd',
        runAutopilotRunFn: async () =>
          fakeAutopilotResult(planResult, [{ taskId: task1.id, status: 'paused_git_auth' }]),
        gitExecFn: fakeGitExec(),
        collectDiffFn: () => '',
      });

      assert.strictEqual(pausedResult.verdict, 'MULTITASK_MISSION_PAUSED_GIT_AUTH');
      assert.strictEqual(pausedResult.exit_code, 1);
      assert.strictEqual(pausedResult.resume_supported, true);
      assert.strictEqual(pausedResult.resume_command, `test-cmd --run-id ${runId} --resume`);
      assert.strictEqual(pausedResult.git_failure?.failure_kind, 'GIT_AUTH_INVALID');
      const pausedTaskState = pausedResult.task_states?.find((s) => s.task_id === task1.id);
      assert.strictEqual(pausedTaskState?.status, 'paused_git_auth');
      assert.strictEqual(
        pausedResult.task_results.find((t) => t.task_id === task1.id)?.status,
        'paused_git_auth'
      );
      // Regression 9: descendants remain pending, NOT blocked_skipped.
      const dependentState = pausedResult.task_states?.find((s) => s.task_id === task2.id);
      assert.strictEqual(dependentState?.status, 'pending');

      const runDir = getMissionRunDir(tmpDir, runId);
      const persisted = loadMissionState(runDir);
      assert.strictEqual(persisted?.stage, 'executing_tasks');

      // Resume after credential rotation: task-1 completes, task-2 runs, mission done.
      const commitSha1 = 'a'.repeat(40);
      const commitSha2 = 'c'.repeat(40);
      const calls: string[] = [];
      const resumedResult = await runMultitaskMission(mission, planResult, {
        command: 'test-cmd --resume',
        resume: true,
        runAutopilotRunFn: async () => {
          calls.push('autopilot');
          return fakeAutopilotResult(planResult, [
            { taskId: task1.id, status: 'passed', commitSha: commitSha1 },
            { taskId: task2.id, status: 'passed', commitSha: commitSha2 },
          ]);
        },
        gitExecFn: fakeGitExec([commitSha1, commitSha2]),
        collectDiffFn: () => 'diff --git a/docs/AUTOPILOT_PLAN.md b/docs/AUTOPILOT_PLAN.md\n+line',
      });

      assert.strictEqual(resumedResult.verdict, 'MULTITASK_MISSION_DONE', `reason: ${resumedResult.reason}`);
      assert.strictEqual(resumedResult.exit_code, 0);
      assert.strictEqual(
        resumedResult.task_states?.find((s) => s.task_id === task1.id)?.status,
        'accepted'
      );
      assert.strictEqual(
        resumedResult.task_states?.find((s) => s.task_id === task2.id)?.status,
        'accepted'
      );
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
      rmSync(tmpRepo, { recursive: true, force: true });
    }
  });
});
