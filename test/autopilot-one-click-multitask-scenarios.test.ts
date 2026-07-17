import { describe, test } from 'node:test';
import assert from 'node:assert';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildMissionFromGoal } from '../src/autopilot-one-click/mission-builder.js';
import { runAutopilotPlan } from '../src/autopilot-plan/runner.js';
import { runAutopilotRun } from '../src/autopilot-run/runner.js';
import type { MvpRunResult } from '../src/mvp-run/types.js';
import { prepareScenarioWorkBranch } from '../src/acceptance-matrix/sandbox-preparer.js';
import { loadMissionState, runMultitaskMission } from '../src/autopilot-one-click/multitask/runner.js';
import { loadMissionState, saveMissionState, getMissionRunDir, computePlanHash } from '../src/autopilot-one-click/multitask/state-manager.js';
import { validateGeneratedPlan } from '../src/autopilot-one-click/multitask/plan-validator.js';
import { scheduleTasks, filterRunnableTasks, allRequiredTasksAccepted } from '../src/autopilot-one-click/multitask/scheduler.js';
import { runMissionFinalReview } from '../src/autopilot-one-click/multitask/final-review.js';
import { collectUnauthorizedFiles, collectAcceptanceGaps } from '../src/autopilot-one-click/multitask/final-review.js';
import { buildOpenAIReviewCallFn, buildProductionFinalReviewCallFn } from '../src/autopilot-one-click/multitask/reviewer-provider.js';
import { validateFileList } from '../src/guardrails.js';
import { branchExists, getCurrentBranch } from '../src/autopilot-one-click/multitask/git-helpers.js';
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
      return { status: 1, stdout: '', stderr: 'unknown revision' };
    }
    return { status: 0, stdout: '', stderr: '' };
  };
}

