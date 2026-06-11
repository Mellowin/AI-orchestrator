import type { ReviewerBlockActionPlan } from './reviewer-block-action-plan.js';
import type { ReviewerFixTaskPlan, ReviewerFixTaskDraft } from './reviewer-fix-task-plan.js';

export type ReviewerBlockResolutionAction =
  | 'continue_block'
  | 'append_fix_task'
  | 'block_for_human'
  | 'wait';

export type ReviewerBlockResolutionStatus =
  | 'ready_to_continue'
  | 'needs_fix'
  | 'blocked'
  | 'not_ready';

export interface ReviewerBlockResolutionPlanInput {
  blockId: string;
  actionPlan: ReviewerBlockActionPlan;
  fixTaskPlan: ReviewerFixTaskPlan;
}

export interface ReviewerBlockResolutionPlan {
  blockId: string;
  action: ReviewerBlockResolutionAction;
  status: ReviewerBlockResolutionStatus;
  reason: string;
  selectedTaskId?: string;
  fixTask?: ReviewerFixTaskDraft;
  blockingIssues: string[];
}

function cloneFixTask(fixTask: ReviewerFixTaskDraft): ReviewerFixTaskDraft {
  return {
    ...fixTask,
    blockingIssues: [...fixTask.blockingIssues],
  };
}

export function deriveReviewerBlockResolutionPlan(
  input: ReviewerBlockResolutionPlanInput
): ReviewerBlockResolutionPlan {
  const { blockId, actionPlan, fixTaskPlan } = input;

  if (fixTaskPlan.action === 'create_fix_task') {
    return {
      blockId,
      action: 'append_fix_task',
      status: 'needs_fix',
      reason: `Append reviewer fix task for ${actionPlan.selectedTaskId ?? 'unknown task'}.`,
      selectedTaskId: actionPlan.selectedTaskId,
      fixTask: fixTaskPlan.fixTask
        ? cloneFixTask(fixTaskPlan.fixTask)
        : undefined,
      blockingIssues:
        fixTaskPlan.blockingIssues.length > 0
          ? [...fixTaskPlan.blockingIssues]
          : [...actionPlan.blockingIssues],
    };
  }

  if (fixTaskPlan.action === 'block_for_human') {
    return {
      blockId,
      action: 'block_for_human',
      status: 'blocked',
      reason: 'Block requires human review.',
      selectedTaskId: actionPlan.selectedTaskId,
      blockingIssues: [...fixTaskPlan.blockingIssues],
    };
  }

  if (fixTaskPlan.action === 'wait') {
    return {
      blockId,
      action: 'wait',
      status: 'not_ready',
      reason: 'Block is not ready to resolve.',
      selectedTaskId: actionPlan.selectedTaskId,
      blockingIssues: [...fixTaskPlan.blockingIssues],
    };
  }

  // fixTaskPlan.action === 'no_fix_needed'
  if (actionPlan.action === 'create_fix_task') {
    return {
      blockId,
      action: 'block_for_human',
      status: 'blocked',
      reason: 'Inconsistent reviewer fix plan: action expects fix but fix plan says none needed; block for human review.',
      selectedTaskId: actionPlan.selectedTaskId,
      blockingIssues: [...actionPlan.blockingIssues],
    };
  }

  if (actionPlan.action === 'block_for_human') {
    return {
      blockId,
      action: 'block_for_human',
      status: 'blocked',
      reason: 'Inconsistent reviewer block plan: action expects human review but fix plan says none needed; block for human review.',
      selectedTaskId: actionPlan.selectedTaskId,
      blockingIssues: [...actionPlan.blockingIssues],
    };
  }

  if (actionPlan.action === 'wait') {
    return {
      blockId,
      action: 'wait',
      status: 'not_ready',
      reason: 'Inconsistent reviewer wait plan: action is wait but fix plan says none needed; wait.',
      selectedTaskId: actionPlan.selectedTaskId,
      blockingIssues: [...actionPlan.blockingIssues],
    };
  }

  return {
    blockId,
    action: 'continue_block',
    status: 'ready_to_continue',
    reason: 'No reviewer fix needed; continue block.',
    blockingIssues: [],
  };
}
