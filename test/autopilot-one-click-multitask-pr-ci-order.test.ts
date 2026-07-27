import { describe, test } from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildMissionFromGoal } from '../src/autopilot-one-click/mission-builder.js';
import { runAutopilotPlan } from '../src/autopilot-plan/runner.js';
import { runMultitaskMission } from '../src/autopilot-one-click/multitask/runner.js';
import {
  computePlanHash,
  getMissionRunDir,
  loadMissionState,
  saveMissionState,
} from '../src/autopilot-one-click/multitask/state-manager.js';
import type { AutopilotRunResult } from '../src/autopilot-run/types.js';
import type { AutopilotRemoteFinalizationResult } from '../src/autopilot-run/runner.js';
import type { MvpRunConfig } from '../src/mvp-run/types.js';

function initTempGitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'repo-'));
  spawnSync('git', ['init', '--initial-branch=main'], { cwd: dir, encoding: 'utf-8', shell: false });
  spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir, encoding: 'utf-8', shell: false });
  spawnSync('git', ['config', 'user.name', 'Test User'], { cwd: dir, encoding: 'utf-8', shell: false });
  writeFileSync(join(dir, 'README.md'), '# test\n');
  spawnSync('git', ['add', '.'], { cwd: dir, encoding: 'utf-8', shell: false });
  spawnSync('git', ['commit', '-m', 'init'], { cwd: dir, encoding: 'utf-8', shell: false });
  return dir;
}

function makeDeferredAutopilotResult(planResult: Awaited<ReturnType<typeof runAutopilotPlan>>): AutopilotRunResult {
  const configPath = planResult.generated_files.find((p) => p.endsWith('autopilot.config.json'))!;
  const mvpConfigPath = planResult.generated_files.find((p) => p.endsWith('mvp-run.config.json'))!;
  return {
    config: {} as AutopilotRunResult['config'],
    command: 'test',
    config_path: configPath,
    started_at: new Date().toISOString(),
    finished_at: new Date().toISOString(),
    duration_ms: 100,
    verdict: 'AUTOPILOT_MVP_DEFERRED',
    reason: 'MVP completed; remote finalization deferred to caller',
    repair_attempts: 0,
    report_dir: planResult.run_dir,
    exit_code: 0,
    mvp_result: {
      config: {} as AutopilotRunResult['mvp_result']['config'],
      command: 'mvp',
      config_path: mvpConfigPath,
      started_at: new Date().toISOString(),
      finished_at: new Date().toISOString(),
      duration_ms: 50,
      verdict: 'MVP_RUN_PASSED',
      reason: 'Fake MVP',
      preflight: {} as AutopilotRunResult['mvp_result']['preflight'],
      task_results: [
        {
          id: 'mission-task-1',
          title: 'Mission task',
          status: 'passed',
          provider_attempts: 1,
          recovery_attempts: 0,
          commit_sha: 'a'.repeat(40),
        },
      ],
      tasks_total: 1,
      tasks_passed: 1,
      tasks_failed: 0,
      tasks_blocked: 0,
      tasks_skipped: 0,
      tasks_caveats: 0,
      commits: ['a'.repeat(40)],
      branch: 'mission-branch',
      pushed: true,
      caveats: [],
      report_dir: join(planResult.run_dir, 'mvp-run-reports'),
    },
  };
}

function makeApprovedFinalReview(): string {
  return JSON.stringify({
    verdict: 'approved',
    summary: 'approved',
    caveats: [],
    unauthorized_files: [],
    acceptance_gaps: [],
  });
}

function makeCiSuccess(): AutopilotRemoteFinalizationResult {
  return {
    verdict: 'AUTOPILOT_GREEN',
    reason: 'CI green',
    ci_run_id: 123456,
    ci_conclusion: 'success',
    repair_attempts: 0,
  };
}

function makeCiTimeout(): AutopilotRemoteFinalizationResult {
  return {
    verdict: 'AUTOPILOT_CI_TIMEOUT',
    reason: 'CI workflow timed out',
    ci_run_id: 123456,
    ci_conclusion: null,
    repair_attempts: 0,
  };
}

