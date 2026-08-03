import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { isAbsolute, resolve } from 'node:path';
import { matchesPattern } from '../guardrails.js';
import type { DependencyEvidenceItem, DependencyEvidencePackage } from '../types.js';

export interface DependencyEvidenceTask {
  id: string;
  depends_on?: string[];
  allowed_files?: string[];
}

export interface DependencyEvidenceTaskState {
  task_id: string;
  status: string;
  commit_sha?: string;
  fix_commit_sha?: string;
}

export interface DependencyEvidenceOptions {
  repoPath: string;
  currentTaskId: string;
  tasks: DependencyEvidenceTask[];
  taskStates: DependencyEvidenceTaskState[];
  perFileByteLimit?: number;
  totalByteLimit?: number;
}

const DEFAULT_PER_FILE_BYTE_LIMIT = 100_000;
const DEFAULT_TOTAL_BYTE_LIMIT = 500_000;

const DENIED_PATH_SEGMENTS = ['.env', '.git', 'node_modules'];

function normalizePath(value: string): string {
  return value.replace(/\\/g, '/');
}

function isDeniedPath(path: string): boolean {
  const normalized = normalizePath(path);
  if (isAbsolute(normalized) || normalized.includes('..')) return true;
  if (normalized.startsWith('/') || normalized.startsWith('\\')) return true;
  const segments = normalized.split('/');
  for (const segment of segments) {
    if (DENIED_PATH_SEGMENTS.includes(segment)) return true;
    if (segment.startsWith('.env')) return true;
  }
  return false;
}

function verifyCommitExists(repoPath: string, commitSha: string): boolean {
  const result = spawnSync('git', ['cat-file', '-t', commitSha], {
    cwd: repoPath,
    encoding: 'utf-8',
    shell: false,
  });
  return result.status === 0 && result.stdout.trim() === 'commit';
}

function verifyCommitIsAncestor(repoPath: string, commitSha: string): boolean {
  if (!/^[0-9a-f]{40}$/i.test(commitSha)) return false;
  if (!verifyCommitExists(repoPath, commitSha)) return false;
  const result = spawnSync('git', ['merge-base', '--is-ancestor', commitSha, 'HEAD'], {
    cwd: repoPath,
    encoding: 'utf-8',
    shell: false,
  });
  return result.status === 0;
}

function getCommitChangedFiles(repoPath: string, commitSha: string): string[] {
  const result = spawnSync(
    'git',
    ['diff-tree', '--no-commit-id', '--name-only', '-r', commitSha],
    {
      cwd: repoPath,
      encoding: 'utf-8',
      shell: false,
    }
  );
  if (result.status !== 0) return [];
  return result.stdout
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

function readFileFromHead(repoPath: string, path: string): Buffer | undefined {
  const result = spawnSync('git', ['show', `HEAD:${path}`], {
    cwd: repoPath,
    shell: false,
    // Intentionally omit encoding so we get a Buffer for binary detection.
  });
  if (result.status !== 0 || !result.stdout) return undefined;
  return result.stdout as Buffer;
}

function computeSha256(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

function isBinaryBuffer(buffer: Buffer): boolean {
  return buffer.indexOf(0) !== -1;
}

function truncateContent(content: string, byteLimit: number): { content: string; truncated: boolean } {
  const buffer = Buffer.from(content, 'utf-8');
  if (buffer.length <= byteLimit) {
    return { content, truncated: false };
  }
  const truncatedBuffer = buffer.subarray(0, byteLimit);
  // Decode safely by stripping an incomplete multi-byte sequence at the end.
  let text = truncatedBuffer.toString('utf-8');
  // Remove the last character if it became a replacement marker due to truncation.
  if (text.includes('\uFFFD') && text.length > 0) {
    text = text.slice(0, text.lastIndexOf('\uFFFD'));
  }
  const marker = `\n[truncated at ${byteLimit} bytes]`;
  return { content: text + marker, truncated: true };
}

function collectAncestorIds(
  currentTaskId: string,
  taskMap: Map<string, DependencyEvidenceTask>
): string[] {
  const ancestors: string[] = [];
  const visited = new Set<string>();
  const stack: string[] = [currentTaskId];

  while (stack.length > 0) {
    const id = stack.pop()!;
    if (visited.has(id)) continue;
    visited.add(id);

    const task = taskMap.get(id);
    if (!task) continue;

    for (const dep of task.depends_on ?? []) {
      if (!visited.has(dep)) {
        stack.push(dep);
        if (dep !== currentTaskId && !ancestors.includes(dep)) {
          ancestors.push(dep);
        }
      }
    }
  }

  // Return ancestors in task-definition order for deterministic, stable output.
  const taskList = [...taskMap.values()];
  const order = new Map(taskList.map((t, i) => [t.id, i]));
  return ancestors.sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));
}

