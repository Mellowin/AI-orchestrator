import type { ReviewerTaskDecision } from './reviewer-task-decision.js';
import type { ReviewerTaskTransition } from './reviewer-task-transition.js';

export type ReviewerBlockAction =
  | 'continue'
  | 'create_fix_task'
  | 'block_for_human'
  | 'wait';

export interface ReviewerBlockActionPlanInput {
  blockId: string;
  decisions: ReviewerTaskDecision[];
}

export interface ReviewerBlockActionPlan {
  blockId: string;
  action: ReviewerBlockAction;
  reason: string;
  selectedTaskId?: string;
  selectedTransition?: ReviewerTaskTransition;
  blockingIssues: string[];
}

function cloneTransition(transition: ReviewerTaskTransition): ReviewerTaskTransition {
  const cloned: ReviewerTaskTransition = {
    ...transition,
    blockingIssues: [...transition.blockingIssues],
  };
  if (transition.fixTask) {
    cloned.fixTask = {
      ...transition.fixTask,
      blockingIssues: [...transition.fixTask.blockingIssues],
    };
  }
  return cloned;
}

export function deriveReviewerBlockActionPlan(
  input: ReviewerBlockActionPlanInput
): ReviewerBlockActionPlan {
  const { blockId, decisions } = input;

  if (decisions.length === 0) {
    return {
      blockId,
      action: 'wait',
      reason: 'No reviewer task decisions available; wait.',
      blockingIssues: [],
    };
  }

  const block = decisions.find(
    (d) => d.transition.action === 'block_for_human'
  );
  if (block) {
    return {
      blockId,
      action: 'block_for_human',
      reason: 'At least one task is blocked for human review.',
      selectedTaskId: block.transition.taskId,
      selectedTransition: cloneTransition(block.transition),
      blockingIssues: [...block.transition.blockingIssues],
    };
  }

  const fix = decisions.find(
    (d) => d.transition.action === 'create_fix_task'
  );
  if (fix) {
    return {
      blockId,
      action: 'create_fix_task',
      reason: 'At least one task requires a fix.',
      selectedTaskId: fix.transition.taskId,
      selectedTransition: cloneTransition(fix.transition),
      blockingIssues: [...fix.transition.blockingIssues],
    };
  }

  const wait = decisions.find((d) => d.transition.action === 'wait');
  if (wait) {
    return {
      blockId,
      action: 'wait',
      reason: 'At least one task is not ready; wait.',
      selectedTaskId: wait.transition.taskId,
      selectedTransition: cloneTransition(wait.transition),
      blockingIssues: [...wait.transition.blockingIssues],
    };
  }

  const allContinue = decisions.every(
    (d) => d.transition.action === 'continue'
  );
  if (allContinue) {
    return {
      blockId,
      action: 'continue',
      reason: 'All reviewer decisions allow continuing.',
      blockingIssues: [],
    };
  }

  return {
    blockId,
    action: 'block_for_human',
    reason: 'Unsupported transition state; block for human review.',
    blockingIssues: [],
  };
}
