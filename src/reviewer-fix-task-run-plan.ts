import type {
  PendingReviewerFixTaskExecutionRequestStateResult,
  PendingReviewerFixTaskExecutionRequestStateReady,
} from './reviewer-pending-fix-task-execution-request-state.js';
import type { ReviewerFixTaskExecutionRequest } from './reviewer-pending-fix-task-execution-request.js';
import type { ReviewerFixTaskDraft } from './reviewer-fix-task-plan.js';

export type ReviewerFixTaskRunPlanAction =
  | 'no_op'
  | 'run_fix_task'
  | 'block_for_human';

export interface ReviewerFixTaskRunPlanInput {
  executionRequestState: PendingReviewerFixTaskExecutionRequestStateResult;
}

export interface ReviewerFixTaskRunPlan {
  action: ReviewerFixTaskRunPlanAction;
  reason: string;
  executionRequest?: ReviewerFixTaskExecutionRequest;
  fixTask?: ReviewerFixTaskDraft;
  taskId?: string;
  parentTaskId?: string;
  attempt?: number;
  title?: string;
  goal?: string;
  blockingIssues: string[];
}

export function deriveReviewerFixTaskRunPlan(
  input: ReviewerFixTaskRunPlanInput
): ReviewerFixTaskRunPlan {
  const { executionRequestState } = input;

  if (executionRequestState.status === 'not_present') {
    return {
      action: 'no_op',
      reason: 'No pending reviewer fix task execution request is present.',
      blockingIssues: [],
    };
  }

  if (executionRequestState.status === 'invalid') {
    return {
      action: 'block_for_human',
      reason:
        'Pending reviewer fix task execution request state is invalid; block for human review.',
      blockingIssues: [...executionRequestState.blockingIssues],
    };
  }

  const ready = executionRequestState as PendingReviewerFixTaskExecutionRequestStateReady;
  const executionRequest = ready.executionRequest;

  const clonedExecutionRequest: ReviewerFixTaskExecutionRequest = {
    kind: executionRequest.kind,
    status: executionRequest.status,
    source: executionRequest.source,
    taskId: executionRequest.taskId,
    parentTaskId: executionRequest.parentTaskId,
    attempt: executionRequest.attempt,
    title: executionRequest.title,
    goal: executionRequest.goal,
    blockingIssues: [...executionRequest.blockingIssues],
    task: {
      taskId: executionRequest.task.taskId,
      parentTaskId: executionRequest.task.parentTaskId,
      attempt: executionRequest.task.attempt,
      title: executionRequest.task.title,
      goal: executionRequest.task.goal,
      source: executionRequest.task.source,
      blockingIssues: [...executionRequest.task.blockingIssues],
    },
  };

  const fixTask: ReviewerFixTaskDraft = clonedExecutionRequest.task;

  return {
    action: 'run_fix_task',
    reason: 'Reviewer fix task is ready for future execution.',
    executionRequest: clonedExecutionRequest,
    fixTask,
    taskId: clonedExecutionRequest.taskId,
    parentTaskId: clonedExecutionRequest.parentTaskId,
    attempt: clonedExecutionRequest.attempt,
    title: clonedExecutionRequest.title,
    goal: clonedExecutionRequest.goal,
    blockingIssues: [...clonedExecutionRequest.blockingIssues],
  };
}
