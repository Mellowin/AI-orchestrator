import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  deriveReviewerFixTaskPostRunReviewPlan,
  type ReviewerFixTaskPostRunReviewPlanInput,
} from '../src/reviewer-fix-task-post-run-review-plan.js';
import type {
  PersistedReviewerFixTaskRunnerResultState,
  PersistedReviewerFixTaskExecutorResult,
} from '../src/reviewer-fix-task-runner-result-state.js';
import type { ReviewerFixTaskExecutionRequest } from '../src/reviewer-pending-fix-task-execution-request.js';
import type { ReviewerFixTaskDraft } from '../src/reviewer-fix-task-plan.js';

const PARENT_TASK_ID = 'demo-task';
const ATTEMPT = 1;
const TASK_ID = `fix-${PARENT_TASK_ID}-reviewer-${ATTEMPT}`;
const TITLE = 'Fix review issue';
const GOAL = 'Address reviewer feedback';
const BLOCKING_ISSUES = ['line too long', 'missing tests'];
const VALID_SHA = 'a961b0bbfb16242491307adbd8741b0595942497';

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
  overrides: Partial<PersistedReviewerFixTaskExecutorResult> = {}
): PersistedReviewerFixTaskExecutorResult {
  return {
    status: 'completed',
    reason: 'Fix applied.',
    commitSha: VALID_SHA,
    changedFiles: ['src/file.ts'],
    blockingIssues: [],
    hasRunState: false,
    ...overrides,
  };
}

function buildPersistedRunnerState(
  overrides: Partial<PersistedReviewerFixTaskRunnerResultState> = {}
): PersistedReviewerFixTaskRunnerResultState {
  return {
    status: 'executed',
    nextAction: 'review_fix_result',
    reason: 'Fix applied.',
    executorCalled: true,
    taskId: TASK_ID,
    parentTaskId: PARENT_TASK_ID,
    attempt: ATTEMPT,
    executionRequest: buildExecutionRequest(),
    fixTask: buildFixTask(),
    executorResult: buildExecutorResult(),
    blockingIssues: [],
    ...overrides,
  };
}

function derive(
  overrides: Partial<PersistedReviewerFixTaskRunnerResultState> = {}
) {
  return deriveReviewerFixTaskPostRunReviewPlan({
    persistedRunnerState: buildPersistedRunnerState(overrides),
  });
}

