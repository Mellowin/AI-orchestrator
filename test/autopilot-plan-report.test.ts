import { describe, test } from 'node:test';
import assert from 'node:assert';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { runAutopilotPlan } from '../src/autopilot-plan/runner.js';
import { validateMissionConfig } from '../src/autopilot-plan/config-loader.js';
import { buildMvpRunConfig } from '../src/autopilot-plan/report-writer.js';
import type { AutopilotPlanGeneratedPlan, AutopilotPlanMission, AutopilotPlanTask } from '../src/autopilot-plan/types.js';

describe('autopilot-plan report-writer', () => {
  test('operator-command.md contains exact autopilot-run command', async () => {
    const outDir = join(process.cwd(), 'tmp', `plan-report-${Date.now()}`);
    const mission = validateMissionConfig({
      run_id: 'report-demo',
      repo_slug: 'owner/repo',
      repo_path: '.',
      base_branch: 'main',
      goal: 'Add docs',
      mode: 'fake',
      capabilities: {
        allow_real_provider: false,
        allow_repo_apply: false,
        allow_repo_commit: false,
        allow_repo_push: false,
        allow_pr_create: false,
        allow_pr_update: false,
        allow_actions_read: false,
        allow_repair: false,
      },
      output_dir: outDir,
    });

    const result = await runAutopilotPlan(mission, { command: 'test' });

    assert.ok(result.verdict === 'AUTOPILOT_PLAN_READY' || result.verdict === 'AUTOPILOT_PLAN_READY_WITH_CAVEATS', `Unexpected verdict: ${result.verdict}`);
    const operatorCommand = readFileSync(join(result.run_dir, 'operator-command.md'), 'utf-8');
    assert.ok(operatorCommand.includes('npx tsx src/cli.ts autopilot-run'));
    assert.ok(operatorCommand.includes('autopilot.config.json'));

    rmSync(outDir, { recursive: true, force: true });
  });

  test('generated JSON files are parseable', async () => {
    const outDir = join(process.cwd(), 'tmp', `plan-report-${Date.now()}`);
    const mission = validateMissionConfig({
      run_id: 'json-demo',
      repo_slug: 'owner/repo',
      repo_path: '.',
      base_branch: 'main',
      goal: 'Add docs',
      mode: 'fake',
      capabilities: {
        allow_real_provider: false,
        allow_repo_apply: false,
        allow_repo_commit: false,
        allow_repo_push: false,
        allow_pr_create: false,
        allow_pr_update: false,
        allow_actions_read: false,
        allow_repair: false,
      },
      output_dir: outDir,
    });

    const result = await runAutopilotPlan(mission, { command: 'test' });
    JSON.parse(readFileSync(join(result.run_dir, 'mission.json'), 'utf-8'));
    JSON.parse(readFileSync(join(result.run_dir, 'plan.json'), 'utf-8'));
    JSON.parse(readFileSync(join(result.run_dir, 'mvp-run.config.json'), 'utf-8'));
    JSON.parse(readFileSync(join(result.run_dir, 'autopilot.config.json'), 'utf-8'));

    rmSync(outDir, { recursive: true, force: true });
  });

  test('autopilot.config.json repair allowed_files scopes to mission and task allowed_files', async () => {
    const outDir = join(process.cwd(), 'tmp', `plan-report-repair-${Date.now()}`);
    const mission = validateMissionConfig({
      run_id: 'repair-scope-demo',
      repo_slug: 'owner/repo',
      repo_path: '.',
      base_branch: 'main',
      goal: 'Add docs',
      mode: 'fake',
      capabilities: {
        allow_real_provider: false,
        allow_repo_apply: true,
        allow_repo_commit: true,
        allow_repo_push: true,
        allow_pr_create: true,
        allow_pr_update: true,
        allow_actions_read: false,
        allow_repair: true,
      },
      allowed_files: ['docs/mission.md'],
      output_dir: outDir,
    });

    const result = await runAutopilotPlan(mission, { command: 'test' });

    assert.ok(result.verdict === 'AUTOPILOT_PLAN_READY' || result.verdict === 'AUTOPILOT_PLAN_READY_WITH_CAVEATS', `Unexpected verdict: ${result.verdict}`);
    const autopilotConfig = JSON.parse(readFileSync(join(result.run_dir, 'autopilot.config.json'), 'utf-8'));
    assert.ok(Array.isArray(autopilotConfig.repair.allowed_files), 'repair.allowed_files must be an array');
    assert.ok(autopilotConfig.repair.allowed_files.includes('docs/mission.md'), 'must include mission allowed_files');
    assert.ok(!autopilotConfig.repair.allowed_files.includes('src/secret.ts'), 'must not include arbitrary files');

    rmSync(outDir, { recursive: true, force: true });
  });

  test('autopilot.config.json repair allowed_files includes task defaults when no mission allowlist is set', async () => {
    const outDir = join(process.cwd(), 'tmp', `plan-report-repair-default-${Date.now()}`);
    const mission = validateMissionConfig({
      run_id: 'repair-scope-default-demo',
      repo_slug: 'owner/repo',
      repo_path: '.',
      base_branch: 'main',
      goal: 'Add docs',
      mode: 'fake',
      capabilities: {
        allow_real_provider: false,
        allow_repo_apply: true,
        allow_repo_commit: true,
        allow_repo_push: true,
        allow_pr_create: true,
        allow_pr_update: true,
        allow_actions_read: false,
        allow_repair: true,
      },
      output_dir: outDir,
    });

    const result = await runAutopilotPlan(mission, { command: 'test' });

    assert.ok(result.verdict === 'AUTOPILOT_PLAN_READY' || result.verdict === 'AUTOPILOT_PLAN_READY_WITH_CAVEATS', `Unexpected verdict: ${result.verdict}`);
    const autopilotConfig = JSON.parse(readFileSync(join(result.run_dir, 'autopilot.config.json'), 'utf-8'));
    assert.ok(autopilotConfig.repair.allowed_files.includes('docs/AUTOPILOT_PLAN.md'), 'must include task default allowed_files');
    assert.ok(!autopilotConfig.repair.allowed_files.includes('src/secret.ts'), 'must not include arbitrary files');

    rmSync(outDir, { recursive: true, force: true });
  });
});


