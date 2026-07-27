import { describe, test } from 'node:test';
import assert from 'node:assert';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { runAutopilotPlan } from '../src/autopilot-plan/runner.js';
import { validateMissionConfig } from '../src/autopilot-plan/config-loader.js';

function makeMission(overrides: Record<string, unknown> = {}) {
  return validateMissionConfig({
    run_id: `plan-test-${Date.now()}`,
    repo_slug: 'owner/repo',
    repo_path: '.',
    base_branch: 'main',
    goal: 'Add a small documentation note',
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
    output_dir: join(process.cwd(), 'tmp', `plan-out-${Date.now()}`),
    ...overrides,
  });
}

describe('autopilot-plan runner', () => {
  test('fake plan writes all required artifacts', async () => {
    const outDir = join(process.cwd(), 'tmp', `plan-out-${Date.now()}`);
    const mission = makeMission({ output_dir: outDir });
    const result = await runAutopilotPlan(mission, { command: 'test' });

    assert.ok(result.verdict === 'AUTOPILOT_PLAN_READY' || result.verdict === 'AUTOPILOT_PLAN_READY_WITH_CAVEATS', `Unexpected verdict: ${result.verdict}`);
    assert.strictEqual(result.exit_code, 0);
    assert.strictEqual(result.plan.tasks.length, 1);
    assert.ok(result.next_command.includes('autopilot-run'));

    const runDir = result.run_dir;
    assert.ok(existsSync(join(runDir, 'mission.md')));
    assert.ok(existsSync(join(runDir, 'mission.json')));
    assert.ok(existsSync(join(runDir, 'plan.md')));
    assert.ok(existsSync(join(runDir, 'plan.json')));
    assert.ok(existsSync(join(runDir, 'mvp-run.config.json')));
    assert.ok(existsSync(join(runDir, 'autopilot.config.json')));
    assert.ok(existsSync(join(runDir, 'operator-command.md')));

    rmSync(outDir, { recursive: true, force: true });
  });

  test('generated fake autopilot config has all write capabilities disabled', async () => {
    const outDir = join(process.cwd(), 'tmp', `plan-out-${Date.now()}`);
    const mission = makeMission({
      output_dir: outDir,
      capabilities: {
        allow_real_provider: true,
        allow_repo_apply: true,
        allow_repo_commit: true,
        allow_repo_push: true,
        allow_pr_create: true,
        allow_pr_update: true,
        allow_actions_read: true,
        allow_repair: true,
      },
    });
    const result = await runAutopilotPlan(mission, { command: 'test' });

    assert.ok(result.verdict === 'AUTOPILOT_PLAN_READY' || result.verdict === 'AUTOPILOT_PLAN_READY_WITH_CAVEATS', `Unexpected verdict: ${result.verdict}`);

    const autopilotConfig = JSON.parse(readFileSync(join(result.run_dir, 'autopilot.config.json'), 'utf-8'));
    assert.strictEqual(autopilotConfig.mode, 'fake');
    assert.strictEqual(autopilotConfig.repair.enabled, false);
    assert.strictEqual(autopilotConfig.ci.enabled, false);
    assert.strictEqual(autopilotConfig.github.allow_pr_create, false);
    assert.strictEqual(autopilotConfig.repair.allow_apply, false);

    rmSync(outDir, { recursive: true, force: true });
  });

  test('explicit real capabilities are copied correctly', async () => {
    const outDir = join(process.cwd(), 'tmp', `plan-out-${Date.now()}`);
    const mission = makeMission({
      mode: 'github',
      output_dir: outDir,
      capabilities: {
        allow_real_provider: true,
        allow_repo_apply: true,
        allow_repo_commit: true,
        allow_repo_push: true,
        allow_pr_create: true,
        allow_pr_update: true,
        allow_actions_read: true,
        allow_repair: true,
      },
      provider: { name: 'kimi', token_env: 'TEST_KIMI_API_KEY_PLAN' },
      github: { token_env: 'TEST_GITHUB_TOKEN_PLAN' },
    });

    process.env.TEST_KIMI_API_KEY_PLAN = 'sk-fake';
    process.env.TEST_GITHUB_TOKEN_PLAN = 'ghp_fake';

    const result = await runAutopilotPlan(mission, {
      command: 'test',
      providerCallFn: async () => JSON.stringify({
        tasks: [{
          id: 'task-1',
          title: 'Implement feature',
          goal: 'Implement a small safe code change',
          allowed_files: ['src/feature.ts'],
          denied_files: ['.env'],
          tests: ['npm run typecheck'],
          risk: 'medium',
          acceptance_criteria: ['Feature compiles and passes tests'],
          expected_result: 'src/feature.ts updated',
          max_lines_changed: 100,
        }],
        ci_enabled: true,
        repair_enabled: true,
        risk_level: 'medium',
        caveats: [],
      }),
    });

    assert.ok(result.verdict === 'AUTOPILOT_PLAN_READY' || result.verdict === 'AUTOPILOT_PLAN_READY_WITH_CAVEATS', `Unexpected verdict: ${result.verdict}`);

    const autopilotConfig = JSON.parse(readFileSync(join(result.run_dir, 'autopilot.config.json'), 'utf-8'));
    assert.strictEqual(autopilotConfig.mode, 'github');
    assert.strictEqual(autopilotConfig.repair.enabled, true);
    assert.strictEqual(autopilotConfig.ci.enabled, true);
    assert.strictEqual(autopilotConfig.github.allow_pr_create, true);
    assert.strictEqual(autopilotConfig.repair.allow_apply, true);
    assert.strictEqual(autopilotConfig.repair.allow_commit, true);
    assert.strictEqual(autopilotConfig.repair.allow_push, true);

    delete process.env.TEST_KIMI_API_KEY_PLAN;
    delete process.env.TEST_GITHUB_TOKEN_PLAN;

    rmSync(outDir, { recursive: true, force: true });
  });

  test('github/real provider mode without provider token returns NEEDS_PROVIDER_TOKEN', async () => {
    const mission = makeMission({
      mode: 'github',
      capabilities: {
        allow_real_provider: true,
        allow_repo_apply: false,
        allow_repo_commit: false,
        allow_repo_push: false,
        allow_pr_create: false,
        allow_pr_update: false,
        allow_actions_read: false,
        allow_repair: false,
      },
      provider: { name: 'kimi', token_env: 'MISSING_KIMI_TOKEN_PLAN' },
    });

    delete process.env.MISSING_KIMI_TOKEN_PLAN;

    const result = await runAutopilotPlan(mission, { command: 'test' });

    assert.strictEqual(result.verdict, 'AUTOPILOT_PLAN_NEEDS_PROVIDER_TOKEN');
    assert.notStrictEqual(result.exit_code, 0);
  });

  test('provider bad output is rejected and records attempts', async () => {
    const outDir = join(process.cwd(), 'tmp', `plan-out-${Date.now()}`);
    const mission = makeMission({
      mode: 'github',
      output_dir: outDir,
      capabilities: {
        allow_real_provider: true,
        allow_repo_apply: false,
        allow_repo_commit: false,
        allow_repo_push: false,
        allow_pr_create: false,
        allow_pr_update: false,
        allow_actions_read: false,
        allow_repair: false,
      },
      provider: { name: 'kimi', token_env: 'TEST_KIMI_API_KEY_PLAN_BAD_ATTEMPTS' },
    });

    process.env.TEST_KIMI_API_KEY_PLAN_BAD_ATTEMPTS = 'sk-fake';

    let call = 0;
    const result = await runAutopilotPlan(mission, {
      command: 'test',
      providerCallFn: async () => {
        call += 1;
        if (call === 1) {
          return 'not valid json';
        }
        return 'still not valid json';
      },
    });

    assert.strictEqual(result.verdict, 'AUTOPILOT_PLAN_PROVIDER_BAD_OUTPUT');
    assert.notStrictEqual(result.exit_code, 0);
    assert.ok(existsSync(join(result.run_dir, 'plan-provider-attempts.json')));

    delete process.env.TEST_KIMI_API_KEY_PLAN_BAD_ATTEMPTS;
    rmSync(outDir, { recursive: true, force: true });
  });

  test('generated task plan validates allowed files and checks', async () => {
    const outDir = join(process.cwd(), 'tmp', `plan-out-${Date.now()}`);
    const mission = makeMission({ output_dir: outDir });
    const result = await runAutopilotPlan(mission, { command: 'test' });

    assert.ok(result.plan.tasks.length > 0);
    for (const task of result.plan.tasks) {
      assert.ok(task.id.length > 0);
      assert.ok(task.title.length > 0);
      assert.ok(Array.isArray(task.allowed_files));
      assert.ok(task.allowed_files.length > 0);
      assert.ok(['low', 'medium', 'high'].includes(task.risk));
    }

    rmSync(outDir, { recursive: true, force: true });
  });

  test('reports redact GitHub/Kimi-like tokens', async () => {
    const outDir = join(process.cwd(), 'tmp', `plan-out-${Date.now()}`);
    const mission = makeMission({
      mode: 'github',
      output_dir: outDir,
      capabilities: {
        allow_real_provider: true,
        allow_repo_apply: false,
        allow_repo_commit: false,
        allow_repo_push: false,
        allow_pr_create: false,
        allow_pr_update: false,
        allow_actions_read: false,
        allow_repair: false,
      },
      constraints: ['Token ghp_secret123 must not leak', 'Kimi sk-abc123 must not leak'],
      provider: { name: 'kimi', token_env: 'TEST_KIMI_API_KEY_PLAN_REDACT' },
    });

    process.env.TEST_KIMI_API_KEY_PLAN_REDACT = 'sk-realredact';

    const result = await runAutopilotPlan(mission, {
      command: 'test',
      providerCallFn: async () => JSON.stringify({
        tasks: [{
          id: 'task-1',
          title: 'Safe change',
          goal: 'Make a safe change',
          allowed_files: ['src/feature.ts'],
          risk: 'low',
          acceptance_criteria: ['Change is safe'],
          expected_result: 'src/feature.ts updated',
          max_lines_changed: 50,
          checks: [],
        }],
        ci_enabled: false,
        repair_enabled: false,
        risk_level: 'low',
        caveats: [],
      }),
    });
    assert.ok(result.verdict === 'AUTOPILOT_PLAN_READY' || result.verdict === 'AUTOPILOT_PLAN_READY_WITH_CAVEATS', `Unexpected verdict: ${result.verdict}`);

    const planMd = readFileSync(join(result.run_dir, 'plan.md'), 'utf-8');
    const missionMd = readFileSync(join(result.run_dir, 'mission.md'), 'utf-8');

    assert.ok(!planMd.includes('ghp_secret123'));
    assert.ok(!planMd.includes('sk-abc123'));
    assert.ok(!missionMd.includes('ghp_secret123'));
    assert.ok(!missionMd.includes('sk-abc123'));

    delete process.env.TEST_KIMI_API_KEY_PLAN_REDACT;
    rmSync(outDir, { recursive: true, force: true });
  });
});
