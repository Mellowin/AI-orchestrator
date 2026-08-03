import { spawnSync } from 'node:child_process';

export interface CommitEvidenceInput {
  repoPath: string;
  taskId: string;
  taskGoal: string;
  allowedFiles: string[];
  deniedFiles: string[];
  maxLinesChanged: number;
  commitSha: string;
  baseRef?: string;
}

export interface CommitEvidence {
  taskId: string;
  taskGoal: string;
  repoPath: string;
  allowedFiles: string[];
  deniedFiles: string[];
  maxLinesChanged: number;
  commitSha: string;
  changedFiles: string[];
  diff: string;
  gitStatus: string;
  currentBranch: string;
  safetyFindings: string[];
}

const SHA_REGEX = /^[0-9a-fA-F]{40}$/;
const DIFF_MAX_BYTES = 500_000;
const DIFF_MAX_LINES = 5_000;

export function validateCommitSha(commitSha: string): string {
  if (!commitSha || typeof commitSha !== 'string') {
    throw new Error('Commit SHA must be a non-empty string');
  }
  if (!SHA_REGEX.test(commitSha)) {
    throw new Error('Commit SHA must be a full 40-character hex string');
  }
  return commitSha.toLowerCase();
}

export function verifyCommitExists(repoPath: string, commitSha: string): boolean {
  const result = spawnSync('git', ['rev-parse', '--verify', '--end-of-options', `${commitSha}^{commit}`], {
    cwd: repoPath,
    shell: false,
    encoding: 'utf-8',
  });
  return result.status === 0 && result.stdout.trim().length > 0;
}

export function getCommitChangedFiles(repoPath: string, commitSha: string, baseRef?: string): string[] {
  const args = baseRef
    ? ['diff', '--name-only', `${baseRef}...${commitSha}`]
    : ['show', '--format=', '--name-only', commitSha];

  const result = spawnSync('git', args, {
    cwd: repoPath,
    shell: false,
    encoding: 'utf-8',
  });

  if (result.status !== 0) {
    throw new Error(`Failed to get changed files: ${result.stderr?.trim() || 'unknown error'}`);
  }

  return result.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .sort();
}

export function getCommitDiff(repoPath: string, commitSha: string, baseRef?: string): string {
  const args = baseRef
    ? ['diff', `${baseRef}...${commitSha}`]
    : ['show', '--format=', '--patch', commitSha];

  const result = spawnSync('git', args, {
    cwd: repoPath,
    shell: false,
    encoding: 'utf-8',
  });

  if (result.status !== 0) {
    throw new Error(`Failed to get diff: ${result.stderr?.trim() || 'unknown error'}`);
  }

  let diff = result.stdout;

  // Max output guard
  const lines = diff.split('\n');
  if (diff.length > DIFF_MAX_BYTES || lines.length > DIFF_MAX_LINES) {
    const truncated = lines.slice(0, DIFF_MAX_LINES).join('\n');
    const safeTruncated = truncated.length > DIFF_MAX_BYTES ? truncated.slice(0, DIFF_MAX_BYTES) : truncated;
    diff = safeTruncated + '\n\n[diff truncated: output exceeded safe limits]';
  }

  return diff;
}

export function getGitStatusPorcelain(repoPath: string): string {
  const result = spawnSync('git', ['status', '--porcelain'], {
    cwd: repoPath,
    shell: false,
    encoding: 'utf-8',
  });

  if (result.status !== 0) {
    throw new Error(`Failed to get git status: ${result.stderr?.trim() || 'unknown error'}`);
  }

  return result.stdout.trim();
}

export function getCurrentBranchName(repoPath: string): string {
  const result = spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
    cwd: repoPath,
    shell: false,
    encoding: 'utf-8',
  });

  if (result.status !== 0) {
    throw new Error(`Failed to get current branch: ${result.stderr?.trim() || 'unknown error'}`);
  }

  return result.stdout.trim();
}

export function buildCommitEvidence(input: CommitEvidenceInput): CommitEvidence {
  const safetyFindings: string[] = [];

  const normalizedSha = validateCommitSha(input.commitSha);

  if (!verifyCommitExists(input.repoPath, normalizedSha)) {
    throw new Error(`Commit ${normalizedSha} does not exist in repository`);
  }

  const changedFiles = getCommitChangedFiles(input.repoPath, normalizedSha, input.baseRef);
  let diff = getCommitDiff(input.repoPath, normalizedSha, input.baseRef);
  const gitStatus = getGitStatusPorcelain(input.repoPath);
  const currentBranch = getCurrentBranchName(input.repoPath);

  if (diff.includes('[diff truncated:')) {
    safetyFindings.push('Diff was truncated due to size limits');
  }

  return {
    taskId: input.taskId,
    taskGoal: input.taskGoal,
    repoPath: input.repoPath,
    allowedFiles: [...input.allowedFiles],
    deniedFiles: [...input.deniedFiles],
    maxLinesChanged: input.maxLinesChanged,
    commitSha: normalizedSha,
    changedFiles,
    diff,
    gitStatus,
    currentBranch,
    safetyFindings,
  };
}
