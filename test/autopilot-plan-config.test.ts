import { describe, test } from 'node:test';
import assert from 'node:assert';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
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

  test('relative repo_path is resolved relative to mission.json', () => {
    const tmpDir = mkdtempSync(join(process.cwd(), 'tmp', 'apcfg-relative-'));
    const repoDir = join(tmpDir, 'proof-repo');
    mkdirSync(repoDir, { recursive: true });
    const missionPath = join(tmpDir, 'mission.json');
    writeFileSync(
      missionPath,
      JSON.stringify({
        run_id: 'relative-repo-test',
        repo_slug: 'owner/repo',
        repo_path: 'proof-repo',
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
        output_dir: join(tmpDir, 'out'),
      })
    );

    const mission = loadMissionConfig(missionPath);
    assert.strictEqual(mission.repo_path, resolve(tmpDir, 'proof-repo'));
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('nested relative repo_path is resolved relative to mission.json directory', () => {
    const tmpDir = mkdtempSync(join(process.cwd(), 'tmp', 'apcfg-nested-'));
    const repoDir = join(tmpDir, 'a', 'b', 'proof-repo');
    mkdirSync(repoDir, { recursive: true });
    const missionPath = join(tmpDir, 'mission.json');
    writeFileSync(
      missionPath,
      JSON.stringify({
        run_id: 'nested-repo-test',
        repo_slug: 'owner/repo',
        repo_path: 'a/b/proof-repo',
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
        output_dir: join(tmpDir, 'out'),
      })
    );

    const mission = loadMissionConfig(missionPath);
    assert.strictEqual(mission.repo_path, resolve(tmpDir, 'a', 'b', 'proof-repo'));
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('absolute repo_path is preserved', () => {
    const tmpDir = mkdtempSync(join(process.cwd(), 'tmp', 'apcfg-absolute-'));
    const repoDir = join(tmpDir, 'absolute-repo');
    mkdirSync(repoDir, { recursive: true });
    const missionPath = join(tmpDir, 'mission.json');
    writeFileSync(
      missionPath,
      JSON.stringify({
        run_id: 'absolute-repo-test',
        repo_slug: 'owner/repo',
        repo_path: repoDir,
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
        output_dir: join(tmpDir, 'out'),
      })
    );

    const mission = loadMissionConfig(missionPath);
    assert.strictEqual(mission.repo_path, resolve(repoDir));
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('missing relative repo_path reports the resolved and original paths', () => {
    const tmpDir = mkdtempSync(join(process.cwd(), 'tmp', 'apcfg-missing-'));
    const missionPath = join(tmpDir, 'mission.json');
    writeFileSync(
      missionPath,
      JSON.stringify({
        run_id: 'missing-repo-test',
        repo_slug: 'owner/repo',
        repo_path: 'does-not-exist',
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
        output_dir: join(tmpDir, 'out'),
      })
    );

    assert.throws(
      () => loadMissionConfig(missionPath),
      /repo_path does not exist: .*does-not-exist \(original: does-not-exist\)/
    );
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('repo_path with spaces is resolved correctly', () => {
    const tmpDir = mkdtempSync(join(process.cwd(), 'tmp', 'apcfg-space-'));
    const repoDir = join(tmpDir, 'proof repo', 'proof-repo');
    mkdirSync(repoDir, { recursive: true });
    const missionPath = join(tmpDir, 'mission.json');
    writeFileSync(
      missionPath,
      JSON.stringify({
        run_id: 'space-repo-test',
        repo_slug: 'owner/repo',
        repo_path: 'proof repo/proof-repo',
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
        output_dir: join(tmpDir, 'out'),
      })
    );

    const mission = loadMissionConfig(missionPath);
    assert.strictEqual(mission.repo_path, resolve(tmpDir, 'proof repo', 'proof-repo'));
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('repo_path with backslash separators is normalized on Windows', () => {
    const tmpDir = mkdtempSync(join(process.cwd(), 'tmp', 'apcfg-backslash-'));
    const repoDir = join(tmpDir, 'proof-repo', 'nested');
    mkdirSync(repoDir, { recursive: true });
    const missionPath = join(tmpDir, 'mission.json');
    writeFileSync(
      missionPath,
      JSON.stringify({
        run_id: 'backslash-repo-test',
        repo_slug: 'owner/repo',
        repo_path: 'proof-repo\\nested',
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
        output_dir: join(tmpDir, 'out'),
      })
    );

    const mission = loadMissionConfig(missionPath);
    assert.strictEqual(mission.repo_path, resolve(tmpDir, 'proof-repo', 'nested'));
    rmSync(tmpDir, { recursive: true, force: true });
  });
});
