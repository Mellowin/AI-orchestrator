import type { ReviewerProvider, ReviewerDecision, ReviewerNextAction } from '../providers/provider-types.js';
import type { ReviewInput } from './reviewer-types.js';
import { validateReviewerDecision } from './reviewer-schema.js';
import { redactReviewerList, redactReviewerText } from './reviewer-redaction.js';
import { runSummaryChecks } from './summary-checks.js';

export interface ReviewerGateInput {
  reviewer: ReviewerProvider;
  reviewInput: ReviewInput;
  deterministicResult: {
    ok: boolean;
    blockingIssues: string[];
    safetyFindings: string[];
  };
}

export interface ReviewerGateResult {
  decision: ReviewerDecision;
  reviewerCalled: boolean;
  safetyFindings: string[];
}

const SEVERE_SAFETY_FINDINGS = [
  'secret pattern detected',
  'main branch violation',
  'merge conflict markers in diff',
  'invalid commit sha format',
  'denied file touched',
];

function isSevereSafetyIssue(findings: string[]): boolean {
  const lowerFindings = findings.map((f) => f.toLowerCase());
  for (const severe of SEVERE_SAFETY_FINDINGS) {
    if (lowerFindings.some((f) => f.includes(severe))) {
      return true;
    }
  }
  return false;
}

function buildDeterministicRejectionDecision(
  blockingIssues: string[],
  safetyFindings: string[],
  nextAction: ReviewerNextAction
): ReviewerDecision {
  const safeBlockingIssues = redactReviewerList(blockingIssues);
  return {
    decision: 'rejected',
    confidence: 'high',
    blocking_issues: safeBlockingIssues,
    non_blocking_issues: [],
    review_summary: redactReviewerText(`Rejected by deterministic checks: ${safeBlockingIssues.join('; ')}`),
    fix_task: redactReviewerText(`Fix the following issues: ${safeBlockingIssues.join('; ')}`),
    next_action: nextAction,
  };
}

export async function runReviewerGate(input: ReviewerGateInput): Promise<ReviewerGateResult> {
  const safetyFindings = [...input.deterministicResult.safetyFindings];

  if (!input.deterministicResult.ok) {
    const nextAction: ReviewerNextAction = isSevereSafetyIssue(safetyFindings)
      ? 'block_for_human'
      : 'send_fix_to_coder';

    return {
      decision: buildDeterministicRejectionDecision(
        input.deterministicResult.blockingIssues,
        safetyFindings,
        nextAction
      ),
      reviewerCalled: false,
      safetyFindings,
    };
  }

  const summaryCheckResult = runSummaryChecks({
    repoPath: input.reviewInput.repo_path,
    commitSha: input.reviewInput.commit_sha,
    allowedFiles: input.reviewInput.allowed_files,
    acceptanceCriteria: input.reviewInput.acceptance_criteria,
    dependencyEvidence: input.reviewInput.dependency_evidence,
  });
  if (!summaryCheckResult.ok) {
    const safeIssues = redactReviewerList(summaryCheckResult.issues);
    return {
      decision: buildDeterministicRejectionDecision(
        safeIssues,
        [...safetyFindings, 'summary check failed'],
        'send_fix_to_coder'
      ),
      reviewerCalled: false,
      safetyFindings: [...safetyFindings, 'summary check failed'],
    };
  }

  // Deterministic checks passed — call the reviewer
  const rawDecision = await input.reviewer.reviewCommit(input.reviewInput);
  const validated = validateReviewerDecision(rawDecision);

  return {
    decision: validated,
    reviewerCalled: true,
    safetyFindings,
  };
}
