import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeJsonAtomic } from './state-atomic-write.js';

export interface CandidateSnapshotFile {
  path: string;
  content: string;
  sha256: string;
}

export interface CandidateSnapshot {
  attemptId: string;
  phase: string;
  taskBaseSha: string;
  changedFiles: string[];
  fileContents: CandidateSnapshotFile[];
  candidatePackageHash: string;
}

export function computeFileHash(content: string): string {
  return createHash('sha256').update(content, 'utf-8').digest('hex');
}

export function computeCandidatePackageHash(snapshot: Pick<CandidateSnapshot, 'fileContents'>): string {
  const hasher = createHash('sha256');
  for (const file of [...snapshot.fileContents].sort((a, b) => a.path.localeCompare(b.path))) {
    hasher.update(`${file.path}:${file.sha256}\n`);
  }
  return hasher.digest('hex');
}

function getSnapshotsDir(runsDir: string, taskId: string): string {
  return join(runsDir, taskId, 'candidate-snapshots');
}

export function saveCandidateSnapshot(
  runsDir: string,
  taskId: string,
  snapshot: CandidateSnapshot
): void {
  const snapshotsDir = getSnapshotsDir(runsDir, taskId);
  if (!existsSync(snapshotsDir)) {
    mkdirSync(snapshotsDir, { recursive: true });
  }
  const computed = computeCandidatePackageHash(snapshot);
  if (snapshot.candidatePackageHash !== computed) {
    snapshot.candidatePackageHash = computed;
  }
  const path = join(snapshotsDir, `${snapshot.attemptId}.json`);
  writeJsonAtomic(path, snapshot);
}

export function loadLatestCandidateSnapshot(
  runsDir: string,
  taskId: string
): CandidateSnapshot | null {
  const snapshotsDir = getSnapshotsDir(runsDir, taskId);
  if (!existsSync(snapshotsDir)) {
    return null;
  }
  const entries = readdirSync(snapshotsDir, { withFileTypes: true });
  const files = entries
    .filter((e) => e.isFile() && e.name.endsWith('.json'))
    .map((e) => e.name)
    .sort();
  if (files.length === 0) {
    return null;
  }
  const latest = files[files.length - 1];
  const path = join(snapshotsDir, latest);
  try {
    const raw = readFileSync(path, 'utf-8');
    const parsed = JSON.parse(raw) as unknown;
    if (!isCandidateSnapshot(parsed)) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function isCandidateSnapshot(value: unknown): value is CandidateSnapshot {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const s = value as Record<string, unknown>;
  if (typeof s.attemptId !== 'string') return false;
  if (typeof s.phase !== 'string') return false;
  if (typeof s.taskBaseSha !== 'string') return false;
  if (!Array.isArray(s.changedFiles)) return false;
  if (!Array.isArray(s.fileContents)) return false;
  if (typeof s.candidatePackageHash !== 'string') return false;
  for (const f of s.fileContents) {
    if (typeof f !== 'object' || f === null || Array.isArray(f)) return false;
    const cf = f as Record<string, unknown>;
    if (typeof cf.path !== 'string') return false;
    if (typeof cf.content !== 'string') return false;
    if (typeof cf.sha256 !== 'string') return false;
  }
  return true;
}

/**
 * Restore a candidate workspace from a snapshot. This writes the saved file
 * contents into the workspace, stages the changed files, and validates the
 * workspace state. It is used on resume when the workspace is missing or invalid.
 */
export function restoreCandidateSnapshot(
  candidatePath: string,
  snapshot: CandidateSnapshot
): { ok: boolean; reason?: string } {
  if (!existsSync(candidatePath)) {
    return { ok: false, reason: 'Candidate workspace does not exist' };
  }
  for (const file of snapshot.fileContents) {
    const expectedHash = computeFileHash(file.content);
    if (file.sha256 !== expectedHash) {
      return { ok: false, reason: `Snapshot hash mismatch for ${file.path}` };
    }
  }
  // Restore files by writing content directly. Existing files are overwritten;
  // new files are created. Any files not in the snapshot are left untouched, but
  // the caller must validate the workspace afterwards.
  for (const file of snapshot.fileContents) {
    const filePath = join(candidatePath, file.path);
    const parentDir = join(filePath, '..');
    if (!existsSync(parentDir)) {
      mkdirSync(parentDir, { recursive: true });
    }
    writeFileSync(filePath, file.content, 'utf-8');
  }
  return { ok: true };
}
