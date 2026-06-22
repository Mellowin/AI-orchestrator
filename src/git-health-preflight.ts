import { spawnSync } from 'node:child_process';
import { redactSecrets } from './sandbox-preflight-repair.js';

export interface GitHealthPreflightInput {
  repoPath: string;
  workBranch?: string;
  baseBranch?: string;
}

export interface GitHealthPreflightResult {
  ok: boolean;
  issues: string[];
}

const ZERO_SHA = '0000000000000000000000000000000000000000';
const FORBIDDEN_BRANCHES = new Set(['main', 'master']);

interface GitCmdSuccess {
  ok: true;
  stdout: string;
}

interface GitCmdFailure {
  ok: false;
  command: string;
  error: string;
}

type GitCmdResult = GitCmdSuccess | GitCmdFailure;

function runGit(repoPath: string, args: string[]): GitCmdResult {
  const result = spawnSync('git', args, {
    cwd: repoPath,
    encoding: 'utf-8',
    shell: false,
  });
  if (result.error) {
    return {
      ok: false,
      command: `git ${args.join(' ')}`,
      error: result.error.message,
    };
  }
  if (result.status !== 0) {
    const err =
      result.stderr?.trim() || `git ${args.join(' ')} exited with code ${result.status}`;
    return { ok: false, command: `git ${args.join(' ')}`, error: err };
  }
  return { ok: true, stdout: result.stdout || '' };
}

function isZeroSha(value: string): boolean {
  return value.trim() === ZERO_SHA;
}

function describeCommandFailure(result: GitCmdFailure): string {
  return `${result.command}: ${redactSecrets(result.error)}`;
}

export function runGitHealthPreflight(
  input: GitHealthPreflightInput
): GitHealthPreflightResult {
  const issues: string[] = [];
  const { repoPath, workBranch, baseBranch } = input;

  // 1. Directory must be inside a git work tree.
  const insideWorkTree = runGit(repoPath, ['rev-parse', '--is-inside-work-tree']);
  if (!insideWorkTree.ok) {
    issues.push(`Git repository health check failed: ${describeCommandFailure(insideWorkTree)}`);
    return { ok: false, issues };
  }
  if (insideWorkTree.stdout.trim() !== 'true') {
    issues.push('Git repository health check failed: directory is not a git work tree');
    return { ok: false, issues };
  }

  // 2. HEAD must resolve to a valid, non-zero commit.
  const headResult = runGit(repoPath, ['rev-parse', '--verify', 'HEAD']);
  if (!headResult.ok) {
    issues.push(`Git repository health check failed: HEAD is invalid (${describeCommandFailure(headResult)})`);
  } else if (isZeroSha(headResult.stdout)) {
    issues.push('Git repository health check failed: HEAD points to zero SHA');
  }

  // 3. HEAD must be a valid local branch symbolic ref.
  const symbolicRef = runGit(repoPath, ['symbolic-ref', '--quiet', 'HEAD']);
  if (!symbolicRef.ok) {
    issues.push(`Git repository health check failed: current branch ref is invalid (${describeCommandFailure(symbolicRef)})`);
  } else {
    const ref = symbolicRef.stdout.trim();
    if (!ref.startsWith('refs/heads/')) {
      issues.push(`Git repository health check failed: HEAD is not a local branch (${ref})`);
    }
  }

  // 4. No local/remote ref may point to the zero SHA.
  const showRef = runGit(repoPath, ['show-ref']);
  if (!showRef.ok) {
    // `git show-ref` reports broken zero-SHA refs in stderr as:
    // "fatal: git show-ref: bad ref refs/heads/<name> (0000...0000)"
    const brokenRefMatch = showRef.error.match(
      /bad ref\s+(\S+)\s+\((0000000000000000000000000000000000000000)\)/i
    );
    if (brokenRefMatch) {
      const refName = brokenRefMatch[1];
      issues.push(`Git repository health check failed: ref ${refName} points to zero SHA`);
    } else if (!showRef.error.toLowerCase().includes('no ref')) {
      // Repositories with no refs legitimately fail `git show-ref`. HEAD checks above
      // already cover the unborn-branch case, so only report unexpected failures.
      issues.push(`Git repository health check failed: unable to list refs (${describeCommandFailure(showRef)})`);
    }
  } else {
    const lines = showRef.stdout
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    for (const line of lines) {
      const firstSpace = line.indexOf(' ');
      if (firstSpace === -1) continue;
      const sha = line.slice(0, firstSpace).trim();
      const refName = line.slice(firstSpace + 1).trim();
      if (isZeroSha(sha)) {
        issues.push(`Git repository health check failed: ref ${refName} points to zero SHA`);
      }
    }
  }

  // 5. Target work branch must not be main/master.
  if (workBranch && FORBIDDEN_BRANCHES.has(workBranch.toLowerCase())) {
    issues.push('Target work_branch is main or master');
  }

  // 6. Target work branch ref, if it exists, must not be zero SHA.
  if (workBranch) {
    const workRef = runGit(repoPath, ['rev-parse', '--verify', `refs/heads/${workBranch}`]);
    if (workRef.ok && isZeroSha(workRef.stdout)) {
      issues.push(`Target work branch ${workBranch} points to zero SHA`);
    }
  }

  // 7. Origin base branch ref, if present, must not be zero SHA.
  const remoteBase = baseBranch || 'main';
  const originRef = runGit(repoPath, ['rev-parse', '--verify', `refs/remotes/origin/${remoteBase}`]);
  if (originRef.ok && isZeroSha(originRef.stdout)) {
    issues.push(`Remote origin/${remoteBase} points to zero SHA`);
  }

  return { ok: issues.length === 0, issues };
}

export function formatGitHealthPreflightError(issues: string[]): string {
  const lines = [
    'Git repository health check failed',
    ...issues.map((issue) => `- ${redactSecrets(issue)}`),
    'Manual recovery hint: inspect refs with `git show-ref` and `git fsck`, restore corrupted refs from backup or remote, then retry.',
  ];
  return lines.join('\n');
}
