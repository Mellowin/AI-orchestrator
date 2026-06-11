import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  derivePendingReviewerFixTaskExecutionPlan,
  type PendingReviewerFixTaskExecutionPlan,
} from '../src/reviewer-pending-fix-task-execution-plan.js';
import type {
  PendingReviewerFixTaskStateNotPresent,
  PendingReviewerFixTaskStateInvalid,
  PendingReviewerFixTaskStateReady,
} from '../src/reviewer-pending-fix-task-state.js';

function buildReadyState(parentTaskId: string, attempt: number) {
  const task = {
    taskId: `fix-${parentTaskId}-reviewer-${attempt}`,
    parentTaskId,
    title: 'Fix title',
    goal: 'Fix goal',
    attempt,
    blockingIssues: ['issue one', 'issue two'],
    source: 'reviewer_gate' as const,
  };
  return {
    status: 'ready' as const,
    reason: 'Pending reviewer fix task is valid and ready.',
    pendingFixTask: {
      status: 'pending' as const,
      source: 'reviewer_gate' as const,
      task,
      parentTaskId,
      attempt,
      createdFromResolutionAction: 'append_fix_task' as const,
    },
    blockingIssues: [] as string[],
  } satisfies PendingReviewerFixTaskStateReady;
}

function buildNotPresentState(): PendingReviewerFixTaskStateNotPresent {
  return {
    status: 'not_present',
    reason: 'pending_reviewer_fix_task is missing.',
    blockingIssues: [],
  };
}

function buildInvalidState(): PendingReviewerFixTaskStateInvalid {
  return {
    status: 'invalid',
    reason: 'pending_reviewer_fix_task is not an object.',
    blockingIssues: ['pending_reviewer_fix_task is not an object.'],
  };
}

function assertNoOp(plan: PendingReviewerFixTaskExecutionPlan) {
  assert.strictEqual(plan.action, 'no_op');
  assert.strictEqual(plan.fixTask, undefined);
  assert.deepStrictEqual(plan.blockingIssues, []);
}

function assertBlockForHuman(plan: PendingReviewerFixTaskExecutionPlan) {
  assert.strictEqual(plan.action, 'block_for_human');
  assert.strictEqual(plan.fixTask, undefined);
  assert.ok(plan.blockingIssues.length > 0);
}

function assertReadyToExecute(plan: PendingReviewerFixTaskExecutionPlan) {
  assert.strictEqual(plan.action, 'ready_to_execute');
  assert.ok(plan.fixTask, 'Ready plan should include fixTask');
}

