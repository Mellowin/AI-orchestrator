export type ReviewerDecisionValue = 'accept' | 'reject' | 'block_for_human';
export type ReviewerConfidence = 'low' | 'medium' | 'high';
export type ReviewerNextAction = 'continue' | 'fix' | 'block';

export interface ReviewerDecision {
  decision: ReviewerDecisionValue;
  confidence: ReviewerConfidence;
  blockingIssues: string[];
  nonBlockingIssues: string[];
  reviewSummary: string;
  fixTask?: string;
  nextAction: ReviewerNextAction;
}

export interface ReviewerDecisionParseResult {
  ok: boolean;
  decision?: ReviewerDecision;
  error?: string;
}

const ALLOWED_DECISIONS: ReviewerDecisionValue[] = ['accept', 'reject', 'block_for_human'];
const ALLOWED_CONFIDENCE: ReviewerConfidence[] = ['low', 'medium', 'high'];
const ALLOWED_NEXT_ACTIONS: ReviewerNextAction[] = ['continue', 'fix', 'block'];

export function parseReviewerDecision(
  input: string | unknown
): ReviewerDecisionParseResult {
  let obj: unknown;

  if (typeof input === 'string') {
    try {
      obj = JSON.parse(input);
    } catch {
      return { ok: false, error: 'Invalid JSON string' };
    }
  } else {
    obj = input;
  }

  if (obj === null || typeof obj !== 'object') {
    return { ok: false, error: 'Input is not an object' };
  }

  const o = obj as Record<string, unknown>;

  // decision
  if (
    !('decision' in o) ||
    typeof o.decision !== 'string' ||
    !ALLOWED_DECISIONS.includes(o.decision as ReviewerDecisionValue)
  ) {
    return { ok: false, error: 'Invalid or missing decision' };
  }
  const decision = o.decision as ReviewerDecisionValue;

  // confidence
  if (
    !('confidence' in o) ||
    typeof o.confidence !== 'string' ||
    !ALLOWED_CONFIDENCE.includes(o.confidence as ReviewerConfidence)
  ) {
    return { ok: false, error: 'Invalid or missing confidence' };
  }
  const confidence = o.confidence as ReviewerConfidence;

  // blockingIssues
  if (
    !('blockingIssues' in o) ||
    !Array.isArray(o.blockingIssues) ||
    !o.blockingIssues.every((i) => typeof i === 'string')
  ) {
    return { ok: false, error: 'Invalid or missing blockingIssues' };
  }
  const blockingIssues = o.blockingIssues as string[];

  // nonBlockingIssues
  if (
    !('nonBlockingIssues' in o) ||
    !Array.isArray(o.nonBlockingIssues) ||
    !o.nonBlockingIssues.every((i) => typeof i === 'string')
  ) {
    return { ok: false, error: 'Invalid or missing nonBlockingIssues' };
  }
  const nonBlockingIssues = o.nonBlockingIssues as string[];

  // reviewSummary
  if (!('reviewSummary' in o) || typeof o.reviewSummary !== 'string') {
    return { ok: false, error: 'Invalid or missing reviewSummary' };
  }
  const reviewSummary = o.reviewSummary as string;

  // nextAction
  if (
    !('nextAction' in o) ||
    typeof o.nextAction !== 'string' ||
    !ALLOWED_NEXT_ACTIONS.includes(o.nextAction as ReviewerNextAction)
  ) {
    return { ok: false, error: 'Invalid or missing nextAction' };
  }
  const nextAction = o.nextAction as ReviewerNextAction;

  // fixTask (optional)
  let fixTask: string | undefined;
  if ('fixTask' in o) {
    if (typeof o.fixTask !== 'string') {
      return { ok: false, error: 'fixTask must be a string' };
    }
    fixTask = o.fixTask;
  }

  // decision / nextAction consistency
  if (decision === 'accept' && nextAction !== 'continue') {
    return { ok: false, error: 'accept decision requires nextAction continue' };
  }
  if (decision === 'reject' && nextAction !== 'fix') {
    return { ok: false, error: 'reject decision requires nextAction fix' };
  }
  if (decision === 'block_for_human' && nextAction !== 'block') {
    return { ok: false, error: 'block_for_human decision requires nextAction block' };
  }

  // reject additional rules
  if (decision === 'reject') {
    if (blockingIssues.length === 0) {
      return { ok: false, error: 'reject decision requires non-empty blockingIssues' };
    }
    if (!fixTask || fixTask.length === 0) {
      return { ok: false, error: 'reject decision requires non-empty fixTask' };
    }
  }

  // block_for_human additional rule
  if (decision === 'block_for_human' && blockingIssues.length === 0) {
    return { ok: false, error: 'block_for_human decision requires non-empty blockingIssues' };
  }

  return {
    ok: true,
    decision: {
      decision,
      confidence,
      blockingIssues,
      nonBlockingIssues,
      reviewSummary,
      fixTask,
      nextAction,
    },
  };
}
