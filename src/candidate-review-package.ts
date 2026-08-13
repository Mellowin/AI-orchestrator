import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { getCandidateDiff } from './candidate-workspace.js';
import { computeFileHash } from './candidate-state.js';
import type { DependencyEvidencePackage, Task } from './types.js';
import type { ReviewerEvidence } from './reviewer-evidence.js';

export interface CandidateReviewPackageFile {
  path: string;
  bytes: number;
  lines: number;
  sha256: string;
  content: string;
}

export interface ReadOnlyContextFile {
  path: string;
  bytes: number;
  lines: number;
  sha256: string;
  content: string;
  truncated?: boolean;
}

export interface CandidateReviewPackage {
  task_id: string;
  task_base_sha: string;
  candidate_package_hash: string;
  changed_files: string[];
  files: CandidateReviewPackageFile[];
  staged_diff: string;
  staged_diff_sha256: string;
  checks_summary: ReviewerEvidence['checkSummary'];
  acceptance_criteria?: string[];
  allowed_files: string[];
  denied_files: string[];
  dependency_evidence?: DependencyEvidencePackage;
  read_only_context: ReadOnlyContextFile[];
  read_only_context_total_bytes: number;
  read_only_context_truncated: boolean;
  created_at: string;
}

export interface BuildCandidateReviewPackageOptions {
  candidatePath: string;
  taskBaseSha: string;
  task: Task;
  checkSummary: ReviewerEvidence['checkSummary'];
  dependencyEvidence?: DependencyEvidencePackage;
  maxContextFileBytes?: number;
  maxTotalContextBytes?: number;
}

const DEFAULT_MAX_CONTEXT_FILE_BYTES = 50 * 1024;
const DEFAULT_MAX_TOTAL_CONTEXT_BYTES = 200 * 1024;

function countLines(text: string): number {
  if (text.length === 0) return 0;
  const lines = text.split('\n');
  return text.endsWith('\n') ? lines.length - 1 : lines.length;
}

function readWorkspaceFile(candidatePath: string, filePath: string): CandidateReviewPackageFile | null {
  const absolutePath = join(candidatePath, filePath);
  if (!existsSync(absolutePath)) {
    return null;
  }
  const content = readFileSync(absolutePath, 'utf-8');
  return {
    path: filePath,
    bytes: Buffer.byteLength(content, 'utf-8'),
    lines: countLines(content),
    sha256: computeFileHash(content),
    content,
  };
}

export function computeCandidateReviewPackageHash(files: CandidateReviewPackageFile[]): string {
  const hasher = createHash('sha256');
  for (const file of [...files].sort((a, b) => a.path.localeCompare(b.path))) {
    hasher.update(`${file.path}:${file.sha256}\n`);
  }
  return hasher.digest('hex');
}

function buildReadOnlyContext(
  candidatePath: string,
  contextFiles: string[],
  maxContextFileBytes: number,
  maxTotalContextBytes: number
): { files: ReadOnlyContextFile[]; total_bytes: number; truncated: boolean } {
  const files: ReadOnlyContextFile[] = [];
  let totalBytes = 0;
  let truncated = false;

  for (const filePath of contextFiles) {
    if (totalBytes >= maxTotalContextBytes) {
      truncated = true;
      break;
    }
    const absolutePath = join(candidatePath, filePath);
    if (!existsSync(absolutePath)) {
      continue;
    }
    const content = readFileSync(absolutePath, 'utf-8');
    const fullBytes = Buffer.byteLength(content, 'utf-8');
    const fileMax = Math.min(maxContextFileBytes, maxTotalContextBytes - totalBytes);
    const fileTruncated = fullBytes > fileMax;
    const effectiveContent = fileTruncated ? content.slice(0, fileMax) : content;
    const effectiveBytes = Buffer.byteLength(effectiveContent, 'utf-8');

    files.push({
      path: filePath,
      bytes: fullBytes,
      lines: countLines(content),
      sha256: computeFileHash(content),
      content: effectiveContent,
      truncated: fileTruncated || undefined,
    });
    totalBytes += effectiveBytes;

    if (fileTruncated) {
      truncated = true;
    }
  }

  return { files, total_bytes: totalBytes, truncated };
}

