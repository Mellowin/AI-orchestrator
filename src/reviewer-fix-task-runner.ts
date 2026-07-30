import type {
  ReviewerFixTaskRunPlanStateResult,
  ReviewerFixTaskRunPlanStateReady,
} from './reviewer-fix-task-run-plan-state.js';
import type { ReviewerFixTaskExecutionRequest } from './reviewer-pending-fix-task-execution-request.js';
import type { ReviewerFixTaskDraft } from './reviewer-fix-task-plan.js';
import { redactSecrets } from './sandbox-preflight-repair.js';

export type ReviewerFixTaskRunnerStatus =
  | 'not_ready'
  | 'blocked'
  | 'executed'
  | 'failed_attempt'
  | 'executor_failed';

export type ReviewerFixTaskRunnerNextAction =
  | 'wait'
  | 'block'
  | 'review_fix_result'
  | 'retry_fix';

export interface ReviewerFixTaskExecutorInput {
  executionRequest: ReviewerFixTaskExecutionRequest;
  fixTask: ReviewerFixTaskDraft;
  taskId: string;
  parentTaskId: string;
  attempt: number;
  title: string;
  goal: string;
  blockingIssues: string[];
}

export interface ReviewerFixTaskExecutorResult {
  status: 'completed' | 'blocked' | 'failed';
  reason: string;
  runState?: unknown;
  commitSha?: string;
  baseCommitSha?: string;
  changedFiles?: string[];
  blockingIssues?: string[];
  checkSummary?: {
    typecheck?: string;
    build?: string;
    test?: string;
    tests?: {
      total?: number;
      suites?: number;
      failures?: number;
    };
  };
  providerAttempts?: import('./types.js').ProviderAttempt[];
}

export type ReviewerFixTaskExecutor = (
  input: ReviewerFixTaskExecutorInput
) => Promise<ReviewerFixTaskExecutorResult> | ReviewerFixTaskExecutorResult;

export interface ReviewerFixTaskRunnerInput {
  runPlanState: ReviewerFixTaskRunPlanStateResult;
  executor: ReviewerFixTaskExecutor;
}

export interface ReviewerFixTaskRunnerResult {
  status: ReviewerFixTaskRunnerStatus;
  nextAction: ReviewerFixTaskRunnerNextAction;
  reason: string;
  executorCalled: boolean;
  taskId?: string;
  parentTaskId?: string;
  attempt?: number;
  executionRequest?: ReviewerFixTaskExecutionRequest;
  fixTask?: ReviewerFixTaskDraft;
  executorResult?: ReviewerFixTaskExecutorResult;
  blockingIssues: string[];
}

function cloneExecutionRequest(
  value: ReviewerFixTaskExecutionRequest
): ReviewerFixTaskExecutionRequest {
  return {
    kind: value.kind,
    status: value.status,
    source: value.source,
    taskId: value.taskId,
    parentTaskId: value.parentTaskId,
    attempt: value.attempt,
    title: value.title,
    goal: value.goal,
    blockingIssues: [...value.blockingIssues],
    task: {
      taskId: value.task.taskId,
      parentTaskId: value.task.parentTaskId,
      attempt: value.task.attempt,
      title: value.task.title,
      goal: value.task.goal,
      source: value.task.source,
      blockingIssues: [...value.task.blockingIssues],
    },
  };
}

function cloneFixTask(value: ReviewerFixTaskDraft): ReviewerFixTaskDraft {
  return {
    taskId: value.taskId,
    parentTaskId: value.parentTaskId,
    attempt: value.attempt,
    title: value.title,
    goal: value.goal,
    source: value.source,
    blockingIssues: [...value.blockingIssues],
  };
}

