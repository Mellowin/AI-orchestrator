import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { redactSecrets } from './sandbox-preflight-repair.js';

export interface RepoCheckpoint {
  repoPath: string;
  branch: string;
  headSha: string;
  untrackedFiles: string[];
}

export interface RollbackResult {
  ok: boolean;
  status: 'succeeded' | 'failed' | 'skipped';
  attempted: boolean;
  checkpointHead: string;
  finalHead?: string;
  reason?: string;
  policy?: import('./types.js').RollbackPolicy;
}

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
    const err = result.stderr?.trim() || `git ${args.join(' ')} exited with code ${result.status}`;
    return { ok: false, command: `git ${args.join(' ')}`, error: err };
  }
  return { ok: true, stdout: result.stdout || '' };
}

function listUntrackedFiles(repoPath: string): string[] {
  const result = runGit(repoPath, ['status', '--porcelain', '--untracked-files=all']);
  if (!result.ok) {
    return [];
  }
  return result.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('??'))
    .map((line) => line.slice(3).trim())
    .filter((line) => line.length > 0);
}

export function captureCheckpoint(repoPath: string): RepoCheckpoint {
  const branchResult = runGit(repoPath, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (!branchResult.ok) {
    throw new Error(`Failed to capture checkpoint branch: ${branchResult.error}`);
  }
  const headResult = runGit(repoPath, ['rev-parse', '--verify', 'HEAD']);
  if (!headResult.ok) {
    throw new Error(`Failed to capture checkpoint HEAD: ${headResult.error}`);
  }
  const cleanResult = runGit(repoPath, ['status', '--porcelain']);
  if (!cleanResult.ok) {
    throw new Error(`Failed to verify working tree cleanliness: ${cleanResult.error}`);
  }
  if (cleanResult.stdout.trim().length > 0) {
    throw new Error('Working tree is not clean; cannot capture rollback checkpoint');
  }
  return {
    repoPath,
    branch: branchResult.stdout.trim(),
    headSha: headResult.stdout.trim(),
    untrackedFiles: listUntrackedFiles(repoPath),
  };
}

export function rollbackToCheckpoint(checkpoint: RepoCheckpoint): RollbackResult {
  const issues: string[] = [];

  if (!existsSync(checkpoint.repoPath)) {
    return {
      ok: false,
      status: 'failed',
      attempted: true,
      checkpointHead: checkpoint.headSha,
      reason: `Repository path does not exist: ${checkpoint.repoPath}`,
    };
  }

  const currentBranchResult = runGit(checkpoint.repoPath, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (currentBranchResult.ok && currentBranchResult.stdout.trim() !== checkpoint.branch) {
    const checkoutResult = runGit(checkpoint.repoPath, ['checkout', checkpoint.branch]);
    if (!checkoutResult.ok) {
      issues.push(`checkout failed: ${checkoutResult.error}`);
    }
  }

  const resetResult = runGit(checkpoint.repoPath, ['reset', '--hard', checkpoint.headSha]);
  if (!resetResult.ok) {
    issues.push(`reset failed: ${resetResult.error}`);
  }

  const newUntracked = listUntrackedFiles(checkpoint.repoPath).filter(
    (p) => !checkpoint.untrackedFiles.includes(p)
  );
  const dirsToCheck = new Set<string>();
  for (const untracked of newUntracked) {
    const fullPath = resolve(checkpoint.repoPath, untracked);
    const dir = dirname(fullPath);
    if (dir !== checkpoint.repoPath) {
      dirsToCheck.add(dir);
    }
    try {
      rmSync(fullPath, { recursive: true, force: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      issues.push(`cleanup of ${untracked} failed: ${message}`);
    }
  }

  const sortedDirs = Array.from(dirsToCheck).sort((a, b) => b.length - a.length);
  for (const dir of sortedDirs) {
    if (!existsSync(dir)) continue;
    try {
      const entries = readdirSync(dir);
      if (entries.length === 0) {
        rmSync(dir, { recursive: true, force: true });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      issues.push(`cleanup of directory ${dir} failed: ${message}`);
    }
  }

  const finalHeadResult = runGit(checkpoint.repoPath, ['rev-parse', '--verify', 'HEAD']);
  const finalHead = finalHeadResult.ok ? finalHeadResult.stdout.trim() : undefined;

  const finalCleanResult = runGit(checkpoint.repoPath, ['status', '--porcelain']);
  if (finalCleanResult.ok && finalCleanResult.stdout.trim().length > 0) {
    issues.push('working tree is not clean after rollback');
  }

  if (issues.length > 0) {
    return {
      ok: false,
      status: 'failed',
      attempted: true,
      checkpointHead: checkpoint.headSha,
      finalHead,
      reason: redactSecrets(issues.join('; ')),
    };
  }

  return {
    ok: true,
    status: 'succeeded',
    attempted: true,
    checkpointHead: checkpoint.headSha,
    finalHead,
  };
}

export function formatRollbackResult(result: RollbackResult): string {
  const parts = [
    `status=${result.status}`,
    `attempted=${result.attempted}`,
    `checkpointHead=${result.checkpointHead}`,
  ];
  if (result.finalHead) parts.push(`finalHead=${result.finalHead}`);
  if (result.policy) parts.push(`policy=${result.policy}`);
  if (result.reason) parts.push(`reason=${redactSecrets(result.reason)}`);
  return parts.join(' ');
}
