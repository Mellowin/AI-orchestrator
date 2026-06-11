import {
  deriveReviewerTaskOutcome,
  type ReviewerTaskOutcomeInput,
  type ReviewerTaskOutcome,
} from './reviewer-task-outcome.js';
import {
  deriveReviewerTaskTransition,
  type ReviewerTaskTransition,
} from './reviewer-task-transition.js';

export interface ReviewerTaskDecisionInput extends ReviewerTaskOutcomeInput {
  originalTaskId: string;
  originalTaskTitle?: string;
  originalTaskGoal?: string;
}

export interface ReviewerTaskDecision {
  outcome: ReviewerTaskOutcome;
  transition: ReviewerTaskTransition;
}

export function deriveReviewerTaskDecision(
  input: ReviewerTaskDecisionInput
): ReviewerTaskDecision {
  const outcome = deriveReviewerTaskOutcome({ runState: input.runState });
  const transition = deriveReviewerTaskTransition({
    outcome,
    originalTaskId: input.originalTaskId,
    originalTaskTitle: input.originalTaskTitle,
    originalTaskGoal: input.originalTaskGoal,
  });
  return { outcome, transition };
}
