import { describe, test } from 'node:test';
import assert from 'node:assert';
import {
  validateRealRepoApplySafety,
} from '../src/real-repo-apply-safety.js';

function safeTask(workBranch = 'ai/test-task'): Parameters<typeof validateRealRepoApplySafety>[0] {
  return {
    work_branch: workBranch,
    guardrails: {
      auto_commit: false,
      auto_push: false,
      auto_merge: false,
    },
  };
}

function safeRepoStatus(branch = 'ai/test-task'): Parameters<typeof validateRealRepoApplySafety>[1] {
  return {
    isClean: true,
    currentBranch: branch,
  };
}

describe('validateRealRepoApplySafety', () => {
  test('returns ok true for safe non-main clean work branch', () => {
    const result = validateRealRepoApplySafety(safeTask(), safeRepoStatus());
    assert.strictEqual(result.ok, true);
  });

  test('rejects dirty working tree', () => {
    const result = validateRealRepoApplySafety(
      safeTask(),
      { isClean: false, currentBranch: 'ai/test-task' }
    );
    assert.strictEqual(result.ok, false);
    assert((result as { ok: false; reason: string }).reason.includes('not clean'));
  });

  test('rejects empty current branch', () => {
    const result = validateRealRepoApplySafety(
      safeTask(),
      { isClean: true, currentBranch: '' }
    );
    assert.strictEqual(result.ok, false);
    assert(
      (result as { ok: false; reason: string }).reason.includes('Current branch')
    );
  });

  test('rejects current branch main', () => {
    const result = validateRealRepoApplySafety(
      safeTask(),
      { isClean: true, currentBranch: 'main' }
    );
    assert.strictEqual(result.ok, false);
    assert(
      (result as { ok: false; reason: string }).reason.includes('main')
    );
  });

  test('rejects missing work_branch', () => {
    const result = validateRealRepoApplySafety(
      { guardrails: { auto_commit: false, auto_push: false, auto_merge: false } },
      safeRepoStatus()
    );
    assert.strictEqual(result.ok, false);
    assert(
      (result as { ok: false; reason: string }).reason.includes('work_branch')
    );
  });

  test('rejects empty work_branch', () => {
    const result = validateRealRepoApplySafety(
      { work_branch: '', guardrails: { auto_commit: false, auto_push: false, auto_merge: false } },
      safeRepoStatus()
    );
    assert.strictEqual(result.ok, false);
    assert(
      (result as { ok: false; reason: string }).reason.includes('work_branch')
    );
  });

  test('rejects work_branch main', () => {
    const result = validateRealRepoApplySafety(
      safeTask('main'),
      { isClean: true, currentBranch: 'ai/test-task' }
    );
    assert.strictEqual(result.ok, false);
    const reason = (result as { ok: false; reason: string }).reason;
    assert(reason.includes('work_branch'));
    assert(reason.includes('main'));
  });

  test('rejects when current branch does not equal work_branch', () => {
    const result = validateRealRepoApplySafety(
      safeTask('ai/feature-a'),
      safeRepoStatus('ai/feature-b')
    );
    assert.strictEqual(result.ok, false);
    assert(
      (result as { ok: false; reason: string }).reason.includes('does not equal')
    );
  });

  test('rejects auto_commit true', () => {
    const task = safeTask();
    task.guardrails.auto_commit = true;
    const result = validateRealRepoApplySafety(task, safeRepoStatus());
    assert.strictEqual(result.ok, false);
    assert(
      (result as { ok: false; reason: string }).reason.includes('auto_commit')
    );
  });

  test('rejects auto_push true', () => {
    const task = safeTask();
    task.guardrails.auto_push = true;
    const result = validateRealRepoApplySafety(task, safeRepoStatus());
    assert.strictEqual(result.ok, false);
    assert(
      (result as { ok: false; reason: string }).reason.includes('auto_push')
    );
  });

  test('rejects auto_merge true', () => {
    const task = safeTask();
    task.guardrails.auto_merge = true;
    const result = validateRealRepoApplySafety(task, safeRepoStatus());
    assert.strictEqual(result.ok, false);
    assert(
      (result as { ok: false; reason: string }).reason.includes('auto_merge')
    );
  });

  test('confirms helper does not mutate input objects', () => {
    const task = safeTask();
    const repoStatus = safeRepoStatus();
    const taskBefore = JSON.stringify(task);
    const repoBefore = JSON.stringify(repoStatus);

    validateRealRepoApplySafety(task, repoStatus);

    assert.strictEqual(JSON.stringify(task), taskBefore);
    assert.strictEqual(JSON.stringify(repoStatus), repoBefore);
  });

  test('confirms returned reason mentions the failed safety condition clearly', () => {
    const result = validateRealRepoApplySafety(
      safeTask(),
      { isClean: false, currentBranch: 'ai/test-task' }
    );
    assert.strictEqual(result.ok, false);
    const reason = (result as { ok: false; reason: string }).reason;
    assert(reason.length > 0);
    assert(reason.toLowerCase().includes('clean') || reason.toLowerCase().includes('dirty'));
  });
});