function fileMatchesAnyPattern(file: string, patterns: string[] | undefined): boolean {
  if (!patterns || patterns.length === 0) return false;
  const normalizedFile = normalizePath(file);
  return patterns.some((pattern) => matchesPattern(normalizedFile, normalizePath(pattern)));
}

export function buildDependencyEvidence(
  options: DependencyEvidenceOptions
): DependencyEvidencePackage {
  const repoPath = resolve(options.repoPath);
  const perFileByteLimit = options.perFileByteLimit ?? DEFAULT_PER_FILE_BYTE_LIMIT;
  const totalByteLimit = options.totalByteLimit ?? DEFAULT_TOTAL_BYTE_LIMIT;

  const taskMap = new Map<string, DependencyEvidenceTask>();
  for (const task of options.tasks) {
    taskMap.set(task.id, task);
  }

  const stateMap = new Map<string, DependencyEvidenceTaskState>();
  for (const state of options.taskStates) {
    stateMap.set(state.task_id, state);
  }

  const ancestors = collectAncestorIds(options.currentTaskId, taskMap);
  const items: DependencyEvidenceItem[] = [];
  let totalBytes = 0;
  let truncated = false;
  let omittedCount = 0;

  for (const ancestorId of ancestors) {
    const state = stateMap.get(ancestorId);
    if (!state) {
      throw new Error(
        `Dependency evidence cannot be built: ancestor task ${ancestorId} has no recorded state`
      );
    }

    if (state.status !== 'accepted' && state.status !== 'fixed_and_accepted') {
      throw new Error(
        `Dependency evidence cannot be built: ancestor task ${ancestorId} is ${state.status}`
      );
    }

    const effectiveCommitSha = state.fix_commit_sha ?? state.commit_sha;
    if (!effectiveCommitSha || effectiveCommitSha.length !== 40) {
      throw new Error(
        `Dependency evidence cannot be built: ancestor task ${ancestorId} has no valid commit SHA`
      );
    }

    if (!verifyCommitExists(repoPath, effectiveCommitSha)) {
      throw new Error(
        `Dependency evidence cannot be built: commit ${effectiveCommitSha} for ancestor task ${ancestorId} does not exist`
      );
    }
    if (!verifyCommitIsAncestor(repoPath, effectiveCommitSha)) {
      throw new Error(
        `Dependency evidence cannot be built: commit ${effectiveCommitSha} for ancestor task ${ancestorId} is not in current branch history`
      );
    }

    const ancestorTask = taskMap.get(ancestorId);
    const changedFiles = getCommitChangedFiles(repoPath, effectiveCommitSha);

    for (const file of changedFiles) {
      if (isDeniedPath(file)) continue;

      const ancestorAllowed = ancestorTask?.allowed_files;
      if (ancestorAllowed && !fileMatchesAnyPattern(file, ancestorAllowed)) {
        // Skip files that the ancestor task was not authorized to create/modify.
        continue;
      }

      const rawBuffer = readFileFromHead(repoPath, file);
      if (!rawBuffer) continue;
      if (isBinaryBuffer(rawBuffer)) continue;

      const sha256 = computeSha256(rawBuffer);
      const bytes = rawBuffer.length;
      const contentString = rawBuffer.toString('utf-8');
      const lines = contentString.split('\n').length - (contentString.endsWith('\n') ? 1 : 0);

      if (totalBytes >= totalByteLimit) {
        omittedCount++;
        truncated = true;
        continue;
      }

      const { content, truncated: fileTruncated } = truncateContent(
        contentString,
        Math.min(perFileByteLimit, totalByteLimit - totalBytes)
      );

      items.push({
        task_id: ancestorId,
        task_status: state.status,
        accepted_commit_sha: state.commit_sha,
        fix_commit_sha: state.fix_commit_sha,
        path: file,
        content_sha256: sha256,
        bytes,
        lines,
        content,
        truncated: fileTruncated,
      });

      totalBytes += Buffer.byteLength(content, 'utf-8');
      if (fileTruncated) {
        truncated = true;
      }
    }
  }

  return {
    items,
    total_bytes: totalBytes,
    truncated,
    omitted_count: omittedCount,
  };
}

