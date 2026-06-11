import type {
  PendingReviewerFixTaskExecutionPlan,
} from './reviewer-pending-fix-task-execution-plan.js';
import type { ReviewerFixTaskDraft } from './reviewer-fix-task-plan.js';

export type PendingReviewerFixTaskExecutionRequestAction =
  | 'no_request'
  | 'create_execution_request'
  | 'block_for_human';

export interface ReviewerFixTaskExecutionRequest {
  kind: 'reviewer_fix_task';
  status: 'pending';
  source: 'reviewer_gate';
  taskId: string;
  parentTaskId: string;
  attempt: number;
  title: string;
  goal: string;
  blockingIssues: string[];
  task: ReviewerFixTaskDraft;
}

export interface PendingReviewerFixTaskExecutionRequestInput {
  executionPlan: PendingReviewerFixTaskExecutionPlan;
}

export interface PendingReviewerFixTaskExecutionRequestResult {
  action: PendingReviewerFixTaskExecutionRequestAction;
  reason: string;
  executionRequest?: ReviewerFixTaskExecutionRequest;
  blockingIssues: string[];
}

function blockForHuman(
  reason: string,
  blockingIssues: string[]
): PendingReviewerFixTaskExecutionRequestResult {
  return {
    action: 'block_for_human',
    reason,
    blockingIssues: [...blockingIssues],
  };
}

export function derivePendingReviewerFixTaskExecutionRequest(
  input: PendingReviewerFixTaskExecutionRequestInput
): PendingReviewerFixTaskExecutionRequestResult {
  const { executionPlan } = input;

  if (executionPlan.action === 'no_op') {
    return {
      action: 'no_request',
      reason: 'No pending reviewer fix task execution request needed.',
      blockingIssues: [],
    };
  }

  if (executionPlan.action === 'block_for_human') {
    return {
      action: 'block_for_human',
      reason:
        'Pending reviewer fix task cannot be executed automatically; block for human review.',
      blockingIssues: [...executionPlan.blockingIssues],
    };
  }

  const issues: string[] = [];
  if (executionPlan.fixTask === undefined || executionPlan.fixTask === null) {
    issues.push(
      'Pending reviewer fix task execution plan is ready but fixTask is missing.'
    );
  }
  if (
    executionPlan.parentTaskId === undefined ||
    executionPlan.parentTaskId === null
  ) {
    issues.push(
      'Pending reviewer fix task execution plan is ready but parentTaskId is missing.'
    );
  }
  if (
    executionPlan.attempt === undefined ||
    executionPlan.attempt === null
  ) {
    issues.push(
      'Pending reviewer fix task execution plan is ready but attempt is missing.'
    );
  }

  if (issues.length > 0) {
    return blockForHuman(
      'Pending reviewer fix task execution plan is incomplete; block for human review.',
      issues
    );
  }

  const fixTask = executionPlan.fixTask!;
  const parentTaskId = executionPlan.parentTaskId!;
  const attempt = executionPlan.attempt!;

  const executionRequest: ReviewerFixTaskExecutionRequest = {
    kind: 'reviewer_fix_task',
    status: 'pending',
    source: 'reviewer_gate',
    taskId: fixTask.taskId,
    parentTaskId,
    attempt,
    title: fixTask.title,
    goal: fixTask.goal,
    blockingIssues: [...fixTask.blockingIssues],
    task: {
      taskId: fixTask.taskId,
      parentTaskId: fixTask.parentTaskId,
      title: fixTask.title,
      goal: fixTask.goal,
      attempt: fixTask.attempt,
      blockingIssues: [...fixTask.blockingIssues],
      source: fixTask.source,
    },
  };

  return {
    action: 'create_execution_request',
    reason:
      'Pending reviewer fix task execution request is ready for future execution.',
    executionRequest,
    blockingIssues: [...executionPlan.blockingIssues],
  };
}