function cloneExecutorResult(
  value: ReviewerFixTaskExecutorResult
): ReviewerFixTaskExecutorResult {
  const result: ReviewerFixTaskExecutorResult = {
    status: value.status,
    reason: value.reason,
    runState: value.runState,
  };

  if (value.commitSha !== undefined) {
    result.commitSha = value.commitSha;
  }

  if (value.baseCommitSha !== undefined) {
    result.baseCommitSha = value.baseCommitSha;
  }

  if (value.changedFiles !== undefined) {
    result.changedFiles = [...value.changedFiles];
  }

  if (value.blockingIssues !== undefined) {
    result.blockingIssues = [...value.blockingIssues];
  }

  if (value.checkSummary !== undefined) {
    result.checkSummary = {
      typecheck: value.checkSummary.typecheck,
      build: value.checkSummary.build,
      test: value.checkSummary.test,
      tests: value.checkSummary.tests
        ? {
            total: value.checkSummary.tests.total,
            suites: value.checkSummary.tests.suites,
            failures: value.checkSummary.tests.failures,
          }
        : undefined,
    };
  }

  if (Array.isArray(value.providerAttempts)) {
    result.providerAttempts = value.providerAttempts.map((attempt) => ({ ...attempt }));
  }

  return result;
}

export async function runReviewerFixTaskWithExecutor(
  input: ReviewerFixTaskRunnerInput
): Promise<ReviewerFixTaskRunnerResult> {
  const { runPlanState, executor } = input;

  if (runPlanState.status === 'not_present') {
    return {
      status: 'not_ready',
      nextAction: 'wait',
      reason: 'No reviewer fix task run plan is present.',
      executorCalled: false,
      blockingIssues: [],
    };
  }

  if (runPlanState.status === 'invalid') {
    return {
      status: 'blocked',
      nextAction: 'block',
      reason:
        'Reviewer fix task run plan state is invalid; block for human review.',
      executorCalled: false,
      blockingIssues: [...runPlanState.blockingIssues],
    };
  }

  const ready = runPlanState as ReviewerFixTaskRunPlanStateReady;
  const executionRequest = cloneExecutionRequest(ready.executionRequest);
  const fixTask = cloneFixTask(ready.fixTask);
  const blockingIssues = [...ready.blockingIssues];

  const executorInput: ReviewerFixTaskExecutorInput = {
    executionRequest,
    fixTask,
    taskId: executionRequest.taskId,
    parentTaskId: executionRequest.parentTaskId,
    attempt: executionRequest.attempt,
    title: executionRequest.title,
    goal: executionRequest.goal,
    blockingIssues: [...blockingIssues],
  };

  try {
    const rawResult = await executor(executorInput);
    const result = cloneExecutorResult(rawResult);

    if (result.status === 'completed') {
      return {
        status: 'executed',
        nextAction: 'review_fix_result',
        reason: result.reason,
        executorCalled: true,
        taskId: executionRequest.taskId,
        parentTaskId: executionRequest.parentTaskId,
        attempt: executionRequest.attempt,
        executionRequest,
        fixTask,
        executorResult: result,
        blockingIssues: [...blockingIssues],
      };
    }

    if (result.status === 'failed') {
      return {
        status: 'failed_attempt',
        nextAction: 'retry_fix',
        reason: result.reason,
        executorCalled: true,
        taskId: executionRequest.taskId,
        parentTaskId: executionRequest.parentTaskId,
        attempt: executionRequest.attempt,
        executionRequest,
        fixTask,
        executorResult: result,
        blockingIssues: result.blockingIssues
          ? [...result.blockingIssues]
          : [...blockingIssues],
      };
    }

    return {
      status: 'blocked',
      nextAction: 'block',
      reason: result.reason,
      executorCalled: true,
      taskId: executionRequest.taskId,
      parentTaskId: executionRequest.parentTaskId,
      attempt: executionRequest.attempt,
      executionRequest,
      fixTask,
      executorResult: result,
      blockingIssues: result.blockingIssues
        ? [...result.blockingIssues]
        : [...blockingIssues],
    };
  } catch (err) {
    const rawMessage = err instanceof Error ? err.message : String(err);
    const redactedMessage = redactSecrets(rawMessage);
    return {
      status: 'executor_failed',
      nextAction: 'block',
      reason: `Executor failed: ${redactedMessage}`,
      executorCalled: true,
      taskId: executionRequest.taskId,
      parentTaskId: executionRequest.parentTaskId,
      attempt: executionRequest.attempt,
      executionRequest,
      fixTask,
      blockingIssues: [redactedMessage],
    };
  }
}
