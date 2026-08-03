import { buildReviewerInput } from './reviewer-input.js';
import { parseReviewerDecision } from './reviewer-decision.js';
import type { ReviewerEvidence } from './reviewer-evidence.js';
import type { ReviewerInput } from './reviewer-input.js';
import type { ReviewerDecision } from './reviewer-decision.js';
import { runAcceptanceCriteriaChecks } from './reviewer/acceptance-criteria-check.js';

export type ReviewerGateStatus = 'accepted' | 'fix_required' | 'blocked';
export type ReviewerGateDecisionSource =
  | 'reviewer'
  | 'parser'
  | 'deterministic_safety'
  | 'deterministic_acceptance'
  | 'provider';

export interface ReviewerGateInput {
  evidence: ReviewerEvidence;
  reviewerOutput: string | unknown;
}

export interface ReviewerGateResult {
  status: ReviewerGateStatus;
  source: ReviewerGateDecisionSource;
  reviewerInput: ReviewerInput;
  reviewerDecision?: ReviewerDecision;
  blockingIssues: string[];
  nonBlockingIssues: string[];
  reviewSummary: string;
  fixTask?: string;
  nextAction: 'continue' | 'fix' | 'block';
  parseAttempts?: number;
}

export function evaluateReviewerGate(
  input: ReviewerGateInput
): ReviewerGateResult {
  const reviewerInput = buildReviewerInput(input.evidence);

  // Deterministic safety checks override everything
  const safetyIssues: string[] = [];
  if (!input.evidence.safety.commitShaIsFullLength) {
    safetyIssues.push('Commit SHA is not full length (40 characters).');
  }
  if (!input.evidence.safety.hasChangedFiles) {
    safetyIssues.push('No changed files detected.');
  }
  if (!input.evidence.safety.branchIsNotMain) {
    safetyIssues.push('Branch is main, which is not allowed for autonomous reviewer gate.');
  }

  if (safetyIssues.length > 0) {
    return {
      status: 'blocked',
      source: 'deterministic_safety',
      reviewerInput,
      blockingIssues: safetyIssues,
      nonBlockingIssues: [],
      reviewSummary: 'Blocked by deterministic safety checks.',
      nextAction: 'block',
    };
  }

  const acceptanceIssues = runAcceptanceCriteriaChecks({
    repoPath: input.evidence.repoPath,
    commitSha: input.evidence.commitSha,
    acceptanceCriteria: input.evidence.acceptance_criteria,
    allowedFiles: input.evidence.allowedFiles,
  });

  if (acceptanceIssues.length > 0) {
    const details = acceptanceIssues.map((i) => i.detail);
    const fixTask = `Fix the following acceptance criterion issues:\n${acceptanceIssues
      .map((i) => `- ${i.criterion}: ${i.detail}`)
      .join('\n')}`;
    return {
      status: 'fix_required',
      source: 'deterministic_acceptance',
      reviewerInput,
      blockingIssues: details,
      nonBlockingIssues: [],
      reviewSummary: 'Deterministic acceptance criteria not satisfied.',
      fixTask,
      nextAction: 'fix',
    };
  }

  const parseResult = parseReviewerDecision(input.reviewerOutput);

  if (!parseResult.ok) {
    return {
      status: 'blocked',
      source: 'parser',
      reviewerInput,
      blockingIssues: [parseResult.error || 'Unknown parser error'],
      nonBlockingIssues: [],
      reviewSummary: 'Blocked due to invalid reviewer output format.',
      nextAction: 'block',
    };
  }

  const decision = parseResult.decision!;

  let status: ReviewerGateStatus;
  let nextAction: 'continue' | 'fix' | 'block';

  switch (decision.decision) {
    case 'accept':
      status = 'accepted';
      nextAction = 'continue';
      break;
    case 'reject':
      status = 'fix_required';
      nextAction = 'fix';
      break;
    case 'block_for_human':
      status = 'blocked';
      nextAction = 'block';
      break;
    default:
      status = 'blocked';
      nextAction = 'block';
  }

  return {
    status,
    source: 'reviewer',
    reviewerInput,
    reviewerDecision: decision,
    blockingIssues: decision.blockingIssues,
    nonBlockingIssues: decision.nonBlockingIssues,
    reviewSummary: decision.reviewSummary,
    fixTask: decision.fixTask,
    nextAction,
  };
}
