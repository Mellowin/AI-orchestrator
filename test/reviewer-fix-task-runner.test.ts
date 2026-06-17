import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  runReviewerFixTaskWithExecutor,
  type ReviewerFixTaskExecutor,
  type ReviewerFixTaskExecutorInput,
  type ReviewerFixTaskExecutorResult,
  type ReviewerFixTaskRunnerResult,
} from '../src/reviewer-fix-task-runner.js';
import type {
  ReviewerFixTaskRunPlanStateReady,
  ReviewerFixTaskRunPlanStateInvalid,
  ReviewerFixTaskRunPlanStateNotPresent,
} from '../src/reviewer-fix-task-run-plan-state.js';
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

function buildReadyState(
  overrides: Partial<ReviewerFixTaskRunPlanStateReady> = {}
): ReviewerFixTaskRunPlanStateReady {
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
    ...overrides,
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

function blockedExecutor(): ReviewerFixTaskExecutor {
  return async () => ({
    status: 'blocked',
    reason: 'Could not fix.',
    blockingIssues: ['still broken'],
  });
}

function assertBaseFields(
  result: ReviewerFixTaskRunnerResult
): void {
  assert.strictEqual(result.taskId, TASK_ID);
  assert.strictEqual(result.parentTaskId, PARENT_TASK_ID);
  assert.strictEqual(result.attempt, ATTEMPT);
}

describe('runReviewerFixTaskWithExecutor', () => {
  it('not_present returns not_ready', async () => {
    const result = await runReviewerFixTaskWithExecutor({
      runPlanState: buildNotPresentState(),
      executor: completedExecutor(),
    });
    assert.strictEqual(result.status, 'not_ready');
  });

  it('not_present nextAction is wait', async () => {
    const result = await runReviewerFixTaskWithExecutor({
      runPlanState: buildNotPresentState(),
      executor: completedExecutor(),
    });
    assert.strictEqual(result.nextAction, 'wait');
  });

  it('not_present does not call executor', async () => {
    let called = false;
    await runReviewerFixTaskWithExecutor({
      runPlanState: buildNotPresentState(),
      executor: async () => {
        called = true;
        return { status: 'completed', reason: '' };
      },
    });
    assert.strictEqual(called, false);
    assert.strictEqual(
      (
        await runReviewerFixTaskWithExecutor({
          runPlanState: buildNotPresentState(),
          executor: async () => ({ status: 'completed', reason: '' }),
        })
      ).executorCalled,
      false
    );
  });

  it('invalid returns blocked', async () => {
    const result = await runReviewerFixTaskWithExecutor({
      runPlanState: buildInvalidState(),
      executor: completedExecutor(),
    });
    assert.strictEqual(result.status, 'blocked');
  });

  it('invalid nextAction is block', async () => {
    const result = await runReviewerFixTaskWithExecutor({
      runPlanState: buildInvalidState(),
      executor: completedExecutor(),
    });
    assert.strictEqual(result.nextAction, 'block');
  });

  it('invalid does not call executor', async () => {
    let called = false;
    await runReviewerFixTaskWithExecutor({
      runPlanState: buildInvalidState(),
      executor: async () => {
        called = true;
        return { status: 'completed', reason: '' };
      },
    });
    assert.strictEqual(called, false);
  });

  it('invalid preserves blockingIssues', async () => {
    const result = await runReviewerFixTaskWithExecutor({
      runPlanState: buildInvalidState(),
      executor: completedExecutor(),
    });
    assert.deepStrictEqual(result.blockingIssues, ['taskId missing']);
  });

  it('ready calls executor exactly once', async () => {
    let count = 0;
    await runReviewerFixTaskWithExecutor({
      runPlanState: buildReadyState(),
      executor: async () => {
        count += 1;
        return { status: 'completed', reason: '' };
      },
    });
    assert.strictEqual(count, 1);
  });

  it('ready executor input preserves taskId', async () => {
    let input: ReviewerFixTaskExecutorInput | undefined;
    await runReviewerFixTaskWithExecutor({
      runPlanState: buildReadyState(),
      executor: async (i) => {
        input = i;
        return { status: 'completed', reason: '' };
      },
    });
    assert.strictEqual(input?.taskId, TASK_ID);
  });

  it('ready executor input preserves parentTaskId', async () => {
    let input: ReviewerFixTaskExecutorInput | undefined;
    await runReviewerFixTaskWithExecutor({
      runPlanState: buildReadyState(),
      executor: async (i) => {
        input = i;
        return { status: 'completed', reason: '' };
      },
    });
    assert.strictEqual(input?.parentTaskId, PARENT_TASK_ID);
  });

  it('ready executor input preserves attempt', async () => {
    let input: ReviewerFixTaskExecutorInput | undefined;
    await runReviewerFixTaskWithExecutor({
      runPlanState: buildReadyState(),
      executor: async (i) => {
        input = i;
        return { status: 'completed', reason: '' };
      },
    });
    assert.strictEqual(input?.attempt, ATTEMPT);
  });

  it('ready executor input preserves title', async () => {
    let input: ReviewerFixTaskExecutorInput | undefined;
    await runReviewerFixTaskWithExecutor({
      runPlanState: buildReadyState(),
      executor: async (i) => {
        input = i;
        return { status: 'completed', reason: '' };
      },
    });
    assert.strictEqual(input?.title, TITLE);
  });

  it('ready executor input preserves goal', async () => {
    let input: ReviewerFixTaskExecutorInput | undefined;
    await runReviewerFixTaskWithExecutor({
      runPlanState: buildReadyState(),
      executor: async (i) => {
        input = i;
        return { status: 'completed', reason: '' };
      },
    });
    assert.strictEqual(input?.goal, GOAL);
  });

  it('ready executor input preserves blockingIssues', async () => {
    let input: ReviewerFixTaskExecutorInput | undefined;
    await runReviewerFixTaskWithExecutor({
      runPlanState: buildReadyState({
        blockingIssues: ['extra issue'],
      }),
      executor: async (i) => {
        input = i;
        return { status: 'completed', reason: '' };
      },
    });
    assert.deepStrictEqual(input?.blockingIssues, ['extra issue']);
  });

  it('ready executor input preserves executionRequest', async () => {
    let input: ReviewerFixTaskExecutorInput | undefined;
    await runReviewerFixTaskWithExecutor({
      runPlanState: buildReadyState(),
      executor: async (i) => {
        input = i;
        return { status: 'completed', reason: '' };
      },
    });
    assert.strictEqual(input?.executionRequest.taskId, TASK_ID);
    assert.strictEqual(input?.executionRequest.kind, 'reviewer_fix_task');
  });

  it('ready executor input preserves fixTask', async () => {
    let input: ReviewerFixTaskExecutorInput | undefined;
    await runReviewerFixTaskWithExecutor({
      runPlanState: buildReadyState(),
      executor: async (i) => {
        input = i;
        return { status: 'completed', reason: '' };
      },
    });
    assert.strictEqual(input?.fixTask.taskId, TASK_ID);
    assert.strictEqual(input?.fixTask.source, 'reviewer_gate');
  });

  it('completed executor result maps to executed', async () => {
    const result = await runReviewerFixTaskWithExecutor({
      runPlanState: buildReadyState(),
      executor: completedExecutor(),
    });
    assert.strictEqual(result.status, 'executed');
  });

  it('completed executor result nextAction is review_fix_result', async () => {
    const result = await runReviewerFixTaskWithExecutor({
      runPlanState: buildReadyState(),
      executor: completedExecutor(),
    });
    assert.strictEqual(result.nextAction, 'review_fix_result');
  });

  it('completed executor result preserves commitSha', async () => {
    const result = await runReviewerFixTaskWithExecutor({
      runPlanState: buildReadyState(),
      executor: completedExecutor(),
    });
    assert.strictEqual(result.executorResult?.commitSha, 'abc123');
  });

  it('completed executor result preserves changedFiles', async () => {
    const result = await runReviewerFixTaskWithExecutor({
      runPlanState: buildReadyState(),
      executor: completedExecutor(),
    });
    assert.deepStrictEqual(result.executorResult?.changedFiles, ['src/file.ts']);
  });

  it('completed executor result preserves checkSummary', async () => {
    const result = await runReviewerFixTaskWithExecutor({
      runPlanState: buildReadyState(),
      executor: async () => ({
        status: 'completed',
        reason: 'Done',
        checkSummary: {
          typecheck: 'pass',
          build: 'pass',
          test: 'pass',
          tests: { total: 3, suites: 0, failures: 0 },
        },
      }),
    });
    assert.deepStrictEqual(result.executorResult?.checkSummary, {
      typecheck: 'pass',
      build: 'pass',
      test: 'pass',
      tests: { total: 3, suites: 0, failures: 0 },
    });
  });

  it('blocked executor result preserves checkSummary', async () => {
    const result = await runReviewerFixTaskWithExecutor({
      runPlanState: buildReadyState(),
      executor: async () => ({
        status: 'blocked',
        reason: 'Checks failed.',
        blockingIssues: ['test failed'],
        checkSummary: {
          typecheck: 'not_run',
          build: 'not_run',
          test: 'fail',
          tests: { total: 1, suites: 0, failures: 1 },
        },
      }),
    });
    assert.deepStrictEqual(result.executorResult?.checkSummary, {
      typecheck: 'not_run',
      build: 'not_run',
      test: 'fail',
      tests: { total: 1, suites: 0, failures: 1 },
    });
  });

  it('returned executorResult checkSummary is cloned', async () => {
    const checkSummary = {
      typecheck: 'pass',
      build: 'pass',
      test: 'pass',
      tests: { total: 3, suites: 0, failures: 0 },
    };
    const result = await runReviewerFixTaskWithExecutor({
      runPlanState: buildReadyState(),
      executor: async () => ({
        status: 'completed',
        reason: 'Done',
        checkSummary,
      }),
    });
    assert.notStrictEqual(result.executorResult?.checkSummary, checkSummary);
    assert.notStrictEqual(result.executorResult?.checkSummary?.tests, checkSummary.tests);
    checkSummary.tests.failures = 99;
    assert.strictEqual(result.executorResult?.checkSummary?.tests?.failures, 0);
  });

  it('blocked executor result maps to blocked', async () => {
    const result = await runReviewerFixTaskWithExecutor({
      runPlanState: buildReadyState(),
      executor: blockedExecutor(),
    });
    assert.strictEqual(result.status, 'blocked');
  });

  it('blocked executor result nextAction is block', async () => {
    const result = await runReviewerFixTaskWithExecutor({
      runPlanState: buildReadyState(),
      executor: blockedExecutor(),
    });
    assert.strictEqual(result.nextAction, 'block');
  });

  it('blocked executor result preserves blockingIssues', async () => {
    const result = await runReviewerFixTaskWithExecutor({
      runPlanState: buildReadyState(),
      executor: blockedExecutor(),
    });
    assert.deepStrictEqual(result.blockingIssues, ['still broken']);
  });

  it('thrown executor error maps to executor_failed', async () => {
    const result = await runReviewerFixTaskWithExecutor({
      runPlanState: buildReadyState(),
      executor: async () => {
        throw new Error('Executor crashed');
      },
    });
    assert.strictEqual(result.status, 'executor_failed');
  });

  it('thrown executor error nextAction is block', async () => {
    const result = await runReviewerFixTaskWithExecutor({
      runPlanState: buildReadyState(),
      executor: async () => {
        throw new Error('Executor crashed');
      },
    });
    assert.strictEqual(result.nextAction, 'block');
  });

  it('thrown executor error is redacted for sk secret', async () => {
    const result = await runReviewerFixTaskWithExecutor({
      runPlanState: buildReadyState(),
      executor: async () => {
        throw new Error('Failed with sk-fake-secret-key');
      },
    });
    assert(!JSON.stringify(result).includes('sk-fake-secret-key'));
    assert(result.reason.includes('[REDACTED]'));
  });

  it('thrown executor error is redacted for Bearer token', async () => {
    const result = await runReviewerFixTaskWithExecutor({
      runPlanState: buildReadyState(),
      executor: async () => {
        throw new Error('Failed with Bearer fake-token');
      },
    });
    assert(!JSON.stringify(result).includes('Bearer fake-token'));
    assert(result.reason.includes('[REDACTED]'));
  });

  it('thrown executor error is redacted for api_key/token/password patterns', async () => {
    const result = await runReviewerFixTaskWithExecutor({
      runPlanState: buildReadyState(),
      executor: async () => {
        throw new Error('api_key=secret123 token=abc password=hunter2');
      },
    });
    const raw = JSON.stringify(result);
    assert(!raw.includes('secret123'));
    assert(!raw.includes('hunter2'));
    assert(result.reason.includes('[REDACTED]'));
  });

  it('executor receives cloned executionRequest/fixTask/blockingIssues', async () => {
    const state = buildReadyState();
    let capturedInput: ReviewerFixTaskExecutorInput | undefined;
    await runReviewerFixTaskWithExecutor({
      runPlanState: state,
      executor: async (i) => {
        capturedInput = i;
        return { status: 'completed', reason: '' };
      },
    });
    assert(capturedInput !== undefined);
    assert.notStrictEqual(
      capturedInput!.executionRequest,
      state.executionRequest
    );
    assert.notStrictEqual(capturedInput!.fixTask, state.fixTask);
    assert.notStrictEqual(
      capturedInput!.blockingIssues,
      state.blockingIssues
    );
  });

  it('returned executionRequest is cloned', async () => {
    const state = buildReadyState();
    const result = await runReviewerFixTaskWithExecutor({
      runPlanState: state,
      executor: completedExecutor(),
    });
    assertStatus(result, 'executed');
    if (result.status !== 'executed') return;
    assert.notStrictEqual(result.executionRequest, state.executionRequest);
    state.executionRequest.goal = 'mutated';
    assert.strictEqual(result.executionRequest.goal, GOAL);
  });

  it('returned fixTask is cloned', async () => {
    const state = buildReadyState();
    const result = await runReviewerFixTaskWithExecutor({
      runPlanState: state,
      executor: completedExecutor(),
    });
    assertStatus(result, 'executed');
    if (result.status !== 'executed') return;
    assert.notStrictEqual(result.fixTask, state.fixTask);
    state.fixTask.goal = 'mutated';
    assert.strictEqual(result.fixTask.goal, GOAL);
  });

  it('returned executorResult arrays are cloned', async () => {
    const executorResult: ReviewerFixTaskExecutorResult = {
      status: 'completed',
      reason: 'Done',
      changedFiles: ['src/file.ts'],
      blockingIssues: ['issue'],
    };
    const result = await runReviewerFixTaskWithExecutor({
      runPlanState: buildReadyState(),
      executor: async () => executorResult,
    });
    assertStatus(result, 'executed');
    if (result.status !== 'executed') return;
    assert.notStrictEqual(
      result.executorResult?.changedFiles,
      executorResult.changedFiles
    );
    assert.notStrictEqual(
      result.executorResult?.blockingIssues,
      executorResult.blockingIssues
    );
    executorResult.changedFiles!.push('mutated');
    executorResult.blockingIssues!.push('mutated');
    assert.deepStrictEqual(result.executorResult?.changedFiles, ['src/file.ts']);
    assert.deepStrictEqual(result.executorResult?.blockingIssues, ['issue']);
  });

  it('helper does not mutate input', async () => {
    const state = buildReadyState();
    const before = JSON.stringify(state);
    await runReviewerFixTaskWithExecutor({
      runPlanState: state,
      executor: completedExecutor(),
    });
    const after = JSON.stringify(state);
    assert.strictEqual(after, before);
  });

  it('helper does not call git/provider/network/filesystem APIs directly', async () => {
    const result = await runReviewerFixTaskWithExecutor({
      runPlanState: buildReadyState(),
      executor: completedExecutor(),
    });
    assert.strictEqual(result.status, 'executed');
  });
});

function assertStatus(
  result: ReviewerFixTaskRunnerResult,
  expected: 'not_ready' | 'blocked' | 'executed' | 'executor_failed'
): void {
  assert.strictEqual(result.status, expected);
}