export function buildCandidateReviewPackage(
  options: BuildCandidateReviewPackageOptions
): CandidateReviewPackage {
  const { candidatePath, taskBaseSha, task, checkSummary, dependencyEvidence } = options;
  const diffInfo = getCandidateDiff(candidatePath, taskBaseSha);

  const files: CandidateReviewPackageFile[] = [];
  for (const filePath of diffInfo.changedFiles) {
    const file = readWorkspaceFile(candidatePath, filePath);
    if (file) {
      files.push(file);
    }
  }

  const candidatePackageHash = computeCandidateReviewPackageHash(files);
  const readOnlyContext = buildReadOnlyContext(
    candidatePath,
    task.context_files ?? [],
    options.maxContextFileBytes ?? DEFAULT_MAX_CONTEXT_FILE_BYTES,
    options.maxTotalContextBytes ?? DEFAULT_MAX_TOTAL_CONTEXT_BYTES
  );

  return {
    task_id: task.id,
    task_base_sha: taskBaseSha,
    candidate_package_hash: candidatePackageHash,
    changed_files: diffInfo.changedFiles,
    files,
    staged_diff: diffInfo.diff,
    staged_diff_sha256: computeFileHash(diffInfo.diff),
    checks_summary: checkSummary,
    acceptance_criteria: task.acceptance_criteria,
    allowed_files: task.guardrails.allow_modify ?? [],
    denied_files: task.guardrails.deny_modify,
    dependency_evidence: dependencyEvidence,
    read_only_context: readOnlyContext.files,
    read_only_context_total_bytes: readOnlyContext.total_bytes,
    read_only_context_truncated: readOnlyContext.truncated,
    created_at: new Date().toISOString(),
  };
}

export function recomputeCandidateReviewPackage(
  pkg: CandidateReviewPackage
): { hash: string; files: CandidateReviewPackageFile[]; diffSha256: string } {
  const hash = computeCandidateReviewPackageHash(pkg.files);
  return {
    hash,
    files: pkg.files,
    diffSha256: computeFileHash(pkg.staged_diff),
  };
}

export function recomputeCandidateReviewPackageFromWorkspace(
  options: BuildCandidateReviewPackageOptions
): CandidateReviewPackage {
  return buildCandidateReviewPackage(options);
}

function packagePath(runsDir: string, taskId: string): string {
  return join(runsDir, taskId, 'candidate-review-package.json');
}

export function saveCandidateReviewPackage(
  runsDir: string,
  taskId: string,
  pkg: CandidateReviewPackage
): void {
  const path = packagePath(runsDir, taskId);
  const parent = dirname(path);
  if (!existsSync(parent)) {
    mkdirSync(parent, { recursive: true });
  }
  writeFileSync(path, JSON.stringify(pkg, null, 2), 'utf-8');
}

export function loadCandidateReviewPackage(
  runsDir: string,
  taskId: string
): CandidateReviewPackage | null {
  const path = packagePath(runsDir, taskId);
  if (!existsSync(path)) {
    return null;
  }
  try {
    const raw = readFileSync(path, 'utf-8');
    const parsed = JSON.parse(raw) as unknown;
    if (!isCandidateReviewPackage(parsed)) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function isCandidateReviewPackage(value: unknown): value is CandidateReviewPackage {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const p = value as Record<string, unknown>;
  return (
    typeof p.task_id === 'string' &&
    typeof p.task_base_sha === 'string' &&
    typeof p.candidate_package_hash === 'string' &&
    Array.isArray(p.changed_files) &&
    Array.isArray(p.files) &&
    typeof p.staged_diff === 'string' &&
    typeof p.staged_diff_sha256 === 'string'
  );
}
