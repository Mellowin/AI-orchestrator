import { describe, test } from 'node:test';
import assert from 'node:assert';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildMissionFromGoal, MissionBuilderError } from '../src/autopilot-one-click/mission-builder.js';
import { runAutopilotPlan } from '../src/autopilot-plan/runner.js';
import { runMultitaskMission, loadMissionState } from '../src/autopilot-one-click/multitask/runner.js';
import { runAutopilotOneClick } from '../src/autopilot-one-click/runner.js';
import type { AutopilotRunResult } from '../src/autopilot-run/types.js';

function fakeGitExec(acceptedCommits: string[] = []) {
  return (args: string[], options?: { cwd?: string }) => {
    const command = args[0];
    if (command === 'rev-parse' && args[1] === 'main') {
      return { status: 0, stdout: 'base-sha-1234567890abcdef\n', stderr: '' };
    }
    if (command === 'rev-parse' && args[1] === '--abbrev-ref' && args[2] === 'HEAD') {
      return { status: 0, stdout: 'mission-branch\n', stderr: '' };
    }
    if (command === 'checkout' || command === 'revert' || command === 'push') {
      return { status: 0, stdout: '', stderr: '' };
    }
    if (command === 'checkout' && args[1] === '-B') {
      return { status: 0, stdout: '', stderr: '' };
    }
    if (command === 'merge-base' && args[1] === '--is-ancestor') {
      const sha = args[2];
      return { status: acceptedCommits.includes(sha) ? 0 : 1, stdout: '', stderr: '' };
    }
    if (command === 'merge-base') {
      return { status: 0, stdout: 'base-sha-1234567890abcdef\n', stderr: '' };
    }
    if (command === 'rev-parse' && args[1] === '--verify') {
      return { status: 0, stdout: args[2] + '\n', stderr: '' };
    }
    return { status: 0, stdout: '', stderr: '' };
  };
}

function fakeCollectDiff(): string {
  return 'diff --git a/docs/AUTOPILOT_PLAN.md b/docs/AUTOPILOT_PLAN.md\n+added line';
}

describe('autopilot-one-click multitask presets', () => {
  test('multitask-safe preset is fake with no writes', () => {
    const mission = buildMissionFromGoal('Add docs', { preset: 'multitask-safe' });
    assert.strictEqual(mission.mode, 'fake');
    assert.strictEqual(mission.capabilities.allow_real_provider, false);
    assert.strictEqual(mission.capabilities.allow_repo_apply, false);
    assert.strictEqual(mission.capabilities.allow_repo_commit, false);
    assert.strictEqual(mission.capabilities.allow_repo_push, false);
    assert.strictEqual(mission.capabilities.allow_pr_create, false);
    assert.strictEqual(mission.capabilities.allow_repair, false);
  });

  test('real-multitask preset enables all mutation and repair capabilities', () => {
    const mission = buildMissionFromGoal('Implement multi-task feature', { preset: 'real-multitask' });
    assert.strictEqual(mission.mode, 'github');
    assert.strictEqual(mission.capabilities.allow_real_provider, true);
    assert.strictEqual(mission.capabilities.allow_repo_apply, true);
    assert.strictEqual(mission.capabilities.allow_repo_commit, true);
    assert.strictEqual(mission.capabilities.allow_repo_push, true);
    assert.strictEqual(mission.capabilities.allow_pr_create, true);
    assert.strictEqual(mission.capabilities.allow_actions_read, true);
    assert.strictEqual(mission.capabilities.allow_repair, true);
    assert.strictEqual(mission.repair?.max_attempts, 2);
  });

  test('multitask-safe rejects github mode', () => {
    assert.throws(
      () => buildMissionFromGoal('x', { preset: 'multitask-safe', mode: 'github' }),
      MissionBuilderError
    );
  });

  test('real-multitask rejects fake mode', () => {
    assert.throws(
      () => buildMissionFromGoal('x', { preset: 'real-multitask', mode: 'fake' }),
      MissionBuilderError
    );
  });
});

