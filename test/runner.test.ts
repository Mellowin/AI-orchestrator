import { describe, test } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, existsSync, rmSync, mkdirSync, writeFileSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runChecks, parseShellCheckString } from '../src/runner.js';
import type { Check } from '../src/types.js';

const secrets = [
  'TASKS_FILE',
  'AI_PROVIDER',
  'MOCK_AI_RESPONSE',
  'KIMI_API_KEY',
  'KIMI_MODEL',
  'KIMI_BASE_URL',
  'KIMI_USER_AGENT',
  'OPENAI_API_KEY',
  'MOCK_AI',
];

function withSecrets<T>(fn: () => T): T {
  const originals = new Map<string, string | undefined>();
  for (const key of secrets) {
    originals.set(key, process.env[key]);
    process.env[key] = `secret-${key}`;
  }
  try {
    return fn();
  } finally {
    for (const [key, value] of originals) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

describe('runner', () => {
  test('runChecks returns success=true when all checks exit 0', () => {
    const result = runChecks(process.cwd(), [
      { command: 'node', args: ['-e', 'process.exit(0)'] },
      { command: 'node', args: ['-e', 'process.exit(0)'] },
    ]);
    assert.strictEqual(result.success, true);
  });

  test('runChecks returns success=false when a check exits non-zero', () => {
    const result = runChecks(process.cwd(), [
      { command: 'node', args: ['-e', 'process.exit(1)'] },
    ]);
    assert.strictEqual(result.success, false);
  });

  test('runChecks stops after the first failed check', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'runner-stop-'));
    const markerFile = join(tmpDir, 'second-ran.txt');
    try {
      const result = runChecks(process.cwd(), [
        { command: 'node', args: ['-e', 'process.exit(1)'] },
        { command: 'node', args: ['-e', `require('fs').writeFileSync('${markerFile.replace(/\\/g, '\\\\')}', 'x', 'utf-8')`] },
      ]);
      assert.strictEqual(result.success, false);
      assert.strictEqual(existsSync(markerFile), false, 'Second check should not have run');
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('runChecks includes stdout in logs', () => {
    const result = runChecks(process.cwd(), [
      { command: 'node', args: ['-e', 'console.log("hello stdout")'] },
    ]);
    assert.strictEqual(result.success, true);
    assert(result.logs.includes('hello stdout'));
  });

  test('runChecks includes stderr in logs', () => {
    const result = runChecks(process.cwd(), [
      { command: 'node', args: ['-e', 'console.error("hello stderr")'] },
    ]);
    assert.strictEqual(result.success, true);
    assert(result.logs.includes('hello stderr'));
  });

  test('runChecks returns failedStep for failed check', () => {
    const check: Check = { command: 'node', args: ['-e', 'process.exit(1)'] };
    const result = runChecks(process.cwd(), [check]);
    assert.strictEqual(result.success, false);
    assert.deepStrictEqual(result.failedStep, check);
  });

  test('runChecks returns failure for empty command', () => {
    const result = runChecks(process.cwd(), [
      { command: '', args: [] },
    ]);
    assert.strictEqual(result.success, false);
  });

  test('runChecks returns failure for command containing /', () => {
    const result = runChecks(process.cwd(), [
      { command: 'path/to/cmd', args: [] },
    ]);
    assert.strictEqual(result.success, false);
  });

  test('runChecks returns failure for command containing \\', () => {
    const result = runChecks(process.cwd(), [
      { command: 'path\\to\\cmd', args: [] },
    ]);
    assert.strictEqual(result.success, false);
  });

  test('runChecks returns failure for invalid args', () => {
    const result = runChecks(process.cwd(), [
      { command: 'node', args: [123 as unknown as string] },
    ]);
    assert.strictEqual(result.success, false);
  });

  test('runChecks returns failure for non-array args', () => {
    const result = runChecks(process.cwd(), [
      { command: 'node', args: 'not-an-array' as unknown as string[] },
    ]);
    assert.strictEqual(result.success, false);
  });

  test('runChecks removes secret env variables before running child process', () => {
    withSecrets(() => {
      const script = `
        const secrets = ${JSON.stringify(secrets)};
        for (const key of secrets) {
          if (process.env[key]) {
            console.error('LEAK:' + key);
            process.exit(1);
          }
        }
        console.log('all clean');
      `;
      const result = runChecks(process.cwd(), [
        { command: 'node', args: ['-e', script] },
      ]);
      assert.strictEqual(result.success, true, `Secrets leaked, logs: ${result.logs}`);
    });
  });

  test('runChecks keeps harmless environment variables available', () => {
    const original = process.env.RUNNER_HARMLESS_VAR;
    process.env.RUNNER_HARMLESS_VAR = 'present';
    try {
      const result = runChecks(process.cwd(), [
        {
          command: 'node',
          args: ['-e', 'if (process.env.RUNNER_HARMLESS_VAR !== "present") process.exit(1); console.log("harmless ok");'],
        },
      ]);
      assert.strictEqual(result.success, true, `Harmless var missing, logs: ${result.logs}`);
      assert(result.logs.includes('harmless ok'));
    } finally {
      if (original === undefined) {
        delete process.env.RUNNER_HARMLESS_VAR;
      } else {
        process.env.RUNNER_HARMLESS_VAR = original;
      }
    }
  });

  test('runChecks does not leak TASKS_FILE to child process', () => {
    const original = process.env.TASKS_FILE;
    process.env.TASKS_FILE = 'tmp/smoke-tasks.yaml';
    try {
      const result = runChecks(process.cwd(), [
        {
          command: 'node',
          args: ['-e', 'if (process.env.TASKS_FILE) { console.error("TASKS_FILE leaked"); process.exit(1); } console.log("TASKS_FILE clean");'],
        },
      ]);
      assert.strictEqual(result.success, true, `Expected success, got logs: ${result.logs}`);
      assert(result.logs.includes('TASKS_FILE clean'));
      assert(!result.logs.includes('TASKS_FILE leaked'));
    } finally {
      if (original === undefined) {
        delete process.env.TASKS_FILE;
      } else {
        process.env.TASKS_FILE = original;
      }
    }
  });

  test('runChecks runs a structured check with cwd', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'runner-cwd-'));
    const subDir = join(tmpDir, 'demo-repo');
    mkdirSync(subDir, { recursive: true });
    const markerFile = join(subDir, 'marker.txt');
    writeFileSync(markerFile, 'inside', 'utf-8');
    try {
      const result = runChecks(tmpDir, [
        {
          command: 'node',
          args: [
            '-e',
            'const fs=require("fs"); const data=fs.readFileSync("marker.txt","utf-8"); console.log(data);',
          ],
          cwd: 'demo-repo',
        },
      ]);
      assert.strictEqual(result.success, true, result.logs);
      assert(result.logs.includes('inside'), result.logs);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('runChecks runs npm install in a cwd subdirectory', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'runner-npm-install-'));
    const subDir = join(tmpDir, 'demo-repo');
    mkdirSync(subDir, { recursive: true });
    writeFileSync(
      join(subDir, 'package.json'),
      JSON.stringify({ name: 'demo', version: '1.0.0' }),
      'utf-8'
    );
    try {
      const result = runChecks(tmpDir, [
        { command: 'npm', args: ['install'], cwd: 'demo-repo' },
      ]);
      assert.strictEqual(result.success, true, result.logs);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('runChecks runs npm test in a cwd subdirectory', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'runner-npm-test-'));
    const subDir = join(tmpDir, 'demo-repo');
    mkdirSync(subDir, { recursive: true });
    writeFileSync(
      join(subDir, 'package.json'),
      JSON.stringify({
        name: 'demo',
        version: '1.0.0',
        scripts: {
          test: 'node -e "console.log(\'demo test ok\')"',
        },
      }),
      'utf-8'
    );
    try {
      const result = runChecks(tmpDir, [
        { command: 'npm', args: ['test'], cwd: 'demo-repo' },
      ]);
      assert.strictEqual(result.success, true, result.logs);
      assert(result.logs.includes('demo test ok'), result.logs);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('runChecks runs multiple structured checks in cwd sequentially', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'runner-seq-cwd-'));
    const subDir = join(tmpDir, 'demo-repo');
    mkdirSync(subDir, { recursive: true });
    const marker1 = join(subDir, 'first.txt');
    const marker2 = join(subDir, 'second.txt');
    try {
      const result = runChecks(tmpDir, [
        {
          command: 'node',
          args: ['-e', 'require("fs").writeFileSync("first.txt", "a", "utf-8")'],
          cwd: 'demo-repo',
        },
        {
          command: 'node',
          args: ['-e', 'require("fs").writeFileSync("second.txt", "b", "utf-8")'],
          cwd: 'demo-repo',
        },
      ]);
      assert.strictEqual(result.success, true, result.logs);
      assert.strictEqual(existsSync(marker1), true);
      assert.strictEqual(existsSync(marker2), true);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('runChecks stops after a failed structured check in cwd', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'runner-stop-cwd-'));
    const subDir = join(tmpDir, 'demo-repo');
    mkdirSync(subDir, { recursive: true });
    const markerFile = join(subDir, 'should-not-exist.txt');
    try {
      const result = runChecks(tmpDir, [
        {
          command: 'node',
          args: ['-e', 'process.exit(1)'],
          cwd: 'demo-repo',
        },
        {
          command: 'node',
          args: ['-e', 'require("fs").writeFileSync("should-not-exist.txt", "x", "utf-8")'],
          cwd: 'demo-repo',
        },
      ]);
      assert.strictEqual(result.success, false, result.logs);
      assert.strictEqual(existsSync(markerFile), false, 'Second check should not have run');
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('runChecks rejects cwd that escapes repo with ..', () => {
    const result = runChecks(process.cwd(), [
      { command: 'node', args: ['-e', 'process.exit(0)'], cwd: '../outside' },
    ]);
    assert.strictEqual(result.success, false);
    assert(
      result.logs.includes('..') || result.logs.includes('repository root'),
      `Expected rejection reason, got: ${result.logs}`
    );
  });

  test('runChecks rejects absolute cwd', () => {
    const result = runChecks(process.cwd(), [
      { command: 'node', args: ['-e', 'process.exit(0)'], cwd: '/tmp/absolute' },
    ]);
    assert.strictEqual(result.success, false);
    assert(result.logs.includes('relative'), `Expected relative path rejection, got: ${result.logs}`);
  });

  test('runChecks rejects cwd that resolves outside repo via symlink', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'runner-symlink-'));
    const repoDir = join(tmpDir, 'repo');
    const outsideDir = join(tmpDir, 'outside');
    mkdirSync(repoDir, { recursive: true });
    mkdirSync(outsideDir, { recursive: true });
    let symlinkCreated = false;
    try {
      try {
        symlinkSync(outsideDir, join(repoDir, 'link'), 'dir');
        symlinkCreated = true;
      } catch {
        // Symlinks may not be supported or permitted; skip this test.
      }
      if (!symlinkCreated) {
        return;
      }
      const result = runChecks(repoDir, [
        { command: 'node', args: ['-e', 'process.exit(0)'], cwd: 'link' },
      ]);
      assert.strictEqual(result.success, false);
      assert(result.logs.includes('symlink'), `Expected symlink rejection, got: ${result.logs}`);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('parseShellCheckString rejects shell operators in string checks before executing', () => {
    assert.throws(
      () => parseShellCheckString('node -e "process.exit(0) && touch pwned.txt"'),
      /Unsupported shell syntax/
    );
  });

  test('runChecks rejects cd command before executing', () => {
    const result = runChecks(process.cwd(), [
      { command: 'cd', args: ['demo-repo', '&&', 'npm', 'test'] },
    ]);
    assert.strictEqual(result.success, false);
    assert(result.logs.includes('cd') || result.logs.includes('shell'), result.logs);
  });

  test('parseShellCheckString rejects cd and shell operators', () => {
    assert.throws(
      () => parseShellCheckString('cd demo-repo && npm install && npm test'),
      /Unsupported shell syntax/
    );
  });

  test('parseShellCheckString accepts a simple legacy command', () => {
    const check = parseShellCheckString('npm test');
    assert.deepStrictEqual(check, { command: 'npm', args: ['test'] });
  });

  test('parseShellCheckString accepts legacy node script with || inside a single token', () => {
    const check = parseShellCheckString(
      "node -e require('fs').existsSync('marker.txt')||process.exit(1)"
    );
    assert.strictEqual(check.command, 'node');
    assert.deepStrictEqual(check.args, [
      '-e',
      "require('fs').existsSync('marker.txt')||process.exit(1)",
    ]);
  });

  test('runChecks executes a legacy node script with || inside a single token', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'runner-legacy-or-'));
    const markerFile = join(tmpDir, 'marker.txt');
    writeFileSync(markerFile, 'x', 'utf-8');
    try {
      const result = runChecks(tmpDir, [
        {
          command: 'node',
          args: ['-e', "require('fs').existsSync('marker.txt')||process.exit(1)"],
        },
      ]);
      assert.strictEqual(result.success, true, result.logs);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
