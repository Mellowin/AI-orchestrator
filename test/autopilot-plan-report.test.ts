import { describe, test } from 'node:test';
import assert from 'node:assert';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { runAutopilotPlan } from '../src/autopilot-plan/runner.js';
import { validateMissionConfig } from '../src/autopilot-plan/config-loader.js';

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
