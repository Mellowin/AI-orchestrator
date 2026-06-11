import type { ReviewerBlockActionPlan } from './reviewer-block-action-plan.js';

export type ReviewerFixTaskPlanAction =
  | 'no_fix_needed'
  | 'create_fix_task'
  | 'block_for_human'
  | 'wait';

export interface ReviewerFixTaskDraft {
  taskId: string;
  parentTaskId: string;
  title: string;
  goal: string;
  attempt: number;
  blockingIssues: string[];
  source: 'reviewer_gate';
}

export interface ReviewerFixTaskPlanInput {
  blockId: string;
  actionPlan: ReviewerBlockActionPlan;
  existingFixAttemptsByParentTaskId?: Record<string, number>;
  maxFixAttempts: number;
}

export interface ReviewerFixTaskPlan {
  blockId: string;
  action: ReviewerFixTaskPlanAction;
  reason: string;
  fixTask?: ReviewerFixTaskDraft;
  blockingIssues: string[];
}

export function deriveReviewerFixTaskPlan(
  input: ReviewerFixTaskPlanInput
): ReviewerFixTaskPlan {
  const { blockId, actionPlan, existingFixAttemptsByParentTaskId, maxFixAttempts } =
    input;

  const base = {
    blockId,
    blockingIssues: [...actionPlan.blockingIssues],
  };

  if (actionPlan.action === 'continue') {
    return {
      ...base,
      action: 'no_fix_needed',
      reason: 'Reviewer action plan is continue; no fix needed.',
    };
  }

  if (actionPlan.action === 'wait') {
    return {
      ...base,
      action: 'wait',
      reason: 'Reviewer action plan is wait; not ready for fix.',
    };
  }

  if (actionPlan.action === 'block_for_human') {
    return {
      ...base,
      action: 'block_for_human',
      reason: 'Reviewer action plan is block_for_human; human review required.',
    };
  }

  // create_fix_task
  const transition = actionPlan.selectedTransition;
  const fixTask = transition?.fixTask;

  if (!transition || !fixTask) {
    return {
      ...base,
      action: 'block_for_human',
      reason: 'Reviewer fix action missing fix task data; block for human review.',
    };
  }

  const parentTaskId = fixTask.parentTaskId;
  const existingAttempts = existingFixAttemptsByParentTaskId?.[parentTaskId] ?? 0;
  const nextAttempt = existingAttempts + 1;

  if (nextAttempt > maxFixAttempts) {
    return {
      ...base,
      action: 'block_for_human',
      reason: `Max fix attempts (${maxFixAttempts}) reached for ${parentTaskId}; block for human review.`,
    };
  }

  return {
    ...base,
    action: 'create_fix_task',
    reason: `Create reviewer fix task for ${parentTaskId} (attempt ${nextAttempt}).`,
    fixTask: {
      taskId: `fix-${parentTaskId}-reviewer-${nextAttempt}`,
      parentTaskId,
      title: fixTask.title,
      goal: fixTask.goal,
      attempt: nextAttempt,
      blockingIssues:
        fixTask.blockingIssues.length > 0
          ? [...fixTask.blockingIssues]
          : [...actionPlan.blockingIssues],
      source: 'reviewer_gate',
    },
  };
}
