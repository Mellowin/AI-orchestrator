import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import type { BlockDefinition } from './block-types.js';
import type { RealBlockRunTaskResult } from '../real-block-run-ai-state.js';

export interface CommitVerificationResult {
  ok: boolean;
  reason?: string;
}

function runGit(
  repoPath: string,
  args: string[],
  allowFailure = false
): { ok: boolean; stdout: string; stderr: string } {
  const result = spawnSync('git', args, {
    cwd: repoPath,
    encoding: 'utf-8',
    shell: false,
  });
  if (!allowFailure && result.status !== 0) {
    return {
      ok: false,
      stdout: result.stdout || '',
      stderr: result.stderr || '',
    };
  }
  return {
    ok: result.status === 0,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
  };
}

export function verifyCommitExists(repoPath: string, commitSha: string): CommitVerificationResult {
  if (!/^[0-9a-f]{40}$/i.test(commitSha)) {
    return { ok: false, reason: `Invalid commit SHA: ${commitSha}` };
  }
  const result = runGit(repoPath, ['cat-file', '-e', `${commitSha}^{commit}`], true);
  if (!result.ok) {
    return { ok: false, reason: `Commit ${commitSha} does not exist in repository` };
  }
  return { ok: true };
}

export function verifyCommitIsAncestor(
  repoPath: string,
  commitSha: string,
  headRef = 'HEAD'
): CommitVerificationResult {
  const exists = verifyCommitExists(repoPath, commitSha);
  if (!exists.ok) {
    return exists;
  }
  const result = runGit(repoPath, ['merge-base', '--is-ancestor', commitSha, headRef], true);
  if (!result.ok) {
    return {
      ok: false,
      reason: `Commit ${commitSha} is not an ancestor of ${headRef}`,
    };
  }
  return { ok: true };
}

export function verifyTaskResultHistory(
  taskResult: RealBlockRunTaskResult,
  repoPath: string,
  headRef = 'HEAD'
): CommitVerificationResult {
  const shas: string[] = [];
  if (typeof taskResult.originalCommitSha === 'string' && taskResult.originalCommitSha.length === 40) {
    shas.push(taskResult.originalCommitSha);
  }
  if (typeof taskResult.fixCommitSha === 'string' && taskResult.fixCommitSha.length === 40) {
    shas.push(taskResult.fixCommitSha);
  }

  if (shas.length === 0) {
    return { ok: true };
  }

  for (const sha of shas) {
    const ancestor = verifyCommitIsAncestor(repoPath, sha, headRef);
    if (!ancestor.ok) {
      return {
        ok: false,
        reason: `Stale completed task state: ${taskResult.taskId} is marked ${taskResult.status} with commit ${sha}, but ${ancestor.reason}.`,
      };
    }
  }

  return { ok: true };
}

export interface RemovedStatePaths {
  blockStatePath: string;
  taskStatePaths: string[];
}

export function prepareFreshBlockRun(
  block: BlockDefinition,
  runsDir: string
): RemovedStatePaths {
  const blockRunDir = join(runsDir, 'block', block.block_id.replace(/[^a-zA-Z0-9_-]/g, '_'));
  const blockStatePath = join(blockRunDir, 'state.json');
  const removed: RemovedStatePaths = {
    blockStatePath,
    taskStatePaths: [],
  };

  if (existsSync(blockStatePath)) {
    rmSync(blockStatePath, { force: true });
  }

  for (const task of block.tasks) {
    const taskStatePath = join(runsDir, 'tasks', task.task_id, 'state.json');
    if (existsSync(taskStatePath)) {
      rmSync(taskStatePath, { force: true });
      removed.taskStatePaths.push(taskStatePath);
    }
  }

  return removed;
}
