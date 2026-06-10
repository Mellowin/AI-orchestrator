import type { ReviewerProvider, ReviewInput, ReviewerDecision, ProviderId } from '../provider-types.js';

export interface FakeReviewerOptions {
  decision?: ReviewerDecision;
  decisions?: ReviewerDecision[];
  decisionIndex?: number;
}

export function createFakeReviewerProvider(options: FakeReviewerOptions = {}): ReviewerProvider {
  const defaultAccepted: ReviewerDecision = {
    decision: 'accepted',
    confidence: 'high',
    blocking_issues: [],
    non_blocking_issues: [],
    review_summary: 'Fake reviewer accepts everything by default',
    fix_task: null,
    next_action: 'advance_to_next_task',
  };

  let index = 0;

  function nextDecision(): ReviewerDecision {
    if (options.decisions && options.decisions.length > 0) {
      const idx = options.decisionIndex ?? 0;
      const result = options.decisions[idx % options.decisions.length];
      options.decisionIndex = idx + 1;
      return result;
    }
    return options.decision ?? defaultAccepted;
  }

  return {
    id: 'fake' as ProviderId,
    role: 'reviewer',
    async reviewCommit(_input: ReviewInput): Promise<ReviewerDecision> {
      return nextDecision();
    },
  };
}