describe('autopilot-one-click multitask mission runner', () => {
  test('multitask-safe mission completes with MULTITASK_MISSION_DONE', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'multi-'));
    const runId = `multitask-test-${Date.now()}`;
    const mission = buildMissionFromGoal('Add a docs note', {
      preset: 'multitask-safe',
      output_dir: tmpDir,
      run_id: runId,
    });

    const planResult = await runAutopilotPlan(mission, { command: 'test' });
    assert.strictEqual(planResult.exit_code, 0);

    const commitSha = 'a'.repeat(40);
    const fakeAutopilotResult: AutopilotRunResult = {
      config: {} as AutopilotRunResult['config'],
      command: 'test',
      config_path: planResult.generated_files.find((p) => p.endsWith('autopilot.config.json'))!,
      started_at: new Date().toISOString(),
      finished_at: new Date().toISOString(),
      duration_ms: 100,
      verdict: 'AUTOPILOT_GREEN',
      reason: 'Fake green',
      repair_attempts: 0,
      report_dir: join(tmpDir, runId),
      exit_code: 0,
      mvp_result: {
        config: {} as AutopilotRunResult['mvp_result']['config'],
        command: 'mvp',
        config_path: planResult.generated_files.find((p) => p.endsWith('mvp-run.config.json'))!,
        started_at: new Date().toISOString(),
        finished_at: new Date().toISOString(),
        duration_ms: 50,
        verdict: 'MVP_RUN_PASSED',
        reason: 'Fake MVP',
        preflight: {} as AutopilotRunResult['mvp_result']['preflight'],
        task_results: [
          {
            id: 'mission-task-1',
            title: 'Add a docs note',
            status: 'passed',
            provider_attempts: 1,
            recovery_attempts: 0,
            commit_sha: commitSha,
          },
        ],
        tasks_total: 1,
        tasks_passed: 1,
        tasks_failed: 0,
        tasks_blocked: 0,
        tasks_skipped: 0,
        tasks_caveats: 0,
        commits: [commitSha],
        branch: `mission-${runId}`,
        pushed: false,
        caveats: [],
        report_dir: join(tmpDir, runId, 'mvp-run-reports'),
      },
    };

    const result = await runMultitaskMission(mission, planResult, {
      command: 'test',
      runAutopilotRunFn: async () => fakeAutopilotResult,
      gitExecFn: fakeGitExec([commitSha]),
      collectDiffFn: fakeCollectDiff,
    });

    assert.strictEqual(result.verdict, 'MULTITASK_MISSION_DONE');
    assert.strictEqual(result.exit_code, 0);
    assert.strictEqual(result.task_results.length, 1);
    assert.strictEqual(result.task_results[0].status, 'accepted');
    assert.ok(existsSync(join(tmpDir, 'missions', runId, 'multitask-mission-report.md')));
    assert.ok(existsSync(join(tmpDir, 'missions', runId, 'multitask-mission-report.json')));

    const state = loadMissionState(join(tmpDir, 'missions', runId));
    assert.ok(state);
    assert.strictEqual(state?.stage, 'completed');
    assert.strictEqual(state?.result?.verdict, 'MULTITASK_MISSION_DONE');

    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('repair-exhausted autopilot maps to MULTITASK_MISSION_FAILED', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'multi-'));
    const runId = `multitask-repair-${Date.now()}`;
    const mission = buildMissionFromGoal('Fix CI', {
      preset: 'multitask-safe',
      output_dir: tmpDir,
      run_id: runId,
    });

    const planResult = await runAutopilotPlan(mission, { command: 'test' });
    assert.strictEqual(planResult.exit_code, 0);

    const fakeAutopilotResult: AutopilotRunResult = {
      config: {} as AutopilotRunResult['config'],
      command: 'test',
      config_path: planResult.generated_files.find((p) => p.endsWith('autopilot.config.json'))!,
      started_at: new Date().toISOString(),
      finished_at: new Date().toISOString(),
      duration_ms: 100,
      verdict: 'AUTOPILOT_REPAIR_EXHAUSTED',
      reason: 'Repair exhausted',
      repair_attempts: 2,
      report_dir: join(tmpDir, runId),
      exit_code: 1,
    };

    const result = await runMultitaskMission(mission, planResult, {
      command: 'test',
      runAutopilotRunFn: async () => fakeAutopilotResult,
      gitExecFn: fakeGitExec(),
      collectDiffFn: fakeCollectDiff,
    });

    assert.strictEqual(result.verdict, 'MULTITASK_MISSION_FAILED');
    assert.notStrictEqual(result.exit_code, 0);

    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('runMultitaskMission rejection is converted to MULTITASK_MISSION_FAILED', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'multi-'));
    const runId = `multitask-reject-${Date.now()}`;

    const result = await runAutopilotOneClick(
      'Add a docs note',
      {
        preset: 'multitask-safe',
        output_dir: tmpDir,
        run_id: runId,
        runMultitaskMissionFn: async () => {
          throw new Error('simulated multitask runner failure');
        },
      },
      'test'
    );

    assert.strictEqual(result.verdict, 'MULTITASK_MISSION_FAILED');
    assert.ok(result.reason.includes('simulated multitask runner failure'));
    assert.strictEqual(result.exit_code, 1);
    assert.ok(existsSync(join(tmpDir, runId, 'one-click-report.md')));

    rmSync(tmpDir, { recursive: true, force: true });
  });
});
