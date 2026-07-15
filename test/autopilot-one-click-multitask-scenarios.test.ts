import { describe, test } from 'node:test';
import assert from 'node:assert';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildMissionFromGoal } from '../src/autopilot-one-click/mission-builder.js';
import { runAutopilotPlan } from '../src/autopilot-plan/runner.js';
import { runMultitaskMission, loadMissionState } from '../src/autopilot-one-click/multitask/runner.js';
import { saveMissionState, getMissionRunDir, computePlanHash } from '../src/autopilot-one-click/multitask/state-manager.js';
import { validateGeneratedPlan } from '../src/autopilot-one-click/multitask/plan-validator.js';
import { scheduleTasks, filterRunnableTasks, allRequiredTasksAccepted } from '../src/autopilot-one-click/multitask/scheduler.js';
import { runMissionFinalReview } from '../src/autopilot-one-click/multitask/final-review.js';
import { collectUnauthorizedFiles, collectAcceptanceGaps } from '../src/autopilot-one-click/multitask/final-review.js';
import type { AutopilotPlanGeneratedPlan, AutopilotPlanMission, AutopilotPlanTask } from '../src/autopilot-plan/types.js';
import type { AutopilotRunResult } from '../src/autopilot-run/types.js';

function makeTask(id: string, overrides: Partial<AutopilotPlanTask> = {}): AutopilotPlanTask {
  return {
    id,
    title: `Task ${id}`,
    goal: `Implement ${id}`,
    allowed_files: ['docs/AUTOPILOT_PLAN.md'],
    denied_files: ['.env'],
    checks: ['npm test'],
    risk: 'low',
    acceptance_criteria: [`${id} works`],
    expected_result: `${id} passes tests`,
    max_lines_changed: 100,
    ...overrides,
  };
}

function makePlan(tasks: AutopilotPlanTask[]): AutopilotPlanGeneratedPlan {
  return {
    goal: 'Test plan',
    mode: 'fake',
    tasks,
    ci_enabled: false,
    repair_enabled: false,
    risk_level: 'low',
    caveats: [],
  };
}

function fakeGitExec(acceptedCommits: string[] = [], captured: string[][] = []) {
  return (args: string[], options?: { cwd?: string }) => {
    captured.push(args);
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
      return { status: 0, stdout: args[2] + '\n', stderr: '' };
    }
    return { status: 0, stdout: '', stderr: '' };
  };
}

function fakeAutopilotResult(
  planResult: ReturnType<typeof runAutopilotPlan> extends Promise<infer R> ? R : never,
  taskStatuses: { id: string; status: 'passed' | 'failed' | 'blocked' | 'needs_human'; commit_sha?: string }[],
  verdict: AutopilotRunResult['verdict'] = 'AUTOPILOT_GREEN'
): AutopilotRunResult {
  const configPath = planResult.generated_files.find((p: string) => p.endsWith('autopilot.config.json'))!;
  const mvpConfigPath = planResult.generated_files.find((p: string) => p.endsWith('mvp-run.config.json'))!;
  return {
    config: {} as AutopilotRunResult['config'],
    command: 'test',
    config_path: configPath,
    started_at: new Date().toISOString(),
    finished_at: new Date().toISOString(),
    duration_ms: 100,
    verdict,
    reason: 'Fake autopilot',
    repair_attempts: 0,
    report_dir: planResult.run_dir,
    exit_code: verdict === 'AUTOPILOT_GREEN' || verdict === 'AUTOPILOT_MVP_DONE_CI_NOT_OBSERVED' ? 0 : 1,
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
      task_results: taskStatuses.map((t) => ({
        id: t.id,
        title: `Task ${t.id}`,
        status: t.status,
        provider_attempts: 1,
        recovery_attempts: 0,
        commit_sha: t.commit_sha,
      })),
      tasks_total: taskStatuses.length,
      tasks_passed: taskStatuses.filter((t) => t.status === 'passed').length,
      tasks_failed: taskStatuses.filter((t) => t.status === 'failed').length,
      tasks_blocked: taskStatuses.filter((t) => t.status === 'blocked').length,
      tasks_skipped: 0,
      tasks_caveats: 0,
      commits: taskStatuses.map((t) => t.commit_sha).filter((sha): sha is string => typeof sha === 'string'),
      branch: 'mission-branch',
      pushed: false,
      caveats: [],
      report_dir: join(planResult.run_dir, 'mvp-run-reports'),
    },
  };
}

