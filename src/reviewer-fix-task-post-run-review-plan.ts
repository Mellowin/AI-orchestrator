import type {
  PersistedReviewerFixTaskRunnerResultState,
  PersistedReviewerFixTaskExecutorResult,
} from './reviewer-fix-task-runner-result-state.js';
import type {
  ReviewerFixTaskExecutionRequest,
} from './reviewer-pending-fix-task-execution-request.js';
import type { ReviewerFixTaskDraft } from './reviewer-fix-task-plan.js';

export type ReviewerFixTaskPostRunReviewPlanAction =
  | 'no_op'
  | 'review_fix_result'
  | 'block_for_human';

export interface ReviewerFixTaskPostRunReviewPlanInput {
  persistedRunnerState: PersistedReviewerFixTaskRunnerResultState;
}

export interface ReviewerFixTaskPostRunReviewPlan {
  action: ReviewerFixTaskPostRunReviewPlanAction;
  reason: string;
  taskId?: string;
  parentTaskId?: string;
  attempt?: number;
  commitSha?: string;
  changedFiles: string[];
  executionRequest?: ReviewerFixTaskExecutionRequest;
  fixTask?: ReviewerFixTaskDraft;
  executorResult?: PersistedReviewerFixTaskExecutorResult;
  blockingIssues: string[];
}

const VALID_SHA = /^[0-9a-f]{40}$/i;

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
  value: PersistedReviewerFixTaskExecutorResult
): PersistedReviewerFixTaskExecutorResult {
  const result: PersistedReviewerFixTaskExecutorResult = {
    status: value.status,
    reason: value.reason,
    hasRunState: value.hasRunState,
  };

  if (value.commitSha !== undefined) {
    result.commitSha = value.commitSha;
  }

  if (value.changedFiles !== undefined) {
    result.changedFiles = [...value.changedFiles];
  }

  if (value.blockingIssues !== undefined) {
    result.blockingIssues = [...value.blockingIssues];
  }

  return result;
}

function changedFilesFromExecutorResult(
  executorResult: PersistedReviewerFixTaskExecutorResult | undefined
): string[] {
  if (executorResult?.changedFiles !== undefined) {
    return [...executorResult.changedFiles];
  }
  return [];
}

function blockForHuman(
  reason: string,
  input: PersistedReviewerFixTaskRunnerResultState
): ReviewerFixTaskPostRunReviewPlan {
  return {
    action: 'block_for_human',
    reason,
    taskId: input.taskId,
    parentTaskId: input.parentTaskId,
    attempt: input.attempt,
    changedFiles: changedFilesFromExecutorResult(input.executorResult),
    executionRequest:
      input.executionRequest !== undefined
        ? cloneExecutionRequest(input.executionRequest)
        : undefined,
    fixTask:
      input.fixTask !== undefined ? cloneFixTask(input.fixTask) : undefined,
    executorResult:
      input.executorResult !== undefined
        ? cloneExecutorResult(input.executorResult)
        : undefined,
    blockingIssues: [...input.blockingIssues],
  };
}

export function deriveReviewerFixTaskPostRunReviewPlan(
  input: ReviewerFixTaskPostRunReviewPlanInput
): ReviewerFixTaskPostRunReviewPlan {
  const state = input.persistedRunnerState;

  if (state.status === 'not_ready') {
    return {
      action: 'no_op',
      reason: 'No completed reviewer fix task run is available for review.',
      changedFiles: [],
      blockingIssues: [],
    };
  }

  if (state.status === 'blocked') {
    return blockForHuman(
      'Reviewer fix task run is blocked; human review required.',
      state
    );
  }

  if (state.status === 'executor_failed') {
    return blockForHuman(
      'Reviewer fix task executor failed; block for human review.',
      state
    );
  }

  // state.status === 'executed'

  if (state.nextAction !== 'review_fix_result') {
    return blockForHuman(
      'Executed reviewer fix task run does not expect a review pass; block for human review.',
      state
    );
  }

  if (state.executorResult === undefined) {
    return blockForHuman(
      'Executed reviewer fix task run is missing executor result; block for human review.',
      {
        ...state,
        blockingIssues: [
          ...state.blockingIssues,
          'Executed reviewer fix task run is missing executor result.',
        ],
      }
    );
  }

  if (state.executorResult.status !== 'completed') {
    return blockForHuman(
      'Executed reviewer fix task run has non-completed executor status; block for human review.',
      {
        ...state,
        blockingIssues: [
          ...state.blockingIssues,
          'Executed reviewer fix task run has non-completed executor status.',
        ],
      }
    );
  }

  const commitSha = state.executorResult.commitSha;
  if (commitSha === undefined || !VALID_SHA.test(commitSha)) {
    return blockForHuman(
      'Executed reviewer fix task run is missing a valid full commit SHA; block for human review.',
      {
        ...state,
        blockingIssues: [
          ...state.blockingIssues,
          'Executed reviewer fix task run is missing a valid full 40-character hex commit SHA.',
        ],
      }
    );
  }

  return {
    action: 'review_fix_result',
    reason: 'Fix task run is ready for a reviewer pass.',
    taskId: state.taskId,
    parentTaskId: state.parentTaskId,
    attempt: state.attempt,
    commitSha,
    changedFiles: changedFilesFromExecutorResult(state.executorResult),
    executionRequest:
      state.executionRequest !== undefined
        ? cloneExecutionRequest(state.executionRequest)
        : undefined,
    fixTask:
      state.fixTask !== undefined ? cloneFixTask(state.fixTask) : undefined,
    executorResult: cloneExecutorResult(state.executorResult),
    blockingIssues: [...state.blockingIssues],
  };
}
