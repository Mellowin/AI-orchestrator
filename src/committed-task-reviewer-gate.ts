import { buildReviewerEvidence } from './reviewer-evidence.js';
import { runReviewerGateWithProvider } from './reviewer-provider-runner.js';
import type { ReviewerEvidenceInput, ReviewerEvidence } from './reviewer-evidence.js';
import type { ReviewerProviderCall, ReviewerProviderRunnerResult } from './reviewer-provider-runner.js';

export interface CommittedTaskReviewerGateInput extends ReviewerEvidenceInput {
  reviewer: ReviewerProviderCall;
  maxParseRetries?: number;
}

export interface CommittedTaskReviewerGateResult {
  evidence: ReviewerEvidence;
  reviewerRunnerResult: ReviewerProviderRunnerResult;
}

export async function runCommittedTaskReviewerGate(
  input: CommittedTaskReviewerGateInput
): Promise<CommittedTaskReviewerGateResult> {
  const evidence = buildReviewerEvidence(input);
  const reviewerRunnerResult = await runReviewerGateWithProvider({
    evidence,
    reviewer: input.reviewer,
    maxParseRetries: input.maxParseRetries,
  });
  return {
    evidence,
    reviewerRunnerResult,
  };
}
