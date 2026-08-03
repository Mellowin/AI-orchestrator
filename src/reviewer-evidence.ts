import { spawnSync } from 'node:child_process';

export interface ReviewerEvidenceInput {
  repoPath: string;
  taskId: string;
  taskGoal: string;
  branchName: string;
  commitSha: string;
  checkSummary: {
    typecheck?: string;
    build?: string;
    test?: string;
    tests?: {
      total?: number;
      suites?: number;
      failures?: number;
    };
  };
  acceptance_criteria?: string[];
  stateStatus?: string;
  previousFailure?: string;
}

export interface ReviewerEvidence {
  taskId: string;
  taskGoal: string;
  repoPath: string;
  branchName: string;
  commitSha: string;
  shortCommitSha: string;
  changedFiles: string[];
  diffStat: string;
  commitExists: boolean;
  acceptance_criteria?: string[];
  stateStatus?: string;
  checkSummary: ReviewerEvidenceInput['checkSummary'];
  previousFailure?: string;
  safety: {
    commitShaIsFullLength: boolean;
    branchIsNotMain: boolean;
    hasChangedFiles: boolean;
  };
}

function runGit(repoPath: string, args: string[]): string {
  const result = spawnSync('git', args, {
    cwd: repoPath,
    encoding: 'utf-8',
    shell: false,
  });
  return result.stdout || '';
}

function commitExistsInRepo(repoPath: string, commitSha: string): boolean {
  const result = spawnSync('git', ['cat-file', '-t', commitSha], {
    cwd: repoPath,
    encoding: 'utf-8',
    shell: false,
  });
  return result.status === 0 && result.stdout.trim() === 'commit';
}

function getCommitChangedFiles(repoPath: string, commitSha: string): string[] {
  const stdout = runGit(repoPath, [
    'diff-tree',
    '--no-commit-id',
    '--name-only',
    '-r',
    '--root',
    commitSha,
  ]);
  return stdout
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

function getCommitDiffStat(repoPath: string, commitSha: string): string {
  return runGit(repoPath, ['show', '--stat', '--format=', commitSha]).trim();
}

export function buildReviewerEvidence(
  input: ReviewerEvidenceInput
): ReviewerEvidence {
  const commitExists = commitExistsInRepo(input.repoPath, input.commitSha);
  const changedFiles = commitExists
    ? getCommitChangedFiles(input.repoPath, input.commitSha)
    : [];
  const diffStat = commitExists
    ? getCommitDiffStat(input.repoPath, input.commitSha)
    : '';

  return {
    taskId: input.taskId,
    taskGoal: input.taskGoal,
    repoPath: input.repoPath,
    branchName: input.branchName,
    commitSha: input.commitSha,
    shortCommitSha: input.commitSha.slice(0, 7),
    changedFiles,
    diffStat,
    commitExists,
    stateStatus: input.stateStatus,
    previousFailure: input.previousFailure,
    checkSummary: input.checkSummary,
    acceptance_criteria: input.acceptance_criteria,
    safety: {
      commitShaIsFullLength: input.commitSha.length === 40,
      branchIsNotMain: input.branchName !== 'main',
      hasChangedFiles: changedFiles.length > 0,
    },
  };
}