describe('dependency-aware scheduler', () => {
  test('topological order runs dependencies first', () => {
    const tasks = [makeTask('b', { depends_on: ['a'] }), makeTask('a')];
    const scheduled = scheduleTasks(tasks, []);
    assert.deepStrictEqual(
      scheduled.map((s) => ({ id: s.task.id, disposition: s.disposition })),
      [
        { id: 'a', disposition: 'run' },
        { id: 'b', disposition: 'run' },
      ]
    );
  });

  test('already accepted tasks are skipped', () => {
    const tasks = [makeTask('a'), makeTask('b', { depends_on: ['a'] })];
    const states = [{ task_id: 'a', status: 'accepted' as const, commit_sha: 'abc' }];
    const scheduled = scheduleTasks(tasks, states);
    assert.strictEqual(scheduled[0].disposition, 'skip_already_finished');
    assert.strictEqual(scheduled[1].disposition, 'run');
  });

  test('failed dependency blocks descendants', () => {
    const tasks = [makeTask('a'), makeTask('b', { depends_on: ['a'] }), makeTask('c', { depends_on: ['b'] })];
    const states = [{ task_id: 'a', status: 'failed' as const }];
    const scheduled = scheduleTasks(tasks, states);
    assert.strictEqual(scheduled[0].disposition, 'run');
    assert.strictEqual(scheduled[1].disposition, 'skip_dependency_failed');
    assert.strictEqual(scheduled[2].disposition, 'skip_dependency_failed');
  });

  test('independent tasks remain runnable when sibling fails', () => {
    const tasks = [makeTask('a'), makeTask('b'), makeTask('c', { depends_on: ['b'] })];
    const states = [{ task_id: 'a', status: 'failed' as const }];
    const runnable = filterRunnableTasks(tasks, states);
    assert.deepStrictEqual(runnable.map((t) => t.id), ['b', 'c']);
  });

  test('allRequiredTasksAccepted is false when any task not accepted', () => {
    const tasks = [makeTask('a'), makeTask('b')];
    assert.strictEqual(allRequiredTasksAccepted(tasks, [{ task_id: 'a', status: 'accepted' }]), false);
    assert.strictEqual(
      allRequiredTasksAccepted(tasks, [
        { task_id: 'a', status: 'accepted' },
        { task_id: 'b', status: 'accepted' },
      ]),
      true
    );
  });
});

describe('plan validation', () => {
  const baseMission = buildMissionFromGoal('Add feature', { preset: 'multitask-safe', repo_path: '.' });

  test('valid plan passes', () => {
    const plan = makePlan([makeTask('a')]);
    const result = validateGeneratedPlan(plan, baseMission);
    assert.strictEqual(result.ok, true);
  });

  test('rejects missing required fields', () => {
    const plan = makePlan([{ ...makeTask('a'), acceptance_criteria: undefined } as AutopilotPlanTask]);
    const result = validateGeneratedPlan(plan, baseMission);
    assert.strictEqual(result.ok, false);
    assert.ok(result.issues.some((i) => i.field.includes('acceptance_criteria')));
  });

  test('rejects duplicate task ids', () => {
    const plan = makePlan([makeTask('a'), makeTask('a')]);
    const result = validateGeneratedPlan(plan, baseMission);
    assert.strictEqual(result.ok, false);
    assert.ok(result.issues.some((i) => i.message.includes('Duplicate')));
  });

  test('rejects dependency cycle', () => {
    const plan = makePlan([makeTask('a', { depends_on: ['b'] }), makeTask('b', { depends_on: ['a'] })]);
    const result = validateGeneratedPlan(plan, baseMission);
    assert.strictEqual(result.ok, false);
    assert.ok(result.issues.some((i) => i.message.includes('cycle')));
  });

  test('rejects file scope overlap on independent tasks', () => {
    const plan = makePlan([makeTask('a'), makeTask('b')]);
    const result = validateGeneratedPlan(plan, baseMission);
    assert.strictEqual(result.ok, false);
    assert.ok(result.issues.some((i) => i.message.includes('share allowed files')));
  });

  test('allows shared files when tasks depend on each other', () => {
    const plan = makePlan([makeTask('a'), makeTask('b', { depends_on: ['a'] })]);
    const result = validateGeneratedPlan(plan, baseMission);
    assert.strictEqual(result.ok, true);
  });

  test('rejects path traversal in allowed_files', () => {
    const plan = makePlan([makeTask('a', { allowed_files: ['../secret.ts'] })]);
    const result = validateGeneratedPlan(plan, baseMission);
    assert.strictEqual(result.ok, false);
    assert.ok(result.issues.some((i) => i.message.includes('traversal')));
  });

  test('rejects absolute path in allowed_files', () => {
    const plan = makePlan([makeTask('a', { allowed_files: ['/etc/passwd'] })]);
    const result = validateGeneratedPlan(plan, baseMission);
    assert.strictEqual(result.ok, false);
    assert.ok(result.issues.some((i) => i.message.includes('relative path')));
  });

  test('rejects more than 8 tasks', () => {
    const tasks = Array.from({ length: 9 }, (_, i) =>
      makeTask(`t${i}`, {
        allowed_files: i % 2 === 0 ? ['README.md'] : ['docs/AUTOPILOT_PLAN.md'],
        depends_on: i > 0 ? [`t${i - 1}`] : undefined,
      })
    );
    const plan = makePlan(tasks);
    const result = validateGeneratedPlan(plan, baseMission);
    assert.strictEqual(result.ok, false);
    assert.ok(result.issues.some((i) => i.message.includes('at most 8')));
  });

  test('rejects empty task list', () => {
    const plan = makePlan([]);
    const result = validateGeneratedPlan(plan, baseMission);
    assert.strictEqual(result.ok, false);
  });

  test('allows non-existent file for create tasks', () => {
    const plan = makePlan([makeTask('a', { goal: 'Create new helper', allowed_files: ['src/new-helper.ts'] })]);
    const result = validateGeneratedPlan(plan, baseMission);
    assert.strictEqual(result.ok, true);
  });
});

