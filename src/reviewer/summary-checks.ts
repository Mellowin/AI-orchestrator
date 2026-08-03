import { spawnSync } from 'node:child_process';
import { isAbsolute } from 'node:path';
import type { DependencyEvidencePackage } from '../types.js';

export interface SummaryCheckInput {
  repoPath: string;
  commitSha: string;
  allowedFiles: string[];
  acceptanceCriteria?: string[];
  dependencyEvidence?: DependencyEvidencePackage;
}

export interface SummaryCheckResult {
  ok: boolean;
  issues: string[];
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, '/');
}

function isConcretePath(pattern: string): boolean {
  return !/[?*]/.test(pattern);
}

function isDeniedPath(path: string): boolean {
  const normalized = normalizePath(path);
  if (isAbsolute(normalized) || normalized.includes('..')) return true;
  if (normalized.startsWith('/')) return true;
  const segments = normalized.split('/');
  return segments.some((s) => s === '.env' || s.startsWith('.env') || s === '.git' || s === 'node_modules');
}

function readFileFromCommit(repoPath: string, commitSha: string, path: string): string | undefined {
  const result = spawnSync('git', ['show', `${commitSha}:${path}`], {
    cwd: repoPath,
    encoding: 'utf-8',
    shell: false,
  });
  if (result.status !== 0) return undefined;
  return result.stdout;
}

function extractQuotedStrings(text: string): string[] {
  const strings: string[] = [];
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"' || ch === "'") {
      let j = i + 1;
      let escaped = false;
      while (j < text.length) {
        if (escaped) {
          escaped = false;
        } else if (text[j] === '\\') {
          escaped = true;
        } else if (text[j] === ch) {
          strings.push(text.slice(i + 1, j));
          break;
        }
        j++;
      }
    }
  }
  return strings;
}

function extractBareTokens(text: string): string[] {
  // Match path-like tokens such as docs/proofs/PART1.md or src/foo.ts.
  const matches = text.match(/(?:[a-zA-Z0-9_\-]+\/)+[a-zA-Z0-9_\-.]+/g);
  return matches ?? [];
}

function collectReferenceTargets(criterion: string): string[] {
  const lower = criterion.toLowerCase();
  if (
    !lower.includes('reference') &&
    !lower.includes('link') &&
    !lower.includes('mention') &&
    !lower.includes('summarize') &&
    !lower.includes('reflect')
  ) {
    return [];
  }

  const targets: string[] = [];
  for (const quoted of extractQuotedStrings(criterion)) {
    if (quoted.includes('/') || quoted.includes('.')) {
      targets.push(quoted);
    }
  }
  for (const token of extractBareTokens(criterion)) {
    if (token.includes('/') || token.includes('.')) {
      targets.push(token);
    }
  }
  return [...new Set(targets)];
}

function collectCurrentFilesContent(
  repoPath: string,
  commitSha: string,
  allowedFiles: string[]
): string {
  const concrete = allowedFiles.filter(isConcretePath);
  if (concrete.length === 0) return '';

  const parts: string[] = [];
  for (const path of concrete) {
    if (isDeniedPath(path)) continue;
    const content = readFileFromCommit(repoPath, commitSha, path);
    if (content !== undefined) {
      parts.push(content);
    }
  }
  return parts.join('\n');
}

export function runSummaryChecks(input: SummaryCheckInput): SummaryCheckResult {
  const issues: string[] = [];

  if (!input.dependencyEvidence || input.dependencyEvidence.items.length === 0) {
    return { ok: true, issues };
  }

  const dependencyPaths = new Set(
    input.dependencyEvidence.items.map((item) => normalizePath(item.path))
  );
  const dependencyBasenames = new Set(
    [...dependencyPaths].map((p) => p.split('/').pop()!).filter(Boolean)
  );

  const currentContent = collectCurrentFilesContent(
    input.repoPath,
    input.commitSha,
    input.allowedFiles
  );

  const criteria = input.acceptanceCriteria ?? [];
  for (const criterion of criteria) {
    const targets = collectReferenceTargets(criterion);
    for (const target of targets) {
      const normalized = normalizePath(target);
      if (isDeniedPath(normalized)) continue;
      if (dependencyPaths.has(normalized)) {
        if (!currentContent.includes(target)) {
          issues.push(
            `Summary check: acceptance criterion "${criterion}" requires reference to "${target}", but the current task files do not mention it.`
          );
        }
        continue;
      }
      const basename = normalized.split('/').pop();
      if (basename && dependencyBasenames.has(basename)) {
        if (!currentContent.includes(basename)) {
          issues.push(
            `Summary check: acceptance criterion "${criterion}" requires reference to "${target}", but the current task files do not mention "${basename}".`
          );
        }
        continue;
      }
      // Reference target is not part of the collected dependency evidence.
      issues.push(
        `Summary check: acceptance criterion "${criterion}" references "${target}" which is not a known dependency artifact.`
      );
    }
  }

  // Detect fabricated dependency paths: any path-like token in the current
  // task content that claims to be inside a known proof/docs area but is not
  // in the writable scope or dependency evidence.
  const writablePaths = new Set(input.allowedFiles.filter(isConcretePath).map(normalizePath));
  const allReferencedPaths: string[] = [];
  allReferencedPaths.push(...extractBareTokens(currentContent));
  // Also capture markdown link targets.
  const markdownLinkMatches = currentContent.match(/\[([^\]]*)\]\(([^)]+)\)/g) ?? [];
  for (const link of markdownLinkMatches) {
    const match = link.match(/\[([^\]]*)\]\(([^)]+)\)/);
    if (match && match[2]) {
      allReferencedPaths.push(match[2]);
    }
  }

  for (const ref of [...new Set(allReferencedPaths)]) {
    const normalized = normalizePath(ref);
    if (!normalized.includes('/')) continue;
    if (isDeniedPath(normalized)) continue;
    if (writablePaths.has(normalized) || dependencyPaths.has(normalized)) continue;
    // Allow relative references within dependency set by basename.
    const basename = normalized.split('/').pop();
    if (basename && dependencyBasenames.has(basename)) continue;
    // Only flag references that look like proof/docs artifacts.
    if (normalized.startsWith('docs/') || normalized.startsWith('proof')) {
      issues.push(
        `Summary check: current task content references unknown dependency path "${ref}".`
      );
    }
  }

  return { ok: issues.length === 0, issues };
}
