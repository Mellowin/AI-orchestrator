import { describe, test } from 'node:test';
import assert from 'node:assert';
import {
  buildRealRepoApplyDryRunSummary,
  type RealRepoDryRunInput,
} from '../src/real-repo-apply-dry-run.js';

function validInput(): RealRepoDryRunInput {
  return {
    taskId: 'task-1',
    currentBranch: 'ai/task-1',
    workBranch: 'ai/task-1',
    guardrailsVerdict: 'PASS',
    safetyVerdict: 'PASS',
    files: [
      { path: 'src/index.ts', lineDelta: 5, isNew: false },
      { path: 'README.md', lineDelta: -2, isNew: false },
    ],
  };
}

describe('buildRealRepoApplyDryRunSummary', () => {
  test('builds summary for valid dry-run input', () => {
    const result = buildRealRepoApplyDryRunSummary(validInput());
    assert.strictEqual(result.taskId, 'task-1');
    assert.strictEqual(result.currentBranch, 'ai/task-1');
    assert.strictEqual(result.workBranch, 'ai/task-1');
    assert.strictEqual(result.guardrailsVerdict, 'PASS');
    assert.strictEqual(result.safetyVerdict, 'PASS');
    assert.strictEqual(result.files.length, 2);
  });

  test('preserves file order', () => {
    const input = validInput();
    input.files = [
      { path: 'z-last.ts', lineDelta: 1, isNew: false },
      { path: 'a-first.ts', lineDelta: 2, isNew: true },
    ];
    const result = buildRealRepoApplyDryRunSummary(input);
    assert.strictEqual(result.files[0].path, 'z-last.ts');
    assert.strictEqual(result.files[1].path, 'a-first.ts');
  });

  test('trims taskId/currentBranch/workBranch/file paths', () => {
    const input = validInput();
    input.taskId = '  task-1  ';
    input.currentBranch = '  ai/task-1  ';
    input.workBranch = '  ai/task-1  ';
    input.files = [{ path: '  src/index.ts  ', lineDelta: 0, isNew: false }];
    const result = buildRealRepoApplyDryRunSummary(input);
    assert.strictEqual(result.taskId, 'task-1');
    assert.strictEqual(result.currentBranch, 'ai/task-1');
    assert.strictEqual(result.workBranch, 'ai/task-1');
    assert.strictEqual(result.files[0].path, 'src/index.ts');
  });

  test('includes all safety messages', () => {
    const result = buildRealRepoApplyDryRunSummary(validInput());
    assert(result.safetyMessages.includes('No files were modified'));
    assert(result.safetyMessages.includes('No commit was made'));
    assert(result.safetyMessages.includes('No push was performed'));
    assert(result.safetyMessages.includes('No merge was performed'));
    assert(result.safetyMessages.includes('Real repo apply is dry-run only'));
  });

  test('rejects empty taskId', () => {
    const input = validInput();
    input.taskId = '';
    assert.throws(
      () => buildRealRepoApplyDryRunSummary(input),
      /taskId/
    );
  });

  test('rejects empty currentBranch', () => {
    const input = validInput();
    input.currentBranch = '';
    assert.throws(
      () => buildRealRepoApplyDryRunSummary(input),
      /currentBranch/
    );
  });

  test('rejects empty workBranch', () => {
    const input = validInput();
    input.workBranch = '';
    assert.throws(
      () => buildRealRepoApplyDryRunSummary(input),
      /workBranch/
    );
  });

  test('rejects empty file path', () => {
    const input = validInput();
    input.files = [{ path: '', lineDelta: 0, isNew: false }];
    assert.throws(
      () => buildRealRepoApplyDryRunSummary(input),
      /empty path/
    );
  });

  test('rejects duplicate file paths after trimming', () => {
    const input = validInput();
    input.files = [
      { path: 'src/index.ts', lineDelta: 1, isNew: false },
      { path: '  src/index.ts  ', lineDelta: 2, isNew: false },
    ];
    assert.throws(
      () => buildRealRepoApplyDryRunSummary(input),
      /Duplicate/
    );
  });

  test('rejects non-finite lineDelta', () => {
    const input = validInput();
    input.files = [{ path: 'a.ts', lineDelta: NaN, isNew: false }];
    assert.throws(
      () => buildRealRepoApplyDryRunSummary(input),
      /non-finite/
    );
  });

  test('rejects non-finite lineDelta (Infinity)', () => {
    const input = validInput();
    input.files = [{ path: 'a.ts', lineDelta: Infinity, isNew: false }];
    assert.throws(
      () => buildRealRepoApplyDryRunSummary(input),
      /non-finite/
    );
  });

  test('does not mutate input objects', () => {
    const input = validInput();
    const before = JSON.stringify(input);
    buildRealRepoApplyDryRunSummary(input);
    assert.strictEqual(JSON.stringify(input), before);
  });

  test('works with empty files array', () => {
    const input = validInput();
    input.files = [];
    const result = buildRealRepoApplyDryRunSummary(input);
    assert.strictEqual(result.files.length, 0);
    assert.strictEqual(result.taskId, 'task-1');
  });

  test('keeps PASS/REJECTED verdicts unchanged', () => {
    const input = validInput();
    input.guardrailsVerdict = 'REJECTED';
    input.safetyVerdict = 'REJECTED';
    const result = buildRealRepoApplyDryRunSummary(input);
    assert.strictEqual(result.guardrailsVerdict, 'REJECTED');
    assert.strictEqual(result.safetyVerdict, 'REJECTED');
  });
});