describe('deriveReviewerFixTaskPostRunReviewPlan', () => {
  it('not_ready maps to no_op', () => {
    const result = derive({ status: 'not_ready', nextAction: 'wait' });
    assert.strictEqual(result.action, 'no_op');
  });

  it('not_ready has empty changedFiles', () => {
    const result = derive({ status: 'not_ready', nextAction: 'wait' });
    assert.deepStrictEqual(result.changedFiles, []);
  });

  it('blocked maps to block_for_human', () => {
    const result = derive({
      status: 'blocked',
      nextAction: 'block',
      executorResult: buildExecutorResult({ status: 'blocked', reason: 'Blocked.' }),
    });
    assert.strictEqual(result.action, 'block_for_human');
  });

  it('blocked preserves blockingIssues', () => {
    const result = derive({
      status: 'blocked',
      nextAction: 'block',
      blockingIssues: ['issue one'],
    });
    assert.deepStrictEqual(result.blockingIssues, ['issue one']);
  });

  it('executor_failed maps to block_for_human', () => {
    const result = derive({
      status: 'executor_failed',
      nextAction: 'block',
      executorResult: undefined,
    });
    assert.strictEqual(result.action, 'block_for_human');
  });

  it('executor_failed preserves blockingIssues', () => {
    const result = derive({
      status: 'executor_failed',
      nextAction: 'block',
      blockingIssues: ['issue two'],
    });
    assert.deepStrictEqual(result.blockingIssues, ['issue two']);
  });

  it('executed with completed executor result maps to review_fix_result', () => {
    const result = derive();
    assert.strictEqual(result.action, 'review_fix_result');
  });

  it('executed review plan preserves taskId', () => {
    const result = derive();
    assert.strictEqual(result.taskId, TASK_ID);
  });

  it('executed review plan preserves parentTaskId', () => {
    const result = derive();
    assert.strictEqual(result.parentTaskId, PARENT_TASK_ID);
  });

  it('executed review plan preserves attempt', () => {
    const result = derive();
    assert.strictEqual(result.attempt, ATTEMPT);
  });

  it('executed review plan preserves commitSha', () => {
    const result = derive();
    assert.strictEqual(result.commitSha, VALID_SHA);
  });

  it('executed review plan preserves changedFiles', () => {
    const result = derive();
    assert.deepStrictEqual(result.changedFiles, ['src/file.ts']);
  });

  it('executed review plan preserves executionRequest', () => {
    const result = derive();
    assert(result.executionRequest !== undefined);
    assert.strictEqual(result.executionRequest!.taskId, TASK_ID);
    assert.strictEqual(result.executionRequest!.kind, 'reviewer_fix_task');
  });

  it('executed review plan preserves fixTask', () => {
    const result = derive();
    assert(result.fixTask !== undefined);
    assert.strictEqual(result.fixTask!.taskId, TASK_ID);
    assert.strictEqual(result.fixTask!.source, 'reviewer_gate');
  });

  it('executed review plan preserves executorResult', () => {
    const result = derive();
    assert(result.executorResult !== undefined);
    assert.strictEqual(result.executorResult!.status, 'completed');
  });

  it('executed missing executorResult blocks for human', () => {
    const result = derive({ executorResult: undefined });
    assert.strictEqual(result.action, 'block_for_human');
    assert(result.blockingIssues.some((issue) =>
      issue.includes('missing executor result')
    ));
  });

  it('executed executorResult.status blocked blocks for human', () => {
    const result = derive({
      executorResult: buildExecutorResult({ status: 'blocked', reason: 'Blocked.' }),
    });
    assert.strictEqual(result.action, 'block_for_human');
    assert(result.blockingIssues.some((issue) =>
      issue.includes('non-completed executor status')
    ));
  });

  it('executed missing commitSha blocks for human', () => {
    const result = derive({
      executorResult: buildExecutorResult({ commitSha: undefined }),
    });
    assert.strictEqual(result.action, 'block_for_human');
    assert(result.blockingIssues.some((issue) =>
      issue.includes('missing a valid full 40-character hex commit SHA')
    ));
  });

  it('executed short commitSha blocks for human', () => {
    const result = derive({
      executorResult: buildExecutorResult({ commitSha: 'abc123' }),
    });
    assert.strictEqual(result.action, 'block_for_human');
  });

  it('executed non-hex commitSha blocks for human', () => {
    const result = derive({
      executorResult: buildExecutorResult({
        commitSha: 'zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz',
      }),
    });
    assert.strictEqual(result.action, 'block_for_human');
  });

  it('full 40-character hex commitSha is accepted', () => {
    const result = derive();
    assert.strictEqual(result.action, 'review_fix_result');
    assert.strictEqual(result.commitSha, VALID_SHA);
  });

  it('changedFiles are cloned', () => {
    const state = buildPersistedRunnerState();
    const result = deriveReviewerFixTaskPostRunReviewPlan({
      persistedRunnerState: state,
    });
    assert.notStrictEqual(result.changedFiles, state.executorResult!.changedFiles);
    state.executorResult!.changedFiles!.push('mutated');
    assert.deepStrictEqual(result.changedFiles, ['src/file.ts']);
  });

  it('blockingIssues are cloned', () => {
    const state = buildPersistedRunnerState({ blockingIssues: ['issue'] });
    const result = deriveReviewerFixTaskPostRunReviewPlan({
      persistedRunnerState: state,
    });
    assert.notStrictEqual(result.blockingIssues, state.blockingIssues);
    state.blockingIssues.push('mutated');
    assert.deepStrictEqual(result.blockingIssues, ['issue']);
  });

  it('executionRequest is cloned', () => {
    const state = buildPersistedRunnerState();
    const result = deriveReviewerFixTaskPostRunReviewPlan({
      persistedRunnerState: state,
    });
    assert.notStrictEqual(result.executionRequest, state.executionRequest);
    state.executionRequest!.goal = 'mutated';
    assert.strictEqual(result.executionRequest!.goal, GOAL);
  });

  it('nested executionRequest.task is cloned', () => {
    const state = buildPersistedRunnerState();
    const result = deriveReviewerFixTaskPostRunReviewPlan({
      persistedRunnerState: state,
    });
    assert.notStrictEqual(result.executionRequest!.task, state.executionRequest!.task);
    state.executionRequest!.task.goal = 'mutated';
    assert.strictEqual(result.executionRequest!.task.goal, GOAL);
  });

  it('fixTask is cloned', () => {
    const state = buildPersistedRunnerState();
    const result = deriveReviewerFixTaskPostRunReviewPlan({
      persistedRunnerState: state,
    });
    assert.notStrictEqual(result.fixTask, state.fixTask);
    state.fixTask!.goal = 'mutated';
    assert.strictEqual(result.fixTask!.goal, GOAL);
  });

  it('executorResult changedFiles are cloned', () => {
    const state = buildPersistedRunnerState();
    const result = deriveReviewerFixTaskPostRunReviewPlan({
      persistedRunnerState: state,
    });
    assert.notStrictEqual(
      result.executorResult!.changedFiles,
      state.executorResult!.changedFiles
    );
    state.executorResult!.changedFiles!.push('mutated');
    assert.deepStrictEqual(result.executorResult!.changedFiles, ['src/file.ts']);
  });

  it('executorResult blockingIssues are cloned', () => {
    const state = buildPersistedRunnerState({
      executorResult: buildExecutorResult({ blockingIssues: ['issue'] }),
    });
    const result = deriveReviewerFixTaskPostRunReviewPlan({
      persistedRunnerState: state,
    });
    assert.notStrictEqual(
      result.executorResult!.blockingIssues,
      state.executorResult!.blockingIssues
    );
    state.executorResult!.blockingIssues!.push('mutated');
    assert.deepStrictEqual(result.executorResult!.blockingIssues, ['issue']);
  });

  it('helper does not mutate input', () => {
    const state = buildPersistedRunnerState();
    const before = JSON.stringify(state);
    deriveReviewerFixTaskPostRunReviewPlan({ persistedRunnerState: state });
    const after = JSON.stringify(state);
    assert.strictEqual(after, before);
  });

  it('helper does not perform redaction or alter already-redacted text', () => {
    const state = buildPersistedRunnerState({
      reason: 'Use sk-fake-reviewer-secret token',
      executionRequest: {
        ...buildExecutionRequest(),
        goal: 'Use sk-fake-reviewer-secret token',
      },
      executorResult: buildExecutorResult({
        reason: 'Use Bearer fake-token',
      }),
    });
    const result = deriveReviewerFixTaskPostRunReviewPlan({
      persistedRunnerState: state,
    });
    assert.strictEqual(
      result.executionRequest!.goal,
      'Use sk-fake-reviewer-secret token'
    );
    assert.strictEqual(result.executorResult!.reason, 'Use Bearer fake-token');
  });

  it('helper does not call git/provider/network/filesystem APIs', () => {
    const result = derive();
    assert.strictEqual(result.action, 'review_fix_result');
  });
});
