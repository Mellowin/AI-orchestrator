import { describe, test } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadMissionConfig, validateMissionConfig, buildWorkBranch } from '../src/autopilot-plan/config-loader.js';

describe('autopilot-plan config-loader', () => {
  test('fake mission config validates', () => {
    const mission = validateMissionConfig({
      run_id: 'mission-demo',
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
      output_dir: 'reports/autopilot-plans',
    });

    assert.strictEqual(mission.run_id, 'mission-demo');
    assert.strictEqual(mission.mode, 'fake');
    assert.strictEqual(mission.capabilities.allow_repo_apply, false);
  });

  test('fake mode forces all write capabilities off', () => {
    const mission = validateMissionConfig({
      run_id: 'mission-demo',
      repo_slug: 'owner/repo',
      repo_path: '.',
      base_branch: 'main',
      goal: 'Add docs',
      mode: 'fake',
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
      output_dir: 'reports/autopilot-plans',
    });

    assert.strictEqual(mission.capabilities.allow_real_provider, false);
    assert.strictEqual(mission.capabilities.allow_repo_apply, false);
    assert.strictEqual(mission.capabilities.allow_actions_read, false);
    assert.strictEqual(mission.capabilities.allow_repair, false);
  });

  test('real capabilities are preserved in github mode', () => {
    const mission = validateMissionConfig({
      run_id: 'mission-real',
      repo_slug: 'owner/repo',
      repo_path: '.',
      base_branch: 'main',
      goal: 'Implement feature',
      mode: 'github',
      capabilities: {
        allow_real_provider: true,
        allow_repo_apply: true,
        allow_repo_commit: true,
        allow_repo_push: true,
        allow_pr_create: true,
        allow_pr_update: false,
        allow_actions_read: true,
        allow_repair: true,
      },
      output_dir: 'reports/autopilot-plans',
    });

    assert.strictEqual(mission.capabilities.allow_repo_apply, true);
    assert.strictEqual(mission.capabilities.allow_pr_create, true);
    assert.strictEqual(mission.capabilities.allow_pr_update, false);
  });

  test('missing mission config file gives clean error', () => {
    assert.throws(() => loadMissionConfig('nonexistent-mission.json'), /Mission config not found/);
  });

  test('invalid mode is rejected', () => {
    assert.throws(
      () =>
        validateMissionConfig({
          run_id: 'x',
          repo_slug: 'owner/repo',
          repo_path: '.',
          base_branch: 'main',
          goal: 'g',
          mode: 'unknown',
          capabilities: {},
          output_dir: 'out',
        }),
      /Mission mode must be/
    );
  });

  test('buildWorkBranch derives safe branch name', () => {
    assert.strictEqual(buildWorkBranch('my mission!'), 'mission-my-mission-');
    assert.strictEqual(buildWorkBranch('demo-1'), 'mission-demo-1');
  });
});
