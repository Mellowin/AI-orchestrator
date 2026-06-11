import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  derivePendingReviewerFixTaskExecutionRequest,
  type PendingReviewerFixTaskExecutionRequestResult,
} from '../src/reviewer-pending-fix-task-execution-request.js';
import type { PendingReviewerFixTaskExecutionPlan } from '../src/reviewer-pending-fix-task-execution-plan.js';

function buildFixTask(parentTaskId: string, attempt: number) {
  return {
    taskId: `fix-${parentTaskId}-reviewer-${attempt}`,
    parentTaskId,
    title: 'Fix title',
    goal: 'Fix goal',
    attempt,
    blockingIssues: ['issue one', 'issue two'],
    source: 'reviewer_gate' as const,
  };
}

function buildReadyPlan(parentTaskId: string, attempt: number): PendingReviewerFixTaskExecutionPlan {
  return {
    action: 'ready_to_execute',
    reason: 'Ready.',
    fixTask: buildFixTask(parentTaskId, attempt),
    parentTaskId,
    attempt,
    blockingIssues: [],
  };
}

function buildNoOpPlan(): PendingReviewerFixTaskExecutionPlan {
  return {
    action: 'no_op',
    reason: 'No pending reviewer fix task is present.',
    blockingIssues: [],
  };
}

function buildBlockForHumanPlan(): PendingReviewerFixTaskExecutionPlan {
  return {
    action: 'block_for_human',
    reason: 'Invalid state.',
    blockingIssues: ['invalid pending state'],
  };
}

function assertNoRequest(result: PendingReviewerFixTaskExecutionRequestResult) {
  assert.strictEqual(result.action, 'no_request');
  assert.strictEqual(result.executionRequest, undefined);
  assert.deepStrictEqual(result.blockingIssues, []);
}

function assertBlockForHuman(result: PendingReviewerFixTaskExecutionRequestResult) {
  assert.strictEqual(result.action, 'block_for_human');
  assert.strictEqual(result.executionRequest, undefined);
}

function assertCreateExecutionRequest(
  result: PendingReviewerFixTaskExecutionRequestResult
) {
  assert.strictEqual(result.action, 'create_execution_request');
  assert.ok(result.executionRequest, 'Should include executionRequest');
}

