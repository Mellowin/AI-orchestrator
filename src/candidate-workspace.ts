import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { getGitRemoteUrl, injectGitHubTokenIntoRemoteUrl } from './git-push-auth.js';

export interface CandidateWorkspaceValidationResult {
  ok: boolean;
  reason?: string;
}

export interface CandidateDiffResult {
  diff: string;
  changedFiles: string[];
}

function git(args: string[], cwd: string, allowFailure = false): { status: number; stdout: string; stderr: string } {
  const result = spawnSync('git', args, {
    cwd,
    shell: false,
    encoding: 'utf-8',
  });
  if (!allowFailure && result.status !== 0) {
    const message = result.stderr?.trim() || `git ${args.join(' ')} exited with code ${result.status}`;
    throw new Error(message);
  }
  return {
    status: result.status ?? 1,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
  };
}

function validatePath(candidatePath: string): void {
  if (!candidatePath || typeof candidatePath !== 'string') {
    throw new Error('candidatePath must be a non-empty string');
  }
  if (candidatePath.includes('\0')) {
    throw new Error('candidatePath contains null byte');
  }
}

/**
 * Create or validate a persistent candidate workspace for a task.
 *
 * The workspace is a clone of the target repo checked out to a local branch
 * `candidate/<task-id>` from `taskBaseSha`. It survives process crashes and is
 * the source of truth for uncommitted changes until acceptance.
 */
export function createCandidateWorkspace(
  candidatePath: string,
  repoPath: string,
  taskBaseSha: string,
  workBranch: string,
  taskId: string
): CandidateWorkspaceValidationResult {
  validatePath(candidatePath);

  if (!/^[0-9a-f]{40}$/i.test(taskBaseSha)) {
    return { ok: false, reason: `Invalid task_base_sha: ${taskBaseSha}` };
  }

  const resolvedRepo = resolve(repoPath);
  if (!existsSync(resolvedRepo) || !statSync(resolvedRepo).isDirectory()) {
    return { ok: false, reason: `repoPath does not exist or is not a directory: ${repoPath}` };
  }
  if (!existsSync(resolve(resolvedRepo, '.git'))) {
    return { ok: false, reason: `repoPath is not a git repository: ${repoPath}` };
  }

  const parentDir = dirname(candidatePath);
  if (!existsSync(parentDir)) {
    mkdirSync(parentDir, { recursive: true });
  }

  // If a workspace already exists, validate it instead of re-cloning.
  if (existsSync(candidatePath) && existsSync(resolve(candidatePath, '.git'))) {
    return validateCandidateWorkspace(candidatePath, taskBaseSha);
  }

  // Clone the main repo into the candidate workspace with line-ending conversion
  // disabled so the working tree matches the base blob byte-for-byte.
  const cloneResult = spawnSync('git', ['clone', '--config', 'core.autocrlf=false', '--no-checkout', resolvedRepo, candidatePath], {
    shell: false,
    encoding: 'utf-8',
  });
  if (cloneResult.status !== 0) {
    return {
      ok: false,
      reason: `Failed to clone candidate workspace: ${cloneResult.stderr?.trim() || 'unknown error'}`,
    };
  }

  // Copy the origin URL from the main repo so pushes go to the real remote.
  const originUrl = getGitRemoteUrl(resolvedRepo, 'origin');
  if (originUrl) {
    git(['remote', 'set-url', 'origin', originUrl], candidatePath);
  }

  // Configure a local identity for the candidate workspace so git commits work.
  git(['config', 'user.email', 'ai-orchestrator@localhost'], candidatePath);
  git(['config', 'user.name', 'AI Orchestrator'], candidatePath);

  // Disable line-ending conversion so the working tree matches the base blob
  // byte-for-byte; otherwise Windows autocrlf can make an identical proposed
  // file appear modified and then produce an empty staged diff.
  git(['config', 'core.autocrlf', 'false'], candidatePath);

  // Create and checkout the candidate branch from the immutable task base SHA.
  const candidateBranch = `candidate/${taskId}`;
  git(['checkout', '-b', candidateBranch, taskBaseSha], candidatePath);

  return validateCandidateWorkspace(candidatePath, taskBaseSha);
}