function makeMission(overrides: Partial<AutopilotPlanMission> = {}): AutopilotPlanMission {
  return {
    run_id: 'report-legacy-tests',
    repo_slug: 'owner/repo',
    repo_path: '.',
    base_branch: 'main',
    goal: 'Add docs',
    mode: 'fake',
    capabilities: {
      allow_real_provider: false,
      allow_repo_apply: false,
      allow_repo_commit: false,
      allow_repo_push: false,
      allow_pr_create: false,
      allow_pr_update: false,
      allow_actions_read: false,
      allow_repair: false,
    },
    output_dir: '/tmp/out',
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

function makeTask(overrides: Partial<AutopilotPlanTask> = {}): AutopilotPlanTask {
  return {
    id: 't1',
    title: 'Task 1',
    goal: 'Do something',
    allowed_files: ['docs/AUTOPILOT_PLAN.md'],
    denied_files: ['.env'],
    risk: 'low',
    acceptance_criteria: ['it works'],
    expected_result: 'passes',
    max_lines_changed: 100,
    ...overrides,
  };
}

describe('taskToMvpTask preserves legacy tests when checks are absent', () => {
  test('omits checks field when only legacy tests are defined', () => {
    const mission = makeMission();
    const plan = makePlan([makeTask({ tests: ['npm test'], checks: undefined })]);
    const config = buildMvpRunConfig(mission, plan, '/tmp/out/run');
    const task = config.tasks[0];
    assert.ok(!('checks' in task), 'checks must be omitted to preserve legacy tests');
    assert.deepStrictEqual(task.tests, ['npm test']);
  });

  test('explicit empty checks override legacy tests', () => {
    const mission = makeMission();
    const plan = makePlan([makeTask({ tests: ['npm test'], checks: [] })]);
    const config = buildMvpRunConfig(mission, plan, '/tmp/out/run');
    const task = config.tasks[0];
    assert.deepStrictEqual(task.checks, []);
    assert.deepStrictEqual(task.tests, ['npm test']);
  });

  test('non-empty checks take precedence over legacy tests', () => {
    const mission = makeMission();
    const plan = makePlan([makeTask({ tests: ['npm test'], checks: ['npm run lint'] })]);
    const config = buildMvpRunConfig(mission, plan, '/tmp/out/run');
    const task = config.tasks[0];
    assert.deepStrictEqual(task.checks, ['npm run lint']);
    assert.deepStrictEqual(task.tests, ['npm test']);
  });

  test('mixed tasks keep correct checks/tests per task', () => {
    const mission = makeMission();
    const plan = makePlan([
      makeTask({ id: 'legacy', tests: ['npm test'], checks: undefined }),
      makeTask({ id: 'explicit', tests: ['npm test'], checks: ['npm run lint'] }),
      makeTask({ id: 'empty', tests: ['npm test'], checks: [] }),
    ]);
    const config = buildMvpRunConfig(mission, plan, '/tmp/out/run');
    assert.ok(!('checks' in config.tasks[0]));
    assert.deepStrictEqual(config.tasks[0].tests, ['npm test']);
    assert.deepStrictEqual(config.tasks[1].checks, ['npm run lint']);
    assert.deepStrictEqual(config.tasks[2].checks, []);
  });
});
