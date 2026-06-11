export type ReviewerTaskOutcomeStatus =
  | 'legacy_success'
  | 'accepted'
  | 'fix_required'
  | 'blocked'
  | 'not_ready';

export type ReviewerTaskNextAction = 'continue' | 'fix' | 'block' | 'wait';

export interface PersistedReviewerGate {
  status: 'accepted' | 'fix_required' | 'blocked';
  source: 'reviewer' | 'parser' | 'deterministic_safety' | 'provider';
  nextAction: 'continue' | 'fix' | 'block';
  blockingIssues: string[];
  nonBlockingIssues: string[];
  reviewSummary: string;
  fixTask?: string;
}

export interface ReviewerTaskOutcomeInput {
  runState: {
    status?: string;
    commit_sha?: string;
    pushed?: boolean;
    reviewer_gate?: PersistedReviewerGate;
  } | null | undefined;
}

export interface ReviewerTaskOutcome {
  status: ReviewerTaskOutcomeStatus;
  nextAction: ReviewerTaskNextAction;
  reason: string;
  reviewerGate?: PersistedReviewerGate;
  fixTask?: string;
  blockingIssues: string[];
}

const COMPLETED_STATUSES = new Set(['pushed', 'committed', 'approved']);

export function deriveReviewerTaskOutcome(
  input: ReviewerTaskOutcomeInput
): ReviewerTaskOutcome {
  const runState = input.runState;

  if (!runState) {
    return {
      status: 'not_ready',
      nextAction: 'wait',
      reason: 'Run state is missing.',
      blockingIssues: [],
    };
  }

  if (!runState.status || !COMPLETED_STATUSES.has(runState.status)) {
    return {
      status: 'not_ready',
      nextAction: 'wait',
      reason: `Run not completed (status: ${runState.status ?? 'unknown'}).`,
      blockingIssues: [],
    };
  }

  const gate = runState.reviewer_gate;
  if (!gate) {
    return {
      status: 'legacy_success',
      nextAction: 'continue',
      reason: 'Reviewer gate absent; legacy success.',
      blockingIssues: [],
    };
  }

  if (gate.status === 'accepted') {
    return {
      status: 'accepted',
      nextAction: 'continue',
      reason: gate.reviewSummary || 'Reviewer gate accepted.',
      reviewerGate: { ...gate },
      blockingIssues: [],
    };
  }

  if (gate.status === 'fix_required') {
    return {
      status: 'fix_required',
      nextAction: 'fix',
      reason: gate.reviewSummary || 'Reviewer requested fix.',
      reviewerGate: { ...gate },
      fixTask: gate.fixTask,
      blockingIssues: [...gate.blockingIssues],
    };
  }

  // blocked
  return {
    status: 'blocked',
    nextAction: 'block',
    reason: gate.reviewSummary || 'Reviewer gate blocked.',
    reviewerGate: { ...gate },
    blockingIssues: [...gate.blockingIssues],
  };
}
