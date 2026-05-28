import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { sync as spawnSync } from 'cross-spawn';
import type { DiffStat } from './types.js';

function validateRepoPath(repoPath: string): void {
  const resolved = resolve(repoPath);
  if (!existsSync(resolved)) {
    throw new Error(`repoPath does not exist: ${repoPath}`);
  }
  if (!statSync(resolved).isDirectory()) {
    throw new Error(`repoPath is not a directory: ${repoPath}`);
  }
  if (!existsSync(resolve(resolved, '.git'))) {
    throw new Error(`repoPath is not a git repository: ${repoPath}`);
  }
}

function validateBranchName(branch: string): void {
  if (!branch || branch.length === 0) {
    throw new Error('Branch name must not be empty');
  }
  if (branch.startsWith('-')) {
    throw new Error(`Invalid branch name: "${branch}" (starts with "-")`);
  }
  if (branch.includes(' ')) {
    throw new Error(`Invalid branch name: "${branch}" (contains space)`);
  }
  if (branch.includes('..')) {
    throw new Error(`Invalid branch name: "${branch}" (contains "..")`);
  }
  if (
    branch.includes('~') ||
    branch.includes('^') ||
    branch.includes(':') ||
    branch.includes('?') ||
    branch.includes('*') ||
    branch.includes('[') ||
    branch.includes('\\')
  ) {
    throw new Error(
      `Invalid branch name: "${branch}" (contains special characters)`
    );
  }
  if (branch.endsWith('/')) {
    throw new Error(`Invalid branch name: "${branch}" (ends with "/")`);
  }
  if (branch.includes('//')) {
    throw new Error(`Invalid branch name: "${branch}" (contains "//")`);
  }
}

function gitRaw(repoPath: string, args: string[]): string {
  const result = spawnSync('git', args, {
    cwd: repoPath,
    shell: false,
    encoding: 'utf-8',
  });
  if (result.error) {
    throw new Error(
      `Git command failed: git ${args.join(' ')} — ${result.error.message}`
    );
  }
  if (result.status !== 0) {
    const err =
      result.stderr?.trim() ||
      `git ${args.join(' ')} exited with code ${result.status}`;
    throw new Error(err);
  }
  return result.stdout;
}

function git(repoPath: string, args: string[]): string {
  return gitRaw(repoPath, args).trim();
}

export function ensureClean(repoPath: string): void {
  validateRepoPath(repoPath);
  const status = git(repoPath, ['status', '--porcelain']);
  if (status.length > 0) {
    throw new Error(
      'Working tree is not clean. Commit or stash changes first.'
    );
  }
}

export function getCurrentBranch(repoPath: string): string {
  validateRepoPath(repoPath);
  return git(repoPath, ['rev-parse', '--abbrev-ref', 'HEAD']);
}

export function branchExists(repoPath: string, branch: string): boolean {
  validateRepoPath(repoPath);
  validateBranchName(branch);
  const result = spawnSync(
    'git',
    ['rev-parse', '--verify', `refs/heads/${branch}`],
    {
      cwd: repoPath,
      shell: false,
      encoding: 'utf-8',
    }
  );

  if (result.error) {
    throw new Error(
      `Git command failed: git rev-parse --verify refs/heads/${branch} — ${result.error.message}`
    );
  }

  return result.status === 0;
}

export function checkoutExistingBranch(
  repoPath: string,
  branch: string
): void {
  validateRepoPath(repoPath);
  validateBranchName(branch);
  git(repoPath, ['checkout', branch]);
}

export function createBranch(
  repoPath: string,
  baseBranch: string,
  workBranch: string
): void {
  validateRepoPath(repoPath);
  validateBranchName(baseBranch);
  validateBranchName(workBranch);
  git(repoPath, ['checkout', baseBranch]);
  git(repoPath, ['pull', '--ff-only']);
  git(repoPath, ['checkout', '-b', workBranch]);
}

export function getChangedFiles(repoPath: string): string[] {
  validateRepoPath(repoPath);
  const output = gitRaw(repoPath, [
    'status',
    '--porcelain',
    '--untracked-files=all',
  ]);
  return output
    .split('\n')
    .map((s) => s.trimEnd())
    .filter((s) => s.length > 0)
    .map((s) => {
      const withoutPrefix = s.slice(3);
      if (withoutPrefix.includes(' -> ')) {
        return withoutPrefix.split(' -> ')[1];
      }
      return withoutPrefix;
    });
}

export function getCurrentDiff(repoPath: string): string {
  validateRepoPath(repoPath);
  return gitRaw(repoPath, ['diff', '--no-ext-diff']);
}

export function getDiffStat(repoPath: string): DiffStat {
  validateRepoPath(repoPath);
  const output = git(repoPath, ['diff', '--numstat']);
  const lines = output
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  const files: string[] = [];
  const binaryFiles: string[] = [];
  let insertions = 0;
  let deletions = 0;

  for (const line of lines) {
    const parts = line.split('\t');
    if (parts.length < 3) continue;

    const [insStr, delStr, filePath] = parts;
    files.push(filePath);

    if (insStr === '-' || delStr === '-') {
      binaryFiles.push(filePath);
      continue;
    }

    const ins = parseInt(insStr, 10);
    const del = parseInt(delStr, 10);
    if (!isNaN(ins)) insertions += ins;
    if (!isNaN(del)) deletions += del;
  }

  return { files, insertions, deletions, binaryFiles };
}

export function getWorkingTreeDiffStat(repoPath: string): DiffStat {
  validateRepoPath(repoPath);
  const baseStat = getDiffStat(repoPath);

  const stat: DiffStat = {
    files: [...baseStat.files],
    insertions: baseStat.insertions,
    deletions: baseStat.deletions,
    binaryFiles: [...baseStat.binaryFiles],
  };

  const untrackedOutput = gitRaw(repoPath, [
    'status',
    '--porcelain',
    '--untracked-files=all',
  ]);

  const untrackedLines = untrackedOutput
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && s.startsWith('??'));

  for (const line of untrackedLines) {
    const filePath = line.slice(3);
    const fullPath = resolve(repoPath, filePath);

    if (!existsSync(fullPath) || !statSync(fullPath).isFile()) {
      continue;
    }

    const content = readFileSync(fullPath);
    if (content.includes(0)) {
      stat.binaryFiles.push(filePath);
    } else {
      const text = content.toString('utf-8');
      const lineCount = text.split('\n').length;
      stat.insertions += lineCount;
    }
    stat.files.push(filePath);
  }

  return stat;
}

export function prepareWorkBranch(
  repoPath: string,
  baseBranch: string,
  workBranch: string,
  isResume: boolean
): void {
  ensureClean(repoPath);

  if (isResume) {
    if (!branchExists(repoPath, workBranch)) {
      throw new Error(
        `Cannot resume: work branch "${workBranch}" does not exist`
      );
    }
    checkoutExistingBranch(repoPath, workBranch);
  } else {
    if (branchExists(repoPath, workBranch)) {
      throw new Error(`Work branch "${workBranch}" already exists`);
    }
    createBranch(repoPath, baseBranch, workBranch);
  }
}