/**
 * Validate that the candidate workspace is in the expected state:
 * - HEAD is exactly taskBaseSha (no accidental commits)
 * - No unexpected unstaged changes or untracked files
 * - If expectedChangedFiles is provided, all are staged and no other files are staged
 */
export function validateCandidateWorkspace(
  candidatePath: string,
  taskBaseSha: string,
  expectedChangedFiles?: string[]
): CandidateWorkspaceValidationResult {
  validatePath(candidatePath);
  if (!existsSync(candidatePath) || !existsSync(resolve(candidatePath, '.git'))) {
    return { ok: false, reason: 'Candidate workspace does not exist or is not a git repository' };
  }

  const headResult = git(['rev-parse', '--verify', 'HEAD'], candidatePath, true);
  if (headResult.status !== 0) {
    return { ok: false, reason: 'Failed to read HEAD in candidate workspace' };
  }
  const headSha = headResult.stdout.trim();
  if (headSha !== taskBaseSha) {
    return {
      ok: false,
      reason: `Candidate workspace HEAD mismatch: expected ${taskBaseSha}, got ${headSha}`,
    };
  }

  const statusResult = git(['status', '--porcelain', '--untracked-files=all'], candidatePath, true);
  if (statusResult.status !== 0) {
    return { ok: false, reason: 'Failed to read candidate workspace status' };
  }

  const lines = statusResult.stdout
    .split('\n')
    .map((s) => s.trimEnd())
    .filter((s) => s.length > 0);

  const untracked: string[] = [];
  const unstaged: string[] = [];
  const staged: string[] = [];
  for (const line of lines) {
    const code = line.slice(0, 2);
    const pathPart = line.slice(3);
    const filePath = pathPart.includes(' -> ') ? pathPart.split(' -> ')[1] : pathPart;
    if (code === '??') {
      untracked.push(filePath);
    } else {
      if (code[0] !== ' ' && code[0] !== '?') {
        staged.push(filePath);
      }
      if (code[1] !== ' ' && code[1] !== '?') {
        unstaged.push(filePath);
      }
    }
  }

  if (untracked.length > 0) {
    return { ok: false, reason: `Unexpected untracked files in candidate workspace: ${untracked.join(', ')}` };
  }
  if (unstaged.length > 0) {
    return { ok: false, reason: `Unexpected unstaged changes in candidate workspace: ${unstaged.join(', ')}` };
  }

  if (expectedChangedFiles !== undefined) {
    const expectedSet = new Set(expectedChangedFiles);
    const stagedSet = new Set(staged);
    const missing = expectedChangedFiles.filter((f) => !stagedSet.has(f));
    const extra = staged.filter((f) => !expectedSet.has(f));
    if (missing.length > 0 || extra.length > 0) {
      return {
        ok: false,
        reason: `Staged files mismatch. Expected: [${expectedChangedFiles.join(', ')}], actual: [${staged.join(', ')}]`,
      };
    }
  }

  return { ok: true };
}

/**
 * Explicitly stage a set of files in the candidate workspace.
 */
export function stageCandidateFiles(
  candidatePath: string,
  changedFiles: string[]
): CandidateWorkspaceValidationResult {
  validatePath(candidatePath);
  if (!existsSync(candidatePath) || !existsSync(resolve(candidatePath, '.git'))) {
    return { ok: false, reason: 'Candidate workspace does not exist or is not a git repository' };
  }
  if (changedFiles.length === 0) {
    return { ok: true };
  }
  const result = git(['add', '--', ...changedFiles], candidatePath, true);
  if (result.status !== 0) {
    return { ok: false, reason: `git add failed: ${result.stderr.trim()}` };
  }
  return { ok: true };
}

/**
 * Get the staged diff and changed file list relative to taskBaseSha.
 */
export function getCandidateDiff(
  candidatePath: string,
  taskBaseSha: string
): CandidateDiffResult {
  validatePath(candidatePath);
  const diffResult = git(['diff', '--cached', '--no-ext-diff', taskBaseSha], candidatePath, true);
  const diff = diffResult.status === 0 ? diffResult.stdout : '';
  const namesResult = git(['diff', '--cached', '--name-only', taskBaseSha], candidatePath, true);
  const changedFiles =
    namesResult.status === 0
      ? namesResult.stdout
          .split('\n')
          .map((s) => s.trim())
          .filter((s) => s.length > 0)
      : [];
  return { diff, changedFiles };
}