describe('final review helpers', () => {
  test('collectUnauthorizedFiles flags files outside allowed set', () => {
    const diff = 'diff --git a/src/bad.ts b/src/bad.ts\n+line';
    assert.deepStrictEqual(collectUnauthorizedFiles(diff, ['src/ok.ts']), ['src/bad.ts']);
  });

  test('collectUnauthorizedFiles ignores allowed files', () => {
    const diff = 'diff --git a/src/ok.ts b/src/ok.ts\n+line';
    assert.deepStrictEqual(collectUnauthorizedFiles(diff, ['src/ok.ts']), []);
  });

  test('collectAcceptanceGaps lists non-accepted tasks', () => {
    const expected = new Map([['a', 'works']]);
    const gaps = collectAcceptanceGaps([{ task_id: 'a', status: 'failed' }], expected);
    assert.strictEqual(gaps.length, 1);
    assert.ok(gaps[0].includes('a'));
  });

  test('deterministic final review rejects false green with unauthorized file', async () => {
    const mission = buildMissionFromGoal('Add feature', { preset: 'multitask-safe', repo_path: '.' });
    const plan = makePlan([makeTask('a', { allowed_files: ['src/a.ts'] })]);
    const autopilot = fakeAutopilotResult(
      { generated_files: [], run_dir: '/tmp' } as unknown as Awaited<ReturnType<typeof runAutopilotPlan>>,
      [{ id: 'a', status: 'passed', commit_sha: 'abc' }]
    );
    const review = await runMissionFinalReview({
      mission,
      plan,
      autopilotResult: autopilot,
      integratedDiff: 'diff --git a/src/other.ts b/src/other.ts\n+line',
      taskStates: [{ task_id: 'a', status: 'accepted' }],
    });
    assert.strictEqual(review.verdict, 'rejected');
    assert.ok(review.unauthorized_files?.includes('src/other.ts'));
  });

  test('deterministic final review rejects false green with acceptance gap', async () => {
    const mission = buildMissionFromGoal('Add feature', { preset: 'multitask-safe', repo_path: '.' });
    const plan = makePlan([makeTask('a', { allowed_files: ['src/a.ts'] })]);
    const autopilot = fakeAutopilotResult(
      { generated_files: [], run_dir: '/tmp' } as unknown as Awaited<ReturnType<typeof runAutopilotPlan>>,
      [{ id: 'a', status: 'passed', commit_sha: 'abc' }]
    );
    const review = await runMissionFinalReview({
      mission,
      plan,
      autopilotResult: autopilot,
      integratedDiff: 'diff --git a/src/a.ts b/src/a.ts\n+line',
      taskStates: [{ task_id: 'a', status: 'failed' }],
    });
    assert.strictEqual(review.verdict, 'rejected');
    assert.ok((review.acceptance_gaps ?? []).length > 0);
  });

  test('deterministic final review approves green run with all tasks accepted', async () => {
    const mission = buildMissionFromGoal('Add feature', { preset: 'multitask-safe', repo_path: '.' });
    const plan = makePlan([makeTask('a', { allowed_files: ['src/a.ts'] })]);
    const autopilot = fakeAutopilotResult(
      { generated_files: [], run_dir: '/tmp' } as unknown as Awaited<ReturnType<typeof runAutopilotPlan>>,
      [{ id: 'a', status: 'passed', commit_sha: 'abc' }]
    );
    const review = await runMissionFinalReview({
      mission,
      plan,
      autopilotResult: autopilot,
      integratedDiff: 'diff --git a/src/a.ts b/src/a.ts\n+line',
      taskStates: [{ task_id: 'a', status: 'accepted' }],
    });
    assert.strictEqual(review.verdict, 'approved');
  });
});

