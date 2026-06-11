import {
  deriveReviewerTaskDecision,
  type ReviewerTaskDecision,
} from './reviewer-task-decision.js';
import {
  deriveReviewerBlockActionPlan,
  type ReviewerBlockActionPlan,
} from './reviewer-block-action-plan.js';
import type { PersistedReviewerGate } from './reviewer-task-outcome.js';

export interface ReviewerBlockTaskInput {
  taskId: string;
  taskTitle?: string;
  taskGoal?: string;
  runState: {
    status?: string;
    commit_sha?: string;
    pushed?: boolean;
    reviewer_gate?: PersistedReviewerGate;
  } | null | undefined;
}

export interface ReviewerBlockDecisionInput {
  blockId: string;
  tasks: ReviewerBlockTaskInput[];
}

export interface ReviewerBlockDecision {
  blockId: string;
  taskDecisions: ReviewerTaskDecision[];
  actionPlan: ReviewerBlockActionPlan;
}

export function deriveReviewerBlockDecision(
  input: ReviewerBlockDecisionInput
): ReviewerBlockDecision {
  const taskDecisions = input.tasks.map((task) =>
    deriveReviewerTaskDecision({
      runState: task.runState,
      originalTaskId: task.taskId,
      originalTaskTitle: task.taskTitle,
      originalTaskGoal: task.taskGoal,
    })
  );

  const actionPlan = deriveReviewerBlockActionPlan({
    blockId: input.blockId,
    decisions: taskDecisions,
  });

  return {
    blockId: input.blockId,
    taskDecisions,
    actionPlan,
  };
}