describe('derivePendingReviewerFixTaskExecutionRequest', () => {
  test('no_op maps to no_request', () => {
    const result = derivePendingReviewerFixTaskExecutionRequest({
      executionPlan: buildNoOpPlan(),
    });
    assertNoRequest(result);
  });

  test('no_op has no executionRequest', () => {
    const result = derivePendingReviewerFixTaskExecutionRequest({
      executionPlan: buildNoOpPlan(),
    });
    assert.strictEqual(result.executionRequest, undefined);
    assert.strictEqual(result.blockingIssues.length, 0);
  });

  test('block_for_human maps to block_for_human', () => {
    const result = derivePendingReviewerFixTaskExecutionRequest({
      executionPlan: buildBlockForHumanPlan(),
    });
    assertBlockForHuman(result);
  });

  test('block_for_human preserves blockingIssues', () => {
    const plan = buildBlockForHumanPlan();
    const result = derivePendingReviewerFixTaskExecutionRequest({
      executionPlan: plan,
    });
    assert.deepStrictEqual(result.blockingIssues, plan.blockingIssues);
  });

  test('ready_to_execute maps to create_execution_request', () => {
    const result = derivePendingReviewerFixTaskExecutionRequest({
      executionPlan: buildReadyPlan('task-1', 1),
    });
    assertCreateExecutionRequest(result);
  });

  test('ready request has kind reviewer_fix_task', () => {
    const result = derivePendingReviewerFixTaskExecutionRequest({
      executionPlan: buildReadyPlan('task-1', 1),
    });
    assertCreateExecutionRequest(result);
    assert.strictEqual(result.executionRequest?.kind, 'reviewer_fix_task');
  });

  test('ready request has status pending', () => {
    const result = derivePendingReviewerFixTaskExecutionRequest({
      executionPlan: buildReadyPlan('task-1', 1),
    });
    assertCreateExecutionRequest(result);
    assert.strictEqual(result.executionRequest?.status, 'pending');
  });

  test('ready request has source reviewer_gate', () => {
    const result = derivePendingReviewerFixTaskExecutionRequest({
      executionPlan: buildReadyPlan('task-1', 1),
    });
    assertCreateExecutionRequest(result);
    assert.strictEqual(result.executionRequest?.source, 'reviewer_gate');
  });

  test('ready request preserves taskId', () => {
    const result = derivePendingReviewerFixTaskExecutionRequest({
      executionPlan: buildReadyPlan('task-1', 1),
    });
    assertCreateExecutionRequest(result);
    assert.strictEqual(result.executionRequest?.taskId, 'fix-task-1-reviewer-1');
  });

  test('ready request preserves parentTaskId', () => {
    const result = derivePendingReviewerFixTaskExecutionRequest({
      executionPlan: buildReadyPlan('task-1', 1),
    });
    assertCreateExecutionRequest(result);
    assert.strictEqual(result.executionRequest?.parentTaskId, 'task-1');
  });

  test('ready request preserves attempt', () => {
    const result = derivePendingReviewerFixTaskExecutionRequest({
      executionPlan: buildReadyPlan('task-1', 2),
    });
    assertCreateExecutionRequest(result);
    assert.strictEqual(result.executionRequest?.attempt, 2);
  });

  test('ready request preserves title', () => {
    const result = derivePendingReviewerFixTaskExecutionRequest({
      executionPlan: buildReadyPlan('task-1', 1),
    });
    assertCreateExecutionRequest(result);
    assert.strictEqual(result.executionRequest?.title, 'Fix title');
  });

  test('ready request preserves goal', () => {
    const result = derivePendingReviewerFixTaskExecutionRequest({
      executionPlan: buildReadyPlan('task-1', 1),
    });
    assertCreateExecutionRequest(result);
    assert.strictEqual(result.executionRequest?.goal, 'Fix goal');
  });

  test('ready request preserves fixTask blockingIssues', () => {
    const result = derivePendingReviewerFixTaskExecutionRequest({
      executionPlan: buildReadyPlan('task-1', 1),
    });
    assertCreateExecutionRequest(result);
    assert.deepStrictEqual(result.executionRequest?.blockingIssues, [
      'issue one',
      'issue two',
    ]);
  });

  test('ready result preserves top-level blockingIssues', () => {
    const plan = buildReadyPlan('task-1', 1);
    plan.blockingIssues = ['top-level issue'];
    const result = derivePendingReviewerFixTaskExecutionRequest({
      executionPlan: plan,
    });
    assertCreateExecutionRequest(result);
    assert.deepStrictEqual(result.blockingIssues, ['top-level issue']);
  });

  test('ready result clones executionRequest', () => {
    const plan = buildReadyPlan('task-1', 1);
    const result = derivePendingReviewerFixTaskExecutionRequest({
      executionPlan: plan,
    });
    assertCreateExecutionRequest(result);
    assert.notStrictEqual(result.executionRequest, plan.fixTask);
  });

  test('ready result clones nested task', () => {
    const plan = buildReadyPlan('task-1', 1);
    const result = derivePendingReviewerFixTaskExecutionRequest({
      executionPlan: plan,
    });
    assertCreateExecutionRequest(result);
    assert.notStrictEqual(
      result.executionRequest?.task,
      plan.fixTask
    );
  });

  test('ready result clones blockingIssues', () => {
    const plan = buildReadyPlan('task-1', 1);
    const result = derivePendingReviewerFixTaskExecutionRequest({
      executionPlan: plan,
    });
    assertCreateExecutionRequest(result);
    assert.notStrictEqual(
      result.executionRequest?.blockingIssues,
      plan.fixTask?.blockingIssues
    );
    assert.notStrictEqual(result.blockingIssues, plan.blockingIssues);
  });

  test('ready_to_execute missing fixTask blocks for human', () => {
    const plan = buildReadyPlan('task-1', 1);
    (plan as Record<string, unknown>).fixTask = undefined;
    const result = derivePendingReviewerFixTaskExecutionRequest({
      executionPlan: plan,
    });
    assertBlockForHuman(result);
    assert.ok(
      result.blockingIssues.some((i) => i.includes('fixTask is missing'))
    );
  });

  test('ready_to_execute missing parentTaskId blocks for human', () => {
    const plan = buildReadyPlan('task-1', 1);
    (plan as Record<string, unknown>).parentTaskId = undefined;
    const result = derivePendingReviewerFixTaskExecutionRequest({
      executionPlan: plan,
    });
    assertBlockForHuman(result);
    assert.ok(
      result.blockingIssues.some((i) => i.includes('parentTaskId is missing'))
    );
  });

  test('ready_to_execute missing attempt blocks for human', () => {
    const plan = buildReadyPlan('task-1', 1);
    (plan as Record<string, unknown>).attempt = undefined;
    const result = derivePendingReviewerFixTaskExecutionRequest({
      executionPlan: plan,
    });
    assertBlockForHuman(result);
    assert.ok(
      result.blockingIssues.some((i) => i.includes('attempt is missing'))
    );
  });

  test('helper does not mutate input', () => {
    const plan = buildReadyPlan('task-1', 1);
    const original = JSON.stringify(plan);
    derivePendingReviewerFixTaskExecutionRequest({ executionPlan: plan });
    assert.strictEqual(JSON.stringify(plan), original);
  });

  test('helper does not perform redaction or alter already-redacted text', () => {
    const plan = buildReadyPlan('task-1', 1);
    plan.fixTask.goal = 'Fix sk-fake-secret and Bearer fake-token';
    plan.fixTask.blockingIssues = ['sk-fake-secret', 'Bearer fake-token'];
    const result = derivePendingReviewerFixTaskExecutionRequest({
      executionPlan: plan,
    });
    assertCreateExecutionRequest(result);
    assert.strictEqual(
      result.executionRequest?.goal,
      'Fix sk-fake-secret and Bearer fake-token'
    );
    assert.deepStrictEqual(result.executionRequest?.blockingIssues, [
      'sk-fake-secret',
      'Bearer fake-token',
    ]);
  });

  test('helper does not call git/provider/network/filesystem APIs', () => {
    const result = derivePendingReviewerFixTaskExecutionRequest({
      executionPlan: buildReadyPlan('task-1', 1),
    });
    assertCreateExecutionRequest(result);
  });
});