export interface MissionDependencyEvidenceOptions {
  repoPath: string;
  tasks: DependencyEvidenceTask[];
  taskStates: DependencyEvidenceTaskState[];
  perFileByteLimit?: number;
  totalByteLimit?: number;
}

export function buildMissionDependencyEvidence(
  options: MissionDependencyEvidenceOptions
): DependencyEvidencePackage {
  const repoPath = resolve(options.repoPath);
  const perFileByteLimit = options.perFileByteLimit ?? DEFAULT_PER_FILE_BYTE_LIMIT;
  const totalByteLimit = options.totalByteLimit ?? DEFAULT_TOTAL_BYTE_LIMIT;

  const taskMap = new Map<string, DependencyEvidenceTask>();
  for (const task of options.tasks) {
    taskMap.set(task.id, task);
  }

  const stateMap = new Map<string, DependencyEvidenceTaskState>();
  for (const state of options.taskStates) {
    stateMap.set(state.task_id, state);
  }

  const items: DependencyEvidenceItem[] = [];
  let totalBytes = 0;
  let truncated = false;
  let omittedCount = 0;

  for (const state of options.taskStates) {
    if (state.status !== 'accepted' && state.status !== 'fixed_and_accepted') {
      continue;
    }

    const effectiveCommitSha = state.fix_commit_sha ?? state.commit_sha;
    if (!effectiveCommitSha || effectiveCommitSha.length !== 40) continue;
    if (!verifyCommitExists(repoPath, effectiveCommitSha)) continue;
    if (!verifyCommitIsAncestor(repoPath, effectiveCommitSha)) continue;

    const task = taskMap.get(state.task_id);
    const changedFiles = getCommitChangedFiles(repoPath, effectiveCommitSha);

    for (const file of changedFiles) {
      if (isDeniedPath(file)) continue;
      if (task?.allowed_files && !fileMatchesAnyPattern(file, task.allowed_files)) continue;

      const rawBuffer = readFileFromHead(repoPath, file);
      if (!rawBuffer) continue;
      if (isBinaryBuffer(rawBuffer)) continue;

      const sha256 = computeSha256(rawBuffer);
      const bytes = rawBuffer.length;
      const contentString = rawBuffer.toString('utf-8');
      const lines = contentString.split('\n').length - (contentString.endsWith('\n') ? 1 : 0);

      if (totalBytes >= totalByteLimit) {
        omittedCount++;
        truncated = true;
        continue;
      }

      const { content, truncated: fileTruncated } = truncateContent(
        contentString,
        Math.min(perFileByteLimit, totalByteLimit - totalBytes)
      );

      items.push({
        task_id: state.task_id,
        task_status: state.status,
        accepted_commit_sha: state.commit_sha,
        fix_commit_sha: state.fix_commit_sha,
        path: file,
        content_sha256: sha256,
        bytes,
        lines,
        content,
        truncated: fileTruncated,
      });

      totalBytes += Buffer.byteLength(content, 'utf-8');
      if (fileTruncated) {
        truncated = true;
      }
    }
  }

  return {
    items,
    total_bytes: totalBytes,
    truncated,
    omitted_count: omittedCount,
  };
}
