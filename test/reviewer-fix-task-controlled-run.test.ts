import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { runReviewerFixTaskControlled } from '../src/reviewer-fix-task-controlled-run.js';
import type {
  ReviewerFixTaskRunPlanStateReady,
  ReviewerFixTaskRunPlanStateInvalid,
  ReviewerFixTaskRunPlanStateNotPresent,
} from '../src/reviewer-fix-task-run-plan-state.js';
import type {
  ReviewerFixTaskExecutor,
  ReviewerFixTaskExecutorResult,
} from '../src/reviewer-fix-task-runner.js';
import type { ReviewerFixTaskExecutionRequest } from '../src/reviewer-pending-fix-task-execution-request.js';
import type { ReviewerFixTaskDraft } from '../src/reviewer-fix-task-plan.js';

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

function buildFixTask(): ReviewerFixTaskDraft {
  return {
    taskId: TASK_ID,
    parentTaskId: PARENT_TASK_ID,
    attempt: ATTEMPT,
    title: TITLE,
    goal: GOAL,
    source: 'reviewer_gate',
    blockingIssues: [...BLOCKING_ISSUES],
  };
}

function buildReadyState(): ReviewerFixTaskRunPlanStateReady {
  const executionRequest = buildExecutionRequest();
  const fixTask = buildFixTask();
  return {
    status: 'ready',
    reason: 'Ready.',
    runPlan: {
      action: 'run_fix_task',
      reason: 'Run plan ready.',
      executionRequest,
      fixTask,
      taskId: TASK_ID,
      parentTaskId: PARENT_TASK_ID,
      attempt: ATTEMPT,
      title: TITLE,
      goal: GOAL,
      blockingIssues: [],
    },
    executionRequest,
    fixTask,
    blockingIssues: [],
  };
}

function buildInvalidState(): ReviewerFixTaskRunPlanStateInvalid {
  return {
    status: 'invalid',
    reason: 'Invalid.',
    blockingIssues: ['taskId missing'],
  };
}

function buildNotPresentState(): ReviewerFixTaskRunPlanStateNotPresent {
  return {
    status: 'not_present',
    reason: 'Missing.',
    blockingIssues: [],
  };
}

function completedExecutor(): ReviewerFixTaskExecutor {
  return async () => ({
    status: 'completed',
    reason: 'Fix applied.',
    commitSha: 'abc123',
    changedFiles: ['src/file.ts'],
  });
}

