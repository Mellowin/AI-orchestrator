import {
  deriveReviewerBlockDecision,
  type ReviewerBlockDecision,
  type ReviewerBlockDecisionInput,
} from './reviewer-block-decision.js';
import {
  deriveReviewerFixTaskPlan,
  type ReviewerFixTaskPlan,
} from './reviewer-fix-task-plan.js';
import {
  deriveReviewerBlockResolutionPlan,
  type ReviewerBlockResolutionPlan,
} from './reviewer-block-resolution-plan.js';

export interface ReviewerBlockReviewResultInput
  extends ReviewerBlockDecisionInput {
  existingFixAttemptsByParentTaskId?: Record<string, number>;
  maxFixAttempts: number;
}

export interface ReviewerBlockReviewResult {
  blockId: string;
  blockDecision: ReviewerBlockDecision;
  fixTaskPlan: ReviewerFixTaskPlan;
  resolutionPlan: ReviewerBlockResolutionPlan;
}

export function deriveReviewerBlockReviewResult(
  input: ReviewerBlockReviewResultInput
): ReviewerBlockReviewResult {
  const {
    blockId,
    tasks,
    existingFixAttemptsByParentTaskId,
    maxFixAttempts,
  } = input;

  const blockDecision = deriveReviewerBlockDecision({ blockId, tasks });

  const fixTaskPlan = deriveReviewerFixTaskPlan({
    blockId,
    actionPlan: blockDecision.actionPlan,
    existingFixAttemptsByParentTaskId,
    maxFixAttempts,
  });

  const resolutionPlan = deriveReviewerBlockResolutionPlan({
    blockId,
    actionPlan: blockDecision.actionPlan,
    fixTaskPlan,
  });

  return {
    blockId,
    blockDecision,
    fixTaskPlan,
    resolutionPlan,
  };
}
