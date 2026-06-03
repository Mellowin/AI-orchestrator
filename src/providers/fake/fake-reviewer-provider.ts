import type { ReviewerProvider, ReviewInput, ReviewerDecision, ProviderId } from '../provider-types.js';

export interface FakeReviewerOptions {
  decision?: ReviewerDecision;
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

  return {
    id: 'fake' as ProviderId,
    role: 'reviewer',
    async reviewCommit(_input: ReviewInput): Promise<ReviewerDecision> {
      return options.decision ?? defaultAccepted;
    },
  };
}
