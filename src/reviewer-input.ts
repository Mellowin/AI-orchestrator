import type { ReviewerEvidence } from './reviewer-evidence.js';

export interface ReviewerInput {
  role: 'reviewer';
  repoPath: string;
  taskId: string;
  taskGoal: string;
  commitSha: string;
  branchName: string;
  changedFiles: string[];
  diffStat: string;
  checkSummary: ReviewerEvidence['checkSummary'];
  stateStatus?: string;
  previousFailure?: string;
  safety: ReviewerEvidence['safety'];
  instructions: string[];
  requiredOutputFormat: {
    decision: 'accept' | 'reject' | 'block_for_human';
    confidence: 'low' | 'medium' | 'high';
    blockingIssues: string[];
    nonBlockingIssues: string[];
    reviewSummary: string;
    fixTask?: string;
    nextAction: 'continue' | 'fix' | 'block';
  };
}

export function buildReviewerInput(evidence: ReviewerEvidence): ReviewerInput {
  return {
    role: 'reviewer',
    repoPath: evidence.repoPath,
    taskId: evidence.taskId,
    taskGoal: evidence.taskGoal,
    commitSha: evidence.commitSha,
    branchName: evidence.branchName,
    changedFiles: evidence.changedFiles,
    diffStat: evidence.diffStat,
    checkSummary: evidence.checkSummary,
    stateStatus: evidence.stateStatus,
    previousFailure: evidence.previousFailure,
    safety: evidence.safety,
    instructions: [
      'Review only the provided factual evidence. Do not assume knowledge outside the evidence.',
      'Do not assume tests passed unless the check summary explicitly says so.',
      'Treat missing or empty changed files as a blocking issue.',
      'Treat a non-full-length (not 40 characters) commit SHA as a blocking issue.',
      'Treat the main branch as a blocking issue for autonomous reviewer gate unless explicitly allowed later.',
      'Return a structured decision only; do not include prose outside the required format.',
      'Do not request external provider or API calls.',
      'Do not include secrets, tokens, or API keys in your response.',
    ],
    requiredOutputFormat: {
      decision: 'accept',
      confidence: 'medium',
      blockingIssues: [],
      nonBlockingIssues: [],
      reviewSummary: '',
      nextAction: 'continue',
    },
  };
}
