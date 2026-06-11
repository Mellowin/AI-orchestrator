import type { ReviewerTaskOutcome } from './reviewer-task-outcome.js';

export type ReviewerTaskTransitionAction =
  | 'continue'
  | 'create_fix_task'
  | 'block_for_human'
  | 'wait';

export interface ReviewerTaskTransitionInput {
  outcome: ReviewerTaskOutcome;
  originalTaskId: string;
  originalTaskTitle?: string;
  originalTaskGoal?: string;
}

export interface ReviewerTaskTransition {
  action: ReviewerTaskTransitionAction;
  reason: string;
  taskId: string;
  fixTask?: {
    parentTaskId: string;
    title: string;
    goal: string;
    blockingIssues: string[];
  };
  blockingIssues: string[];
}

export function deriveReviewerTaskTransition(
  input: ReviewerTaskTransitionInput
): ReviewerTaskTransition {
  const { outcome, originalTaskId, originalTaskTitle } = input;

  const base = {
    taskId: originalTaskId,
    blockingIssues: [...outcome.blockingIssues],
  };

  if (outcome.status === 'legacy_success') {
    return {
      ...base,
      action: 'continue',
      reason: outcome.reason || 'Legacy success; continue.',
    };
  }

  if (outcome.status === 'accepted') {
    return {
      ...base,
      action: 'continue',
      reason: outcome.reason || 'Reviewer gate accepted; continue.',
    };
  }

  if (outcome.status === 'fix_required') {
    const goal = outcome.fixTask
      ? outcome.fixTask
      : `Fix reviewer blocking issues: ${outcome.blockingIssues.join('; ')}`;
    return {
      ...base,
      action: 'create_fix_task',
      reason: outcome.reason || 'Reviewer requested fix; create fix task.',
      fixTask: {
        parentTaskId: originalTaskId,
        title: originalTaskTitle
          ? `Fix reviewer issues for ${originalTaskTitle}`
          : `Fix reviewer issues for ${originalTaskId}`,
        goal,
        blockingIssues: [...outcome.blockingIssues],
      },
    };
  }

  if (outcome.status === 'blocked') {
    return {
      ...base,
      action: 'block_for_human',
      reason: outcome.reason || 'Reviewer gate blocked; human review required.',
    };
  }

  // not_ready
  return {
    ...base,
    action: 'wait',
    reason: outcome.reason || 'Reviewer task outcome not ready; wait.',
  };
}
