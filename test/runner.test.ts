import { describe, test } from 'node:test';
import assert from 'node:assert';
import { runChecks } from '../src/runner.js';
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
    let secondRan = false;
    const result = runChecks(process.cwd(), [
      { command: 'node', args: ['-e', 'process.exit(1)'] },
      { command: 'node', args: ['-e', 'secondRan = true'] },
    ]);
    assert.strictEqual(result.success, false);
    assert.strictEqual(secondRan, false);
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
      assert(result.logs.includes('all clean'));
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
});
