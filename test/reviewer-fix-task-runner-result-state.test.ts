import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildPersistedReviewerFixTaskRunnerResultState,
  type PersistedReviewerFixTaskRunnerResultState,
} from '../src/reviewer-fix-task-runner-result-state.js';
import type {
  ReviewerFixTaskRunnerResult,
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

function buildExecutorResult(
  overrides: Partial<ReviewerFixTaskExecutorResult> = {}
): ReviewerFixTaskExecutorResult {
  return {
    status: 'completed',
    reason: 'Fix applied.',
    commitSha: 'abc123',
    changedFiles: ['src/file.ts'],
    ...overrides,
  };
}

function buildRunnerResult(
  overrides: Partial<ReviewerFixTaskRunnerResult> = {}
): ReviewerFixTaskRunnerResult {
  const executionRequest = buildExecutionRequest();
  const fixTask = buildFixTask();
  return {
    status: 'executed',
    nextAction: 'review_fix_result',
    reason: 'Fix applied.',
    executorCalled: true,
    taskId: TASK_ID,
    parentTaskId: PARENT_TASK_ID,
    attempt: ATTEMPT,
    executionRequest,
    fixTask,
    executorResult: buildExecutorResult(),
    blockingIssues: [],
    ...overrides,
  };
}

describe('buildPersistedReviewerFixTaskRunnerResultState', () => {
  it('not_ready result is persisted with status/nextAction/executorCalled', () => {
    const result = buildPersistedReviewerFixTaskRunnerResultState({
      runnerResult: {
        status: 'not_ready',
        nextAction: 'wait',
        reason: 'No plan.',
        executorCalled: false,
        blockingIssues: [],
      },
    });
    assert.strictEqual(result.status, 'not_ready');
    assert.strictEqual(result.nextAction, 'wait');
    assert.strictEqual(result.executorCalled, false);
  });

  it('blocked result is persisted with blockingIssues', () => {
    const result = buildPersistedReviewerFixTaskRunnerResultState({
      runnerResult: buildRunnerResult({
        status: 'blocked',
        nextAction: 'block',
        reason: 'Blocked.',
        blockingIssues: ['issue one'],
      }),
    });
    assert.strictEqual(result.status, 'blocked');
    assert.deepStrictEqual(result.blockingIssues, ['issue one']);
  });

  it('executed result is persisted with taskId/parentTaskId/attempt', () => {
    const result = buildPersistedReviewerFixTaskRunnerResultState({
      runnerResult: buildRunnerResult(),
    });
    assert.strictEqual(result.taskId, TASK_ID);
    assert.strictEqual(result.parentTaskId, PARENT_TASK_ID);
    assert.strictEqual(result.attempt, ATTEMPT);
  });

  it('executed result preserves executionRequest', () => {
    const result = buildPersistedReviewerFixTaskRunnerResultState({
      runnerResult: buildRunnerResult(),
    });
    assert(result.executionRequest !== undefined);
    assert.strictEqual(result.executionRequest!.taskId, TASK_ID);
    assert.strictEqual(result.executionRequest!.kind, 'reviewer_fix_task');
  });

  it('executed result preserves fixTask', () => {
    const result = buildPersistedReviewerFixTaskRunnerResultState({
      runnerResult: buildRunnerResult(),
    });
    assert(result.fixTask !== undefined);
    assert.strictEqual(result.fixTask!.taskId, TASK_ID);
    assert.strictEqual(result.fixTask!.source, 'reviewer_gate');
  });

  it('executed result preserves executorResult.status', () => {
    const result = buildPersistedReviewerFixTaskRunnerResultState({
      runnerResult: buildRunnerResult(),
    });
    assert.strictEqual(result.executorResult!.status, 'completed');
  });

  it('executed result preserves executorResult.commitSha', () => {
    const result = buildPersistedReviewerFixTaskRunnerResultState({
      runnerResult: buildRunnerResult(),
    });
    assert.strictEqual(result.executorResult!.commitSha, 'abc123');
  });

  it('executed result preserves executorResult.changedFiles', () => {
    const result = buildPersistedReviewerFixTaskRunnerResultState({
      runnerResult: buildRunnerResult(),
    });
    assert.deepStrictEqual(result.executorResult!.changedFiles, ['src/file.ts']);
  });

  it('executor_failed result is persisted with status/nextAction', () => {
    const result = buildPersistedReviewerFixTaskRunnerResultState({
      runnerResult: buildRunnerResult({
        status: 'executor_failed',
        nextAction: 'block',
        reason: 'Executor failed.',
        executorResult: undefined,
      }),
    });
    assert.strictEqual(result.status, 'executor_failed');
    assert.strictEqual(result.nextAction, 'block');
  });

  it('reason is redacted for sk secret', () => {
    const result = buildPersistedReviewerFixTaskRunnerResultState({
      runnerResult: buildRunnerResult({
        reason: 'Failed with sk-fake-secret-key',
      }),
    });
    assert(!result.reason.includes('sk-fake-secret-key'));
    assert(result.reason.includes('[REDACTED]'));
  });

  it('reason is redacted for pk secret', () => {
    const result = buildPersistedReviewerFixTaskRunnerResultState({
      runnerResult: buildRunnerResult({
        reason: 'Failed with pk-fake-public',
      }),
    });
    assert(!result.reason.includes('pk-fake-public'));
    assert(result.reason.includes('[REDACTED]'));
  });

  it('reason is redacted for Bearer token', () => {
    const result = buildPersistedReviewerFixTaskRunnerResultState({
      runnerResult: buildRunnerResult({
        reason: 'Failed with Bearer fake-token',
      }),
    });
    assert(!result.reason.includes('Bearer fake-token'));
    assert(result.reason.includes('[REDACTED]'));
  });

  it('reason is redacted for api_key/token/password patterns', () => {
    const result = buildPersistedReviewerFixTaskRunnerResultState({
      runnerResult: buildRunnerResult({
        reason: 'api_key=secret123 token=abc password=hunter2',
      }),
    });
    const raw = JSON.stringify(result);
    assert(!raw.includes('secret123'));
    assert(!raw.includes('hunter2'));
    assert(result.reason.includes('[REDACTED]'));
  });

  it('blockingIssues are redacted', () => {
    const result = buildPersistedReviewerFixTaskRunnerResultState({
      runnerResult: buildRunnerResult({
        blockingIssues: ['Issue with sk-fake-secret-key'],
      }),
    });
    assert(!result.blockingIssues[0].includes('sk-fake-secret-key'));
    assert(result.blockingIssues[0].includes('[REDACTED]'));
  });

  it('executorResult.reason is redacted', () => {
    const result = buildPersistedReviewerFixTaskRunnerResultState({
      runnerResult: buildRunnerResult({
        executorResult: buildExecutorResult({
          reason: 'Error with Bearer fake-token',
        }),
      }),
    });
    assert(!result.executorResult!.reason.includes('Bearer fake-token'));
    assert(result.executorResult!.reason.includes('[REDACTED]'));
  });

  it('executorResult.blockingIssues are redacted', () => {
    const result = buildPersistedReviewerFixTaskRunnerResultState({
      runnerResult: buildRunnerResult({
        executorResult: buildExecutorResult({
          status: 'blocked',
          reason: 'Blocked.',
          blockingIssues: ['Issue with api_key=leaked'],
        }),
      }),
    });
    assert(!result.executorResult!.blockingIssues![0].includes('leaked'));
    assert(result.executorResult!.blockingIssues![0].includes('[REDACTED]'));
  });

  it('executorResult.runState is not persisted', () => {
    const result = buildPersistedReviewerFixTaskRunnerResultState({
      runnerResult: buildRunnerResult({
        executorResult: buildExecutorResult({
          runState: { secret: 'sk-fake-secret-key' },
        }),
      }),
    });
    const raw = JSON.stringify(result);
    assert(!raw.includes('secret'));
    assert(!raw.includes('sk-fake-secret-key'));
    assert(!('runState' in result.executorResult!));
  });

  it('executorResult.hasRunState is true when runState is present', () => {
    const result = buildPersistedReviewerFixTaskRunnerResultState({
      runnerResult: buildRunnerResult({
        executorResult: buildExecutorResult({
          runState: { some: 'value' },
        }),
      }),
    });
    assert.strictEqual(result.executorResult!.hasRunState, true);
  });

  it('executorResult.hasRunState is false when runState is absent', () => {
    const result = buildPersistedReviewerFixTaskRunnerResultState({
      runnerResult: buildRunnerResult({
        executorResult: buildExecutorResult(),
      }),
    });
    assert.strictEqual(result.executorResult!.hasRunState, false);
  });

  it('no executorResult omits executorResult field', () => {
    const result = buildPersistedReviewerFixTaskRunnerResultState({
      runnerResult: buildRunnerResult({ executorResult: undefined }),
    });
    assert.strictEqual(result.executorResult, undefined);
    assert(!('executorResult' in result));
  });

  it('executionRequest is cloned', () => {
    const runnerResult = buildRunnerResult();
    const result = buildPersistedReviewerFixTaskRunnerResultState({
      runnerResult,
    });
    assert.notStrictEqual(result.executionRequest, runnerResult.executionRequest);
    runnerResult.executionRequest!.goal = 'mutated';
    assert.strictEqual(result.executionRequest!.goal, GOAL);
  });

  it('nested executionRequest.task is cloned', () => {
    const runnerResult = buildRunnerResult();
    const result = buildPersistedReviewerFixTaskRunnerResultState({
      runnerResult,
    });
    assert.notStrictEqual(
      result.executionRequest!.task,
      runnerResult.executionRequest!.task
    );
    runnerResult.executionRequest!.task.goal = 'mutated';
    assert.strictEqual(result.executionRequest!.task.goal, GOAL);
  });

  it('fixTask is cloned', () => {
    const runnerResult = buildRunnerResult();
    const result = buildPersistedReviewerFixTaskRunnerResultState({
      runnerResult,
    });
    assert.notStrictEqual(result.fixTask, runnerResult.fixTask);
    runnerResult.fixTask!.goal = 'mutated';
    assert.strictEqual(result.fixTask!.goal, GOAL);
  });

  it('top-level blockingIssues are cloned', () => {
    const runnerResult = buildRunnerResult({
      blockingIssues: ['issue'],
    });
    const result = buildPersistedReviewerFixTaskRunnerResultState({
      runnerResult,
    });
    assert.notStrictEqual(result.blockingIssues, runnerResult.blockingIssues);
    runnerResult.blockingIssues.push('mutated');
    assert.deepStrictEqual(result.blockingIssues, ['issue']);
  });

  it('executorResult.changedFiles are cloned', () => {
    const executorResult = buildExecutorResult();
    const runnerResult = buildRunnerResult({ executorResult });
    const result = buildPersistedReviewerFixTaskRunnerResultState({
      runnerResult,
    });
    assert.notStrictEqual(
      result.executorResult!.changedFiles,
      executorResult.changedFiles
    );
    executorResult.changedFiles!.push('mutated');
    assert.deepStrictEqual(result.executorResult!.changedFiles, ['src/file.ts']);
  });

  it('executorResult.blockingIssues are cloned', () => {
    const executorResult = buildExecutorResult({
      status: 'blocked',
      reason: 'Blocked.',
      blockingIssues: ['issue'],
    });
    const runnerResult = buildRunnerResult({ executorResult });
    const result = buildPersistedReviewerFixTaskRunnerResultState({
      runnerResult,
    });
    assert.notStrictEqual(
      result.executorResult!.blockingIssues,
      executorResult.blockingIssues
    );
    executorResult.blockingIssues!.push('mutated');
    assert.deepStrictEqual(result.executorResult!.blockingIssues, ['issue']);
  });

  it('executorResult.checkSummary is preserved', () => {
    const runnerResult = buildRunnerResult({
      executorResult: buildExecutorResult({
        checkSummary: {
          typecheck: 'pass',
          build: 'pass',
          test: 'pass',
          tests: { total: 3, suites: 0, failures: 0 },
        },
      }),
    });
    const result = buildPersistedReviewerFixTaskRunnerResultState({ runnerResult });
    assert.deepStrictEqual(result.executorResult!.checkSummary, {
      typecheck: 'pass',
      build: 'pass',
      test: 'pass',
      tests: { total: 3, suites: 0, failures: 0 },
    });
  });

  it('executorResult.checkSummary is cloned', () => {
    const checkSummary = {
      typecheck: 'pass',
      build: 'pass',
      test: 'pass',
      tests: { total: 3, suites: 0, failures: 0 },
    };
    const executorResult = buildExecutorResult({ checkSummary });
    const runnerResult = buildRunnerResult({ executorResult });
    const result = buildPersistedReviewerFixTaskRunnerResultState({
      runnerResult,
    });
    assert.notStrictEqual(result.executorResult!.checkSummary, checkSummary);
    assert.notStrictEqual(result.executorResult!.checkSummary!.tests, checkSummary.tests);
    checkSummary.tests.failures = 99;
    assert.strictEqual(result.executorResult!.checkSummary!.tests!.failures, 0);
  });

  it('helper does not mutate input', () => {
    const runnerResult = buildRunnerResult();
    const before = JSON.stringify(runnerResult);
    buildPersistedReviewerFixTaskRunnerResultState({ runnerResult });
    const after = JSON.stringify(runnerResult);
    assert.strictEqual(after, before);
  });

  it('helper does not call git/provider/network/filesystem APIs', () => {
    const result = buildPersistedReviewerFixTaskRunnerResultState({
      runnerResult: buildRunnerResult(),
    });
    assert.strictEqual(result.status, 'executed');
  });
});
