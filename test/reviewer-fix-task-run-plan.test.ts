import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  deriveReviewerFixTaskRunPlan,
  type ReviewerFixTaskRunPlanInput,
} from '../src/reviewer-fix-task-run-plan.js';
import type {
  PendingReviewerFixTaskExecutionRequestStateReady,
  PendingReviewerFixTaskExecutionRequestStateInvalid,
  PendingReviewerFixTaskExecutionRequestStateNotPresent,
} from '../src/reviewer-pending-fix-task-execution-request-state.js';
import type { ReviewerFixTaskExecutionRequest } from '../src/reviewer-pending-fix-task-execution-request.js';

const PARENT_TASK_ID = 'demo-task';
const ATTEMPT = 1;
const TASK_ID = `fix-${PARENT_TASK_ID}-reviewer-${ATTEMPT}`;
const TITLE = 'Fix review issue';
const GOAL = 'Address reviewer feedback';
const BLOCKING_ISSUES = ['line too long', 'missing tests'];

function buildExecutionRequest(): ReviewerFixTaskExecutionRequest {
  return {
    kind: 'reviewer_fix_task',
    status: 'pending',
    source: 'reviewer_gate',
    taskId: TASK_ID,
    parentTaskId: PARENT_TASK_ID,
    attempt: ATTEMPT,
    title: TITLE,
    goal: GOAL,
    blockingIssues: [...BLOCKING_ISSUES],
    task: {
      taskId: TASK_ID,
      parentTaskId: PARENT_TASK_ID,
      attempt: ATTEMPT,
      title: TITLE,
      goal: GOAL,
      source: 'reviewer_gate',
      blockingIssues: [...BLOCKING_ISSUES],
    },
  };
}

function buildReadyState(): PendingReviewerFixTaskExecutionRequestStateReady {
  const executionRequest = buildExecutionRequest();
  return {
    status: 'ready',
    reason: 'Pending reviewer fix task execution request is valid and ready.',
    executionRequestResult: {
      action: 'create_execution_request',
      reason: 'Ready for future execution.',
      executionRequest,
      blockingIssues: [],
    } as PendingReviewerFixTaskExecutionRequestStateReady['executionRequestResult'],
    executionRequest,
    blockingIssues: [],
  };
}

function buildInvalidState(): PendingReviewerFixTaskExecutionRequestStateInvalid {
  return {
    status: 'invalid',
    reason: 'Invalid state.',
    blockingIssues: ['taskId is missing'],
  };
}

function buildNotPresentState(): PendingReviewerFixTaskExecutionRequestStateNotPresent {
  return {
    status: 'not_present',
    reason: 'No pending request.',
    blockingIssues: [],
  };
}

