import { describe, test } from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

function runCli(args: string[], envOverrides: Record<string, string> = {}, cwd?: string) {
  const env = { ...process.env };
  delete env.KIMI_API_KEY;
  delete env.OPENAI_API_KEY;
  delete env.GITHUB_TOKEN;
  env.AI_PROVIDER = 'mock';
  Object.assign(env, envOverrides);

  const command = `npx tsx "${join(process.cwd(), 'src', 'cli.ts')}" ${args.map((a) => JSON.stringify(a)).join(' ')}`;
  const result = spawnSync(command, {
    cwd: cwd ?? process.cwd(),
    env,
    encoding: 'utf-8',
    shell: true,
    timeout: 30000,
  });

  return {
    status: result.status ?? 1,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
  };
}

describe('cli autopilot-plan', () => {
  test('CLI command works with example mission config', () => {
    const result = runCli(['autopilot-plan', 'configs/mission.example.json']);
    assert.strictEqual(result.status, 0, `Expected exit 0, got: ${result.stderr}`);
    assert(result.stderr.includes('AUTOPILOT_PLAN_READY'), `Expected READY verdict: ${result.stderr}`);
    assert(result.stderr.includes('Generated autopilot config'), `Expected config path: ${result.stderr}`);

    const runDir = join(process.cwd(), 'reports', 'autopilot-plans', 'mission-demo');
    assert(existsSync(join(runDir, 'autopilot.config.json')), 'autopilot config should be generated');
    assert(existsSync(join(runDir, 'operator-command.md')), 'operator command should be generated');
  });

  test('package script works with example mission config', () => {
    const env = { ...process.env };
    delete env.KIMI_API_KEY;
    delete env.OPENAI_API_KEY;
    delete env.GITHUB_TOKEN;
    env.AI_PROVIDER = 'mock';

    const result = spawnSync(
      'npm',
      ['run', 'autopilot:plan', '--', 'configs/mission.example.json'],
      {
        cwd: process.cwd(),
        env,
        encoding: 'utf-8',
        shell: true,
        timeout: 30000,
      }
    );

    const status = result.status ?? 1;
    const stderr = result.stderr || '';
    assert.strictEqual(status, 0, `Expected exit 0, got: ${stderr}`);
    assert(stderr.includes('AUTOPILOT_PLAN_READY'), `Expected READY verdict: ${stderr}`);
  });

  test('missing config path returns clean error', () => {
    const result = runCli(['autopilot-plan']);
    assert.notStrictEqual(result.status, 0);
    assert(result.stderr.includes('mission config path') || result.stderr.includes('Error'));
  });

  test('missing config file returns clean error', () => {
    const result = runCli(['autopilot-plan', 'missing-mission.json']);
    assert.notStrictEqual(result.status, 0);
    assert(result.stderr.includes('Mission config not found') || result.stderr.includes('Error'));
  });

  test('inline goal produces fake plan', () => {
    const result = runCli(['autopilot-plan', 'Add a small README note']);
    assert.strictEqual(result.status, 0, `Expected exit 0, got: ${result.stderr}`);
    assert(result.stderr.includes('AUTOPILOT_PLAN_READY'), `Expected READY verdict: ${result.stderr}`);
    assert(result.stderr.includes('Run id: inline-'), `Expected inline run id: ${result.stderr}`);
  });

  test('fake one-click runs plan + autopilot and exits safe', () => {
    const result = runCli(['autopilot-one-click', 'configs/mission.example.json']);
    assert.strictEqual(result.status, 0, `Expected exit 0, got: ${result.stderr}`);
    assert(result.stderr.includes('AUTOPILOT_PLAN_READY'), `Expected plan READY: ${result.stderr}`);
    assert(
      result.stderr.includes('AUTOPILOT_MVP_DONE_CI_NOT_OBSERVED') || result.stderr.includes('AUTOPILOT_MVP_PASSED'),
      `Expected safe autopilot verdict: ${result.stderr}`
    );
  });

  test('relative repo_path in mission.json is resolved relative to config, not cwd', () => {
    const tmpDir = mkdtempSync(join(process.cwd(), 'tmp', 'cli-plan-relative-'));
    const repoDir = join(tmpDir, 'proof-repo');
    mkdirSync(repoDir, { recursive: true });
    const missionPath = join(tmpDir, 'mission.json');
    writeFileSync(
      missionPath,
      JSON.stringify({
        run_id: 'cli-relative-repo',
        repo_slug: 'owner/repo',
        repo_path: 'proof-repo',
        base_branch: 'main',
        goal: 'Add a small docs note',
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

    const result = runCli(['autopilot-plan', missionPath]);
    assert.strictEqual(result.status, 0, `Expected exit 0, got: ${result.stderr}`);
    assert(result.stderr.includes('AUTOPILOT_PLAN_READY'), `Expected READY verdict: ${result.stderr}`);

    const autopilotConfig = JSON.parse(
      readFileSync(join(tmpDir, 'out', 'cli-relative-repo', 'mvp-run.config.json'), 'utf-8')
    );
    assert.strictEqual(autopilotConfig.repo_path, repoDir);

    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('relative repo_path is resolved relative to mission.json when CLI runs from a different cwd', () => {
    const cfgDir = mkdtempSync(join(process.cwd(), 'tmp', 'cli-plan-cfg-'));
    const otherCwd = mkdtempSync(join(process.cwd(), 'tmp', 'cli-plan-cwd-'));
    const repoDir = join(cfgDir, 'proof-repo');
    mkdirSync(repoDir, { recursive: true });
    const missionPath = join(cfgDir, 'mission.json');
    writeFileSync(
      missionPath,
      JSON.stringify({
        run_id: 'cli-cfg-other-cwd',
        repo_slug: 'owner/repo',
        repo_path: 'proof-repo',
        base_branch: 'main',
        goal: 'Add a small docs note',
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
        output_dir: join(cfgDir, 'out'),
      })
    );

    const result = runCli(['autopilot-plan', missionPath], {}, otherCwd);
    assert.strictEqual(result.status, 0, `Expected exit 0, got: ${result.stderr}`);
    assert(result.stderr.includes('AUTOPILOT_PLAN_READY'), `Expected READY verdict: ${result.stderr}`);

    const autopilotConfig = JSON.parse(
      readFileSync(join(cfgDir, 'out', 'cli-cfg-other-cwd', 'mvp-run.config.json'), 'utf-8')
    );
    assert.strictEqual(autopilotConfig.repo_path, repoDir);

    rmSync(cfgDir, { recursive: true, force: true });
    rmSync(otherCwd, { recursive: true, force: true });
  });

  test('one-click propagates resolved repo_path through planner, runner, and generated configs', () => {
    const tmpDir = mkdtempSync(join(process.cwd(), 'tmp', 'cli-one-click-repo-'));
    const repoDir = join(tmpDir, 'proof-repo');
    mkdirSync(repoDir, { recursive: true });
    const missionPath = join(tmpDir, 'mission.json');
    writeFileSync(
      missionPath,
      JSON.stringify({
        run_id: 'one-click-repo-propagate',
        repo_slug: 'owner/repo',
        repo_path: 'proof-repo',
        base_branch: 'main',
        goal: 'Add a small docs note',
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

    const result = runCli(['autopilot-one-click', missionPath]);
    assert.strictEqual(result.status, 0, `Expected exit 0, got: ${result.stderr}`);
    assert(
      result.stderr.includes('AUTOPILOT_MVP_DONE_CI_NOT_OBSERVED') || result.stderr.includes('AUTOPILOT_MVP_PASSED'),
      `Expected safe autopilot verdict: ${result.stderr}`
    );

    const runDir = join(tmpDir, 'out', 'one-click-repo-propagate');
    const mvpConfig = JSON.parse(readFileSync(join(runDir, 'mvp-run.config.json'), 'utf-8'));
    assert.strictEqual(mvpConfig.repo_path, repoDir);

    rmSync(tmpDir, { recursive: true, force: true });
  });
});