/**
 * Remove the candidate workspace after the accepted commit has been pushed and
 * state persisted. This is the only place where destructive cleanup of the
 * workspace is allowed.
 */
export function cleanupCandidateWorkspace(candidatePath: string): void {
  if (!candidatePath || typeof candidatePath !== 'string') {
    throw new Error('candidatePath must be a non-empty string');
  }
  if (existsSync(candidatePath)) {
    rmSync(candidatePath, { recursive: true, force: true });
  }
}

/**
 * Configure the candidate workspace origin for push, injecting a GitHub token
 * if one is present in the environment. This mirrors the existing cli.ts
 * remote injection logic.
 */
export function configureCandidateRemote(
  candidatePath: string,
  remoteUrl: string
): { ok: boolean; reason?: string } {
  validatePath(candidatePath);
  if (!existsSync(candidatePath) || !existsSync(resolve(candidatePath, '.git'))) {
    return { ok: false, reason: 'Candidate workspace does not exist or is not a git repository' };
  }
  const githubToken = process.env.GITHUB_TOKEN?.trim();
  let url = remoteUrl;
  if (githubToken) {
    const injected = injectGitHubTokenIntoRemoteUrl(remoteUrl, githubToken);
    if (injected) {
      url = injected;
    }
  }
  const result = git(['remote', 'set-url', 'origin', url], candidatePath, true);
  if (result.status !== 0) {
    return { ok: false, reason: `Failed to configure candidate origin: ${result.stderr.trim()}` };
  }
  return { ok: true };
}

/**
 * Push the current HEAD of the candidate workspace to the remote work branch
 * using a normal, non-force push.
 */
export function pushCandidateCommit(
  candidatePath: string,
  workBranch: string
): { ok: boolean; reason?: string } {
  validatePath(candidatePath);
  const result = git(['push', 'origin', `HEAD:${workBranch}`], candidatePath, true);
  if (result.status !== 0) {
    return { ok: false, reason: `Push failed: ${result.stderr.trim()}` };
  }
  return { ok: true };
}

/**
 * In the main repo, fetch origin and fast-forward-only the local mission branch
 * to the pushed commit SHA. This keeps the main repo in sync without rewriting
 * history.
 */
export function fastForwardMissionBranch(
  repoPath: string,
  workBranch: string,
  commitSha: string
): { ok: boolean; reason?: string } {
  if (!/^[0-9a-f]{40}$/i.test(commitSha)) {
    return { ok: false, reason: `Invalid commit SHA: ${commitSha}` };
  }
  const resolvedRepo = resolve(repoPath);
  if (!existsSync(resolvedRepo) || !existsSync(resolve(resolvedRepo, '.git'))) {
    return { ok: false, reason: `repoPath is not a git repository: ${repoPath}` };
  }

  const fetchResult = git(['fetch', 'origin', workBranch], resolvedRepo, true);
  if (fetchResult.status !== 0) {
    return { ok: false, reason: `Fetch failed: ${fetchResult.stderr.trim()}` };
  }

  // Ensure the local work branch exists and points to the fetched commit.
  const branchExistsResult = git(['rev-parse', '--verify', `refs/heads/${workBranch}`], resolvedRepo, true);
  if (branchExistsResult.status === 0) {
    const checkoutResult = git(['checkout', workBranch], resolvedRepo, true);
    if (checkoutResult.status !== 0) {
      return { ok: false, reason: `Checkout of ${workBranch} failed: ${checkoutResult.stderr.trim()}` };
    }
  } else {
    const createResult = git(['checkout', '-b', workBranch, `origin/${workBranch}`], resolvedRepo, true);
    if (createResult.status !== 0) {
      return { ok: false, reason: `Create local ${workBranch} failed: ${createResult.stderr.trim()}` };
    }
  }

  const mergeResult = git(['merge', '--ff-only', commitSha], resolvedRepo, true);
  if (mergeResult.status !== 0) {
    return { ok: false, reason: `Fast-forward merge failed: ${mergeResult.stderr.trim()}` };
  }

  return { ok: true };
}
