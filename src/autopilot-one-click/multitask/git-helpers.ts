import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

export type GitExecFn = (
  args: string[],
  options?: { cwd?: string }
) => { status: number | null; stdout: string; stderr: string };

const defaultGitExec: GitExecFn = (args, options) => {
  return spawnSync('git', args, {
    cwd: options?.cwd,
    encoding: 'utf-8',
    shell: false,
  });
};

export function getBaseSha(repoPath: string, baseBranch: string, gitExec: GitExecFn = defaultGitExec): string {
  const result = gitExec(['rev-parse', baseBranch], { cwd: repoPath });
  if (result.status !== 0) {
    throw new Error(`Failed to resolve base branch ${baseBranch}: ${result.stderr}`);
  }
  return result.stdout.trim();
}

export function isAncestor(
  repoPath: string,
  commitSha: string,
  branch: string,
  gitExec: GitExecFn = defaultGitExec
): boolean {
  const result = gitExec(['merge-base', '--is-ancestor', commitSha, branch], { cwd: repoPath });
  return result.status === 0;
}

export function getCurrentBranch(repoPath: string, gitExec: GitExecFn = defaultGitExec): string {
  const result = gitExec(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repoPath });
  if (result.status !== 0) {
    throw new Error(`Failed to determine current branch: ${result.stderr}`);
  }
  return result.stdout.trim();
}

export function checkoutBranch(
  repoPath: string,
  branch: string,
  gitExec: GitExecFn = defaultGitExec
): void {
  const result = gitExec(['checkout', branch], { cwd: repoPath });
  if (result.status !== 0) {
    throw new Error(`Failed to checkout ${branch}: ${result.stderr}`);
  }
}

export function createWorkBranch(
  repoPath: string,
  baseBranch: string,
  workBranch: string,
  gitExec: GitExecFn = defaultGitExec
): void {
  const result = gitExec(['checkout', '-B', workBranch, baseBranch], { cwd: repoPath });
  if (result.status !== 0) {
    throw new Error(`Failed to create work branch ${workBranch}: ${result.stderr}`);
  }
}

export function branchExists(
  repoPath: string,
  branch: string,
  gitExec: GitExecFn = defaultGitExec
): boolean {
  const result = gitExec(['rev-parse', '--verify', branch], { cwd: repoPath });
  return result.status === 0;
}

export function getMergeBase(
  repoPath: string,
  branchA: string,
  branchB: string,
  gitExec: GitExecFn = defaultGitExec
): string | null {
  const result = gitExec(['merge-base', branchA, branchB], { cwd: repoPath });
  if (result.status !== 0) {
    return null;
  }
  return result.stdout.trim();
}

export function isBranchBasedOn(
  repoPath: string,
  workBranch: string,
  baseBranch: string,
  baseSha: string,
  gitExec: GitExecFn = defaultGitExec
): boolean {
  const mergeBase = getMergeBase(repoPath, workBranch, baseBranch, gitExec);
  return mergeBase === baseSha;
}

export function revertCommits(
  repoPath: string,
  commits: string[],
  gitExec: GitExecFn = defaultGitExec
): void {
  if (commits.length === 0) return;
  const result = gitExec(['revert', '--no-edit', ...commits], { cwd: repoPath });
  if (result.status !== 0) {
    throw new Error(`Failed to revert commits ${commits.join(', ')}: ${result.stderr}`);
  }
}

export function commitRevert(
  repoPath: string,
  message: string,
  gitExec: GitExecFn = defaultGitExec
): void {
  const result = gitExec(['commit', '-m', message], { cwd: repoPath });
  if (result.status !== 0) {
    throw new Error(`Failed to commit revert: ${result.stderr}`);
  }
}

export function verifyAcceptedCommitsAreAncestors(
  repoPath: string,
  workBranch: string,
  acceptedCommits: string[],
  gitExec: GitExecFn = defaultGitExec
): { ok: boolean; missing: string[] } {
  const missing: string[] = [];
  for (const sha of acceptedCommits) {
    if (!isAncestor(repoPath, sha, workBranch, gitExec)) {
      missing.push(sha);
    }
  }
  return { ok: missing.length === 0, missing };
}

export function resetBranchToCommit(
  repoPath: string,
  commitSha: string,
  gitExec: GitExecFn = defaultGitExec
): void {
  const result = gitExec(['reset', '--hard', commitSha], { cwd: repoPath });
  if (result.status !== 0) {
    throw new Error(`Failed to reset to ${commitSha}: ${result.stderr}`);
  }
}

export function cherryPickCommit(
  repoPath: string,
  commitSha: string,
  gitExec: GitExecFn = defaultGitExec
): void {
  const result = gitExec(['cherry-pick', commitSha], { cwd: repoPath });
  if (result.status !== 0) {
    throw new Error(`Failed to cherry-pick ${commitSha}: ${result.stderr}`);
  }
}

export function rebuildBranchWithAcceptedCommits(
  repoPath: string,
  baseBranch: string,
  workBranch: string,
  acceptedCommits: string[],
  gitExec: GitExecFn = defaultGitExec
): void {
  createWorkBranch(repoPath, baseBranch, workBranch, gitExec);
  for (const commit of acceptedCommits) {
    cherryPickCommit(repoPath, commit, gitExec);
  }
}

export function pushBranch(
  repoPath: string,
  remote: string,
  branch: string,
  gitExec: GitExecFn = defaultGitExec
): void {
  const result = gitExec(['push', remote, branch], { cwd: repoPath });
  if (result.status !== 0) {
    throw new Error(`Failed to push ${branch}: ${result.stderr}`);
  }
}
