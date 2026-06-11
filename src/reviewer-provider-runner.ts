import { buildReviewerInput } from './reviewer-input.js';
import { evaluateReviewerGate } from './reviewer-gate.js';
import type { ReviewerEvidence } from './reviewer-evidence.js';
import type { ReviewerInput } from './reviewer-input.js';
import type { ReviewerGateResult } from './reviewer-gate.js';

export type ReviewerProviderCall = (
  input: ReviewerInput
) => Promise<string | unknown>;

export interface ReviewerProviderRunnerInput {
  evidence: ReviewerEvidence;
  reviewer: ReviewerProviderCall;
}

export interface ReviewerProviderRunnerResult {
  reviewerInput: ReviewerInput;
  rawReviewerOutput?: string | unknown;
  gateResult: ReviewerGateResult;
}

export async function runReviewerGateWithProvider(
  input: ReviewerProviderRunnerInput
): Promise<ReviewerProviderRunnerResult> {
  const reviewerInput = buildReviewerInput(input.evidence);

  try {
    const rawReviewerOutput = await input.reviewer(reviewerInput);
    const gateResult = evaluateReviewerGate({
      evidence: input.evidence,
      reviewerOutput: rawReviewerOutput,
    });
    return {
      reviewerInput,
      rawReviewerOutput,
      gateResult,
    };
  } catch (providerError) {
    const errorMessage =
      providerError instanceof Error
        ? providerError.message
        : String(providerError);
    const gateResult: ReviewerGateResult = {
      status: 'blocked',
      source: 'provider',
      reviewerInput,
      blockingIssues: [`Reviewer provider failed: ${errorMessage}`],
      nonBlockingIssues: [],
      reviewSummary: 'Blocked due to reviewer provider failure.',
      nextAction: 'block',
    };
    return {
      reviewerInput,
      gateResult,
    };
  }
}
