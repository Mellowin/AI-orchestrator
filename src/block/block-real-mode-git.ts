import { spawnSync } from 'node:child_process';
import { isAbsolute, relative, resolve } from 'node:path';

function runGit(repoPath: string, args: string[]): { stdout: string; stderr: string; status: number | null } {
  const result = spawnSync('git', args, {
    cwd: repoPath,
    shell: false,
    encoding: 'utf-8',
  });
  return {
    stdout: result.stdout ?? '',
    stderr: (result.stderr ?? '').trim(),
    status: result.status,
  };
}

export function getCurrentBranchName(repoPath: string): string {
  const result = runGit(repoPath, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (result.status !== 0) {
    throw new Error(`Failed to get current branch: ${result.stderr}`);
  }
  return result.stdout.trim();
}

export function getGitStatusPorcelain(repoPath: string): string {
  const result = runGit(repoPath, ['status', '--porcelain']);
  if (result.status !== 0) {
    throw new Error(`Failed to get git status: ${result.stderr}`);
  }
  return result.stdout;
}

export function stageOnlyFiles(repoPath: string, files: string[]): void {
  if (files.length === 0) {
    throw new Error('stageOnlyFiles: files array must not be empty');
  }

  for (const file of files) {
    if (isAbsolute(file)) {
      throw new Error(`stageOnlyFiles: absolute path not allowed: ${file}`);
    }
    if (file.includes('..')) {
      throw new Error(`stageOnlyFiles: path traversal not allowed: ${file}`);
    }
  }

  const result = runGit(repoPath, ['add', '--', ...files]);
  if (result.status !== 0) {
    throw new Error(`git add failed: ${result.stderr}`);
  }
}

export function commitStagedChanges(repoPath: string, message: string): string {
  const result = runGit(repoPath, ['commit', '-m', message, '--no-gpg-sign']);
  if (result.status !== 0) {
    throw new Error(`git commit failed: ${result.stderr}`);
  }

  const shaResult = runGit(repoPath, ['rev-parse', 'HEAD']);
  if (shaResult.status !== 0) {
    throw new Error(`git rev-parse HEAD failed: ${shaResult.stderr}`);
  }
  const sha = shaResult.stdout.trim();
  if (!/^[0-9a-fA-F]{40}$/.test(sha)) {
    throw new Error(`Invalid commit SHA returned: ${sha}`);
  }
  return sha.toLowerCase();
}

export function pushCurrentBranch(repoPath: string, branch: string): boolean {
  const result = runGit(repoPath, ['push', 'origin', branch]);
  return result.status === 0;
}

export function assertNoUnrelatedChanges(repoPath: string, approvedFiles: string[]): void {
  const statusResult = runGit(repoPath, ['status', '--porcelain']);
  if (statusResult.status !== 0) {
    throw new Error(`git status failed: ${statusResult.stderr}`);
  }

  const lines = statusResult.stdout.split('\n').filter((line) => line.trim().length > 0);
  const approvedSet = new Set(approvedFiles.map((f) => f.replace(/\\/g, '/')));

  for (const line of lines) {
    // porcelain format: XY <path> or XY <path> -> <origPath> for renames
    const pathPart = line.substring(3).trim();
    const filePath = pathPart.split(' -> ').pop() ?? pathPart;
    const normalized = filePath.replace(/\\/g, '/');

    if (!approvedSet.has(normalized)) {
      throw new Error(`Unrelated change detected: ${normalized}`);
    }
  }
}

export function getCommitDiff(repoPath: string): string {
  const result = runGit(repoPath, ['diff', 'HEAD~1', 'HEAD']);
  if (result.status === 0) {
    return result.stdout;
  }
  // If HEAD~1 does not exist (single commit), try git show
  const showResult = runGit(repoPath, ['show', '--patch', 'HEAD']);
  if (showResult.status === 0) {
    return showResult.stdout;
  }
  throw new Error(`git diff failed: ${result.stderr}`);
}
