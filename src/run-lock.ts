import { createHash } from 'node:crypto';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { config } from './config.js';
import { redactSecrets } from './sandbox-preflight-repair.js';

export interface RunLockMetadata {
  pid: number;
  command: string;
  blockId?: string;
  repoPath?: string;
  workBranch?: string;
  createdAt: string;
}

export class RunLockError extends Error {
  constructor(
    public readonly lockPath: string,
    public readonly metadata: RunLockMetadata | null
  ) {
    super(formatRunLockError(lockPath, metadata));
  }
}

function formatLockOwner(metadata: RunLockMetadata | null): string {
  if (metadata === null) {
    return 'unknown process';
  }
  const parts: string[] = [`pid=${metadata.pid}`, `command=${metadata.command}`];
  if (metadata.blockId) {
    parts.push(`block_id=${metadata.blockId}`);
  }
  if (metadata.repoPath) {
    parts.push(`repo_path=${redactSecrets(metadata.repoPath)}`);
  }
  if (metadata.workBranch) {
    parts.push(`work_branch=${metadata.workBranch}`);
  }
  return parts.join(', ');
}

function isStaleLock(metadata: RunLockMetadata | null): boolean {
  if (metadata === null) {
    return false;
  }
  const createdAt = Date.parse(metadata.createdAt);
  if (Number.isNaN(createdAt)) {
    return false;
  }
  const oneHour = 60 * 60 * 1000;
  return Date.now() - createdAt > oneHour;
}

export function formatRunLockError(
  lockPath: string,
  metadata: RunLockMetadata | null
): string {
  const owner = formatLockOwner(metadata);
  const staleHint = isStaleLock(metadata)
    ? ' The lock appears stale (older than 1 hour).'
    : '';
  return `Another run appears to be active (${owner}). Lock file: ${lockPath}. If the lock is stale, remove it manually and retry.${staleHint}`;
}

export function readRunLockMetadata(lockPath: string): RunLockMetadata | null {
  if (!existsSync(lockPath)) {
    return null;
  }
  try {
    const raw = readFileSync(lockPath, 'utf-8');
    const parsed = JSON.parse(raw) as unknown;
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      !Array.isArray(parsed) &&
      typeof (parsed as Record<string, unknown>).pid === 'number' &&
      typeof (parsed as Record<string, unknown>).command === 'string' &&
      typeof (parsed as Record<string, unknown>).createdAt === 'string'
    ) {
      return parsed as RunLockMetadata;
    }
    return null;
  } catch {
    return null;
  }
}

export function acquireRunLock(
  lockPath: string,
  metadata: RunLockMetadata
): void {
  const dir = dirname(lockPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  let fd: number | undefined;
  try {
    fd = openSync(lockPath, 'wx');
    writeFileSync(fd, JSON.stringify(metadata, null, 2), 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      const existing = readRunLockMetadata(lockPath);
      throw new RunLockError(lockPath, existing);
    }
    throw err;
  } finally {
    if (fd !== undefined) {
      closeSync(fd);
    }
  }
}

export function releaseRunLock(lockPath: string): void {
  try {
    unlinkSync(lockPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.error(
        `[run-lock] Warning: could not release lock ${lockPath}: ${(err as Error).message}`
      );
    }
  }
}

export function getRepoRunLockPath(
  repoPath: string,
  workBranch: string,
  runsDir?: string
): string {
  const resolvedRepo = resolve(repoPath);
  const key = `${resolvedRepo.replace(/\\/g, '/')}::${workBranch}`;
  const hash = createHash('sha256').update(key).digest('hex').slice(0, 16);
  const baseDir = resolve(runsDir ?? config.runsDir, 'repo-locks');
  return join(baseDir, `${hash}.lock`);
}