describe('deriveReviewerFixTaskRunPlan', () => {
  it('not_present maps to no_op', () => {
    const result = deriveReviewerFixTaskRunPlan({
      executionRequestState: buildNotPresentState(),
    });
    assert.strictEqual(result.action, 'no_op');
  });

  it('not_present has no executionRequest', () => {
    const result = deriveReviewerFixTaskRunPlan({
      executionRequestState: buildNotPresentState(),
    });
    assert.strictEqual(result.executionRequest, undefined);
  });

  it('not_present has no fixTask', () => {
    const result = deriveReviewerFixTaskRunPlan({
      executionRequestState: buildNotPresentState(),
    });
    assert.strictEqual(result.fixTask, undefined);
  });

  it('invalid maps to block_for_human', () => {
    const result = deriveReviewerFixTaskRunPlan({
      executionRequestState: buildInvalidState(),
    });
    assert.strictEqual(result.action, 'block_for_human');
  });

  it('invalid preserves blockingIssues', () => {
    const result = deriveReviewerFixTaskRunPlan({
      executionRequestState: buildInvalidState(),
    });
    assert.deepStrictEqual(result.blockingIssues, ['taskId is missing']);
  });

  it('ready maps to run_fix_task', () => {
    const result = deriveReviewerFixTaskRunPlan({
      executionRequestState: buildReadyState(),
    });
    assert.strictEqual(result.action, 'run_fix_task');
  });

  it('ready preserves executionRequest.kind/status/source', () => {
    const result = deriveReviewerFixTaskRunPlan({
      executionRequestState: buildReadyState(),
    });
    assert.strictEqual(result.executionRequest?.kind, 'reviewer_fix_task');
    assert.strictEqual(result.executionRequest?.status, 'pending');
    assert.strictEqual(result.executionRequest?.source, 'reviewer_gate');
  });

  it('ready preserves taskId', () => {
    const result = deriveReviewerFixTaskRunPlan({
      executionRequestState: buildReadyState(),
    });
    assert.strictEqual(result.taskId, TASK_ID);
  });

  it('ready preserves parentTaskId', () => {
    const result = deriveReviewerFixTaskRunPlan({
      executionRequestState: buildReadyState(),
    });
    assert.strictEqual(result.parentTaskId, PARENT_TASK_ID);
  });

  it('ready preserves attempt', () => {
    const result = deriveReviewerFixTaskRunPlan({
      executionRequestState: buildReadyState(),
    });
    assert.strictEqual(result.attempt, ATTEMPT);
  });

  it('ready preserves title', () => {
    const result = deriveReviewerFixTaskRunPlan({
      executionRequestState: buildReadyState(),
    });
    assert.strictEqual(result.title, TITLE);
  });

  it('ready preserves goal', () => {
    const result = deriveReviewerFixTaskRunPlan({
      executionRequestState: buildReadyState(),
    });
    assert.strictEqual(result.goal, GOAL);
  });

  it('ready preserves blockingIssues', () => {
    const result = deriveReviewerFixTaskRunPlan({
      executionRequestState: buildReadyState(),
    });
    assert.deepStrictEqual(result.blockingIssues, BLOCKING_ISSUES);
  });

  it('ready preserves fixTask taskId', () => {
    const result = deriveReviewerFixTaskRunPlan({
      executionRequestState: buildReadyState(),
    });
    assert.strictEqual(result.fixTask?.taskId, TASK_ID);
  });

  it('ready preserves fixTask title', () => {
    const result = deriveReviewerFixTaskRunPlan({
      executionRequestState: buildReadyState(),
    });
    assert.strictEqual(result.fixTask?.title, TITLE);
  });

  it('ready preserves fixTask goal', () => {
    const result = deriveReviewerFixTaskRunPlan({
      executionRequestState: buildReadyState(),
    });
    assert.strictEqual(result.fixTask?.goal, GOAL);
  });

  it('returned executionRequest is cloned', () => {
    const state = buildReadyState();
    const result = deriveReviewerFixTaskRunPlan({
      executionRequestState: state,
    });
    assert.notStrictEqual(result.executionRequest, state.executionRequest);
    state.executionRequest.goal = 'mutated';
    assert.strictEqual(result.executionRequest?.goal, GOAL);
  });

  it('returned fixTask is cloned', () => {
    const state = buildReadyState();
    const result = deriveReviewerFixTaskRunPlan({
      executionRequestState: state,
    });
    assert.notStrictEqual(result.fixTask, state.executionRequest.task);
    state.executionRequest.task.goal = 'mutated';
    assert.strictEqual(result.fixTask?.goal, GOAL);
  });

  it('returned blockingIssues are cloned', () => {
    const state = buildReadyState();
    state.executionRequest.blockingIssues = [...BLOCKING_ISSUES];
    const result = deriveReviewerFixTaskRunPlan({
      executionRequestState: state,
    });
    assert.notStrictEqual(
      result.blockingIssues,
      state.executionRequest.blockingIssues
    );
    state.executionRequest.blockingIssues.push('mutated');
    assert.deepStrictEqual(result.blockingIssues, BLOCKING_ISSUES);
  });

  it('helper does not mutate input', () => {
    const state = buildReadyState();
    const before = JSON.stringify(state);
    deriveReviewerFixTaskRunPlan({ executionRequestState: state });
    const after = JSON.stringify(state);
    assert.strictEqual(after, before);
  });

  it('helper does not perform redaction or alter already-redacted text', () => {
    const state = buildReadyState();
    state.executionRequest.goal = 'Use sk-fake-reviewer-secret token';
    state.executionRequest.task.goal = 'Use sk-fake-reviewer-secret token';
    const result = deriveReviewerFixTaskRunPlan({
      executionRequestState: state,
    });
    assert.strictEqual(result.goal, 'Use sk-fake-reviewer-secret token');
    assert.strictEqual(
      result.fixTask?.goal,
      'Use sk-fake-reviewer-secret token'
    );
  });

  it('helper does not call git/provider/network/filesystem APIs', () => {
    const result = deriveReviewerFixTaskRunPlan({
      executionRequestState: buildReadyState(),
    });
    assert.strictEqual(result.action, 'run_fix_task');
  });
});