async function setupMission() {
  const tmpRepo = initTempGitRepo();
  const tmpOut = mkdtempSync(join(tmpdir(), 'out-'));
  const runId = `pr-ci-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const mission = buildMissionFromGoal('Add docs note', {
    preset: 'multitask-safe',
    repo_path: tmpRepo,
    output_dir: tmpOut,
    run_id: runId,
  });
  mission.mode = 'github';
  mission.capabilities = {
    allow_real_provider: false,
    allow_repo_apply: true,
    allow_repo_commit: true,
    allow_repo_push: true,
    allow_pr_create: true,
    allow_pr_update: true,
    allow_actions_read: true,
    allow_repair: true,
  };
  const planResult = await runAutopilotPlan(mission, { command: 'test' });
  return { tmpRepo, tmpOut, runId, mission, planResult };
}

describe('mission PR before CI observation', () => {
  const originalToken = process.env.GITHUB_TOKEN;

  test('PR is created before CI observation when autopilot defers remote finalization', async () => {
    process.env.GITHUB_TOKEN = 'fake-token';
    const { tmpRepo, tmpOut, mission, planResult } = await setupMission();
    try {
      const calls: Array<{ type: 'pr' | 'ci'; config?: MvpRunConfig }> = [];

      const result = await runMultitaskMission(mission, planResult, {
        command: 'test',
        runAutopilotRunFn: async () => makeDeferredAutopilotResult(planResult),
        collectDiffFn: () => '',
        reviewCallFn: async () => makeApprovedFinalReview(),
        createMvpRunPrFn: async (config) => {
          calls.push({ type: 'pr', config });
          return { created: true, number: 7, url: 'https://github.com/owner/repo/pull/7', draft: true, reason: 'ok' };
        },
        runAutopilotRemoteFinalizationFn: async (_config, mvpConfig) => {
          calls.push({ type: 'ci', config: mvpConfig });
          return makeCiSuccess();
        },
      });

      assert.strictEqual(result.verdict, 'MULTITASK_MISSION_DONE');
      assert.strictEqual(result.pr?.number, 7);
      assert.strictEqual(calls.length, 2, 'must create PR then observe CI exactly once');
      assert.strictEqual(calls[0].type, 'pr', 'first remote operation must be PR creation');
      assert.strictEqual(calls[1].type, 'ci', 'second remote operation must be CI observation');
      assert.strictEqual(calls[0].config?.work_branch, calls[1].config?.work_branch, 'PR and CI must use the same work branch');
    } finally {
      process.env.GITHUB_TOKEN = originalToken;
      rmSync(tmpRepo, { recursive: true, force: true });
      rmSync(tmpOut, { recursive: true, force: true });
    }
  });

  test('resume from creating_pr reuses existing PR and does not rerun autopilot or final review', async () => {
    process.env.GITHUB_TOKEN = 'fake-token';
    const { tmpRepo, tmpOut, runId, mission, planResult } = await setupMission();
    try {
      const runDir = getMissionRunDir(tmpOut, runId);
      const baseSha = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: tmpRepo, encoding: 'utf-8', shell: false }).stdout?.trim() ?? '';
      mkdirSync(runDir, { recursive: true });
      const autopilotResult = makeDeferredAutopilotResult(planResult);
      writeFileSync(
        join(runDir, 'multitask-mission-state.json'),
        JSON.stringify(
          {
            version: 1,
            run_id: runId,
            stage: 'creating_pr',
            plan_hash: computePlanHash(planResult.plan),
            base_sha: baseSha,
            work_branch: `mission-${runId}`,
            tasks: [{ task_id: 'mission-task-1', status: 'accepted', commit_sha: 'a'.repeat(40) }],
            autopilot_result: autopilotResult,
            final_review: {
              verdict: 'approved',
              summary: 'ok',
              caveats: [],
              unauthorized_files: [],
              acceptance_gaps: [],
            },
            pr: { number: 42, url: 'https://github.com/owner/repo/pull/42' },
          },
          null,
          2
        ),
        'utf-8'
      );

      let autopilotCalled = false;
      let reviewCalled = false;
      let prCalled = false;
      let ciCalled = false;

      const result = await runMultitaskMission(mission, planResult, {
        command: 'test',
        resume: true,
        runAutopilotRunFn: async () => {
          autopilotCalled = true;
          return autopilotResult;
        },
        collectDiffFn: () => {
          reviewCalled = true;
          return '';
        },
        reviewCallFn: async () => {
          reviewCalled = true;
          return makeApprovedFinalReview();
        },
        createMvpRunPrFn: async () => {
          prCalled = true;
          return { created: true, number: 99, url: 'https://github.com/owner/repo/pull/99', draft: true, reason: 'ok' };
        },
        runAutopilotRemoteFinalizationFn: async () => {
          ciCalled = true;
          return makeCiSuccess();
        },
      });

      assert.strictEqual(result.verdict, 'MULTITASK_MISSION_DONE');
      assert.strictEqual(autopilotCalled, false, 'autopilot must not rerun when resuming from creating_pr');
      assert.strictEqual(reviewCalled, false, 'final review/diff must not rerun when resuming from creating_pr');
      assert.strictEqual(prCalled, false, 'existing PR must be reused, not recreated');
      assert.strictEqual(ciCalled, true, 'CI observation must run after reusing PR');
      assert.strictEqual(result.pr?.number, 42, 'result must keep the existing PR number');
      const state = loadMissionState(runDir);
      assert.strictEqual(state?.pr?.number, 42);
      assert.strictEqual(state?.stage, 'completed');
    } finally {
      process.env.GITHUB_TOKEN = originalToken;
      rmSync(tmpRepo, { recursive: true, force: true });
      rmSync(tmpOut, { recursive: true, force: true });
    }
  });

  test('resume from awaiting_ci continues CI observation without re-running tasks or creating a second PR', async () => {
    process.env.GITHUB_TOKEN = 'fake-token';
    const { tmpRepo, tmpOut, runId, mission, planResult } = await setupMission();
    try {
      const runDir = getMissionRunDir(tmpOut, runId);
      const baseSha = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: tmpRepo, encoding: 'utf-8', shell: false }).stdout?.trim() ?? '';
      mkdirSync(runDir, { recursive: true });
      const autopilotResult = makeDeferredAutopilotResult(planResult);
      writeFileSync(
        join(runDir, 'multitask-mission-state.json'),
        JSON.stringify(
          {
            version: 1,
            run_id: runId,
            stage: 'awaiting_ci',
            plan_hash: computePlanHash(planResult.plan),
            base_sha: baseSha,
            work_branch: `mission-${runId}`,
            tasks: [{ task_id: 'mission-task-1', status: 'accepted', commit_sha: 'a'.repeat(40) }],
            autopilot_result: autopilotResult,
            final_review: {
              verdict: 'approved',
              summary: 'ok',
              caveats: [],
              unauthorized_files: [],
              acceptance_gaps: [],
            },
            pr: { number: 42, url: 'https://github.com/owner/repo/pull/42' },
          },
          null,
          2
        ),
        'utf-8'
      );

      let autopilotCalled = false;
      let prCalled = false;
      let ciCallCount = 0;

      const result = await runMultitaskMission(mission, planResult, {
        command: 'test',
        resume: true,
        runAutopilotRunFn: async () => {
          autopilotCalled = true;
          return autopilotResult;
        },
        collectDiffFn: () => '',
        reviewCallFn: async () => makeApprovedFinalReview(),
        createMvpRunPrFn: async () => {
          prCalled = true;
          return { created: true, number: 99, url: 'https://github.com/owner/repo/pull/99', draft: true, reason: 'ok' };
        },
        runAutopilotRemoteFinalizationFn: async () => {
          ciCallCount += 1;
          return makeCiSuccess();
        },
      });

      assert.strictEqual(result.verdict, 'MULTITASK_MISSION_DONE');
      assert.strictEqual(autopilotCalled, false, 'autopilot must not rerun when resuming from awaiting_ci');
      assert.strictEqual(prCalled, false, 'PR must not be recreated when resuming from awaiting_ci');
      assert.strictEqual(ciCallCount, 1, 'CI observation must run exactly once on resume');
      assert.strictEqual(result.pr?.number, 42);
    } finally {
      process.env.GITHUB_TOKEN = originalToken;
      rmSync(tmpRepo, { recursive: true, force: true });
      rmSync(tmpOut, { recursive: true, force: true });
    }
  });

  test('CI timeout after PR creation maps to EXTERNAL_BLOCKER without a second PR', async () => {
    process.env.GITHUB_TOKEN = 'fake-token';
    const { tmpRepo, tmpOut, mission, planResult } = await setupMission();
    try {
      let prCallCount = 0;
      let ciCallCount = 0;

      const result = await runMultitaskMission(mission, planResult, {
        command: 'test',
        runAutopilotRunFn: async () => makeDeferredAutopilotResult(planResult),
        collectDiffFn: () => '',
        reviewCallFn: async () => makeApprovedFinalReview(),
        createMvpRunPrFn: async () => {
          prCallCount += 1;
          return { created: true, number: 7, url: 'https://github.com/owner/repo/pull/7', draft: true, reason: 'ok' };
        },
        runAutopilotRemoteFinalizationFn: async () => {
          ciCallCount += 1;
          return makeCiTimeout();
        },
      });

      assert.strictEqual(result.verdict, 'MULTITASK_MISSION_EXTERNAL_BLOCKER');
      assert.strictEqual(prCallCount, 1, 'PR must be created exactly once');
      assert.strictEqual(ciCallCount, 1, 'CI observation must be attempted once');
      assert.strictEqual(result.pr?.number, 7);
    } finally {
      process.env.GITHUB_TOKEN = originalToken;
      rmSync(tmpRepo, { recursive: true, force: true });
      rmSync(tmpOut, { recursive: true, force: true });
    }
  });

  test('final review rejection prevents PR creation and CI observation', async () => {
    process.env.GITHUB_TOKEN = 'fake-token';
    const { tmpRepo, tmpOut, mission, planResult } = await setupMission();
    try {
      let prCalled = false;
      let ciCalled = false;

      const result = await runMultitaskMission(mission, planResult, {
        command: 'test',
        runAutopilotRunFn: async () => makeDeferredAutopilotResult(planResult),
        collectDiffFn: () => '',
        reviewCallFn: async () =>
          JSON.stringify({
            verdict: 'rejected',
            summary: 'bad',
            caveats: [],
            unauthorized_files: [],
            acceptance_gaps: [],
          }),
        createMvpRunPrFn: async () => {
          prCalled = true;
          return { created: false, reason: 'should not be called' };
        },
        runAutopilotRemoteFinalizationFn: async () => {
          ciCalled = true;
          return makeCiSuccess();
        },
      });

      assert.strictEqual(result.verdict, 'MULTITASK_MISSION_FAILED');
      assert.strictEqual(prCalled, false, 'PR must not be created when final review rejects');
      assert.strictEqual(ciCalled, false, 'CI must not be observed when final review rejects');
      assert.strictEqual(result.pr, undefined);
    } finally {
      process.env.GITHUB_TOKEN = originalToken;
      rmSync(tmpRepo, { recursive: true, force: true });
      rmSync(tmpOut, { recursive: true, force: true });
    }
  });

  test('CI repair result keeps the same PR and records repair attempts', async () => {
    process.env.GITHUB_TOKEN = 'fake-token';
    const { tmpRepo, tmpOut, mission, planResult } = await setupMission();
    try {
      let prCallCount = 0;

      const result = await runMultitaskMission(mission, planResult, {
        command: 'test',
        runAutopilotRunFn: async () => makeDeferredAutopilotResult(planResult),
        collectDiffFn: () => '',
        reviewCallFn: async () => makeApprovedFinalReview(),
        createMvpRunPrFn: async () => {
          prCallCount += 1;
          return { created: true, number: 7, url: 'https://github.com/owner/repo/pull/7', draft: true, reason: 'ok' };
        },
        runAutopilotRemoteFinalizationFn: async () => ({
          verdict: 'AUTOPILOT_REPAIR_EXHAUSTED',
          reason: 'Repair exhausted',
          ci_run_id: 111,
          ci_conclusion: 'failure',
          repair_attempts: 2,
        }),
      });

      assert.strictEqual(result.verdict, 'MULTITASK_MISSION_FAILED');
      assert.strictEqual(prCallCount, 1, 'only one PR must be created');
      assert.strictEqual(result.pr?.number, 7);
      assert.strictEqual(result.ci_run_id, 111);
      assert.strictEqual(result.repair_attempts, 2);
    } finally {
      process.env.GITHUB_TOKEN = originalToken;
      rmSync(tmpRepo, { recursive: true, force: true });
      rmSync(tmpOut, { recursive: true, force: true });
    }
  });
});