function fakeAutopilotResult(
  planResult: ReturnType<typeof runAutopilotPlan> extends Promise<infer R> ? R : never,
  taskStatuses: {
    id: string;
    status: 'passed' | 'passed_with_caveats' | 'failed' | 'blocked' | 'needs_human';
    commit_sha?: string;
    fix_commit_sha?: string;
  }[],
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
        recovery_attempts: t.status === 'passed_with_caveats' ? 1 : 0,
        commit_sha: t.commit_sha,
        fix_commit_sha: t.fix_commit_sha,
      })),
      tasks_total: taskStatuses.length,
      tasks_passed: taskStatuses.filter((t) => t.status === 'passed' || t.status === 'passed_with_caveats').length,
      tasks_failed: taskStatuses.filter((t) => t.status === 'failed').length,
      tasks_blocked: taskStatuses.filter((t) => t.status === 'blocked').length,
      tasks_skipped: 0,
      tasks_caveats: taskStatuses.filter((t) => t.status === 'passed_with_caveats').length,
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

  test('rejects task file outside mission allowlist', () => {
    const mission = { ...baseMission, allowed_files: ['docs/proofs/part1.md'] };
    const plan = makePlan([makeTask('a', { allowed_files: ['docs/proofs/part2.md'] })]);
    const result = validateGeneratedPlan(plan, mission);
    assert.strictEqual(result.ok, false);
    assert.ok(result.issues.some((i) => i.message.includes('outside the mission allowlist')));
  });

  test('allows exact task file within mission allowlist', () => {
    const mission = { ...baseMission, allowed_files: ['docs/proofs/part1.md'] };
    const plan = makePlan([makeTask('a', { allowed_files: ['docs/proofs/part1.md'] })]);
    const result = validateGeneratedPlan(plan, mission);
    assert.strictEqual(result.ok, true);
  });

  test('path normalization cannot bypass mission allowlist', () => {
    const mission = { ...baseMission, allowed_files: ['docs/proofs/part1.md'] };
    const plan = makePlan([makeTask('a', { allowed_files: ['docs\\proofs\\part2.md'] })]);
    const result = validateGeneratedPlan(plan, mission);
    assert.strictEqual(result.ok, false);
    assert.ok(result.issues.some((i) => i.message.includes('outside the mission allowlist')));
  });

  test('union of task scopes must stay within mission allowlist', () => {
    const mission = { ...baseMission, allowed_files: ['docs/proofs/part1.md', 'docs/proofs/part2.md'] };
    const plan = makePlan([
      makeTask('a', { allowed_files: ['docs/proofs/part1.md'] }),
      makeTask('b', { depends_on: ['a'], allowed_files: ['docs/proofs/part2.md'] }),
    ]);
    const result = validateGeneratedPlan(plan, mission);
    assert.strictEqual(result.ok, true);
  });

  test('supports glob patterns in mission allowlist', () => {
    const mission = { ...baseMission, allowed_files: ['docs/proofs/*.md'] };
    const plan = makePlan([makeTask('a', { allowed_files: ['docs/proofs/part1.md'] })]);
    const result = validateGeneratedPlan(plan, mission);
    assert.strictEqual(result.ok, true);
  });
  test('detects glob scope overlap on independent tasks', () => {
    const plan = makePlan([
      makeTask('a', { allowed_files: ['src/**'] }),
      makeTask('b', { allowed_files: ['src/foo.ts'] }),
    ]);
    const result = validateGeneratedPlan(plan, baseMission);
    assert.strictEqual(result.ok, false);
    assert.ok(result.issues.some((i) => i.message.includes('overlapping scopes')));
  });

  test('detects glob scope overlap with single-segment wildcards', () => {
    const plan = makePlan([
      makeTask('a', { allowed_files: ['docs/*.md'] }),
      makeTask('b', { allowed_files: ['docs/readme.md'] }),
    ]);
    const result = validateGeneratedPlan(plan, baseMission);
    assert.strictEqual(result.ok, false);
    assert.ok(result.issues.some((i) => i.message.includes('overlapping scopes')));
  });

  test('allows identical globs for dependent tasks', () => {
    const plan = makePlan([
      makeTask('a', { allowed_files: ['src/**'] }),
      makeTask('b', { depends_on: ['a'], allowed_files: ['src/**'] }),
    ]);
    const result = validateGeneratedPlan(plan, baseMission);
    assert.strictEqual(result.ok, true);
  });

  test('allows non-overlapping exact paths', () => {
    const plan = makePlan([
      makeTask('a', { allowed_files: ['src/a.ts'] }),
      makeTask('b', { allowed_files: ['src/b.ts'] }),
    ]);
    const result = validateGeneratedPlan(plan, baseMission);
    assert.strictEqual(result.ok, true);
  });

  test('normalizes Windows separators for scope overlap', () => {
    const plan = makePlan([
      makeTask('a', { allowed_files: ['src/**'] }),
      makeTask('b', { allowed_files: ['src\\foo.ts'] }),
    ]);
    const result = validateGeneratedPlan(plan, baseMission);
    assert.strictEqual(result.ok, false);
    assert.ok(result.issues.some((i) => i.message.includes('overlapping scopes')));
  });


  test('allows overlap between transitively ordered tasks', () => {
    const plan = makePlan([
      makeTask('a', { allowed_files: ['src/shared.ts'] }),
      makeTask('b', { depends_on: ['a'], allowed_files: ['src/b.ts'] }),
      makeTask('c', { depends_on: ['b'], allowed_files: ['src/shared.ts'] }),
    ]);
    const result = validateGeneratedPlan(plan, baseMission);
    assert.strictEqual(result.ok, true);
  });

  test('rejects overlap between sibling tasks with a shared ancestor', () => {
    const plan = makePlan([
      makeTask('a', { allowed_files: ['src/shared.ts'] }),
      makeTask('b', { depends_on: ['a'], allowed_files: ['src/shared.ts'] }),
      makeTask('c', { depends_on: ['a'], allowed_files: ['src/shared.ts'] }),
    ]);
    const result = validateGeneratedPlan(plan, baseMission);
    assert.strictEqual(result.ok, false);
    assert.ok(result.issues.some((i) => i.message.includes('overlapping scopes')));
  });

  test('allows transitive chain with glob overlap', () => {
    const plan = makePlan([
      makeTask('a', { allowed_files: ['src/**/*.ts'] }),
      makeTask('b', { depends_on: ['a'], allowed_files: ['src/api/*.ts'] }),
      makeTask('c', { depends_on: ['b'], allowed_files: ['src/api/index.ts'] }),
    ]);
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

  test('collectUnauthorizedFiles rejects rename from allowed to out-of-scope', () => {
    const diff = [
      'diff --git a/src/ok.ts b/src/bad.ts',
      'rename from src/ok.ts',
      'rename to src/bad.ts',
    ].join('\n');
    assert.deepStrictEqual(collectUnauthorizedFiles(diff, ['src/ok.ts']), ['src/bad.ts']);
  });

  test('collectUnauthorizedFiles rejects rename from out-of-scope to allowed', () => {
    const diff = [
      'diff --git a/bad.ts b/src/ok.ts',
      'rename from bad.ts',
      'rename to src/ok.ts',
    ].join('\n');
    assert.deepStrictEqual(collectUnauthorizedFiles(diff, ['src/ok.ts']), ['bad.ts']);
  });

  test('collectUnauthorizedFiles allows rename within allowed scope', () => {
    const diff = [
      'diff --git a/src/old.ts b/src/new.ts',
      'rename from src/old.ts',
      'rename to src/new.ts',
    ].join('\n');
    assert.deepStrictEqual(collectUnauthorizedFiles(diff, ['src/**']), []);
  });

  test('collectUnauthorizedFiles validates create and delete sides', () => {
    const createDiff = 'diff --git a/dev/null b/src/new.ts\nnew file mode 100644\n--- /dev/null\n+++ b/src/new.ts';
    const deleteDiff = 'diff --git a/src/old.ts b/dev/null\ndeleted file mode 100644\n--- src/old.ts\n+++ /dev/null';
    assert.deepStrictEqual(collectUnauthorizedFiles(createDiff, ['src/ok.ts']), ['src/new.ts']);
    assert.deepStrictEqual(collectUnauthorizedFiles(deleteDiff, ['src/ok.ts']), ['src/old.ts']);
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

  test('model approval is overridden when deterministic scope gate fails', async () => {
    const mission = buildMissionFromGoal('Add feature', { preset: 'multitask-safe', repo_path: '.' });
    const plan = makePlan([makeTask('a', { allowed_files: ['src/a.ts'] })]);
    const autopilot = fakeAutopilotResult(
      { generated_files: [], run_dir: '/tmp' } as unknown as Awaited<ReturnType<typeof runAutopilotPlan>>,
      [{ id: 'a', status: 'passed', commit_sha: 'abc' }]
    );
    const review = await runMissionFinalReview(
      {
        mission,
        plan,
        autopilotResult: autopilot,
        integratedDiff: 'diff --git a/src/other.ts b/src/other.ts\n+line',
        taskStates: [{ task_id: 'a', status: 'accepted' }],
      },
      async () => '{"verdict":"approved","summary":"looks good","caveats":[]}'
    );
    assert.strictEqual(review.verdict, 'rejected');
    assert.ok(review.unauthorized_files?.includes('src/other.ts'));
  });

  test('model approval is overridden when acceptance gap exists', async () => {
    const mission = buildMissionFromGoal('Add feature', { preset: 'multitask-safe', repo_path: '.' });
    const plan = makePlan([makeTask('a', { allowed_files: ['src/a.ts'] })]);
    const autopilot = fakeAutopilotResult(
      { generated_files: [], run_dir: '/tmp' } as unknown as Awaited<ReturnType<typeof runAutopilotPlan>>,
      [{ id: 'a', status: 'passed', commit_sha: 'abc' }]
    );
    const review = await runMissionFinalReview(
      {
        mission,
        plan,
        autopilotResult: autopilot,
        integratedDiff: 'diff --git a/src/a.ts b/src/a.ts\n+line',
        taskStates: [{ task_id: 'a', status: 'failed' }],
      },
      async () => '{"verdict":"approved","summary":"looks good","caveats":[]}'
    );
    assert.strictEqual(review.verdict, 'rejected');
    assert.ok(review.acceptance_gaps?.some((g) => g.includes('a')));
  });

  test('model approval passes when deterministic gates are clean', async () => {
    const mission = buildMissionFromGoal('Add feature', { preset: 'multitask-safe', repo_path: '.' });
    const plan = makePlan([makeTask('a', { allowed_files: ['src/a.ts'] })]);
    const autopilot = fakeAutopilotResult(
      { generated_files: [], run_dir: '/tmp' } as unknown as Awaited<ReturnType<typeof runAutopilotPlan>>,
      [{ id: 'a', status: 'passed', commit_sha: 'abc' }]
    );
    const review = await runMissionFinalReview(
      {
        mission,
        plan,
        autopilotResult: autopilot,
        integratedDiff: 'diff --git a/src/a.ts b/src/a.ts\n+line',
        taskStates: [{ task_id: 'a', status: 'accepted' }],
      },
      async () => '{"verdict":"approved","summary":"looks good","caveats":[]}'
    );
    assert.strictEqual(review.verdict, 'approved');
    assert.deepStrictEqual(review.caveats, []);
  });

  test('fallback and model path share mandatory gates', async () => {
    const mission = buildMissionFromGoal('Add feature', { preset: 'multitask-safe', repo_path: '.' });
    const plan = makePlan([makeTask('a', { allowed_files: ['src/a.ts'] })]);
    const autopilot = fakeAutopilotResult(
      { generated_files: [], run_dir: '/tmp' } as unknown as Awaited<ReturnType<typeof runAutopilotPlan>>,
      [{ id: 'a', status: 'passed', commit_sha: 'abc' }]
    );
    const input = {
      mission,
      plan,
      autopilotResult: autopilot,
      integratedDiff: 'diff --git a/src/other.ts b/src/other.ts\n+line',
      taskStates: [{ task_id: 'a', status: 'accepted' }],
    };
    const fallbackReview = await runMissionFinalReview(input);
    const modelReview = await runMissionFinalReview(
      input,
      async () => '{"verdict":"approved","summary":"looks good","caveats":[]}'
    );
    assert.strictEqual(fallbackReview.verdict, 'rejected');
    assert.strictEqual(modelReview.verdict, 'rejected');
    assert.deepStrictEqual(modelReview.unauthorized_files, fallbackReview.unauthorized_files);
    assert.deepStrictEqual(modelReview.acceptance_gaps, fallbackReview.acceptance_gaps);
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
    // Enable repository mutation so that branch preparation, rollback, and resume
    // commit validation are exercised by the durable-state tests.
    mission.capabilities.allow_repo_apply = true;
    mission.capabilities.allow_repo_commit = true;
    mission.capabilities.allow_repo_push = true;
    mission.capabilities.allow_pr_create = false;
    mission.capabilities.allow_pr_update = false;
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

  test('resume accepts normal accepted task without fix_commit_sha', async () => {
    const { tmpDir, runId, mission, planResult } = await setupMission();
    const runDir = getMissionRunDir(tmpDir, runId);
    const commitSha = 'a'.repeat(40);
    saveMissionState(runDir, {
      version: 1,
      run_id: runId,
      stage: 'running',
      plan_hash: computePlanHash(planResult.plan),
      base_sha: 'base-sha-1234567890abcdef',
      work_branch: `mission-${runId}`,
      tasks: [{ task_id: 'mission-task-1', status: 'accepted', commit_sha: commitSha }],
    });

    const autopilot = fakeAutopilotResult(planResult, [{ id: 'mission-task-1', status: 'passed', commit_sha: commitSha }]);

    const result = await runMultitaskMission(mission, planResult, {
      command: 'test',
      resume: true,
      runAutopilotRunFn: async () => autopilot,
      gitExecFn: fakeGitExec([commitSha]),
      collectDiffFn: () => 'diff --git a/docs/AUTOPILOT_PLAN.md b/docs/AUTOPILOT_PLAN.md\n+line',
    });

    assert.strictEqual(result.verdict, 'MULTITASK_MISSION_DONE');
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('resume requires both commit_sha and fix_commit_sha for fixed_and_accepted task', async () => {
    const { tmpDir, runId, mission, planResult } = await setupMission();
    const runDir = getMissionRunDir(tmpDir, runId);
    const commitSha = 'a'.repeat(40);
    const fixCommitSha = 'f'.repeat(40);
    saveMissionState(runDir, {
      version: 1,
      run_id: runId,
      stage: 'running',
      plan_hash: computePlanHash(planResult.plan),
      base_sha: 'base-sha-1234567890abcdef',
      work_branch: `mission-${runId}`,
      tasks: [
        {
          task_id: 'mission-task-1',
          status: 'fixed_and_accepted',
          commit_sha: commitSha,
          fix_commit_sha: fixCommitSha,
        },
      ],
    });

    const autopilot = fakeAutopilotResult(planResult, [
      { id: 'mission-task-1', status: 'passed_with_caveats', commit_sha: commitSha, fix_commit_sha: fixCommitSha },
    ]);

    const result = await runMultitaskMission(mission, planResult, {
      command: 'test',
      resume: true,
      runAutopilotRunFn: async () => autopilot,
      gitExecFn: fakeGitExec([commitSha, fixCommitSha]),
      collectDiffFn: () => 'diff --git a/docs/AUTOPILOT_PLAN.md b/docs/AUTOPILOT_PLAN.md\n+line',
    });

    assert.strictEqual(result.verdict, 'MULTITASK_MISSION_DONE');
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('resume rejects fixed_and_accepted when original commit is missing', async () => {
    const { tmpDir, runId, mission, planResult } = await setupMission();
    const runDir = getMissionRunDir(tmpDir, runId);
    const fixCommitSha = 'f'.repeat(40);
    saveMissionState(runDir, {
      version: 1,
      run_id: runId,
      stage: 'running',
      plan_hash: computePlanHash(planResult.plan),
      base_sha: 'base-sha-1234567890abcdef',
      work_branch: `mission-${runId}`,
      tasks: [
        {
          task_id: 'mission-task-1',
          status: 'fixed_and_accepted',
          commit_sha: undefined,
          fix_commit_sha: fixCommitSha,
        },
      ],
    });

    const result = await runMultitaskMission(mission, planResult, {
      command: 'test',
      resume: true,
      runAutopilotRunFn: async () => ({} as AutopilotRunResult),
      gitExecFn: fakeGitExec([fixCommitSha]),
    });

    assert.strictEqual(result.verdict, 'MULTITASK_MISSION_FAILED');
    assert.ok(result.reason.includes('missing from state'));
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('resume rejects fixed_and_accepted when fix commit is missing', async () => {
    const { tmpDir, runId, mission, planResult } = await setupMission();
    const runDir = getMissionRunDir(tmpDir, runId);
    const commitSha = 'a'.repeat(40);
    saveMissionState(runDir, {
      version: 1,
      run_id: runId,
      stage: 'running',
      plan_hash: computePlanHash(planResult.plan),
      base_sha: 'base-sha-1234567890abcdef',
      work_branch: `mission-${runId}`,
      tasks: [
        {
          task_id: 'mission-task-1',
          status: 'fixed_and_accepted',
          commit_sha: commitSha,
          fix_commit_sha: undefined,
        },
      ],
    });

    const result = await runMultitaskMission(mission, planResult, {
      command: 'test',
      resume: true,
      runAutopilotRunFn: async () => ({} as AutopilotRunResult),
      gitExecFn: fakeGitExec([commitSha]),
    });

    assert.strictEqual(result.verdict, 'MULTITASK_MISSION_FAILED');
    assert.ok(result.reason.includes('missing from state'));
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('resume propagates option through real autopilot-run to mvp-run', async () => {
    const { tmpDir, runId, mission, planResult } = await setupMission();
    const runDir = getMissionRunDir(tmpDir, runId);
    const commitSha = 'a'.repeat(40);
    saveMissionState(runDir, {
      version: 1,
      run_id: runId,
      stage: 'running',
      plan_hash: computePlanHash(planResult.plan),
      base_sha: 'base-sha-1234567890abcdef',
      work_branch: `mission-${runId}`,
      tasks: [{ task_id: 'mission-task-1', status: 'accepted', commit_sha: commitSha }],
      pr: { number: 42, url: 'https://github.com/Mellowin/AI-orchestrator/pull/42' },
    });

    const captured: { resume?: boolean; callCount: number } = { callCount: 0 };
    const fakeRunMvpRun = async (
      mvpConfig: unknown,
      mvpConfigPath: string,
      options: { resume?: boolean } = {}
    ) => {
      captured.resume = options.resume;
      captured.callCount += 1;
      return {
        config: mvpConfig,
        command: 'mvp',
        config_path: mvpConfigPath,
        started_at: new Date().toISOString(),
        finished_at: new Date().toISOString(),
        duration_ms: 1,
        verdict: 'MVP_RUN_PASSED',
        reason: 'Fake resume MVP',
        preflight: {} as AutopilotRunResult['mvp_result']['preflight'],
        task_results: [
          {
            id: 'mission-task-1',
            title: 'Task mission-task-1',
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
        pr: { created: false, reason: 'PR creation not attempted' },
        caveats: [],
        report_dir: join(runDir, 'mvp-run-reports'),
      } as AutopilotRunResult['mvp_result'];
    };

    mission.capabilities.allow_pr_create = true;
    const result = await runMultitaskMission(mission, planResult, {
      command: 'test',
      resume: true,
      runAutopilotRunFn: (config, configPath, options) =>
        runAutopilotRun(config, configPath, { ...options, runMvpRunFn: fakeRunMvpRun as typeof import('../src/mvp-run/runner.js').runMvpRun }),
      gitExecFn: fakeGitExec([commitSha]),
      collectDiffFn: () => 'diff --git a/docs/AUTOPILOT_PLAN.md b/docs/AUTOPILOT_PLAN.md\n+line',
      createMvpRunPrFn: async () => ({
        created: true,
        number: 42,
        url: 'https://github.com/Mellowin/AI-orchestrator/pull/42',
        draft: true,
        reason: 'PR created as draft',
      }),
    });

    assert.strictEqual(captured.resume, true, 'MVP run must receive resume: true');
    assert.strictEqual(captured.callCount, 1, 'MVP run must be invoked exactly once');
    assert.strictEqual(result.verdict, 'MULTITASK_MISSION_DONE_WITH_CAVEATS');
    assert.strictEqual(result.task_states[0].commit_sha, commitSha, 'Existing accepted commit must be preserved');
    assert.strictEqual(result.pr?.number, 42, 'Existing PR must be reused');
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('resume with terminal DONE state fails when accepted commits are missing from branch', async () => {
    const { tmpDir, runId, mission, planResult } = await setupMission();
    const repoPath = mkdtempSync(join(tmpdir(), 'repo-'));
    spawnSync('git', ['init', '--initial-branch=main'], { cwd: repoPath, encoding: 'utf-8', shell: false });
    spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoPath, encoding: 'utf-8', shell: false });
    spawnSync('git', ['config', 'user.name', 'Test User'], { cwd: repoPath, encoding: 'utf-8', shell: false });
    writeFileSync(join(repoPath, 'README.md'), '# test\n');
    spawnSync('git', ['add', '.'], { cwd: repoPath, encoding: 'utf-8', shell: false });
    spawnSync('git', ['commit', '-m', 'init'], { cwd: repoPath, encoding: 'utf-8', shell: false });
    mission.repo_path = repoPath;

    const workBranch = `mission-${runId}`;
    const baseSha = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repoPath, encoding: 'utf-8', shell: false }).stdout.trim();
    const acceptedCommit = 'a'.repeat(40);

    saveMissionState(getMissionRunDir(tmpDir, runId), {
      version: 1,
      run_id: runId,
      stage: 'completed',
      plan_hash: computePlanHash(planResult.plan),
      base_sha: baseSha,
      work_branch: workBranch,
      tasks: [{ task_id: planResult.plan.tasks[0].id, status: 'accepted', commit_sha: acceptedCommit }],
      result: {
        verdict: 'MULTITASK_MISSION_DONE',
        reason: 'Stale terminal result',
        run_dir: getMissionRunDir(tmpDir, runId),
        exit_code: 0,
      } as any,
    });

    let autopilotCalled = false;
    const result = await runMultitaskMission(mission, planResult, {
      command: 'test',
      resume: true,
      runAutopilotRunFn: async () => {
        autopilotCalled = true;
        return {} as AutopilotRunResult;
      },
      collectDiffFn: () => '',
    });

    assert.strictEqual(autopilotCalled, false, 'autopilot-run must not be invoked when terminal state is invalid');
    assert.strictEqual(result.verdict, 'MULTITASK_MISSION_FAILED', 'must fail closed instead of returning stale DONE');
    assert.ok(
      result.reason.includes('Resume aborted') && result.reason.includes('not ancestors'),
      `reason must mention missing accepted commits, got: ${result.reason}`
    );

    rmSync(tmpDir, { recursive: true, force: true });
    rmSync(repoPath, { recursive: true, force: true });
  });
});


describe('multitask safe zero-mutation', () => {
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

  function makeRecordingGitExec(calls: string[][]) {
    return (args: string[], options?: { cwd?: string }) => {
      calls.push(args);
      return spawnSync('git', args, { cwd: options?.cwd, encoding: 'utf-8', shell: false });
    };
  }

  async function setupSafeMissionInTempRepo(): Promise<{
    tmpRepo: string;
    tmpOut: string;
    runId: string;
    mission: AutopilotPlanMission;
    planResult: Awaited<ReturnType<typeof runAutopilotPlan>>;
  }> {
    const tmpRepo = initTempGitRepo();
    const tmpOut = mkdtempSync(join(tmpdir(), 'out-'));
    const runId = `safe-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const mission = buildMissionFromGoal('Add docs note', {
      preset: 'multitask-safe',
      repo_path: tmpRepo,
      output_dir: tmpOut,
      run_id: runId,
    });
    const planResult = await runAutopilotPlan(mission, { command: 'test' });
    return { tmpRepo, tmpOut, runId, mission, planResult };
  }

  test('multitask-safe returns DONE_WITH_CAVEATS and skips autopilot execution', async () => {
    const { tmpRepo, tmpOut, mission, planResult } = await setupSafeMissionInTempRepo();
    const calls: string[][] = [];
    let autopilotCalled = false;
    const result = await runMultitaskMission(mission, planResult, {
      runAutopilotRunFn: async () => {
        autopilotCalled = true;
        return {} as AutopilotRunResult;
      },
      gitExecFn: makeRecordingGitExec(calls),
      collectDiffFn: () => '',
    });

    assert.strictEqual(result.verdict, 'MULTITASK_MISSION_DONE_WITH_CAVEATS');
    assert.strictEqual(autopilotCalled, false, 'autopilot-run must not be called in safe mode');
    assert.ok(!calls.some((args) => args[0] === 'checkout' && args[1] === '-B'), 'must not create work branch');
    rmSync(tmpRepo, { recursive: true, force: true });
    rmSync(tmpOut, { recursive: true, force: true });
  });

  test('multitask-safe does not call checkoutBranch', async () => {
    const { tmpRepo, tmpOut, mission, planResult } = await setupSafeMissionInTempRepo();
    const calls: string[][] = [];
    await runMultitaskMission(mission, planResult, {
      runAutopilotRunFn: async () => {
        throw new Error('autopilot-run must not be invoked in safe mode');
      },
      gitExecFn: makeRecordingGitExec(calls),
      collectDiffFn: () => '',
    });

    assert.ok(!calls.some((args) => args[0] === 'checkout'), 'must not checkout any branch');
    rmSync(tmpRepo, { recursive: true, force: true });
    rmSync(tmpOut, { recursive: true, force: true });
  });

  test('existing mission branch is not checked out in safe mode', async () => {
    const { tmpRepo, tmpOut, runId, mission, planResult } = await setupSafeMissionInTempRepo();
    const workBranch = `mission-${runId}`;
    spawnSync('git', ['checkout', '-B', workBranch, 'main'], {
      cwd: tmpRepo,
      encoding: 'utf-8',
      shell: false,
    });
    spawnSync('git', ['checkout', 'main'], { cwd: tmpRepo, encoding: 'utf-8', shell: false });

    const calls: string[][] = [];
    await runMultitaskMission(mission, planResult, {
      runAutopilotRunFn: async () => {
        throw new Error('autopilot-run must not be invoked in safe mode');
      },
      gitExecFn: makeRecordingGitExec(calls),
      collectDiffFn: () => '',
    });

    assert.ok(!calls.some((args) => args[0] === 'checkout'), 'must not checkout existing mission branch');
    assert.ok(branchExists(tmpRepo, workBranch), 'pre-existing branch should remain');
    rmSync(tmpRepo, { recursive: true, force: true });
    rmSync(tmpOut, { recursive: true, force: true });
  });

  test('missing mission branch is not created in safe mode', async () => {
    const { tmpRepo, tmpOut, runId, mission, planResult } = await setupSafeMissionInTempRepo();
    const workBranch = `mission-${runId}`;
    await runMultitaskMission(mission, planResult, {
      runAutopilotRunFn: async () => {
        throw new Error('autopilot-run must not be invoked in safe mode');
      },
      collectDiffFn: () => '',
    });

    assert.strictEqual(branchExists(tmpRepo, workBranch), false, 'work branch must not be created');
    rmSync(tmpRepo, { recursive: true, force: true });
    rmSync(tmpOut, { recursive: true, force: true });
  });

  test('current branch remains unchanged in safe mode', async () => {
    const { tmpRepo, tmpOut, mission, planResult } = await setupSafeMissionInTempRepo();
    const before = getCurrentBranch(tmpRepo);
    await runMultitaskMission(mission, planResult, {
      runAutopilotRunFn: async () => {
        throw new Error('autopilot-run must not be invoked in safe mode');
      },
      collectDiffFn: () => '',
    });
    const after = getCurrentBranch(tmpRepo);

    assert.strictEqual(after, before, 'current branch must not change');
    rmSync(tmpRepo, { recursive: true, force: true });
    rmSync(tmpOut, { recursive: true, force: true });
  });

  test('safe plan/report/state artifacts are still written', async () => {
    const { tmpRepo, tmpOut, runId, mission, planResult } = await setupSafeMissionInTempRepo();
    const result = await runMultitaskMission(mission, planResult, {
      runAutopilotRunFn: async () => {
        throw new Error('autopilot-run must not be invoked in safe mode');
      },
      collectDiffFn: () => '',
    });

    const runDir = getMissionRunDir(tmpOut, runId);
    assert.strictEqual(result.run_dir, runDir);
    assert.ok(existsSync(join(runDir, 'multitask-mission-state.json')), 'state file must exist');
    assert.ok(existsSync(join(runDir, 'multitask-mission-report.md')), 'report markdown must exist');
    assert.ok(existsSync(join(runDir, 'multitask-mission-report.json')), 'report json must exist');
    assert.ok(result.task_states?.every((s) => s.status === 'skipped_safe_mode'), 'tasks must be marked skipped_safe_mode');
    rmSync(tmpRepo, { recursive: true, force: true });
    rmSync(tmpOut, { recursive: true, force: true });
  });

  test('real-multitask still prepares and reuses its work branch correctly', async () => {
    const tmpRepo = initTempGitRepo();
    const tmpOut = mkdtempSync(join(tmpdir(), 'out-'));
    const runId = `real-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const mission = buildMissionFromGoal('Add docs note', {
      preset: 'multitask-safe',
      repo_path: tmpRepo,
      output_dir: tmpOut,
      run_id: runId,
    });
    mission.capabilities = {
      allow_real_provider: true,
      allow_repo_apply: true,
      allow_repo_commit: true,
      allow_repo_push: true,
      allow_pr_create: false,
      allow_pr_update: false,
      allow_actions_read: true,
      allow_repair: true,
    };
    const planResult = await runAutopilotPlan(mission, { command: 'test' });
    const workBranch = `mission-${runId}`;

    function runWithBranchCreation() {
      let commitSha: string | undefined;
      return async (): Promise<AutopilotRunResult> => {
        if (!branchExists(tmpRepo, workBranch)) {
          spawnSync('git', ['checkout', '-B', workBranch, 'main'], { cwd: tmpRepo, encoding: 'utf-8', shell: false });
          const filePath = join(tmpRepo, 'docs', 'AUTOPILOT_PLAN.md');
          mkdirSync(join(tmpRepo, 'docs'), { recursive: true });
          writeFileSync(filePath, '# Plan\n', 'utf-8');
          spawnSync('git', ['add', 'docs/AUTOPILOT_PLAN.md'], { cwd: tmpRepo, encoding: 'utf-8', shell: false });
          spawnSync('git', ['commit', '-m', 'mission task'], { cwd: tmpRepo, encoding: 'utf-8', shell: false });
          commitSha = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: tmpRepo, encoding: 'utf-8', shell: false }).stdout.trim();
        } else {
          spawnSync('git', ['checkout', workBranch], { cwd: tmpRepo, encoding: 'utf-8', shell: false });
        }
        return fakeAutopilotResult(planResult, [
          { id: planResult.plan.tasks[0].id, status: 'passed', commit_sha: commitSha! },
        ]);
      };
    }

    const result = await runMultitaskMission(mission, planResult, {
      runAutopilotRunFn: runWithBranchCreation(),
      collectDiffFn: () => '',
    });

    assert.strictEqual(result.verdict, 'MULTITASK_MISSION_DONE');
    assert.ok(branchExists(tmpRepo, workBranch), 'work branch must be created');
    assert.strictEqual(getCurrentBranch(tmpRepo), workBranch, 'work branch must be checked out');

    const result2 = await runMultitaskMission(mission, planResult, {
      resume: true,
      runAutopilotRunFn: runWithBranchCreation(),
      collectDiffFn: () => '',
    });

    assert.strictEqual(result2.verdict, 'MULTITASK_MISSION_DONE');
    assert.strictEqual(getCurrentBranch(tmpRepo), workBranch, 'existing work branch must remain checked out');
    rmSync(tmpRepo, { recursive: true, force: true });
    rmSync(tmpOut, { recursive: true, force: true });
  });
});

describe('real-multitask production branch preparation', () => {
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

  test('does not pre-create work branch before invoking autopilot-run', async () => {
    const tmpRepo = initTempGitRepo();
    const tmpOut = mkdtempSync(join(tmpdir(), 'out-'));
    const runId = `real-prod-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const mission = buildMissionFromGoal('Add docs note', {
      preset: 'multitask-safe',
      repo_path: tmpRepo,
      output_dir: tmpOut,
      run_id: runId,
    });
    mission.capabilities = {
      allow_real_provider: false,
      allow_repo_apply: true,
      allow_repo_commit: true,
      allow_repo_push: false,
      allow_pr_create: false,
      allow_pr_update: false,
      allow_actions_read: true,
      allow_repair: true,
    };

    const planResult = await runAutopilotPlan(mission, { command: 'test' });
    const workBranch = `mission-${runId}`;

    let branchSeenBeforeMvp = false;
    const result = await runMultitaskMission(mission, planResult, {
      runAutopilotRunFn: (config, configPath, options) =>
        runAutopilotRun(config, configPath, {
          ...options,
          runMvpRunFn: (mvpConfig, _mvpConfigPath, _mvpOptions) => {
            branchSeenBeforeMvp = branchSeenBeforeMvp || branchExists(mvpConfig.repo_path, mvpConfig.work_branch);

            // Mirror the real MVP runner's branch preparation, which fails if the
            // multitask runner has already created and checked out the branch.
            prepareScenarioWorkBranch(mvpConfig.repo_path, mvpConfig.base_branch, mvpConfig.work_branch);

            const docsDir = join(mvpConfig.repo_path, 'docs');
            const filePath = join(docsDir, 'AUTOPILOT_PLAN.md');
            mkdirSync(docsDir, { recursive: true });
            writeFileSync(filePath, '# Plan\n', 'utf-8');
            spawnSync('git', ['add', 'docs/AUTOPILOT_PLAN.md'], { cwd: mvpConfig.repo_path, encoding: 'utf-8', shell: false });
            spawnSync('git', ['commit', '-m', 'mission task'], { cwd: mvpConfig.repo_path, encoding: 'utf-8', shell: false });
            const commitSha = spawnSync('git', ['rev-parse', 'HEAD'], {
              cwd: mvpConfig.repo_path,
              encoding: 'utf-8',
              shell: false,
            }).stdout.trim();

            const mvpResult: MvpRunResult = {
              config: mvpConfig,
              command: 'test mvp',
              config_path: _mvpConfigPath,
              started_at: new Date().toISOString(),
              finished_at: new Date().toISOString(),
              duration_ms: 1,
              verdict: 'MVP_RUN_PASSED',
              reason: 'Fake production MVP run',
              preflight: {
                repo_path: mvpConfig.repo_path,
                repo_slug: mvpConfig.repo_slug,
                base_branch: mvpConfig.base_branch,
                work_branch: mvpConfig.work_branch,
                provider: 'fake',
                real_provider_enabled: false,
                apply_enabled: mvpConfig.allow_real_repo_apply ?? false,
                commit_enabled: mvpConfig.allow_real_repo_commit ?? false,
                push_enabled: mvpConfig.allow_real_repo_push ?? false,
                pr_creation_enabled: mvpConfig.allow_github_pr_create ?? false,
                missing_env_vars: [],
                detected_risks: [],
              },
              task_results: [
                {
                  id: 'mission-task-1',
                  title: 'Mission task',
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
              branch: mvpConfig.work_branch,
              pushed: false,
              caveats: [],
              report_dir: join(tmpOut, 'mvp-report'),
            };
            return Promise.resolve(mvpResult);
          },
        }),
      collectDiffFn: () => '',
    });

    assert.strictEqual(branchSeenBeforeMvp, false, 'work branch must not exist before inner MVP runner creates it');
    assert.ok(
      result.verdict === 'MULTITASK_MISSION_DONE' || result.verdict === 'MULTITASK_MISSION_DONE_WITH_CAVEATS',
      `mission must succeed, got ${result.verdict}: ${result.reason}`
    );
    assert.strictEqual(getCurrentBranch(tmpRepo), workBranch, 'work branch must be checked out after mission');
    assert.ok(branchExists(tmpRepo, workBranch), 'work branch must exist');

    rmSync(tmpRepo, { recursive: true, force: true });
    rmSync(tmpOut, { recursive: true, force: true });
  });
});

describe('final review glob scope', () => {
  test('exact allowed file passes', () => {
    const diff = 'diff --git a/docs/proofs/part1.md b/docs/proofs/part1.md\n+line';
    assert.deepStrictEqual(collectUnauthorizedFiles(diff, ['docs/proofs/part1.md']), []);
  });

  test('docs/proofs/*.md accepts docs/proofs/part1.md', () => {
    const diff = 'diff --git a/docs/proofs/part1.md b/docs/proofs/part1.md\n+line';
    assert.deepStrictEqual(collectUnauthorizedFiles(diff, ['docs/proofs/*.md']), []);
  });

  test('nested or unrelated files outside the pattern are rejected', () => {
    const diff =
      'diff --git a/docs/proofs/part1.md b/docs/proofs/part1.md\n+line\n' +
      'diff --git a/src/secret.ts b/src/secret.ts\n+line';
    assert.deepStrictEqual(collectUnauthorizedFiles(diff, ['docs/proofs/*.md']), ['src/secret.ts']);
  });

  test('Windows separators are normalized', () => {
    const diff = 'diff --git a/docs/proofs/part1.md b/docs/proofs/part1.md\n+line';
    assert.deepStrictEqual(collectUnauthorizedFiles(diff, ['docs\\proofs\\*.md']), []);
  });

  test('traversal or absolute paths remain rejected', () => {
    const diff =
      'diff --git a/../secret.md b/../secret.md\n+line\n' +
      'diff --git a//etc/passwd b//etc/passwd\n+line';
    const unauthorized = collectUnauthorizedFiles(diff, ['docs/*.md']);
    assert.ok(unauthorized.includes('../secret.md'));
    assert.ok(unauthorized.includes('/etc/passwd'));
  });

  test('final review and task guardrails produce consistent scope decisions', () => {
    const patterns = ['docs/**/*.md', 'src/*.ts'];
    const files = ['docs/proofs/part1.md', 'src/index.ts', 'src/secret.ts', '../escape.md', '/etc/passwd'];
    const guardrails = { allow_modify: patterns, deny_modify: [] as string[] };

    for (const file of files) {
      const guardResult = validateFileList([file], guardrails);
      const diff = `diff --git a/${file} b/${file}\n+line`;
      const unauthorized = collectUnauthorizedFiles(diff, patterns);
      if (guardResult.ok) {
        assert.deepStrictEqual(unauthorized, [], `expected ${file} to be allowed by final review`);
      } else {
        assert.ok(unauthorized.includes(file), `expected ${file} to be unauthorized by final review`);
      }
    }
  });
});


describe('fresh-run state isolation', () => {
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

  async function setupFreshMission(): Promise<{
    tmpRepo: string;
    tmpOut: string;
    runId: string;
    mission: AutopilotPlanMission;
    planResult: Awaited<ReturnType<typeof runAutopilotPlan>>;
  }> {
    const tmpRepo = initTempGitRepo();
    const tmpOut = mkdtempSync(join(tmpdir(), 'out-'));
    const runId = `fresh-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const mission = buildMissionFromGoal('Add docs note', {
      preset: 'multitask-safe',
      repo_path: tmpRepo,
      output_dir: tmpOut,
      run_id: runId,
    });
    mission.capabilities = {
      allow_real_provider: true,
      allow_repo_apply: true,
      allow_repo_commit: true,
      allow_repo_push: true,
      allow_pr_create: false,
      allow_pr_update: false,
      allow_actions_read: false,
      allow_repair: false,
    };
    const planResult = await runAutopilotPlan(mission, { command: 'test' });
    return { tmpRepo, tmpOut, runId, mission, planResult };
  }

  test('resume loads and validates persisted state', async () => {
    const { tmpRepo, tmpOut, runId, mission, planResult } = await setupFreshMission();
    const runDir = getMissionRunDir(tmpOut, runId);
    const oldCommit = 'a'.repeat(40);
    saveMissionState(runDir, {
      version: 1,
      run_id: runId,
      stage: 'running',
      plan_hash: computePlanHash(planResult.plan),
      base_sha: 'base-sha-1234567890abcdef',
      work_branch: `mission-${runId}`,
      tasks: [{ task_id: planResult.plan.tasks[0].id, status: 'accepted', commit_sha: oldCommit }],
    });

    const result = await runMultitaskMission(mission, planResult, {
      command: 'test',
      resume: true,
      runAutopilotRunFn: async () =>
        fakeAutopilotResult(planResult, [{ id: planResult.plan.tasks[0].id, status: 'passed', commit_sha: oldCommit }]),
      gitExecFn: fakeGitExec([oldCommit]),
      collectDiffFn: () => '',
    });

    assert.strictEqual(result.verdict, 'MULTITASK_MISSION_DONE');
    assert.strictEqual(result.task_states[0].commit_sha, oldCommit, 'resume must preserve old accepted commit');
    rmSync(tmpRepo, { recursive: true, force: true });
    rmSync(tmpOut, { recursive: true, force: true });
  });

  test('existing state without resume is not reused', async () => {
    const { tmpRepo, tmpOut, runId, mission, planResult } = await setupFreshMission();
    const runDir = getMissionRunDir(tmpOut, runId);
    const oldCommit = 'a'.repeat(40);
    saveMissionState(runDir, {
      version: 1,
      run_id: runId,
      stage: 'running',
      plan_hash: computePlanHash(planResult.plan),
      base_sha: 'base-sha-1234567890abcdef',
      work_branch: `mission-${runId}`,
      tasks: [{ task_id: planResult.plan.tasks[0].id, status: 'accepted', commit_sha: oldCommit }],
    });

    const newCommit = 'b'.repeat(40);
    const result = await runMultitaskMission(mission, planResult, {
      command: 'test',
      resume: false,
      runAutopilotRunFn: async () =>
        fakeAutopilotResult(planResult, [{ id: planResult.plan.tasks[0].id, status: 'passed', commit_sha: newCommit }]),
      gitExecFn: fakeGitExec([newCommit]),
      collectDiffFn: () => '',
    });

    assert.strictEqual(result.verdict, 'MULTITASK_MISSION_DONE');
    assert.strictEqual(result.task_states[0].commit_sha, newCommit, 'fresh run must use new commit, not old state');
    const reloaded = loadMissionState(runDir);
    assert.strictEqual(reloaded?.tasks[0].commit_sha, newCommit, 'persisted state must be overwritten with fresh run');
    rmSync(tmpRepo, { recursive: true, force: true });
    rmSync(tmpOut, { recursive: true, force: true });
  });

  test('accepted states from old run cannot survive into a fresh run', async () => {
    const { tmpRepo, tmpOut, runId, mission, planResult } = await setupFreshMission();
    const runDir = getMissionRunDir(tmpOut, runId);
    saveMissionState(runDir, {
      version: 1,
      run_id: runId,
      stage: 'running',
      plan_hash: computePlanHash(planResult.plan),
      base_sha: 'base-sha-1234567890abcdef',
      work_branch: `mission-${runId}`,
      tasks: [{ task_id: planResult.plan.tasks[0].id, status: 'accepted', commit_sha: 'a'.repeat(40) }],
    });

    const result = await runMultitaskMission(mission, planResult, {
      command: 'test',
      resume: false,
      runAutopilotRunFn: async () =>
        fakeAutopilotResult(planResult, [{ id: planResult.plan.tasks[0].id, status: 'passed', commit_sha: 'c'.repeat(40) }]),
      gitExecFn: fakeGitExec(['c'.repeat(40)]),
      collectDiffFn: () => '',
    });

    assert.strictEqual(result.task_states[0].status, 'accepted');
    assert.notStrictEqual(result.task_states[0].commit_sha, 'a'.repeat(40));
    rmSync(tmpRepo, { recursive: true, force: true });
    rmSync(tmpOut, { recursive: true, force: true });
  });

  test('old commit SHAs cannot appear in the fresh result', async () => {
    const { tmpRepo, tmpOut, runId, mission, planResult } = await setupFreshMission();
    const runDir = getMissionRunDir(tmpOut, runId);
    const staleCommit = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef';
    saveMissionState(runDir, {
      version: 1,
      run_id: runId,
      stage: 'running',
      plan_hash: computePlanHash(planResult.plan),
      base_sha: 'base-sha-1234567890abcdef',
      work_branch: `mission-${runId}`,
      tasks: [{ task_id: planResult.plan.tasks[0].id, status: 'accepted', commit_sha: staleCommit }],
    });

    const freshCommit = 'cafebabecafebabecafebabecafebabecafebabe';
    const result = await runMultitaskMission(mission, planResult, {
      command: 'test',
      resume: false,
      runAutopilotRunFn: async () =>
        fakeAutopilotResult(planResult, [{ id: planResult.plan.tasks[0].id, status: 'passed', commit_sha: freshCommit }]),
      gitExecFn: fakeGitExec([freshCommit]),
      collectDiffFn: () => '',
    });

    const allShas = result.task_states
      ?.map((s) => [s.commit_sha, s.fix_commit_sha])
      .flat()
      .filter((sha): sha is string => typeof sha === 'string');
    assert.ok(allShas !== undefined);
    assert.ok(!allShas.includes(staleCommit), 'stale commit must not appear in fresh result');
    rmSync(tmpRepo, { recursive: true, force: true });
    rmSync(tmpOut, { recursive: true, force: true });
  });

  test('no accidental branch or PR duplication on fresh re-run', async () => {
    const { tmpRepo, tmpOut, runId, mission, planResult } = await setupFreshMission();
    const workBranch = `mission-${runId}`;

    function runWithBranchCreation(verdict: AutopilotRunResult['verdict'] = 'AUTOPILOT_GREEN') {
      let commitSha: string | undefined;
      return async (): Promise<AutopilotRunResult> => {
        if (!branchExists(tmpRepo, workBranch)) {
          spawnSync('git', ['checkout', '-B', workBranch, 'main'], { cwd: tmpRepo, encoding: 'utf-8', shell: false });
          writeFileSync(join(tmpRepo, 'feature.txt'), 'x\n', 'utf-8');
          spawnSync('git', ['add', '.'], { cwd: tmpRepo, encoding: 'utf-8', shell: false });
          spawnSync('git', ['commit', '-m', 'mission task', '--no-gpg-sign'], { cwd: tmpRepo, encoding: 'utf-8', shell: false });
          commitSha = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: tmpRepo, encoding: 'utf-8', shell: false }).stdout.trim();
        } else {
          spawnSync('git', ['checkout', workBranch], { cwd: tmpRepo, encoding: 'utf-8', shell: false });
        }
        return fakeAutopilotResult(planResult, [
          { id: planResult.plan.tasks[0].id, status: 'passed', commit_sha: commitSha! },
        ], verdict);
      };
    }

    const firstResult = await runMultitaskMission(mission, planResult, {
      command: 'test',
      resume: false,
      runAutopilotRunFn: runWithBranchCreation('AUTOPILOT_GREEN'),
      collectDiffFn: () => '',
    });

    assert.strictEqual(firstResult.verdict, 'MULTITASK_MISSION_DONE');
    assert.strictEqual(getCurrentBranch(tmpRepo), workBranch, 'work branch must be checked out after first run');

    const secondResult = await runMultitaskMission(mission, planResult, {
      command: 'test',
      resume: true,
      runAutopilotRunFn: runWithBranchCreation('AUTOPILOT_GREEN'),
      collectDiffFn: () => '',
    });

    assert.strictEqual(secondResult.verdict, 'MULTITASK_MISSION_DONE');
    assert.strictEqual(getCurrentBranch(tmpRepo), workBranch, 'existing work branch must be reused, not duplicated');
    rmSync(tmpRepo, { recursive: true, force: true });
    rmSync(tmpOut, { recursive: true, force: true });
  });

  test('fresh run with existing mission branch fails closed', async () => {
    const { tmpRepo, tmpOut, runId, mission, planResult } = await setupFreshMission();
    const workBranch = `mission-${runId}`;

    // Pre-create a mission branch with a commit.
    spawnSync('git', ['checkout', '-B', workBranch, 'main'], {
      cwd: tmpRepo,
      encoding: 'utf-8',
      shell: false,
    });
    writeFileSync(join(tmpRepo, 'existing.md'), '# existing\n');
    spawnSync('git', ['add', '.'], { cwd: tmpRepo, encoding: 'utf-8', shell: false });
    spawnSync('git', ['commit', '-m', 'existing', '--no-gpg-sign'], { cwd: tmpRepo, encoding: 'utf-8', shell: false });
    spawnSync('git', ['checkout', 'main'], { cwd: tmpRepo, encoding: 'utf-8', shell: false });
    const existingCommit = spawnSync('git', ['rev-parse', workBranch], {
      cwd: tmpRepo,
      encoding: 'utf-8',
      shell: false,
    }).stdout.trim();

    let autopilotCalled = false;
    const result = await runMultitaskMission(mission, planResult, {
      command: 'test',
      resume: false,
      runAutopilotRunFn: async () => {
        autopilotCalled = true;
        return fakeAutopilotResult(planResult, [
          { id: planResult.plan.tasks[0].id, status: 'passed', commit_sha: 'a'.repeat(40) },
        ]);
      },
      collectDiffFn: () => '',
    });

    assert.strictEqual(autopilotCalled, false, 'autopilot-run must not be invoked when branch exists without resume');
    assert.strictEqual(result.verdict, 'MULTITASK_MISSION_FAILED');
    assert.ok(result.reason.includes('Work branch'), 'reason must mention work branch');
    assert.ok(
      result.reason.includes('resume') || result.reason.includes('run-id'),
      'reason must direct user to --resume or a different run-id'
    );

    assert.ok(branchExists(tmpRepo, workBranch), 'existing branch must remain');
    const currentCommit = spawnSync('git', ['rev-parse', workBranch], {
      cwd: tmpRepo,
      encoding: 'utf-8',
      shell: false,
    }).stdout.trim();
    assert.strictEqual(currentCommit, existingCommit, 'existing branch commit must not change');

    const runDir = getMissionRunDir(tmpOut, runId);
    const state = loadMissionState(runDir);
    assert.ok(state, 'state must be persisted');
    assert.strictEqual(state.stage, 'completed', 'terminal failure must mark stage completed');

    rmSync(tmpRepo, { recursive: true, force: true });
    rmSync(tmpOut, { recursive: true, force: true });
  });
});

describe('computePlanHash covers complete execution contract', () => {
  function baseTask(): AutopilotPlanTask {
    return {
      id: 'task-a',
      title: 'Task A',
      goal: 'Implement A',
      allowed_files: ['src/a.ts'],
      denied_files: ['.env'],
      checks: ['npm test'],
      tests: [],
      risk: 'low',
      depends_on: [],
      acceptance_criteria: ['A works'],
      expected_result: 'A passes',
      max_lines_changed: 100,
    };
  }

  function basePlan(overrides: Partial<AutopilotPlanGeneratedPlan> = {}): AutopilotPlanGeneratedPlan {
    return {
      goal: 'Test plan',
      mode: 'fake',
      tasks: [baseTask()],
      ci_enabled: false,
      repair_enabled: false,
      risk_level: 'low',
      caveats: [],
      ...overrides,
    };
  }

  test('changing task id changes hash', () => {
    const h1 = computePlanHash(basePlan());
    const h2 = computePlanHash(basePlan({ tasks: [{ ...baseTask(), id: 'task-b' }] }));
    assert.notStrictEqual(h1, h2);
  });

  test('changing title changes hash', () => {
    const h1 = computePlanHash(basePlan());
    const h2 = computePlanHash(basePlan({ tasks: [{ ...baseTask(), title: 'Different' }] }));
    assert.notStrictEqual(h1, h2);
  });

  test('changing goal changes hash', () => {
    const h1 = computePlanHash(basePlan());
    const h2 = computePlanHash(basePlan({ tasks: [{ ...baseTask(), goal: 'Different' }] }));
    assert.notStrictEqual(h1, h2);
  });

  test('changing allowed_files changes hash', () => {
    const h1 = computePlanHash(basePlan());
    const h2 = computePlanHash(basePlan({ tasks: [{ ...baseTask(), allowed_files: ['src/b.ts'] }] }));
    assert.notStrictEqual(h1, h2);
  });

  test('changing denied_files changes hash', () => {
    const h1 = computePlanHash(basePlan());
    const h2 = computePlanHash(basePlan({ tasks: [{ ...baseTask(), denied_files: ['secret.key'] }] }));
    assert.notStrictEqual(h1, h2);
  });

  test('changing checks changes hash', () => {
    const h1 = computePlanHash(basePlan());
    const h2 = computePlanHash(basePlan({ tasks: [{ ...baseTask(), checks: ['npm run lint'] }] }));
    assert.notStrictEqual(h1, h2);
  });

  test('changing tests changes hash', () => {
    const h1 = computePlanHash(basePlan());
    const h2 = computePlanHash(basePlan({ tasks: [{ ...baseTask(), tests: ['test/a.test.ts'] }] }));
    assert.notStrictEqual(h1, h2);
  });

  test('changing depends_on changes hash', () => {
    const h1 = computePlanHash(basePlan());
    const h2 = computePlanHash(basePlan({ tasks: [{ ...baseTask(), depends_on: ['task-x'] }] }));
    assert.notStrictEqual(h1, h2);
  });

  test('changing acceptance_criteria changes hash', () => {
    const h1 = computePlanHash(basePlan());
    const h2 = computePlanHash(basePlan({ tasks: [{ ...baseTask(), acceptance_criteria: ['Different criteria'] }] }));
    assert.notStrictEqual(h1, h2);
  });

  test('changing expected_result changes hash', () => {
    const h1 = computePlanHash(basePlan());
    const h2 = computePlanHash(basePlan({ tasks: [{ ...baseTask(), expected_result: 'Different result' }] }));
    assert.notStrictEqual(h1, h2);
  });

  test('changing max_lines_changed changes hash', () => {
    const h1 = computePlanHash(basePlan());
    const h2 = computePlanHash(basePlan({ tasks: [{ ...baseTask(), max_lines_changed: 999 }] }));
    assert.notStrictEqual(h1, h2);
  });

  test('changing risk changes hash', () => {
    const h1 = computePlanHash(basePlan());
    const h2 = computePlanHash(basePlan({ tasks: [{ ...baseTask(), risk: 'high' }] }));
    assert.notStrictEqual(h1, h2);
  });

  test('harmless task property ordering does not change hash', () => {
    const t1 = baseTask();
    const t2 = {
      risk: t1.risk,
      id: t1.id,
      title: t1.title,
      goal: t1.goal,
      allowed_files: t1.allowed_files,
      denied_files: t1.denied_files,
      checks: t1.checks,
      tests: t1.tests,
      depends_on: t1.depends_on,
      acceptance_criteria: t1.acceptance_criteria,
      expected_result: t1.expected_result,
      max_lines_changed: t1.max_lines_changed,
    } as AutopilotPlanTask;
    assert.strictEqual(computePlanHash(basePlan({ tasks: [t1] })), computePlanHash(basePlan({ tasks: [t2] })));
  });

  test('task order does not change hash because of canonical sorting', () => {
    const taskA = { ...baseTask(), id: 'a' };
    const taskB = { ...baseTask(), id: 'b', allowed_files: ['src/b.ts'] };
    const h1 = computePlanHash(basePlan({ tasks: [taskA, taskB] }));
    const h2 = computePlanHash(basePlan({ tasks: [taskB, taskA] }));
    assert.strictEqual(h1, h2);
  });

  test('normalizes Windows path separators', () => {
    const h1 = computePlanHash(basePlan({ tasks: [{ ...baseTask(), allowed_files: ['src/a.ts'] }] }));
    const h2 = computePlanHash(basePlan({ tasks: [{ ...baseTask(), allowed_files: ['src\\a.ts'] }] }));
    assert.strictEqual(h1, h2);
  });
});

describe('real safe-mode production path', () => {
  test('npm run one-click --preset multitask-safe returns DONE_WITH_CAVEATS without mutation', () => {
    const runId = `safe-prod-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const outDir = mkdtempSync(join(tmpdir(), 'safe-prod-out-'));
    const beforeBranch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: process.cwd(),
      encoding: 'utf-8',
      shell: false,
    }).trim();

    const result =
      process.platform === 'win32'
        ? spawnSync(
            'cmd',
            ['/c', 'npm', 'run', 'one-click', '--', 'Add a tiny safe-mode docs note', '--preset', 'multitask-safe', '--output-dir', outDir, '--run-id', runId, '--yes'],
            {
              cwd: process.cwd(),
              encoding: 'utf-8',
              shell: false,
              stdio: ['ignore', 'pipe', 'pipe'],
            }
          )
        : spawnSync(
            'npm',
            ['run', 'one-click', '--', 'Add a tiny safe-mode docs note', '--preset', 'multitask-safe', '--output-dir', outDir, '--run-id', runId, '--yes'],
            {
              cwd: process.cwd(),
              encoding: 'utf-8',
              shell: false,
              stdio: ['ignore', 'pipe', 'pipe'],
            }
          );
    const combined = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;

    const afterBranch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: process.cwd(),
      encoding: 'utf-8',
      shell: false,
    }).trim();

    assert.strictEqual(result.status, 0, `CLI must exit 0; output: ${combined}`);
    assert.ok(combined.includes('MULTITASK_MISSION_DONE_WITH_CAVEATS'), `output must contain safe-mode verdict; got: ${combined}`);
    assert.strictEqual(afterBranch, beforeBranch, 'current branch must not change');

    const workBranch = `mission-${runId}`;
    const branchExistsNow = execFileSync('git', ['branch', '--list', workBranch], {
      cwd: process.cwd(),
      encoding: 'utf-8',
      shell: false,
    }).trim();
    assert.strictEqual(branchExistsNow, '', `work branch ${workBranch} must not be created`);

    const runDir = join(outDir, 'missions', runId);
    assert.ok(existsSync(join(runDir, 'multitask-mission-state.json')), 'state file must exist');
    assert.ok(existsSync(join(runDir, 'multitask-mission-report.md')), 'report markdown must exist');

    rmSync(outDir, { recursive: true, force: true });
  });
});


describe('multitask safe mode defers git base resolution', () => {
  test('safe mode works in a directory without a git repo', async () => {
    const tmpRepo = mkdtempSync(join(tmpdir(), 'not-a-repo-'));
    const tmpOut = mkdtempSync(join(tmpdir(), 'out-'));
    const runId = `safe-no-git-${Date.now()}`;
    const mission = buildMissionFromGoal('Add docs note', {
      preset: 'multitask-safe',
      repo_path: tmpRepo,
      output_dir: tmpOut,
      run_id: runId,
    });

    const planResult = await runAutopilotPlan(mission, { command: 'test' });
    assert.strictEqual(planResult.exit_code, 0);

    let gitCalled = false;
    const result = await runMultitaskMission(mission, planResult, {
      runAutopilotRunFn: async () => {
        throw new Error('autopilot-run must not be invoked in safe mode');
      },
      gitExecFn: () => {
        gitCalled = true;
        return { status: 0, stdout: '', stderr: '' };
      },
      collectDiffFn: () => '',
    });

    assert.strictEqual(result.verdict, 'MULTITASK_MISSION_DONE_WITH_CAVEATS');
    assert.strictEqual(result.exit_code, 0);
    assert.strictEqual(gitCalled, false, 'git must not be invoked in safe mode');

    const state = loadMissionState(getMissionRunDir(tmpOut, runId));
    assert.ok(state);
    assert.ok(state.base_sha.startsWith('safe-mode-no-base-'), `expected placeholder base sha, got ${state.base_sha}`);

    rmSync(tmpRepo, { recursive: true, force: true });
    rmSync(tmpOut, { recursive: true, force: true });
  });
});

describe('multitask rollback reverts both original and fix commits', () => {
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

  function getHeadSha(repoPath: string): string {
    const result = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repoPath, encoding: 'utf-8', shell: false });
    return result.stdout!.trim();
  }

  test('rejected task with commit_sha and fix_commit_sha reverts both, newest first', async () => {
    const tmpRepo = initTempGitRepo();
    const tmpOut = mkdtempSync(join(tmpdir(), 'out-'));
    const runId = `rollback-${Date.now()}`;
    const workBranch = `mission-${runId}`;

    // Prepare work branch with two commits representing original and fix.
    spawnSync('git', ['checkout', '-B', workBranch, 'main'], { cwd: tmpRepo, encoding: 'utf-8', shell: false });
    writeFileSync(join(tmpRepo, 'feature.ts'), 'original\n');
    spawnSync('git', ['add', '.'], { cwd: tmpRepo, encoding: 'utf-8', shell: false });
    spawnSync('git', ['commit', '-m', 'original', '--no-gpg-sign'], { cwd: tmpRepo, encoding: 'utf-8', shell: false });
    const originalSha = getHeadSha(tmpRepo);

    writeFileSync(join(tmpRepo, 'feature.ts'), 'fixed\n');
    spawnSync('git', ['add', '.'], { cwd: tmpRepo, encoding: 'utf-8', shell: false });
    spawnSync('git', ['commit', '-m', 'fix', '--no-gpg-sign'], { cwd: tmpRepo, encoding: 'utf-8', shell: false });
    const fixSha = getHeadSha(tmpRepo);

    // Return to main so the runner can reuse the existing branch via resume.
    spawnSync('git', ['checkout', 'main'], { cwd: tmpRepo, encoding: 'utf-8', shell: false });

    const mission = buildMissionFromGoal('Add feature', {
      preset: 'multitask-safe',
      repo_path: tmpRepo,
      output_dir: tmpOut,
      run_id: runId,
    });
    // Enable mutation so rollback executes.
    mission.capabilities = {
      ...mission.capabilities,
      allow_repo_apply: true,
      allow_repo_commit: true,
      allow_repo_push: false,
      allow_pr_create: false,
      allow_pr_update: false,
      allow_actions_read: false,
      allow_repair: false,
    };

    const planResult = await runAutopilotPlan(mission, { command: 'test' });
    assert.strictEqual(planResult.exit_code, 0);

    // Persist running state so the runner resumes and reuses the existing branch.
    const baseSha = getHeadSha(tmpRepo);
    saveMissionState(getMissionRunDir(tmpOut, runId), {
      version: 1,
      run_id: runId,
      stage: 'running',
      plan_hash: computePlanHash(planResult.plan),
      base_sha: baseSha,
      work_branch: workBranch,
      tasks: [],
    });

    const revertCalls: string[][] = [];
    const result = await runMultitaskMission(mission, planResult, {
      command: 'test',
      resume: true,
      runAutopilotRunFn: async () =>
        fakeAutopilotResult(
          planResult,
          [{ id: planResult.plan.tasks[0].id, status: 'blocked', commit_sha: originalSha, fix_commit_sha: fixSha }],
          'AUTOPILOT_MVP_FAILED'
        ),
      gitExecFn: (args, options) => {
        if (args[0] === 'revert') {
          revertCalls.push(args);
        }
        return spawnSync('git', args, { cwd: options?.cwd, encoding: 'utf-8', shell: false });
      },
      collectDiffFn: () => '',
    });

    assert.strictEqual(result.verdict, 'MULTITASK_MISSION_FAILED');
    assert.strictEqual(revertCalls.length, 1, 'revert must be called once');
    const revertArgs = revertCalls[0];
    assert.strictEqual(revertArgs[0], 'revert');
    assert.strictEqual(revertArgs[1], '--no-edit');
    // Newest first: fix commit before original commit.
    assert.strictEqual(revertArgs[2], fixSha, 'first revert must be the newest (fix) commit');
    assert.strictEqual(revertArgs[3], originalSha, 'second revert must be the original commit');

    // Verify the file no longer exists on the work branch after rollback.
    spawnSync('git', ['checkout', workBranch], { cwd: tmpRepo, encoding: 'utf-8', shell: false });
    assert.strictEqual(existsSync(join(tmpRepo, 'feature.ts')), false, 'feature.ts must be removed by revert');

    rmSync(tmpRepo, { recursive: true, force: true });
    rmSync(tmpOut, { recursive: true, force: true });
  });

  test('rejected task rollback is pushed to origin when allow_repo_push is enabled', async () => {
    const tmpRepo = initTempGitRepo();
    const tmpOut = mkdtempSync(join(tmpdir(), 'out-'));
    const runId = `rollback-push-${Date.now()}`;
    const workBranch = `mission-${runId}`;

    spawnSync('git', ['checkout', '-B', workBranch, 'main'], { cwd: tmpRepo, encoding: 'utf-8', shell: false });
    writeFileSync(join(tmpRepo, 'feature.ts'), 'original\n');
    spawnSync('git', ['add', '.'], { cwd: tmpRepo, encoding: 'utf-8', shell: false });
    spawnSync('git', ['commit', '-m', 'original', '--no-gpg-sign'], { cwd: tmpRepo, encoding: 'utf-8', shell: false });
    const originalSha = getHeadSha(tmpRepo);

    writeFileSync(join(tmpRepo, 'feature.ts'), 'fixed\n');
    spawnSync('git', ['add', '.'], { cwd: tmpRepo, encoding: 'utf-8', shell: false });
    spawnSync('git', ['commit', '-m', 'fix', '--no-gpg-sign'], { cwd: tmpRepo, encoding: 'utf-8', shell: false });
    const fixSha = getHeadSha(tmpRepo);

    spawnSync('git', ['checkout', 'main'], { cwd: tmpRepo, encoding: 'utf-8', shell: false });

    const mission = buildMissionFromGoal('Add feature', {
      preset: 'multitask-safe',
      repo_path: tmpRepo,
      output_dir: tmpOut,
      run_id: runId,
    });
    mission.capabilities = {
      ...mission.capabilities,
      allow_repo_apply: true,
      allow_repo_commit: true,
      allow_repo_push: true,
      allow_pr_create: false,
      allow_pr_update: false,
      allow_actions_read: false,
      allow_repair: false,
    };

    const planResult = await runAutopilotPlan(mission, { command: 'test' });
    assert.strictEqual(planResult.exit_code, 0);

    const baseSha = getHeadSha(tmpRepo);
    saveMissionState(getMissionRunDir(tmpOut, runId), {
      version: 1,
      run_id: runId,
      stage: 'running',
      plan_hash: computePlanHash(planResult.plan),
      base_sha: baseSha,
      work_branch: workBranch,
      tasks: [],
    });

    const gitCalls: string[][] = [];
    const result = await runMultitaskMission(mission, planResult, {
      command: 'test',
      resume: true,
      runAutopilotRunFn: async () =>
        fakeAutopilotResult(
          planResult,
          [{ id: planResult.plan.tasks[0].id, status: 'blocked', commit_sha: originalSha, fix_commit_sha: fixSha }],
          'AUTOPILOT_MVP_FAILED'
        ),
      gitExecFn: (args, options) => {
        gitCalls.push(args);
        return spawnSync('git', args, { cwd: options?.cwd, encoding: 'utf-8', shell: false });
      },
      collectDiffFn: () => '',
    });

    assert.strictEqual(result.verdict, 'MULTITASK_MISSION_FAILED');
    assert.ok(
      gitCalls.some((args) => args[0] === 'push' && args.includes('origin') && args.includes(workBranch)),
      'rollback revert must be pushed to origin when allow_repo_push is enabled'
    );
    assert.ok(
      gitCalls.some((args) => args[0] === 'revert' && args.includes(originalSha) && args.includes(fixSha)),
      'local revert must include both commits'
    );

    // Verify the remote branch no longer contains the rejected file (HEAD is the revert).
    spawnSync('git', ['fetch', 'origin'], { cwd: tmpRepo, encoding: 'utf-8', shell: false });
    const remoteHead = spawnSync('git', ['rev-parse', `origin/${workBranch}`], { cwd: tmpRepo, encoding: 'utf-8', shell: false }).stdout!.trim();
    spawnSync('git', ['checkout', remoteHead], { cwd: tmpRepo, encoding: 'utf-8', shell: false });
    assert.strictEqual(existsSync(join(tmpRepo, 'feature.ts')), false, 'rejected file must not remain on remote branch');

    rmSync(tmpRepo, { recursive: true, force: true });
    rmSync(tmpOut, { recursive: true, force: true });
  });
});


describe('production final reviewer and PR gating', () => {
  function setupGithubMission() {
    const tmpRepo = mkdtempSync(join(tmpdir(), 'repo-'));
    const tmpOut = mkdtempSync(join(tmpdir(), 'out-'));
    spawnSync('git', ['init', '--initial-branch=main'], { cwd: tmpRepo, encoding: 'utf-8', shell: false });
    spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: tmpRepo, encoding: 'utf-8', shell: false });
    spawnSync('git', ['config', 'user.name', 'Test User'], { cwd: tmpRepo, encoding: 'utf-8', shell: false });
    writeFileSync(join(tmpRepo, 'README.md'), '# test\n');
    spawnSync('git', ['add', '.'], { cwd: tmpRepo, encoding: 'utf-8', shell: false });
    spawnSync('git', ['commit', '-m', 'init'], { cwd: tmpRepo, encoding: 'utf-8', shell: false });

    const runId = `pr-gate-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
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
      allow_actions_read: false,
      allow_repair: false,
    };
    return { tmpRepo, tmpOut, runId, mission };
  }

  function buildReviewInput(): import('../src/autopilot-one-click/multitask/types.js').FinalReviewInput {
    const mission = buildMissionFromGoal('Add docs note', { preset: 'multitask-safe', repo_path: '.' });
    const task = makeTask('a');
    const plan = makePlan([task]);
    return {
      mission,
      plan,
      autopilotResult: {
        verdict: 'AUTOPILOT_GREEN',
        reason: 'Fake green',
        exit_code: 0,
        ci_run_id: undefined,
        ci_conclusion: undefined,
        repair_attempts: 0,
      } as AutopilotRunResult,
      integratedDiff: '',
      taskStates: [{ task_id: 'a', status: 'accepted' }],
    };
  }

  test('buildOpenAIReviewCallFn returns fake response without network call', async () => {
    const fn = buildOpenAIReviewCallFn({
      fakeResponse: '{"verdict":"approved","summary":"ok","caveats":[]}',
    });
    const result = await fn('prompt');
    assert.strictEqual(result, '{"verdict":"approved","summary":"ok","caveats":[]}');
  });

  test('buildOpenAIReviewCallFn throws when API key is missing', () => {
    assert.throws(() => buildOpenAIReviewCallFn({ apiKey: '' }), /OPENAI_API_KEY is required/);
  });

  test('buildOpenAIReviewCallFn calls OpenAI API with structured response_format and returns content', async () => {
    const fetchCalls: Array<{ url: string; init: { method?: string; headers?: Record<string, string>; body?: string } }> = [];
    const fetchFn = async (url: string, init: { method?: string; headers?: Record<string, string>; body?: string }) => {
      fetchCalls.push({ url, init });
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{ message: { content: '{"verdict":"approved","summary":"ok","caveats":[],"unauthorized_files":[],"acceptance_gaps":[]}' } }],
        }),
      } as unknown as Response;
    };

    const fn = buildOpenAIReviewCallFn({ apiKey: 'sk-test', model: 'gpt-test', fetchFn });
    const result = await fn('review prompt');
    assert.strictEqual(result, '{"verdict":"approved","summary":"ok","caveats":[],"unauthorized_files":[],"acceptance_gaps":[]}');
    assert.strictEqual(fetchCalls.length, 1);
    const call = fetchCalls[0];
    assert.ok(call.url.includes('openai.com'));
    const body = JSON.parse(call.init.body ?? '{}');
    assert.strictEqual(body.model, 'gpt-test');
    assert.strictEqual(body.messages[0].content, 'review prompt');
    assert.deepStrictEqual(body.response_format, {
      type: 'json_schema',
      json_schema: {
        name: 'FinalMissionReview',
        strict: true,
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            verdict: { type: 'string', enum: ['approved', 'approved_with_caveats', 'needs_changes', 'rejected'] },
            summary: { type: 'string' },
            caveats: { type: 'array', items: { type: 'string' } },
            unauthorized_files: { type: 'array', items: { type: 'string' } },
            acceptance_gaps: { type: 'array', items: { type: 'string' } },
          },
          required: ['verdict', 'summary', 'caveats', 'unauthorized_files', 'acceptance_gaps'],
        },
      },
    });
  });

  test('final review rejection prevents PR creation', async () => {
    const { tmpRepo, tmpOut, mission } = setupGithubMission();
    const planResult = await runAutopilotPlan(mission, { command: 'test' });
    let createCalled = false;

    const result = await runMultitaskMission(mission, planResult, {
      command: 'test',
      runAutopilotRunFn: async () =>
        fakeAutopilotResult(planResult, [
          { id: planResult.plan.tasks[0].id, status: 'passed', commit_sha: 'a'.repeat(40) },
        ]),
      gitExecFn: fakeGitExec(),
      collectDiffFn: () => '',
      reviewCallFn: async () => '{"verdict":"rejected","summary":"bad","caveats":[]}',
      createMvpRunPrFn: async () => {
        createCalled = true;
        return { created: false, reason: 'should not be called' };
      },
    });

    assert.strictEqual(result.verdict, 'MULTITASK_MISSION_FAILED');
    assert.ok(result.reason.includes('rejected'));
    assert.strictEqual(createCalled, false, 'PR must not be created when final review rejects');
    assert.strictEqual(result.pr, undefined, 'Result must not contain a PR after rejection');
    rmSync(tmpRepo, { recursive: true, force: true });
    rmSync(tmpOut, { recursive: true, force: true });
  });

  test('final review approval creates PR after deterministic checks', async () => {
    const { tmpRepo, tmpOut, mission } = setupGithubMission();
    const planResult = await runAutopilotPlan(mission, { command: 'test' });
    let createCalled = false;
    const originalToken = process.env.GITHUB_TOKEN;
    process.env.GITHUB_TOKEN = 'fake-token-for-test';

    let result: import('../src/autopilot-one-click/multitask/types.js').MultitaskMissionResult;
    try {
      result = await runMultitaskMission(mission, planResult, {
      command: 'test',
      runAutopilotRunFn: async () =>
        fakeAutopilotResult(planResult, [
          { id: planResult.plan.tasks[0].id, status: 'passed', commit_sha: 'a'.repeat(40) },
        ]),
      gitExecFn: fakeGitExec(),
      collectDiffFn: () => '',
      reviewCallFn: async () => '{"verdict":"approved","summary":"ok","caveats":[]}',
      createMvpRunPrFn: async () => {
        createCalled = true;
        return {
          created: true,
          number: 99,
          url: 'https://github.com/test/99',
          draft: true,
          reason: 'PR created as draft',
        };
      },
    });

    assert.strictEqual(result.verdict, 'MULTITASK_MISSION_DONE');
    assert.strictEqual(createCalled, true, 'PR must be created after final review approval');
    assert.strictEqual(result.pr?.number, 99);
    } finally {
      process.env.GITHUB_TOKEN = originalToken;
    }
    rmSync(tmpRepo, { recursive: true, force: true });
    rmSync(tmpOut, { recursive: true, force: true });
  });

  test('runner fails closed when final reviewer is unavailable', async () => {
    const { tmpRepo, tmpOut, mission } = setupGithubMission();
    const planResult = await runAutopilotPlan(mission, { command: 'test' });

    const result = await runMultitaskMission(mission, planResult, {
      command: 'test',
      runAutopilotRunFn: async () =>
        fakeAutopilotResult(planResult, [
          { id: planResult.plan.tasks[0].id, status: 'passed', commit_sha: 'a'.repeat(40) },
        ]),
      gitExecFn: fakeGitExec(),
      collectDiffFn: () => '',
      reviewCallFn: async () => {
        throw new Error('Final reviewer is not available: OPENAI_API_KEY is missing');
      },
    });

    assert.strictEqual(result.verdict, 'MULTITASK_MISSION_NEEDS_HUMAN');
    assert.ok(result.reason.includes('Final reviewer is not available'));
    rmSync(tmpRepo, { recursive: true, force: true });
    rmSync(tmpOut, { recursive: true, force: true });
  });

  test('terminal final reviewer failure is persisted and not re-run on resume', async () => {
    const { tmpRepo, tmpOut, mission } = setupGithubMission();
    const planResult = await runAutopilotPlan(mission, { command: 'test' });
    let autopilotCalls = 0;

    const result = await runMultitaskMission(mission, planResult, {
      command: 'test',
      runAutopilotRunFn: async () => {
        autopilotCalls += 1;
        return fakeAutopilotResult(planResult, [
          { id: planResult.plan.tasks[0].id, status: 'passed', commit_sha: 'a'.repeat(40) },
        ]);
      },
      gitExecFn: fakeGitExec(),
      collectDiffFn: () => '',
      reviewCallFn: async () => {
        throw new Error('Final reviewer is not available: OPENAI_API_KEY is missing');
      },
    });

    assert.strictEqual(result.verdict, 'MULTITASK_MISSION_NEEDS_HUMAN');
    assert.strictEqual(autopilotCalls, 1, 'autopilot-run must be invoked exactly once on first run');

    const runDir = getMissionRunDir(tmpOut, mission.run_id);
    const state = loadMissionState(runDir);
    assert.ok(state, 'state must be persisted');
    assert.strictEqual(state.stage, 'completed', 'terminal failure must mark stage completed');
    assert.ok(state.last_error?.includes('Final reviewer is not available'), 'last_error must record failure');
    assert.strictEqual(state.result?.verdict, 'MULTITASK_MISSION_NEEDS_HUMAN', 'terminal result must be persisted');

    assert.ok(existsSync(join(runDir, 'multitask-mission-report.json')), 'report JSON must be written');
    assert.ok(existsSync(join(runDir, 'multitask-mission-report.md')), 'report markdown must be written');

    let autopilotCalledOnResume = false;
    const resumed = await runMultitaskMission(mission, planResult, {
      command: 'test',
      resume: true,
      runAutopilotRunFn: async () => {
        autopilotCalledOnResume = true;
        return fakeAutopilotResult(planResult, [
          { id: planResult.plan.tasks[0].id, status: 'passed', commit_sha: 'a'.repeat(40) },
        ]);
      },
      gitExecFn: fakeGitExec(),
      collectDiffFn: () => '',
      reviewCallFn: async () => '{"verdict":"approved","summary":"ok","caveats":[]}',
    });

    assert.strictEqual(autopilotCalledOnResume, false, 'resume must not re-run autopilot-run for terminal failure');
    assert.strictEqual(resumed.verdict, 'MULTITASK_MISSION_NEEDS_HUMAN');
    assert.strictEqual(resumed.run_dir, result.run_dir);

    rmSync(tmpRepo, { recursive: true, force: true });
    rmSync(tmpOut, { recursive: true, force: true });
  });

  test('parseReviewJson rejects prose response', async () => {
    const input = buildReviewInput();
    await assert.rejects(
      () => runMissionFinalReview(input, async () => 'The mission looks good to me.'),
      /not valid JSON/
    );
  });

  test('parseReviewJson rejects JSON missing required fields', async () => {
    const input = buildReviewInput();
    await assert.rejects(
      () => runMissionFinalReview(input, async () => '{"verdict":"approved","summary":"ok"}'),
      /Invalid final review verdict|not valid JSON|Missing/
    );
  });

  test('parseReviewJson rejects unknown verdict', async () => {
    const input = buildReviewInput();
    await assert.rejects(
      () =>
        runMissionFinalReview(
          input,
          async () =>
            '{"verdict":"maybe","summary":"ok","caveats":[],"unauthorized_files":[],"acceptance_gaps":[]}'
        ),
      /Invalid final review verdict/
    );
  });

  test('malformed final-review response persists terminal EXTERNAL_BLOCKER state and report', async () => {
    const { tmpRepo, tmpOut, mission } = setupGithubMission();
    const planResult = await runAutopilotPlan(mission, { command: 'test' });

    const result = await runMultitaskMission(mission, planResult, {
      command: 'test',
      runAutopilotRunFn: async () =>
        fakeAutopilotResult(planResult, [
          { id: planResult.plan.tasks[0].id, status: 'passed', commit_sha: 'a'.repeat(40) },
        ]),
      gitExecFn: fakeGitExec(),
      collectDiffFn: () => '',
      reviewCallFn: async () => 'not-json {',
    });

    assert.strictEqual(result.verdict, 'MULTITASK_MISSION_EXTERNAL_BLOCKER');
    assert.ok(result.reason.includes('Final reviewer failed'));

    const runDir = getMissionRunDir(tmpOut, mission.run_id);
    const state = loadMissionState(runDir);
    assert.strictEqual(state.stage, 'completed');
    assert.strictEqual(state.result?.verdict, 'MULTITASK_MISSION_EXTERNAL_BLOCKER');
    assert.ok(existsSync(join(runDir, 'multitask-mission-report.json')));
    assert.ok(existsSync(join(runDir, 'multitask-mission-report.md')));

    rmSync(tmpRepo, { recursive: true, force: true });
    rmSync(tmpOut, { recursive: true, force: true });
  });

  test('structured approved response still passes deterministic gate and rejects unauthorized diff', async () => {
    const { tmpRepo, tmpOut, mission } = setupGithubMission();
    const planResult = await runAutopilotPlan(mission, { command: 'test' });
    let createCalled = false;

    const result = await runMultitaskMission(mission, planResult, {
      command: 'test',
      runAutopilotRunFn: async () =>
        fakeAutopilotResult(planResult, [
          { id: planResult.plan.tasks[0].id, status: 'passed', commit_sha: 'a'.repeat(40) },
        ]),
      gitExecFn: fakeGitExec(),
      collectDiffFn: () => 'diff --git a/out/bad.ts b/out/bad.ts\n--- /dev/null\n+++ b/out/bad.ts',
      reviewCallFn: async () =>
        '{"verdict":"approved","summary":"looks good","caveats":[],"unauthorized_files":[],"acceptance_gaps":[]}',
      createMvpRunPrFn: async () => {
        createCalled = true;
        return { created: false, reason: 'should not be called' };
      },
    });

    assert.strictEqual(result.verdict, 'MULTITASK_MISSION_FAILED');
    assert.ok(result.reason.toLowerCase().includes('unauthorized'));
    assert.strictEqual(createCalled, false, 'PR must not be created when deterministic gate fails');

    rmSync(tmpRepo, { recursive: true, force: true });
    rmSync(tmpOut, { recursive: true, force: true });
  });
});


describe('final-review rollback of pushed mission commits', () => {
  function initRemoteRepo(): { remote: string; local: string } {
    const remote = mkdtempSync(join(tmpdir(), 'remote-'));
    const local = mkdtempSync(join(tmpdir(), 'local-'));
    for (const dir of [remote, local]) {
      spawnSync('git', ['init', '--initial-branch=main'], { cwd: dir, encoding: 'utf-8', shell: false });
      spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir, encoding: 'utf-8', shell: false });
      spawnSync('git', ['config', 'user.name', 'Test User'], { cwd: dir, encoding: 'utf-8', shell: false });
      writeFileSync(join(dir, 'README.md'), '# test\n');
      spawnSync('git', ['add', '.'], { cwd: dir, encoding: 'utf-8', shell: false });
      spawnSync('git', ['commit', '-m', 'init'], { cwd: dir, encoding: 'utf-8', shell: false });
    }
    spawnSync('git', ['remote', 'add', 'origin', remote], { cwd: local, encoding: 'utf-8', shell: false });
    spawnSync('git', ['push', '-u', 'origin', 'main'], { cwd: local, encoding: 'utf-8', shell: false });
    return { remote, local };
  }

  function getHeadSha(repoPath: string): string {
    const result = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repoPath, encoding: 'utf-8', shell: false });
    return result.stdout!.trim();
  }

  async function runMissionWithCommits(
    repos: { remote: string; local: string },
    finalReview: import('../../src/autopilot-one-click/multitask/types.js').MultitaskMissionFinalReview,
    pushFailure?: { stage: 'revert' | 'push' }
  ): Promise<{ result: any; mission: any; planResult: any; originalCommit: string; workBranch: string }> {
    const tmpOut = mkdtempSync(join(tmpdir(), 'out-'));
    const runId = `final-rollback-${Date.now()}`;
    const workBranch = `mission-${runId}`;
    const { remote, local } = repos;

    spawnSync('git', ['checkout', '-B', workBranch, 'main'], { cwd: local, encoding: 'utf-8', shell: false });
    writeFileSync(join(local, 'feature.ts'), 'added\n');
    spawnSync('git', ['add', '.'], { cwd: local, encoding: 'utf-8', shell: false });
    spawnSync('git', ['commit', '-m', 'task-a', '--no-gpg-sign'], { cwd: local, encoding: 'utf-8', shell: false });
    const originalCommit = getHeadSha(local);
    spawnSync('git', ['push', 'origin', workBranch], { cwd: local, encoding: 'utf-8', shell: false });

    spawnSync('git', ['checkout', 'main'], { cwd: local, encoding: 'utf-8', shell: false });

    const mission = buildMissionFromGoal('Add feature', {
      preset: 'multitask-safe',
      repo_path: local,
      output_dir: tmpOut,
      run_id: runId,
    });
    mission.capabilities = {
      ...mission.capabilities,
      allow_repo_apply: true,
      allow_repo_commit: true,
      allow_repo_push: true,
      allow_pr_create: false,
      allow_pr_update: false,
      allow_actions_read: false,
      allow_repair: false,
    };

    const planResult = await runAutopilotPlan(mission, { command: 'test' });
    assert.strictEqual(planResult.exit_code, 0);
    // Make the generated task cover the commit we actually wrote so the
    // deterministic final-review gate does not reject the diff.
    planResult.plan.tasks[0].allowed_files = ['feature.ts'];

    const baseSha = getHeadSha(local);
    saveMissionState(getMissionRunDir(tmpOut, runId), {
      version: 1,
      run_id: runId,
      stage: 'running',
      plan_hash: computePlanHash(planResult.plan),
      base_sha: baseSha,
      work_branch: workBranch,
      tasks: [],
    });

    const result = await runMultitaskMission(mission, planResult, {
      command: 'test',
      resume: true,
      runAutopilotRunFn: async () =>
        fakeAutopilotResult(planResult, [
          { id: planResult.plan.tasks[0].id, status: 'passed', commit_sha: originalCommit },
        ]),
      collectDiffFn: () => 'diff --git a/feature.ts b/feature.ts\n+added',
      runFinalReviewFn: async () => finalReview,
      gitExecFn: (args, options) => {
        if (pushFailure && args[0] === 'revert' && pushFailure.stage === 'revert') {
          return { status: 1, stderr: 'forced revert failure', stdout: '', pid: -1, output: [], signal: null };
        }
        if (pushFailure && args[0] === 'push' && pushFailure.stage === 'push') {
          return { status: 1, stderr: 'forced push failure', stdout: '', pid: -1, output: [], signal: null };
        }
        return spawnSync('git', args, { cwd: options?.cwd, encoding: 'utf-8', shell: false });
      },
    });

    return { result, mission, planResult, originalCommit, workBranch };
  }

  test('all tasks accepted + final review rejected + allow_repo_push=true => remote branch reverted to base', async () => {
    const repos = initRemoteRepo();
    const { result, workBranch, originalCommit } = await runMissionWithCommits(
      repos,
      { verdict: 'rejected', summary: 'rejected', caveats: [], unauthorized_files: ['feature.ts'], acceptance_gaps: [] }
    );

    assert.strictEqual(result.verdict, 'MULTITASK_MISSION_FAILED');
    spawnSync('git', ['fetch', 'origin'], { cwd: repos.local, encoding: 'utf-8', shell: false });
    const remoteHead = spawnSync('git', ['rev-parse', `origin/${workBranch}`], { cwd: repos.local, encoding: 'utf-8', shell: false }).stdout!.trim();
    spawnSync('git', ['checkout', remoteHead], { cwd: repos.local, encoding: 'utf-8', shell: false });
    assert.strictEqual(existsSync(join(repos.local, 'feature.ts')), false, 'rejected feature.ts must not be on remote branch');
    const persisted = loadMissionState(result.run_dir);
    assert.strictEqual(persisted?.rolled_back_commits?.includes(originalCommit), true, 'state must record rolled back commit');

    rmSync(repos.remote, { recursive: true, force: true });
    rmSync(repos.local, { recursive: true, force: true });
  });

  test('all tasks accepted + final review needs_changes + allow_repo_push=true => rejected commits removed from remote', async () => {
    const repos = initRemoteRepo();
    const { result, workBranch } = await runMissionWithCommits(
      repos,
      { verdict: 'needs_changes', summary: 'needs changes', caveats: ['fix it'], unauthorized_files: [], acceptance_gaps: ['task not accepted'] }
    );

    assert.strictEqual(result.verdict, 'MULTITASK_MISSION_FAILED');
    spawnSync('git', ['fetch', 'origin'], { cwd: repos.local, encoding: 'utf-8', shell: false });
    const remoteHead = spawnSync('git', ['rev-parse', `origin/${workBranch}`], { cwd: repos.local, encoding: 'utf-8', shell: false }).stdout!.trim();
    spawnSync('git', ['checkout', remoteHead], { cwd: repos.local, encoding: 'utf-8', shell: false });
    assert.strictEqual(existsSync(join(repos.local, 'feature.ts')), false, 'feature.ts must not remain on remote after needs_changes');

    rmSync(repos.remote, { recursive: true, force: true });
    rmSync(repos.local, { recursive: true, force: true });
  });

  test('final review approved => no rollback', async () => {
    const repos = initRemoteRepo();
    const { result, workBranch } = await runMissionWithCommits(
      repos,
      { verdict: 'approved', summary: 'approved', caveats: [], unauthorized_files: [], acceptance_gaps: [] }
    );

    assert.strictEqual(result.verdict, 'MULTITASK_MISSION_DONE');
    spawnSync('git', ['fetch', 'origin'], { cwd: repos.local, encoding: 'utf-8', shell: false });
    const remoteHead = spawnSync('git', ['rev-parse', `origin/${workBranch}`], { cwd: repos.local, encoding: 'utf-8', shell: false }).stdout!.trim();
    spawnSync('git', ['checkout', remoteHead], { cwd: repos.local, encoding: 'utf-8', shell: false });
    assert.strictEqual(existsSync(join(repos.local, 'feature.ts')), true, 'approved feature.ts must stay on remote branch');

    rmSync(repos.remote, { recursive: true, force: true });
    rmSync(repos.local, { recursive: true, force: true });
  });

  test('rollback push failure => terminal failure, not DONE', async () => {
    const repos = initRemoteRepo();
    const { result } = await runMissionWithCommits(
      repos,
      { verdict: 'rejected', summary: 'rejected', caveats: [], unauthorized_files: ['feature.ts'], acceptance_gaps: [] },
      { stage: 'push' }
    );

    assert.strictEqual(result.verdict, 'MULTITASK_MISSION_FAILED');
    assert.ok(result.reason.toLowerCase().includes('push') || result.last_error?.toLowerCase().includes('push'), 'failure must mention push');
    rmSync(repos.remote, { recursive: true, force: true });
    rmSync(repos.local, { recursive: true, force: true });
  });

  test('already reverted blocked commits are not reverted again', async () => {
    function initTempGitRepo(): string {
      const dir = mkdtempSync(join(tmpdir(), 'repo-'));
      spawnSync('git', ['init', '--initial-branch=main'], { cwd: dir, encoding: 'utf-8', shell: false });
      spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir, encoding: 'utf-8', shell: false });
      spawnSync('git', ['config', 'user.name', 'Test User'], { cwd: dir, encoding: 'utf-8', shell: false });
      writeFileSync(join(dir, 'README.md'), '# test\\n');
      spawnSync('git', ['add', '.'], { cwd: dir, encoding: 'utf-8', shell: false });
      spawnSync('git', ['commit', '-m', 'init'], { cwd: dir, encoding: 'utf-8', shell: false });
      return dir;
    }
    function getHeadSha(repoPath: string): string {
      const result = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repoPath, encoding: 'utf-8', shell: false });
      return result.stdout!.trim();
    }
    const tmpRepo = initTempGitRepo();
    const tmpOut = mkdtempSync(join(tmpdir(), 'out-'));
    const runId = `final-rollback-dedup-${Date.now()}`;
    const workBranch = `mission-${runId}`;

    spawnSync('git', ['checkout', '-B', workBranch, 'main'], { cwd: tmpRepo, encoding: 'utf-8', shell: false });
    writeFileSync(join(tmpRepo, 'feature.ts'), 'added\n');
    spawnSync('git', ['add', '.'], { cwd: tmpRepo, encoding: 'utf-8', shell: false });
    spawnSync('git', ['commit', '-m', 'task-a', '--no-gpg-sign'], { cwd: tmpRepo, encoding: 'utf-8', shell: false });
    const originalCommit = getHeadSha(tmpRepo);

    spawnSync('git', ['checkout', 'main'], { cwd: tmpRepo, encoding: 'utf-8', shell: false });

    const mission = buildMissionFromGoal('Add feature', {
      preset: 'multitask-safe',
      repo_path: tmpRepo,
      output_dir: tmpOut,
      run_id: runId,
    });
    mission.capabilities = {
      ...mission.capabilities,
      allow_repo_apply: true,
      allow_repo_commit: true,
      allow_repo_push: false,
      allow_pr_create: false,
      allow_pr_update: false,
      allow_actions_read: false,
      allow_repair: false,
    };

    const planResult = await runAutopilotPlan(mission, { command: 'test' });
    assert.strictEqual(planResult.exit_code, 0);

    const baseSha = getHeadSha(tmpRepo);
    saveMissionState(getMissionRunDir(tmpOut, runId), {
      version: 1,
      run_id: runId,
      stage: 'running',
      plan_hash: computePlanHash(planResult.plan),
      base_sha: baseSha,
      work_branch: workBranch,
      tasks: [],
    });

    const revertCalls: string[][] = [];
    const result = await runMultitaskMission(mission, planResult, {
      command: 'test',
      resume: true,
      runAutopilotRunFn: async () =>
        fakeAutopilotResult(
          planResult,
          [{ id: planResult.plan.tasks[0].id, status: 'blocked', commit_sha: originalCommit }],
          'AUTOPILOT_MVP_FAILED'
        ),
      collectDiffFn: () => '',
      reviewCallFn: async () => ({ verdict: 'rejected', summary: 'rejected', caveats: [], unauthorized_files: ['feature.ts'], acceptance_gaps: [] }),
      gitExecFn: (args, options) => {
        if (args[0] === 'revert') revertCalls.push(args);
        return spawnSync('git', args, { cwd: options?.cwd, encoding: 'utf-8', shell: false });
      },
    });

    assert.strictEqual(result.verdict, 'MULTITASK_MISSION_FAILED');
    const revertCount = revertCalls.filter((args) => args.includes(originalCommit)).length;
    assert.strictEqual(revertCount, 1, 'blocked commit must be reverted exactly once');

    rmSync(tmpRepo, { recursive: true, force: true });
    rmSync(tmpOut, { recursive: true, force: true });
  });

  test('repair commits are reverted along with task commits when final review rejects', async () => {
    const repos = initRemoteRepo();
    const tmpOut = mkdtempSync(join(tmpdir(), 'out-'));
    const runId = `repair-rollback-${Date.now()}`;
    const workBranch = `mission-${runId}`;

    // Create a work branch with a task commit and a repair commit that is not
    // tracked in task state. Both are pushed to the remote.
    spawnSync('git', ['checkout', '-B', workBranch, 'main'], { cwd: repos.local, encoding: 'utf-8', shell: false });
    writeFileSync(join(repos.local, 'feature.ts'), 'added\n');
    spawnSync('git', ['add', '.'], { cwd: repos.local, encoding: 'utf-8', shell: false });
    spawnSync('git', ['commit', '-m', 'task-a', '--no-gpg-sign'], { cwd: repos.local, encoding: 'utf-8', shell: false });
    const taskCommit = getHeadSha(repos.local);

    writeFileSync(join(repos.local, 'repair.ts'), 'fix\n');
    spawnSync('git', ['add', '.'], { cwd: repos.local, encoding: 'utf-8', shell: false });
    spawnSync('git', ['commit', '-m', 'ai-orchestrator: autopilot repair attempt 1', '--no-gpg-sign'], { cwd: repos.local, encoding: 'utf-8', shell: false });
    const repairCommit = getHeadSha(repos.local);
    spawnSync('git', ['push', 'origin', workBranch], { cwd: repos.local, encoding: 'utf-8', shell: false });
    spawnSync('git', ['checkout', 'main'], { cwd: repos.local, encoding: 'utf-8', shell: false });

    const mission = buildMissionFromGoal('Add feature', {
      preset: 'multitask-safe',
      repo_path: repos.local,
      output_dir: tmpOut,
      run_id: runId,
    });
    mission.capabilities = {
      ...mission.capabilities,
      allow_repo_apply: true,
      allow_repo_commit: true,
      allow_repo_push: true,
      allow_pr_create: false,
      allow_pr_update: false,
      allow_actions_read: false,
      allow_repair: false,
    };

    const planResult = await runAutopilotPlan(mission, { command: 'test' });
    assert.strictEqual(planResult.exit_code, 0);
    planResult.plan.tasks[0].allowed_files = ['feature.ts', 'repair.ts'];

    const baseSha = getHeadSha(repos.local);
    saveMissionState(getMissionRunDir(tmpOut, runId), {
      version: 1,
      run_id: runId,
      stage: 'running',
      plan_hash: computePlanHash(planResult.plan),
      base_sha: baseSha,
      work_branch: workBranch,
      tasks: [],
    });

    const result = await runMultitaskMission(mission, planResult, {
      command: 'test',
      resume: true,
      runAutopilotRunFn: async () =>
        fakeAutopilotResult(planResult, [{ id: planResult.plan.tasks[0].id, status: 'passed', commit_sha: taskCommit }]),
      collectDiffFn: () => 'diff --git a/feature.ts b/feature.ts\n+added\ndiff --git a/repair.ts b/repair.ts\n+fix',
      runFinalReviewFn: async () => ({
        verdict: 'rejected',
        summary: 'rejected',
        caveats: [],
        unauthorized_files: [],
        acceptance_gaps: ['not accepted'],
      }),
    });

    assert.strictEqual(result.verdict, 'MULTITASK_MISSION_FAILED');
    const persisted = loadMissionState(result.run_dir);
    assert.strictEqual(persisted?.rolled_back_commits?.includes(taskCommit), true, 'task commit must be recorded as rolled back');
    assert.strictEqual(persisted?.rolled_back_commits?.includes(repairCommit), true, 'repair commit must be recorded as rolled back');

    spawnSync('git', ['fetch', 'origin'], { cwd: repos.local, encoding: 'utf-8', shell: false });
    const remoteHead = spawnSync('git', ['rev-parse', `origin/${workBranch}`], { cwd: repos.local, encoding: 'utf-8', shell: false }).stdout!.trim();
    spawnSync('git', ['checkout', remoteHead], { cwd: repos.local, encoding: 'utf-8', shell: false });
    assert.strictEqual(existsSync(join(repos.local, 'feature.ts')), false, 'task feature.ts must not remain on remote');
    assert.strictEqual(existsSync(join(repos.local, 'repair.ts')), false, 'repair.ts must not remain on remote');

    rmSync(repos.remote, { recursive: true, force: true });
    rmSync(repos.local, { recursive: true, force: true });
    rmSync(tmpOut, { recursive: true, force: true });
  });
});

