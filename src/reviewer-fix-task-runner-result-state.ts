import type {
  ReviewerFixTaskRunnerResult,
  ReviewerFixTaskExecutorResult,
} from './reviewer-fix-task-runner.js';
import type { ReviewerFixTaskExecutionRequest } from './reviewer-pending-fix-task-execution-request.js';
import type { ReviewerFixTaskDraft } from './reviewer-fix-task-plan.js';
import { redactSecrets } from './sandbox-preflight-repair.js';

export interface PersistedReviewerFixTaskExecutorResult {
  status: 'completed' | 'blocked';
  reason: string;
  commitSha?: string;
  changedFiles?: string[];
  blockingIssues?: string[];
  hasRunState: boolean;
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
}

export interface PersistedReviewerFixTaskRunnerResultState {
  status: ReviewerFixTaskRunnerResult['status'];
  nextAction: ReviewerFixTaskRunnerResult['nextAction'];
  reason: string;
  executorCalled: boolean;
  taskId?: string;
  parentTaskId?: string;
  attempt?: number;
  executionRequest?: ReviewerFixTaskExecutionRequest;
  fixTask?: ReviewerFixTaskDraft;
  executorResult?: PersistedReviewerFixTaskExecutorResult;
  blockingIssues: string[];
}

export interface PersistReviewerFixTaskRunnerResultStateInput {
  runnerResult: ReviewerFixTaskRunnerResult;
}

function redactString(value: string): string {
  return redactSecrets(value);
}

function redactStrings(values: string[]): string[] {
  return values.map(redactString);
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

function buildPersistedExecutorResult(
  value: ReviewerFixTaskExecutorResult
): PersistedReviewerFixTaskExecutorResult {
  const hasRunState = 'runState' in value;
  const result: PersistedReviewerFixTaskExecutorResult = {
    status: value.status,
    reason: redactString(value.reason),
    hasRunState,
  };

  if (value.commitSha !== undefined) {
    result.commitSha = value.commitSha;
  }

  if (value.changedFiles !== undefined) {
    result.changedFiles = [...value.changedFiles];
  }

  if (value.blockingIssues !== undefined) {
    result.blockingIssues = redactStrings(value.blockingIssues);
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

  return result;
}

export function buildPersistedReviewerFixTaskRunnerResultState(
  input: PersistReviewerFixTaskRunnerResultStateInput
): PersistedReviewerFixTaskRunnerResultState {
  const { runnerResult } = input;

  const state: PersistedReviewerFixTaskRunnerResultState = {
    status: runnerResult.status,
    nextAction: runnerResult.nextAction,
    reason: redactString(runnerResult.reason),
    executorCalled: runnerResult.executorCalled,
    blockingIssues: redactStrings(runnerResult.blockingIssues),
  };

  if (runnerResult.taskId !== undefined) {
    state.taskId = runnerResult.taskId;
  }

  if (runnerResult.parentTaskId !== undefined) {
    state.parentTaskId = runnerResult.parentTaskId;
  }

  if (runnerResult.attempt !== undefined) {
    state.attempt = runnerResult.attempt;
  }

  if (runnerResult.executionRequest !== undefined) {
    state.executionRequest = cloneExecutionRequest(runnerResult.executionRequest);
  }

  if (runnerResult.fixTask !== undefined) {
    state.fixTask = cloneFixTask(runnerResult.fixTask);
  }

  if (runnerResult.executorResult !== undefined) {
    state.executorResult = buildPersistedExecutorResult(
      runnerResult.executorResult
    );
  }

  return state;
}
