import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import type { FileUpdate, KimiOutput } from './types.js';

export type ProposedFileEffect = 'create' | 'modify' | 'identical';

export interface ClassifiedProposedFile {
  path: string;
  exists_before: boolean;
  before_bytes: number | null;
  before_lines: number | null;
  before_sha256: string | null;
  proposed_bytes: number;
  proposed_lines: number;
  proposed_sha256: string;
  effect: ProposedFileEffect;
}

export type KimiOutputClassification =
  | 'EMPTY_FILE_LIST'
  | 'ALL_IDENTICAL'
  | 'EFFECTIVE_CHANGES';

export interface ClassifiedKimiOutput {
  classification: KimiOutputClassification;
  files: ClassifiedProposedFile[];
  summary: string;
}

function hashString(value: string): string {
  return createHash('sha256').update(value, 'utf-8').digest('hex');
}

function countLines(content: string): number {
  if (content.length === 0) {
    return 0;
  }
  return content.split('\n').length;
}

export function classifyProposedFile(
  repoPath: string,
  update: FileUpdate
): ClassifiedProposedFile {
  const normalizedPath = update.path.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+/g, '/');
  const fullPath = `${repoPath}/${normalizedPath}`.replace(/\\/g, '/');
  const proposedSha256 = hashString(update.content);
  const proposedBytes = Buffer.byteLength(update.content, 'utf-8');
  const proposedLines = countLines(update.content);

  if (!existsSync(fullPath)) {
    return {
      path: normalizedPath,
      exists_before: false,
      before_bytes: null,
      before_lines: null,
      before_sha256: null,
      proposed_bytes: proposedBytes,
      proposed_lines: proposedLines,
      proposed_sha256: proposedSha256,
      effect: 'create',
    };
  }

  const beforeContent = readFileSync(fullPath, 'utf-8');
  const beforeSha256 = hashString(beforeContent);
  const beforeBytes = Buffer.byteLength(beforeContent, 'utf-8');
  const beforeLines = countLines(beforeContent);

  return {
    path: normalizedPath,
    exists_before: true,
    before_bytes: beforeBytes,
    before_lines: beforeLines,
    before_sha256: beforeSha256,
    proposed_bytes: proposedBytes,
    proposed_lines: proposedLines,
    proposed_sha256: proposedSha256,
    effect: beforeSha256 === proposedSha256 ? 'identical' : 'modify',
  };
}

export function classifyKimiOutput(
  repoPath: string,
  output: KimiOutput
): ClassifiedKimiOutput {
  if (!output.files || output.files.length === 0) {
    return {
      classification: 'EMPTY_FILE_LIST',
      files: [],
      summary: 'Provider returned no file updates',
    };
  }

  const classifiedFiles = output.files.map((file) => classifyProposedFile(repoPath, file));

  const hasEffective = classifiedFiles.some(
    (file) => file.effect === 'create' || file.effect === 'modify'
  );

  if (!hasEffective) {
    return {
      classification: 'ALL_IDENTICAL',
      files: classifiedFiles,
      summary: `All ${classifiedFiles.length} proposed file(s) match existing content byte-for-byte`,
    };
  }

  const created = classifiedFiles.filter((f) => f.effect === 'create').length;
  const modified = classifiedFiles.filter((f) => f.effect === 'modify').length;
  const identical = classifiedFiles.filter((f) => f.effect === 'identical').length;

  return {
    classification: 'EFFECTIVE_CHANGES',
    files: classifiedFiles,
    summary: `Effective changes: ${created} create(s), ${modified} modify(ies), ${identical} identical`,
  };
}