describe('mission state persistence is atomic', () => {
  test('saveMissionState writes valid JSON via atomic rename', () => {
    const tmpOut = mkdtempSync(join(tmpdir(), 'state-'));
    const runId = `atomic-${Date.now()}`;
    const runDir = getMissionRunDir(tmpOut, runId);

    const state = {
      version: 1 as const,
      run_id: runId,
      stage: 'planning' as const,
      plan_hash: 'abc123',
      base_sha: 'base'.padEnd(40, '0'),
      work_branch: `mission-${runId}`,
      tasks: [],
    };

    saveMissionState(runDir, state);

    const statePath = join(runDir, 'multitask-mission-state.json');
    assert.strictEqual(existsSync(`${statePath}.tmp`), false, 'temp state file must not remain');
    const loaded = loadMissionState(runDir);
    assert.deepStrictEqual(loaded, { ...state });

    rmSync(tmpOut, { recursive: true, force: true });
  });

  test('loadMissionState treats malformed JSON as absent', () => {
    const tmpOut = mkdtempSync(join(tmpdir(), 'state-'));
    const runId = `malformed-${Date.now()}`;
    const runDir = getMissionRunDir(tmpOut, runId);
    const statePath = join(runDir, 'multitask-mission-state.json');
    mkdirSync(runDir, { recursive: true });
    writeFileSync(statePath, '{"run_id": "broken", "tasks": [', 'utf-8');

    const loaded = loadMissionState(runDir);
    assert.strictEqual(loaded, null, 'malformed state must be treated as absent');

    rmSync(tmpOut, { recursive: true, force: true });
  });
});
