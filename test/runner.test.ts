import { describe, test } from 'node:test';
import assert from 'node:assert';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runChecks } from '../src/runner.js';

describe('runner', () => {
  test('runChecks does not leak TASKS_FILE to child process', () => {
    const repoPath = join(process.cwd(), 'tmp', `runner-test-${Date.now()}`);
    mkdirSync(repoPath, { recursive: true });

    const checkScript = join(repoPath, 'check-env.js');
    writeFileSync(
      checkScript,
      `if (process.env.TASKS_FILE) { console.error('TASKS_FILE leaked'); process.exit(1); } console.log('TASKS_FILE clean');`,
      'utf-8'
    );

    const original = process.env.TASKS_FILE;
    process.env.TASKS_FILE = 'tmp/smoke-tasks.yaml';

    try {
      const result = runChecks(repoPath, [
        { command: 'node', args: ['check-env.js'] },
      ]);

      assert.strictEqual(result.success, true, `Expected success, got logs: ${result.logs}`);
      assert(result.logs.includes('TASKS_FILE clean'), `Expected clean message, got logs: ${result.logs}`);
      assert(!result.logs.includes('TASKS_FILE leaked'), `Must NOT leak TASKS_FILE, got logs: ${result.logs}`);
    } finally {
      if (original === undefined) {
        delete process.env.TASKS_FILE;
      } else {
        process.env.TASKS_FILE = original;
      }
      rmSync(repoPath, { recursive: true, force: true });
    }
  });
});
