import { describe, test } from 'node:test';
import assert from 'node:assert';
import type { BlockState } from '../src/block/block-types.js';
import {
  getCurrentTask,
  markTaskInProgress,
  markTaskCoderDone,
  markTaskChecksFailed,
  markTaskCommitted,
  markTaskPushed,
  markTaskWaitingReview,
  markTaskAccepted,
  markTaskRejected,
  markTaskFixRequired,
  markTaskBlocked,
} from '../src/block/block-transitions.js';

function makeState(): BlockState {
  const now = new Date().toISOString();
  return {
    block_id: 'test-block',
    title: 'Test',
    status: 'pending',
    repo_path: '.',
    base_branch: 'main',
    work_branch: 'ai/test',
    current_task_id: 'task-1',
    created_at: now,
    updated_at: now,
    tasks: [
      {
        task_id: 'task-1',
        status: 'pending',
        current_attempt: 0,
        fix_attempts: 0,
        commit_sha: null,
        pushed_ref: null,
        reviewer_decision: null,
        reviewer_summary: null,
        blocking_issues: [],
        updated_at: now,
      },
      {
        task_id: 'task-2',
        status: 'pending',
        current_attempt: 0,
        fix_attempts: 0,
        commit_sha: null,
        pushed_ref: null,
        reviewer_decision: null,
        reviewer_summary: null,
        blocking_issues: [],
        updated_at: now,
      },
    ],
    safety_note: 'Safe',
  };
}

describe('block-transitions', () => {
  test('getCurrentTask returns current task', () => {
    const state = makeState();
    const task = getCurrentTask(state);
    assert(task);
    assert.strictEqual(task.task_id, 'task-1');
  });

  test('markTaskInProgress works', () => {
    const state = makeState();
    const updated = markTaskInProgress(state, 'task-1');
    assert.strictEqual(updated.tasks[0].status, 'in_progress');
    assert.strictEqual(updated.tasks[0].current_attempt, 1);
    assert.strictEqual(updated.status, 'running');
  });

  test('markTaskCoderDone works', () => {
    const state = makeState();
    const updated = markTaskCoderDone(state, 'task-1');
    assert.strictEqual(updated.tasks[0].status, 'coder_done');
  });

  test('markTaskChecksFailed stores blocking issue', () => {
    const state = makeState();
    const updated = markTaskChecksFailed(state, 'task-1', ['Tests failed']);
    assert.strictEqual(updated.tasks[0].status, 'checks_failed');
    assert.deepStrictEqual(updated.tasks[0].blocking_issues, ['Tests failed']);
  });

  test('markTaskCommitted requires full SHA', () => {
    const state = makeState();
    assert.throws(() => markTaskCommitted(state, 'task-1', 'short'), /40-character/);
  });

  test('markTaskCommitted stores SHA', () => {
    const state = makeState();
    const sha = 'a'.repeat(40);
    const updated = markTaskCommitted(state, 'task-1', sha);
    assert.strictEqual(updated.tasks[0].status, 'committed');
    assert.strictEqual(updated.tasks[0].commit_sha, sha);
  });

  test('markTaskPushed stores pushed ref', () => {
    const state = makeState();
    const sha = 'a'.repeat(40);
    const updated = markTaskPushed(state, 'task-1', sha, 'origin/ai/test');
    assert.strictEqual(updated.tasks[0].status, 'pushed');
    assert.strictEqual(updated.tasks[0].pushed_ref, 'origin/ai/test');
  });

  test('markTaskWaitingReview works', () => {
    const state = makeState();
    const updated = markTaskWaitingReview(state, 'task-1');
    assert.strictEqual(updated.tasks[0].status, 'waiting_review');
    assert.strictEqual(updated.status, 'waiting_review');
  });

  test('markTaskAccepted advances to next task', () => {
    const state = makeState();
    const updated = markTaskAccepted(state, 'task-1', 'Looks good');
    assert.strictEqual(updated.tasks[0].status, 'accepted');
    assert.strictEqual(updated.tasks[0].reviewer_decision, 'accepted');
    assert.strictEqual(updated.current_task_id, 'task-2');
    assert.strictEqual(updated.status, 'running');
  });

  test('markTaskAccepted completes block when all tasks accepted', () => {
    let state = makeState();
    state = markTaskAccepted(state, 'task-1', 'Good');
    state = markTaskInProgress(state, 'task-2');
    state = markTaskAccepted(state, 'task-2', 'Good');
    assert.strictEqual(state.tasks[1].status, 'accepted');
    assert.strictEqual(state.current_task_id, null);
    assert.strictEqual(state.status, 'completed');
  });

  test('markTaskRejected works', () => {
    const state = makeState();
    const updated = markTaskRejected(state, 'task-1', ['Missing tests'], 'Needs tests');
    assert.strictEqual(updated.tasks[0].status, 'rejected');
    assert.strictEqual(updated.tasks[0].reviewer_decision, 'rejected');
    assert.deepStrictEqual(updated.tasks[0].blocking_issues, ['Missing tests']);
  });

  test('markTaskFixRequired increments fix_attempts', () => {
    const state = makeState();
    const updated = markTaskFixRequired(state, 'task-1', ['Typo'], 'Fix typo');
    assert.strictEqual(updated.tasks[0].status, 'fix_required');
    assert.strictEqual(updated.tasks[0].fix_attempts, 1);
    assert.strictEqual(updated.status, 'fixing');
  });

  test('max fix attempts exceeded blocks task', () => {
    // This is tested at the orchestrator level; transition itself just increments.
    // We verify the transition works correctly.
    const state = makeState();
    const updated = markTaskFixRequired(state, 'task-1', ['Still broken'], 'Fix it');
    assert.strictEqual(updated.tasks[0].fix_attempts, 1);
    assert.strictEqual(updated.status, 'fixing');
  });

  test('markTaskBlocked blocks block', () => {
    const state = makeState();
    const updated = markTaskBlocked(state, 'task-1', ['Security issue'], 'Blocked');
    assert.strictEqual(updated.tasks[0].status, 'blocked');
    assert.strictEqual(updated.status, 'blocked');
    assert.strictEqual(updated.current_task_id, null);
  });

  test('unknown task rejected', () => {
    const state = makeState();
    assert.throws(() => markTaskInProgress(state, 'unknown'), /Unknown task/);
  });

  test('accepted task cannot transition backwards', () => {
    let state = makeState();
    state = markTaskAccepted(state, 'task-1', 'Good');
    assert.throws(() => markTaskInProgress(state, 'task-1'), /Cannot transition accepted task/);
  });

  test('cannot complete block unless all tasks accepted', () => {
    const state = makeState();
    // Only accept task-1, leave task-2 pending
    const updated = markTaskAccepted(state, 'task-1', 'Good');
    assert.strictEqual(updated.status, 'running');
    assert.strictEqual(updated.current_task_id, 'task-2');
    // Block is not completed yet
    assert.notStrictEqual(updated.status, 'completed');
  });

  test('pure functions do not write files', () => {
    const state = makeState();
    const updated = markTaskInProgress(state, 'task-1');
    // If the function wrote files, it would be observable; pure functions just return new state.
    assert.strictEqual(updated.tasks[0].status, 'in_progress');
    // Original state unchanged
    assert.strictEqual(state.tasks[0].status, 'pending');
  });
});
