import { describe, test } from 'node:test';
import assert from 'node:assert';
import { buildReviewInput } from '../src/reviewer/review-input-builder.js';

describe('review-input-builder', () => {
  function makeInput(overrides: Record<string, unknown> = {}) {
    return {
      blockId: undefined,
      taskId: 'todo-1',
      taskTitle: 'Test Task',
      taskGoal: 'Do something',
      allowedFiles: ['src/test.ts'],
      deniedFiles: ['.env'],
      maxLinesChanged: 100,
      commitSha: 'a'.repeat(40),
      changedFiles: ['src/test.ts'],
      diff: '+line\n',
      typecheckResult: 'pass',
      buildResult: 'pass',
      testResult: 'pass',
      gitStatus: '',
      safetyFindings: [],
      ...overrides,
    };
  }

  test('builds valid ReviewInput', () => {
    const input = makeInput();
    const result = buildReviewInput(input);
    assert.strictEqual(result.task_id, 'todo-1');
    assert.strictEqual(result.task_title, 'Test Task');
    assert.strictEqual(result.task_goal, 'Do something');
    assert.strictEqual(result.commit_sha, 'a'.repeat(40));
    assert.deepStrictEqual(result.allowed_files, ['src/test.ts']);
    assert.deepStrictEqual(result.changed_files, ['src/test.ts']);
    assert.strictEqual(result.diff, '+line\n');
  });

  test('trims taskId/title/goal', () => {
    const input = makeInput({
      taskId: '  task-1  ',
      taskTitle: '  Test Task  ',
      taskGoal: '  Do something  ',
    });
    const result = buildReviewInput(input);
    assert.strictEqual(result.task_id, 'task-1');
    assert.strictEqual(result.task_title, 'Test Task');
    assert.strictEqual(result.task_goal, 'Do something');
  });

  test('preserves diff', () => {
    const diff = '+line1\n+line2\n-line3\n';
    const input = makeInput({ diff });
    const result = buildReviewInput(input);
    assert.strictEqual(result.diff, diff);
  });

  test('rejects missing taskId', () => {
    assert.throws(() => buildReviewInput(makeInput({ taskId: '' })), /taskId/);
    assert.throws(() => buildReviewInput(makeInput({ taskId: undefined })), /taskId/);
  });

  test('rejects missing goal', () => {
    assert.throws(() => buildReviewInput(makeInput({ taskGoal: '' })), /taskGoal/);
  });

  test('rejects invalid commit SHA', () => {
    assert.throws(() => buildReviewInput(makeInput({ commitSha: 'short' })), /commitSha/);
  });

  test('rejects non-array changedFiles', () => {
    assert.throws(() => buildReviewInput(makeInput({ changedFiles: 'bad' })), /changedFiles/);
  });

  test('rejects non-array allowedFiles', () => {
    assert.throws(() => buildReviewInput(makeInput({ allowedFiles: 'bad' })), /allowedFiles/);
  });

  test('rejects non-array deniedFiles', () => {
    assert.throws(() => buildReviewInput(makeInput({ deniedFiles: 'bad' })), /deniedFiles/);
  });

  test('rejects non-array safetyFindings', () => {
    assert.throws(() => buildReviewInput(makeInput({ safetyFindings: 'bad' })), /safetyFindings/);
  });

  test('includes acceptance_criteria when provided', () => {
    const input = makeInput({ acceptanceCriteria: ['criterion one', 'criterion two'] });
    const result = buildReviewInput(input);
    assert.deepStrictEqual(result.acceptance_criteria, ['criterion one', 'criterion two']);
  });

  test('omits acceptance_criteria when not provided', () => {
    const input = makeInput();
    const result = buildReviewInput(input);
    assert.strictEqual(result.acceptance_criteria, undefined);
  });

  test('rejects non-array acceptanceCriteria', () => {
    assert.throws(() => buildReviewInput(makeInput({ acceptanceCriteria: 'bad' })), /acceptanceCriteria/);
  });

  test('trims acceptance_criteria entries', () => {
    const input = makeInput({ acceptanceCriteria: ['  criterion  '] });
    const result = buildReviewInput(input);
    assert.deepStrictEqual(result.acceptance_criteria, ['criterion']);
  });

  test('does not include provider raw output', () => {
    const result = buildReviewInput(makeInput());
    assert(!('provider_raw_output' in result));
  });

  test('does not include API keys', () => {
    const input = makeInput();
    const result = buildReviewInput(input);
    const json = JSON.stringify(result);
    assert(!json.includes('sk-'));
    assert(!json.includes('Bearer'));
  });
});
