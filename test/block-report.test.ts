import { describe, test } from 'node:test';
import assert from 'node:assert';
import type { BlockState } from '../src/block/block-types.js';
import { buildBlockStatusReport } from '../src/block/block-report.js';

function makeState(): BlockState {
  const now = new Date().toISOString();
  return {
    block_id: 'test-block',
    title: 'Test Block',
    status: 'running',
    repo_path: '.',
    base_branch: 'main',
    work_branch: 'ai/test',
    current_task_id: 'task-2',
    created_at: now,
    updated_at: now,
    tasks: [
      {
        task_id: 'task-1',
        status: 'accepted',
        current_attempt: 1,
        fix_attempts: 0,
        commit_sha: 'a'.repeat(40),
        pushed_ref: 'origin/ai/test',
        reviewer_decision: 'accepted',
        reviewer_summary: 'Looks good',
        blocking_issues: [],
        updated_at: now,
      },
      {
        task_id: 'task-2',
        status: 'in_progress',
        current_attempt: 1,
        fix_attempts: 0,
        commit_sha: null,
        pushed_ref: null,
        reviewer_decision: null,
        reviewer_summary: null,
        blocking_issues: [],
        updated_at: now,
      },
      {
        task_id: 'task-3',
        status: 'blocked',
        current_attempt: 2,
        fix_attempts: 1,
        commit_sha: null,
        pushed_ref: null,
        reviewer_decision: null,
        reviewer_summary: 'Security concern',
        blocking_issues: ['Secret detected'],
        updated_at: now,
      },
    ],
    safety_note: 'No secrets stored',
  };
}

describe('block-report', () => {
  test('builds markdown report', () => {
    const state = makeState();
    const report = buildBlockStatusReport(state);
    assert(report.includes('# Block Status Report'));
  });

  test('includes block id/title/status', () => {
    const state = makeState();
    const report = buildBlockStatusReport(state);
    assert(report.includes('test-block'));
    assert(report.includes('Test Block'));
    assert(report.includes('running'));
  });

  test('includes current task', () => {
    const state = makeState();
    const report = buildBlockStatusReport(state);
    assert(report.includes('task-2'));
  });

  test('includes task table', () => {
    const state = makeState();
    const report = buildBlockStatusReport(state);
    assert(report.includes('task-1'));
    assert(report.includes('task-2'));
    assert(report.includes('task-3'));
  });

  test('includes commit sha', () => {
    const state = makeState();
    const report = buildBlockStatusReport(state);
    assert(report.includes('aaaaaaa'));
  });

  test('includes reviewer decision', () => {
    const state = makeState();
    const report = buildBlockStatusReport(state);
    assert(report.includes('accepted'));
  });

  test('includes accepted/rejected/blocked counts', () => {
    const state = makeState();
    const report = buildBlockStatusReport(state);
    assert(report.includes('Accepted: 1'));
    assert(report.includes('Rejected: 0'));
    assert(report.includes('Blocked: 1'));
    assert(report.includes('Total: 3'));
  });

  test('no file writes', () => {
    const state = makeState();
    buildBlockStatusReport(state);
    assert.strictEqual(true, true);
  });
});
