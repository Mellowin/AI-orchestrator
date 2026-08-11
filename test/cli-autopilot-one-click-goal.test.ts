import { describe, test } from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

function runCli(args: string[], envOverrides: Record<string, string> = {}) {
  const env = { ...process.env };
  delete env.KIMI_API_KEY;
  env.KIMI_API_KEY = '';
  delete env.OPENAI_API_KEY;
  delete env.GITHUB_TOKEN;
  env.GITHUB_TOKEN = '';
  env.AI_PROVIDER = 'mock';
  Object.assign(env, envOverrides);

  const result = spawnSync(
    `npx tsx "${join(process.cwd(), 'src', 'cli.ts')}" ${args.join(' ')}`,
    {
      cwd: process.cwd(),
      env,
      encoding: 'utf-8',
      shell: true,
      timeout: 60000,
    }
  );

  return {
    status: result.status ?? 1,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
  };
}

describe('cli autopilot-one-click raw goal', () => {
  test('CLI raw goal runs safe fake one-click without tokens', () => {
    const result = runCli(['autopilot-one-click', 'Add a docs note', '--preset', 'safe']);
    assert.strictEqual(result.status, 0, `Expected exit 0, got: ${result.stderr}`);
    assert(result.stderr.includes('Forbidden:'), `Expected forbidden summary: ${result.stderr}`);
    assert(
      result.stderr.includes('ONE_CLICK_DONE') || result.stderr.includes('ONE_CLICK_DONE_WITH_CAVEATS'),
      `Expected done verdict: ${result.stderr}`
    );
  });

  test('npm script raw goal runs safe fake one-click', () => {
    const env = { ...process.env };
    delete env.KIMI_API_KEY;
    delete env.OPENAI_API_KEY;
    delete env.GITHUB_TOKEN;
    env.AI_PROVIDER = 'mock';

    const result = spawnSync(
      'npm',
      ['run', 'autopilot:one-click', '--', 'Add a docs note', '--preset', 'safe'],
      {
        cwd: process.cwd(),
        env,
        encoding: 'utf-8',
        shell: true,
        timeout: 60000,
      }
    );

    const status = result.status ?? 1;
    const stderr = result.stderr || '';
    assert.strictEqual(status, 0, `Expected exit 0, got: ${stderr}`);
    assert(stderr.includes('ONE_CLICK_DONE'), `Expected ONE_CLICK_DONE in: ${stderr}`);
  });

  test('JSON mission mode still works', () => {
    const result = runCli(['autopilot-one-click', 'configs/mission.example.json']);
    assert.strictEqual(result.status, 0, `Expected exit 0, got: ${result.stderr}`);
    assert(result.stderr.includes('ONE_CLICK_DONE'), `Expected ONE_CLICK_DONE: ${result.stderr}`);
  });

  test('real-pr preset requires provider token', () => {
    const result = runCli([
      'autopilot-one-click',
      'Implement feature',
      '--preset',
      'real-pr',
      '--mode',
      'github',
      '--repo-slug',
      'owner/repo',
      '--yes',
    ]);
    assert.notStrictEqual(result.status, 0);
    assert(
      result.stderr.includes('ONE_CLICK_NEEDS_TOKEN') || result.stderr.includes('Error'),
      `Expected token error: ${result.stderr}`
    );
  });

  test('forbidden actions are not called in source', () => {
    const sourcePath = join(process.cwd(), 'src', 'autopilot-one-click', 'runner.ts');
    const source = readFileSync(sourcePath, 'utf-8');
    assert(!source.includes('merge'), 'Source must not mention merge');
    assert(!source.includes('force_push'), 'Source must not mention force_push');
    assert(!source.includes('rerun'), 'Source must not mention rerun');
    assert(!source.includes('delete_branch'), 'Source must not mention delete_branch');
  });
});