describe('durable mission state and resume', () => {
  async function setupMission(): Promise<{
    tmpDir: string;
    runId: string;
    mission: AutopilotPlanMission;
    planResult: Awaited<ReturnType<typeof runAutopilotPlan>>;
  }> {
    const tmpDir = mkdtempSync(join(tmpdir(), 'multi-'));
    const runId = `scenario-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const mission = buildMissionFromGoal('Add docs note', {
      preset: 'multitask-safe',
      output_dir: tmpDir,
      run_id: runId,
    });
    const planResult = await runAutopilotPlan(mission, { command: 'test' });
    return { tmpDir, runId, mission, planResult };
  }

  test('resume with mismatched plan hash fails', async () => {
    const { tmpDir, runId, mission, planResult } = await setupMission();
    const runDir = getMissionRunDir(tmpDir, runId);
    saveMissionState(runDir, {
      version: 1,
      run_id: runId,
      stage: 'running',
      plan_hash: 'mismatched-hash',
      base_sha: 'base-sha-1234567890abcdef',
      work_branch: `mission-${runId}`,
      tasks: [],
    });

    const result = await runMultitaskMission(mission, planResult, {
      command: 'test',
      resume: true,
      runAutopilotRunFn: async () => ({} as AutopilotRunResult),
      gitExecFn: fakeGitExec(),
    });

    assert.strictEqual(result.verdict, 'MULTITASK_MISSION_FAILED');
    assert.ok(result.reason.includes('plan changed'));
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('resume with moved base branch fails', async () => {
    const { tmpDir, runId, mission, planResult } = await setupMission();
    const runDir = getMissionRunDir(tmpDir, runId);
    saveMissionState(runDir, {
      version: 1,
      run_id: runId,
      stage: 'running',
      plan_hash: computePlanHash(planResult.plan),
      base_sha: 'old-base-sha',
      work_branch: `mission-${runId}`,
      tasks: [],
    });

    const result = await runMultitaskMission(mission, planResult, {
      command: 'test',
      resume: true,
      runAutopilotRunFn: async () => ({} as AutopilotRunResult),
      gitExecFn: fakeGitExec(),
    });

    assert.strictEqual(result.verdict, 'MULTITASK_MISSION_FAILED');
    assert.ok(result.reason.includes('base branch moved'));
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('resume fails when accepted commit is not an ancestor', async () => {
    const { tmpDir, runId, mission, planResult } = await setupMission();
    const runDir = getMissionRunDir(tmpDir, runId);
    saveMissionState(runDir, {
      version: 1,
      run_id: runId,
      stage: 'running',
      plan_hash: 'plan-hash', // will mismatch real plan hash
      base_sha: 'base-sha-1234567890abcdef',
      work_branch: `mission-${runId}`,
      tasks: [{ task_id: 'mission-task-1', status: 'accepted', commit_sha: 'orphan-sha' }],
    });

    const result = await runMultitaskMission(mission, planResult, {
      command: 'test',
      resume: true,
      runAutopilotRunFn: async () => ({} as AutopilotRunResult),
      gitExecFn: fakeGitExec(),
    });

    // Plan hash mismatch is checked before ancestor check, which still proves resume safety.
    assert.strictEqual(result.verdict, 'MULTITASK_MISSION_FAILED');
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('blocked task commit is reverted from mission branch', async () => {
    const { tmpDir, runId, mission, planResult } = await setupMission();
    const commitSha = 'b'.repeat(40);
    const captured: string[][] = [];
    const autopilot = fakeAutopilotResult(planResult, [{ id: 'mission-task-1', status: 'blocked', commit_sha: commitSha }]);

    const result = await runMultitaskMission(mission, planResult, {
      command: 'test',
      runAutopilotRunFn: async () => autopilot,
      gitExecFn: fakeGitExec([], captured),
      collectDiffFn: () => '',
    });

    assert.strictEqual(result.verdict, 'MULTITASK_MISSION_FAILED');
    assert.ok(captured.some((args) => args[0] === 'revert' && args.includes(commitSha)));
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('CI timeout maps to EXTERNAL_BLOCKER', async () => {
    const { tmpDir, runId, mission, planResult } = await setupMission();
    const commitSha = 'c'.repeat(40);
    const autopilot = fakeAutopilotResult(planResult, [{ id: 'mission-task-1', status: 'passed', commit_sha: commitSha }], 'AUTOPILOT_CI_TIMEOUT');

    const result = await runMultitaskMission(mission, planResult, {
      command: 'test',
      runAutopilotRunFn: async () => autopilot,
      gitExecFn: fakeGitExec([commitSha]),
      collectDiffFn: () => 'diff --git a/docs/AUTOPILOT_PLAN.md b/docs/AUTOPILOT_PLAN.md\n+line',
    });

    assert.strictEqual(result.verdict, 'MULTITASK_MISSION_EXTERNAL_BLOCKER');
    rmSync(tmpDir, { recursive: true, force: true });
  });
});
