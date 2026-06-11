import type {
  PendingReviewerFixTaskStateResult,
  PendingReviewerFixTaskStateReady,
} from './reviewer-pending-fix-task-state.js';
import type { ReviewerFixTaskDraft } from './reviewer-fix-task-plan.js';

export type PendingReviewerFixTaskExecutionAction =
  | 'no_op'
  | 'ready_to_execute'
  | 'block_for_human';

export interface PendingReviewerFixTaskExecutionPlanInput {
  pendingFixTaskState: PendingReviewerFixTaskStateResult;
}

export interface PendingReviewerFixTaskExecutionPlan {
  action: PendingReviewerFixTaskExecutionAction;
  reason: string;
  fixTask?: ReviewerFixTaskDraft;
  parentTaskId?: string;
  attempt?: number;
  blockingIssues: string[];
}

export function derivePendingReviewerFixTaskExecutionPlan(
  input: PendingReviewerFixTaskExecutionPlanInput
): PendingReviewerFixTaskExecutionPlan {
  const { pendingFixTaskState } = input;

  if (pendingFixTaskState.status === 'not_present') {
    return {
      action: 'no_op',
      reason: 'No pending reviewer fix task is present.',
      blockingIssues: [],
    };
  }

  if (pendingFixTaskState.status === 'invalid') {
    return {
      action: 'block_for_human',
      reason:
        'Pending reviewer fix task state is invalid; block for human review.',
      blockingIssues: [...pendingFixTaskState.blockingIssues],
    };
  }

  const ready = pendingFixTaskState as PendingReviewerFixTaskStateReady;
  const task = ready.pendingFixTask.task;

  return {
    action: 'ready_to_execute',
    reason: 'Pending reviewer fix task is ready for future execution.',
    fixTask: {
      taskId: task.taskId,
      parentTaskId: task.parentTaskId,
      title: task.title,
      goal: task.goal,
      attempt: task.attempt,
      blockingIssues: [...task.blockingIssues],
      source: task.source,
    },
    parentTaskId: ready.pendingFixTask.parentTaskId,
    attempt: ready.pendingFixTask.attempt,
    blockingIssues: [...pendingFixTaskState.blockingIssues],
  };
}
