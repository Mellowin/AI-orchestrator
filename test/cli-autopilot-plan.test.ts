import { describe, test } from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

function runCli(args: string[], envOverrides: Record<string, string> = {}) {
  const env = { ...process.env };
  delete env.KIMI_API_KEY;
  delete env.OPENAI_API_KEY;
  delete env.GITHUB_TOKEN;
  env.AI_PROVIDER = 'mock';
  Object.assign(env, envOverrides);

  const result = spawnSync(
    `npx tsx "${join(process.cwd(), 'src', 'cli.ts')}" ${args.join(' ')}`,
    {
      cwd: process.cwd(),
      env,
      encoding: 'utf-8',
      shell: true,
      timeout: 30000,
    }
  );

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
});
