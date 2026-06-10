import type { ReviewerDecision, ReviewerDecisionValue, ReviewerConfidence, ReviewerNextAction } from './reviewer-types.js';

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function redactSecrets(message: string): string {
  return message
    .replace(/sk-[^\s]*/g, '[REDACTED]')
    .replace(/Bearer\s+[^\s]*/gi, 'Bearer [REDACTED]')
    .trim();
}

function safeError(message: string): Error {
  return new Error(redactSecrets(message));
}

export function validateReviewerDecision(value: unknown): ReviewerDecision {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw safeError('ReviewerDecision must be an object');
  }

  const obj = value as Record<string, unknown>;

  // decision
  const decision = obj.decision;
  if (decision !== 'accepted' && decision !== 'rejected') {
    throw safeError('ReviewerDecision.decision must be "accepted" or "rejected"');
  }

  // confidence
  const confidence = obj.confidence;
  if (confidence !== 'low' && confidence !== 'medium' && confidence !== 'high') {
    throw safeError('ReviewerDecision.confidence must be "low", "medium", or "high"');
  }

  // blocking_issues
  const blockingIssues = obj.blocking_issues;
  if (!isStringArray(blockingIssues)) {
    throw safeError('ReviewerDecision.blocking_issues must be an array of strings');
  }

  // non_blocking_issues
  const nonBlockingIssues = obj.non_blocking_issues;
  if (!isStringArray(nonBlockingIssues)) {
    throw safeError('ReviewerDecision.non_blocking_issues must be an array of strings');
  }

  // review_summary
  const reviewSummary = obj.review_summary;
  if (typeof reviewSummary !== 'string') {
    throw safeError('ReviewerDecision.review_summary must be a string');
  }

  // fix_task
  const fixTask = obj.fix_task;
  if (fixTask !== null && typeof fixTask !== 'string') {
    throw safeError('ReviewerDecision.fix_task must be a string or null');
  }

  // next_action
  const nextAction = obj.next_action;
  if (
    nextAction !== 'advance_to_next_task' &&
    nextAction !== 'send_fix_to_coder' &&
    nextAction !== 'block_for_human'
  ) {
    throw safeError(
      'ReviewerDecision.next_action must be "advance_to_next_task", "send_fix_to_coder", or "block_for_human"'
    );
  }

  // Logical rules
  if (decision === 'accepted') {
    if (blockingIssues.length > 0) {
      throw safeError('Accepted decision must have empty blocking_issues');
    }
    if (nextAction !== 'advance_to_next_task') {
      throw safeError('Accepted decision must have next_action "advance_to_next_task"');
    }
  }

  if (decision === 'rejected') {
    if (blockingIssues.length === 0 && (fixTask === null || fixTask === '')) {
      throw safeError(
        'Rejected decision must have either blocking_issues or fix_task'
      );
    }
    if (nextAction !== 'send_fix_to_coder' && nextAction !== 'block_for_human') {
      throw safeError(
        'Rejected decision must have next_action "send_fix_to_coder" or "block_for_human"'
      );
    }
  }

  return {
    decision: decision as ReviewerDecisionValue,
    confidence: confidence as ReviewerConfidence,
    blocking_issues: blockingIssues,
    non_blocking_issues: nonBlockingIssues,
    review_summary: reviewSummary,
    fix_task: fixTask,
    next_action: nextAction as ReviewerNextAction,
  };
}
