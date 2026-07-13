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
});