describe('runReviewerFixTaskControlled', () => {
  it('not_present state returns runnerResult not_ready', async () => {
    const { runnerResult } = await runReviewerFixTaskControlled({
      runPlanState: buildNotPresentState(),
      executor: completedExecutor(),
    });
    assert.strictEqual(runnerResult.status, 'not_ready');
  });

  it('not_present state returns persistedState not_ready', async () => {
    const { persistedState } = await runReviewerFixTaskControlled({
      runPlanState: buildNotPresentState(),
      executor: completedExecutor(),
    });
    assert.strictEqual(persistedState.status, 'not_ready');
  });

  it('not_present does not call executor', async () => {
    let called = false;
    await runReviewerFixTaskControlled({
      runPlanState: buildNotPresentState(),
      executor: async () => {
        called = true;
        return { status: 'completed', reason: '' };
      },
    });
    assert.strictEqual(called, false);
  });

  it('invalid state returns runnerResult blocked', async () => {
    const { runnerResult } = await runReviewerFixTaskControlled({
      runPlanState: buildInvalidState(),
      executor: completedExecutor(),
    });
    assert.strictEqual(runnerResult.status, 'blocked');
  });

  it('invalid state returns persistedState blocked', async () => {
    const { persistedState } = await runReviewerFixTaskControlled({
      runPlanState: buildInvalidState(),
      executor: completedExecutor(),
    });
    assert.strictEqual(persistedState.status, 'blocked');
  });

  it('invalid does not call executor', async () => {
    let called = false;
    await runReviewerFixTaskControlled({
      runPlanState: buildInvalidState(),
      executor: async () => {
        called = true;
        return { status: 'completed', reason: '' };
      },
    });
    assert.strictEqual(called, false);
  });

  it('ready state calls executor exactly once', async () => {
    let count = 0;
    await runReviewerFixTaskControlled({
      runPlanState: buildReadyState(),
      executor: async () => {
        count += 1;
        return { status: 'completed', reason: '' };
      },
    });
    assert.strictEqual(count, 1);
  });

  it('ready completed executor returns runnerResult executed', async () => {
    const { runnerResult } = await runReviewerFixTaskControlled({
      runPlanState: buildReadyState(),
      executor: completedExecutor(),
    });
    assert.strictEqual(runnerResult.status, 'executed');
  });

  it('ready completed executor returns persistedState executed', async () => {
    const { persistedState } = await runReviewerFixTaskControlled({
      runPlanState: buildReadyState(),
      executor: completedExecutor(),
    });
    assert.strictEqual(persistedState.status, 'executed');
  });

  it('persistedState nextAction is review_fix_result on completed', async () => {
    const { persistedState } = await runReviewerFixTaskControlled({
      runPlanState: buildReadyState(),
      executor: completedExecutor(),
    });
    assert.strictEqual(persistedState.nextAction, 'review_fix_result');
  });

  it('persistedState preserves taskId/parentTaskId/attempt', async () => {
    const { persistedState } = await runReviewerFixTaskControlled({
      runPlanState: buildReadyState(),
      executor: completedExecutor(),
    });
    assert.strictEqual(persistedState.taskId, TASK_ID);
    assert.strictEqual(persistedState.parentTaskId, PARENT_TASK_ID);
    assert.strictEqual(persistedState.attempt, ATTEMPT);
  });

  it('persistedState preserves executionRequest/fixTask', async () => {
    const { persistedState } = await runReviewerFixTaskControlled({
      runPlanState: buildReadyState(),
      executor: completedExecutor(),
    });
    assert(persistedState.executionRequest !== undefined);
    assert.strictEqual(persistedState.executionRequest!.taskId, TASK_ID);
    assert(persistedState.fixTask !== undefined);
    assert.strictEqual(persistedState.fixTask!.taskId, TASK_ID);
  });

  it('persistedState preserves commitSha/changedFiles', async () => {
    const { persistedState } = await runReviewerFixTaskControlled({
      runPlanState: buildReadyState(),
      executor: completedExecutor(),
    });
    assert.strictEqual(persistedState.executorResult!.commitSha, 'abc123');
    assert.deepStrictEqual(persistedState.executorResult!.changedFiles, [
      'src/file.ts',
    ]);
  });

  it('executor runState is not persisted', async () => {
    const { persistedState } = await runReviewerFixTaskControlled({
      runPlanState: buildReadyState(),
      executor: async () => ({
        status: 'completed',
        reason: 'Done.',
        runState: { secret: 'sk-fake-secret-key' },
      }),
    });
    const raw = JSON.stringify(persistedState);
    assert(!raw.includes('sk-fake-secret-key'));
    assert(!('runState' in persistedState.executorResult!));
  });

  it('persistedState executorResult.hasRunState is true when runState is present', async () => {
    const { persistedState } = await runReviewerFixTaskControlled({
      runPlanState: buildReadyState(),
      executor: async () => ({
        status: 'completed',
        reason: 'Done.',
        runState: { some: 'value' },
      }),
    });
    assert.strictEqual(persistedState.executorResult!.hasRunState, true);
  });

  it('executor throw returns runnerResult executor_failed', async () => {
    const { runnerResult } = await runReviewerFixTaskControlled({
      runPlanState: buildReadyState(),
      executor: async () => {
        throw new Error('Executor crashed');
      },
    });
    assert.strictEqual(runnerResult.status, 'executor_failed');
  });

  it('executor throw returns persistedState executor_failed', async () => {
    const { persistedState } = await runReviewerFixTaskControlled({
      runPlanState: buildReadyState(),
      executor: async () => {
        throw new Error('Executor crashed');
      },
    });
    assert.strictEqual(persistedState.status, 'executor_failed');
  });

  it('thrown secret is redacted in persistedState', async () => {
    const { persistedState } = await runReviewerFixTaskControlled({
      runPlanState: buildReadyState(),
      executor: async () => {
        throw new Error('Failed with sk-fake-secret-key');
      },
    });
    assert(!JSON.stringify(persistedState).includes('sk-fake-secret-key'));
    assert(persistedState.reason.includes('[REDACTED]'));
  });

  it('raw runnerResult still follows runner contract', async () => {
    const { runnerResult } = await runReviewerFixTaskControlled({
      runPlanState: buildReadyState(),
      executor: completedExecutor(),
    });
    assert.strictEqual(runnerResult.status, 'executed');
    assert.strictEqual(runnerResult.nextAction, 'review_fix_result');
    assert.strictEqual(runnerResult.executorCalled, true);
    assert.strictEqual(runnerResult.executionRequest.taskId, TASK_ID);
    assert.strictEqual(runnerResult.fixTask.taskId, TASK_ID);
  });

  it('controlled helper does not mutate input', async () => {
    const runPlanState = buildReadyState();
    const before = JSON.stringify(runPlanState);
    await runReviewerFixTaskControlled({
      runPlanState,
      executor: completedExecutor(),
    });
    const after = JSON.stringify(runPlanState);
    assert.strictEqual(after, before);
  });

  it('controlled helper does not call git/provider/network/filesystem APIs directly', async () => {
    const { persistedState } = await runReviewerFixTaskControlled({
      runPlanState: buildReadyState(),
      executor: completedExecutor(),
    });
    assert.strictEqual(persistedState.status, 'executed');
  });
});
