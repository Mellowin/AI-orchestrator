import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { getGitRemoteUrl, injectGitHubTokenIntoRemoteUrl } from './git-push-auth.js';
import { redactSecrets } from './sandbox-preflight-repair.js';
import type { CandidateSnapshot } from './candidate-state.js';
import { computeFileHash } from './candidate-state.js';

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

function preflightCandidatePath(candidatePath: string): { ok: boolean; reason?: string } {
  if (!candidatePath || typeof candidatePath !== 'string') {
    return { ok: false, reason: 'candidatePath must be a non-empty string' };
  }
  if (candidatePath.includes('\0')) {
    return { ok: false, reason: 'candidatePath contains null byte' };
  }
  if (candidatePath.includes('..')) {
    return { ok: false, reason: 'candidatePath contains path traversal' };
  }
  const normalized = candidatePath.replace(/\\/g, '/');
  if (normalized.split('/').some((segment) => segment === '.git')) {
    return { ok: false, reason: 'candidatePath must not be inside a .git directory' };
  }
  const gitInternalPath = join(candidatePath, '.git', 'objects', 'info', 'commit-graphs', 'commit-graph-chain');
  if (process.platform === 'win32' && gitInternalPath.length > 240) {
    return {
      ok: false,
      reason: `Generated candidate path is too long for Windows (${gitInternalPath.length} chars): ${candidatePath}`,
    };
  }
  if (candidatePath.length > 260) {
    return { ok: false, reason: `Generated candidate path is too long (${candidatePath.length} chars): ${candidatePath}` };
  }
  return { ok: true };
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

  const preflight = preflightCandidatePath(candidatePath);
  if (!preflight.ok) {
    return { ok: false, reason: preflight.reason };
  }

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
  expectedChangedFiles?: string[],
  acceptedCommitSha?: string
): CandidateWorkspaceValidationResult {
  validatePath(candidatePath);
  if (!existsSync(candidatePath) || !existsSync(resolve(candidatePath, '.git'))) {
    return { ok: false, reason: 'Candidate workspace does not exist or is not a git repository' };
  }

  const headResult = git(['rev-parse', '--verify', 'HEAD'], candidatePath, true);
  if (headResult.status !== 0) {
    return { ok: false, reason: 'Failed to read HEAD in candidate workspace' };
  }
  const headSha = headResult.stdout.trim().toLowerCase();
  const base = taskBaseSha.toLowerCase();
  const accepted = acceptedCommitSha?.toLowerCase();

  // Pre-commit: HEAD must be the immutable task base.
  // Post-commit (resume): HEAD may also be the accepted commit SHA.
  if (headSha !== base && headSha !== accepted) {
    return {
      ok: false,
      reason: `Candidate workspace HEAD mismatch: expected ${base}${accepted ? ` or ${accepted}` : ''}, got ${headSha}`,
    };
  }

  // After acceptance the commit is already created; only cleanliness checks apply.
  if (headSha === accepted) {
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
    for (const line of lines) {
      const code = line.slice(0, 2);
      const pathPart = line.slice(3);
      const filePath = pathPart.includes(' -> ') ? pathPart.split(' -> ')[1] : pathPart;
      if (code === '??') {
        untracked.push(filePath);
      } else if (code[1] !== ' ' && code[1] !== '?') {
        unstaged.push(filePath);
      }
    }
    if (untracked.length > 0) {
      return { ok: false, reason: `Unexpected untracked files in candidate workspace: ${untracked.join(', ')}` };
    }
    if (unstaged.length > 0) {
      return { ok: false, reason: `Unexpected unstaged changes in candidate workspace: ${unstaged.join(', ')}` };
    }
    return { ok: true };
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
 * Read the current HEAD SHA of the candidate workspace, if any.
 */
export function getCandidateHead(candidatePath: string): string | undefined {
  validatePath(candidatePath);
  if (!existsSync(candidatePath) || !existsSync(resolve(candidatePath, '.git'))) {
    return undefined;
  }
  const result = git(['rev-parse', '--verify', 'HEAD'], candidatePath, true);
  if (result.status !== 0) return undefined;
  const sha = result.stdout.trim();
  return /^[0-9a-f]{40}$/i.test(sha) ? sha.toLowerCase() : undefined;
}

/**
 * Return the parent SHA of a commit in the candidate workspace.
 */
export function getCommitParent(candidatePath: string, commitSha: string): string | undefined {
  validatePath(candidatePath);
  if (!existsSync(candidatePath) || !existsSync(resolve(candidatePath, '.git'))) {
    return undefined;
  }
  const result = git(['rev-parse', '--verify', `${commitSha}^`], candidatePath, true);
  if (result.status !== 0) return undefined;
  const sha = result.stdout.trim();
  return /^[0-9a-f]{40}$/i.test(sha) ? sha.toLowerCase() : undefined;
}

/**
 * Read the current SHA of a remote branch via ls-remote.
 * Returns undefined if the remote or branch does not exist.
 */
export function getRemoteBranchHead(candidatePath: string, branch: string): string | undefined {
  validatePath(candidatePath);
  if (!existsSync(candidatePath) || !existsSync(resolve(candidatePath, '.git'))) {
    return undefined;
  }
  const result = git(['ls-remote', 'origin', `refs/heads/${branch}`], candidatePath, true);
  if (result.status !== 0) return undefined;
  const line = result.stdout.trim();
  if (!line) return undefined;
  const parts = line.split(/\s+/);
  const sha = parts[0];
  return /^[0-9a-f]{40}$/i.test(sha) ? sha.toLowerCase() : undefined;
}

/**
 * Verify that the files in a commit exactly match an accepted candidate snapshot.
 */
export function verifyCommitAgainstSnapshot(
  candidatePath: string,
  commitSha: string,
  snapshot: CandidateSnapshot
): CandidateWorkspaceValidationResult {
  validatePath(candidatePath);
  if (!existsSync(candidatePath) || !existsSync(resolve(candidatePath, '.git'))) {
    return { ok: false, reason: 'Candidate workspace does not exist' };
  }

  const namesResult = git(
    ['diff-tree', '--no-commit-id', '--name-only', '-r', commitSha],
    candidatePath,
    true
  );
  if (namesResult.status !== 0) {
    return { ok: false, reason: `Could not read commit tree for ${commitSha}` };
  }
  const commitFiles = namesResult.stdout
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const expectedFiles = snapshot.changedFiles;

  const commitSet = new Set(commitFiles);
  const expectedSet = new Set(expectedFiles);
  const missing = expectedFiles.filter((f) => !commitSet.has(f));
  const extra = commitFiles.filter((f) => !expectedSet.has(f));
  if (missing.length > 0 || extra.length > 0) {
    return {
      ok: false,
      reason: `Commit file set mismatch. Expected: [${expectedFiles.join(', ')}], actual: [${commitFiles.join(', ')}]`,
    };
  }

  for (const file of snapshot.fileContents) {
    const showResult = git(['show', `${commitSha}:${file.path}`], candidatePath, true);
    if (showResult.status !== 0) {
      return { ok: false, reason: `Could not read ${file.path} from commit ${commitSha}` };
    }
    const actualHash = computeFileHash(showResult.stdout);
    if (actualHash !== file.sha256) {
      return {
        ok: false,
        reason: `Snapshot hash mismatch for ${file.path}: expected ${file.sha256}, got ${actualHash}`,
      };
    }
  }

  return { ok: true };
}

export interface CandidateReconcileResult {
  ok: boolean;
  reason?: string;
  /** The accepted commit SHA already present in the candidate workspace, if any. */
  acceptedCommitSha?: string;
  /** True if the accepted commit must still be created. */
  commitNeeded: boolean;
  /** True if a push is still required. */
  pushNeeded: boolean;
  /** True if the remote already points to the accepted commit. */
  alreadyPushed: boolean;
}

function fetchRemoteBranch(candidatePath: string, branch: string): { ok: boolean; error?: string } {
  const result = git(['fetch', 'origin', branch], candidatePath, true);
  if (result.status !== 0) {
    return { ok: false, error: result.stderr.trim() };
  }
  return { ok: true };
}

/**
 * Reconcile candidate workspace, local commit, snapshot, and remote mission branch
 * to determine the exact state after a crash/resume. Fail-closed on conflicts.
 *
 * Supported cases:
 * A. HEAD == task_base_sha, remote == base        -> commit needed, push needed.
 * B. HEAD == accepted_commit, remote == base      -> commit exists, push needed.
 * C. HEAD == accepted_commit, remote == head      -> commit exists, already pushed.
 * D. HEAD == task_base_sha, remote == accepted    -> push already happened before state save.
 * E. remote is something else                       -> concurrent mutation, fail closed.
 */
export function reconcileCandidateWorkspace(
  candidatePath: string,
  taskBaseSha: string,
  workBranch: string,
  snapshot: CandidateSnapshot | null
): CandidateReconcileResult {
  const base = taskBaseSha.toLowerCase();
  const head = getCandidateHead(candidatePath);

  if (!head) {
    return { ok: false, reason: 'Candidate workspace has no HEAD', commitNeeded: false, pushNeeded: false, alreadyPushed: false };
  }
  if (!/^[0-9a-f]{40}$/i.test(head)) {
    return { ok: false, reason: `Invalid candidate HEAD: ${head}`, commitNeeded: false, pushNeeded: false, alreadyPushed: false };
  }

  // Try to fetch the remote mission branch so we can detect a push that happened
  // while the local process was crashed (CASE D). Fetch failures are non-fatal here;
  // they simply mean the remote branch does not exist yet.
  fetchRemoteBranch(candidatePath, workBranch);
  const remoteHead = getRemoteBranchHead(candidatePath, workBranch);

  if (head === base) {
    if (!snapshot) {
      return { ok: false, reason: 'Accepted snapshot missing for uncommitted candidate', commitNeeded: false, pushNeeded: false, alreadyPushed: false };
    }

    // CASE A: nothing committed yet.
    if (!remoteHead || remoteHead === base) {
      return { ok: true, commitNeeded: true, pushNeeded: true, alreadyPushed: false };
    }

    // CASE D: remote already has a commit on the mission branch. Verify it is the
    // accepted commit by fetching it and comparing against the snapshot.
    const verify = verifyCommitAgainstSnapshot(candidatePath, remoteHead, snapshot);
    if (!verify.ok) {
      return {
        ok: false,
        reason: `Remote mission branch points to an unexpected commit: ${remoteHead} (${verify.reason})`,
        commitNeeded: false,
        pushNeeded: false,
        alreadyPushed: false,
      };
    }
    const parent = getCommitParent(candidatePath, remoteHead);
    if (parent !== base) {
      return {
        ok: false,
        reason: `Remote mission branch commit ${remoteHead} parent ${parent ?? 'unknown'} != task_base_sha ${base}`,
        commitNeeded: false,
        pushNeeded: false,
        alreadyPushed: false,
      };
    }
    return { ok: true, acceptedCommitSha: remoteHead, commitNeeded: false, pushNeeded: false, alreadyPushed: true };
  }

  // A local commit exists. Verify it descends from the immutable task base.
  const parent = getCommitParent(candidatePath, head);
  if (parent !== base) {
    return {
      ok: false,
      reason: `Candidate HEAD ${head} parent ${parent ?? 'unknown'} != task_base_sha ${base}`,
      commitNeeded: false,
      pushNeeded: false,
      alreadyPushed: false,
    };
  }

  // CASE B/C: candidate already contains the accepted commit.
  if (snapshot) {
    const verify = verifyCommitAgainstSnapshot(candidatePath, head, snapshot);
    if (!verify.ok) {
      return { ok: false, reason: verify.reason, commitNeeded: false, pushNeeded: false, alreadyPushed: false };
    }
  }

  if (remoteHead === head) {
    // CASE C: remote already has the accepted commit.
    return { ok: true, acceptedCommitSha: head, commitNeeded: false, pushNeeded: false, alreadyPushed: true };
  }
  if (!remoteHead || remoteHead === base) {
    // CASE B: commit exists locally but remote still at base (or branch does not exist yet).
    return { ok: true, acceptedCommitSha: head, commitNeeded: false, pushNeeded: true, alreadyPushed: false };
  }

  // CASE E: concurrent remote mutation / unexpected state.
  return {
    ok: false,
    reason: `Remote mission branch conflict: remote=${remoteHead}, local=${head}, base=${base}`,
    commitNeeded: false,
    pushNeeded: false,
    alreadyPushed: false,
  };
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
    return {
      ok: false,
      reason: redactSecrets(`Failed to configure candidate origin: ${result.stderr.trim()}`),
    };
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
