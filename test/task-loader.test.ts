import { describe, test } from 'node:test';
import assert from 'node:assert';
import { parseTaskObject } from '../src/task-loader.js';
import type { Task } from '../src/types.js';

function makeValidTask(): Record<string, unknown> {
  return {
    id: 'demo-task',
    title: 'Demo Task',
    repo_path: './demo-repo',
    base_branch: 'main',
    work_branch: 'ai/demo-task',
    goal: 'Add demo feature',
    context_files: ['src/index.ts'],
    checks: [{ command: 'npm', args: ['run', 'lint'] }],
    guardrails: {
      deny_modify: ['.env'],
      auto_commit: false,
      auto_push: false,
      auto_merge: false,
    },
  };
}

describe('parseTaskObject', () => {
  test('valid full task parses correctly', () => {
    const raw = makeValidTask();
    const task = parseTaskObject(raw);
    assert.strictEqual(task.id, 'demo-task');
    assert.strictEqual(task.title, 'Demo Task');
    assert.strictEqual(task.repo_path, './demo-repo');
    assert.strictEqual(task.base_branch, 'main');
    assert.strictEqual(task.work_branch, 'ai/demo-task');
    assert.strictEqual(task.goal, 'Add demo feature');
    assert.deepStrictEqual(task.context_files, ['src/index.ts']);
    assert.strictEqual(task.checks.length, 1);
    assert.strictEqual(task.checks[0].command, 'npm');
    assert.deepStrictEqual(task.checks[0].args, ['run', 'lint']);
    assert.strictEqual(task.guardrails.deny_modify[0], '.env');
    assert.strictEqual(task.guardrails.auto_commit, false);
    assert.strictEqual(task.guardrails.auto_push, false);
    assert.strictEqual(task.guardrails.auto_merge, false);
  });

  test('missing base_branch defaults to "main"', () => {
    const raw = makeValidTask();
    delete raw.base_branch;
    const task = parseTaskObject(raw);
    assert.strictEqual(task.base_branch, 'main');
  });

  test('missing deny_modify gets safe defaults', () => {
    const raw = makeValidTask();
    delete (raw.guardrails as Record<string, unknown>).deny_modify;
    const task = parseTaskObject(raw);
    assert.deepStrictEqual(task.guardrails.deny_modify, [
      '.env',
      '.env.*',
      'node_modules/**',
      '.git/**',
    ]);
  });

  test('missing auto flags default to false', () => {
    const raw = makeValidTask();
    const g = raw.guardrails as Record<string, unknown>;
    delete g.auto_commit;
    delete g.auto_push;
    delete g.auto_merge;
    const task = parseTaskObject(raw);
    assert.strictEqual(task.guardrails.auto_commit, false);
    assert.strictEqual(task.guardrails.auto_push, false);
    assert.strictEqual(task.guardrails.auto_merge, false);
  });

  test('require_tests remains optional', () => {
    const raw = makeValidTask();
    delete (raw.guardrails as Record<string, unknown>).require_tests;
    const task = parseTaskObject(raw);
    assert.strictEqual(task.guardrails.require_tests, undefined);
  });

  test('invalid input object throws', () => {
    assert.throws(() => parseTaskObject(null), /Expected task input to be an object/);
    assert.throws(() => parseTaskObject('string'), /Expected task input to be an object/);
    assert.throws(() => parseTaskObject(42), /Expected task input to be an object/);
  });

  test('invalid checks shape throws', () => {
    const raw = makeValidTask();
    raw.checks = [{ command: 'npm' }] as unknown[];
    assert.throws(() => parseTaskObject(raw), /Expected "args" to be an array of strings/);
  });

  test('invalid context_files shape throws', () => {
    const raw = makeValidTask();
    raw.context_files = ['src/index.ts', 42] as unknown[];
    assert.throws(() => parseTaskObject(raw), /Expected "context_files" to be an array of strings/);
  });

  test('missing required field throws', () => {
    const raw = makeValidTask();
    delete raw.id;
    assert.throws(() => parseTaskObject(raw), /Expected "id" to be a string/);
  });
});