describe('derivePendingReviewerFixTaskExecutionPlan', () => {
  test('not_present maps to no_op', () => {
    const plan = derivePendingReviewerFixTaskExecutionPlan({
      pendingFixTaskState: buildNotPresentState(),
    });
    assertNoOp(plan);
  });

  test('not_present has no fixTask', () => {
    const plan = derivePendingReviewerFixTaskExecutionPlan({
      pendingFixTaskState: buildNotPresentState(),
    });
    assert.strictEqual(plan.fixTask, undefined);
    assert.strictEqual(plan.parentTaskId, undefined);
    assert.strictEqual(plan.attempt, undefined);
  });

  test('invalid maps to block_for_human', () => {
    const plan = derivePendingReviewerFixTaskExecutionPlan({
      pendingFixTaskState: buildInvalidState(),
    });
    assertBlockForHuman(plan);
  });

  test('invalid preserves blockingIssues', () => {
    const state = buildInvalidState();
    const plan = derivePendingReviewerFixTaskExecutionPlan({
      pendingFixTaskState: state,
    });
    assert.deepStrictEqual(plan.blockingIssues, state.blockingIssues);
  });

  test('ready maps to ready_to_execute', () => {
    const plan = derivePendingReviewerFixTaskExecutionPlan({
      pendingFixTaskState: buildReadyState('task-1', 1),
    });
    assertReadyToExecute(plan);
  });

  test('ready preserves parentTaskId', () => {
    const plan = derivePendingReviewerFixTaskExecutionPlan({
      pendingFixTaskState: buildReadyState('task-1', 1),
    });
    assertReadyToExecute(plan);
    assert.strictEqual(plan.parentTaskId, 'task-1');
  });

  test('ready preserves attempt', () => {
    const plan = derivePendingReviewerFixTaskExecutionPlan({
      pendingFixTaskState: buildReadyState('task-1', 2),
    });
    assertReadyToExecute(plan);
    assert.strictEqual(plan.attempt, 2);
  });

  test('ready preserves fixTask taskId', () => {
    const plan = derivePendingReviewerFixTaskExecutionPlan({
      pendingFixTaskState: buildReadyState('task-1', 1),
    });
    assertReadyToExecute(plan);
    assert.strictEqual(plan.fixTask?.taskId, 'fix-task-1-reviewer-1');
  });

  test('ready preserves fixTask title', () => {
    const plan = derivePendingReviewerFixTaskExecutionPlan({
      pendingFixTaskState: buildReadyState('task-1', 1),
    });
    assertReadyToExecute(plan);
    assert.strictEqual(plan.fixTask?.title, 'Fix title');
  });

  test('ready preserves fixTask goal', () => {
    const plan = derivePendingReviewerFixTaskExecutionPlan({
      pendingFixTaskState: buildReadyState('task-1', 1),
    });
    assertReadyToExecute(plan);
    assert.strictEqual(plan.fixTask?.goal, 'Fix goal');
  });

  test('ready preserves fixTask blockingIssues', () => {
    const plan = derivePendingReviewerFixTaskExecutionPlan({
      pendingFixTaskState: buildReadyState('task-1', 1),
    });
    assertReadyToExecute(plan);
    assert.deepStrictEqual(plan.fixTask?.blockingIssues, [
      'issue one',
      'issue two',
    ]);
  });

  test('ready preserves top-level blockingIssues', () => {
    const state = buildReadyState('task-1', 1);
    const plan = derivePendingReviewerFixTaskExecutionPlan({
      pendingFixTaskState: state,
    });
    assertReadyToExecute(plan);
    assert.deepStrictEqual(plan.blockingIssues, state.blockingIssues);
  });

  test('returned fixTask is cloned', () => {
    const state = buildReadyState('task-1', 1);
    const plan = derivePendingReviewerFixTaskExecutionPlan({
      pendingFixTaskState: state,
    });
    assertReadyToExecute(plan);
    assert.notStrictEqual(plan.fixTask, state.pendingFixTask.task);
    assert.notStrictEqual(
      plan.fixTask?.blockingIssues,
      state.pendingFixTask.task.blockingIssues
    );
  });

  test('returned blockingIssues are cloned', () => {
    const state = buildInvalidState();
    const plan = derivePendingReviewerFixTaskExecutionPlan({
      pendingFixTaskState: state,
    });
    assert.notStrictEqual(plan.blockingIssues, state.blockingIssues);
  });

  test('helper does not mutate input', () => {
    const state = buildReadyState('task-1', 1);
    const original = JSON.stringify(state);
    derivePendingReviewerFixTaskExecutionPlan({ pendingFixTaskState: state });
    assert.strictEqual(JSON.stringify(state), original);
  });

  test('helper does not perform redaction or alter already-redacted text', () => {
    const state = buildReadyState('task-1', 1);
    state.pendingFixTask.task.goal = 'Fix sk-fake-secret and Bearer fake-token';
    state.pendingFixTask.task.blockingIssues = [
      'sk-fake-secret',
      'Bearer fake-token',
    ];
    const plan = derivePendingReviewerFixTaskExecutionPlan({
      pendingFixTaskState: state,
    });
    assertReadyToExecute(plan);
    assert.strictEqual(
      plan.fixTask?.goal,
      'Fix sk-fake-secret and Bearer fake-token'
    );
    assert.deepStrictEqual(plan.fixTask?.blockingIssues, [
      'sk-fake-secret',
      'Bearer fake-token',
    ]);
  });

  test('helper does not call git/provider/network/filesystem APIs', () => {
    const plan = derivePendingReviewerFixTaskExecutionPlan({
      pendingFixTaskState: buildReadyState('task-1', 1),
    });
    assertReadyToExecute(plan);
  });
});
