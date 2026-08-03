import { spawnSync } from 'node:child_process';

export interface AcceptanceCriterionIssue {
  criterion: string;
  targetPath?: string;
  detail: string;
}

export interface AcceptanceCriteriaCheckInput {
  repoPath: string;
  commitSha: string;
  acceptanceCriteria?: string[];
  allowedFiles?: string[];
}

type CheckType = 'contains' | 'endsWith' | 'startsWith';

interface ParsedCriterion {
  type: CheckType;
  expected: string;
}

function isConcretePath(pattern: string): boolean {
  return !/[?*]/.test(pattern);
}

function normalizeSlashes(value: string): string {
  return value.replace(/\\/g, '/');
}

function matchesPattern(file: string, pattern: string): boolean {
  const normalizedFile = normalizeSlashes(file);
  const normalizedPattern = normalizeSlashes(pattern);

  if (normalizedPattern.endsWith('/**')) {
    const prefix = normalizedPattern.slice(0, -2);
    return normalizedFile.startsWith(prefix);
  }
  if (normalizedPattern.includes('*')) {
    const regex = new RegExp(
      '^' +
        normalizedPattern
          .replace(/\*\*/g, '<<<DOUBLESTAR>>>')
          .replace(/\*/g, '[^/]*')
          .replace(/<<<DOUBLESTAR>>>/g, '.*') +
        '$'
    );
    return regex.test(normalizedFile);
  }
  return (
    normalizedFile === normalizedPattern ||
    normalizedFile.startsWith(normalizedPattern + '/')
  );
}

function resolveTargetPath(
  criterion: string,
  allowedFiles: string[]
): string | undefined {
  const concrete = allowedFiles.filter(isConcretePath);

  // Prefer a concrete allowed path that appears in the criterion text.
  const mentioned = concrete.filter((p) => criterion.includes(p));
  if (mentioned.length === 1) {
    return mentioned[0];
  }

  // If exactly one concrete allowed path exists, use it.
  if (concrete.length === 1) {
    return concrete[0];
  }

  // Otherwise try to extract a path-like token from the criterion and
  // validate it against the allowed patterns.
  const tokenMatch = criterion.match(/([^\s'"]+\.[a-zA-Z0-9]+)/);
  if (tokenMatch) {
    const candidate = tokenMatch[1];
    if (allowedFiles.some((p) => matchesPattern(candidate, p))) {
      return candidate;
    }
  }

  return undefined;
}

function extractQuotedStringAfter(
  text: string,
  startIndex: number
): string | undefined {
  let i = startIndex;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '"' || ch === "'") {
      const quote = ch;
      let j = i + 1;
      while (j < text.length) {
        if (text[j] === '\\' && j + 1 < text.length) {
          j += 2;
          continue;
        }
        if (text[j] === quote) {
          return text.slice(i + 1, j);
        }
        j++;
      }
      return undefined;
    }
    i++;
  }
  return undefined;
}

function parseCriterion(criterion: string): ParsedCriterion | undefined {
  const lower = criterion.toLowerCase();

  const endsWithMatch = lower.match(
    /(?:ends?\s+with\s+(?:the\s+)?exact\s+sentence)/
  );
  if (endsWithMatch && endsWithMatch.index !== undefined) {
    const expected = extractQuotedStringAfter(
      criterion,
      endsWithMatch.index + endsWithMatch[0].length
    );
    if (expected !== undefined) {
      return { type: 'endsWith', expected };
    }
  }

  const startsWithMatch = lower.match(
    /(?:starts?\s+with\s+(?:the\s+)?exact\s+(?:string|sentence))/
  );
  if (startsWithMatch && startsWithMatch.index !== undefined) {
    const expected = extractQuotedStringAfter(
      criterion,
      startsWithMatch.index + startsWithMatch[0].length
    );
    if (expected !== undefined) {
      return { type: 'startsWith', expected };
    }
  }

  const containsMatch = lower.match(
    /(?:contains?\s+(?:the\s+)?exact\s+string|must\s+contain\s+(?:the\s+)?exact\s+string)/
  );
  if (containsMatch && containsMatch.index !== undefined) {
    const expected = extractQuotedStringAfter(
      criterion,
      containsMatch.index + containsMatch[0].length
    );
    if (expected !== undefined) {
      return { type: 'contains', expected };
    }
  }

  return undefined;
}

function readFileFromCommit(
  repoPath: string,
  commitSha: string,
  path: string
): { ok: true; content: string } | { ok: false; error: string } {
  const result = spawnSync('git', ['show', `${commitSha}:${path}`], {
    cwd: repoPath,
    encoding: 'utf-8',
    shell: false,
  });
  if (result.status !== 0) {
    return {
      ok: false,
      error: result.stderr.trim() || `git show ${commitSha}:${path} failed`,
    };
  }
  return { ok: true, content: result.stdout };
}

function checkContent(
  type: CheckType,
  content: string,
  expected: string
): boolean {
  switch (type) {
    case 'contains':
      return content.includes(expected);
    case 'endsWith':
      return content.trimEnd().endsWith(expected);
    case 'startsWith':
      return content.startsWith(expected);
    default:
      return false;
  }
}

function checkTypeLabel(type: CheckType): string {
  switch (type) {
    case 'contains':
      return 'contain the exact string';
    case 'endsWith':
      return 'end with the exact sentence';
    case 'startsWith':
      return 'start with the exact string';
    default:
      return 'satisfy the acceptance criterion';
  }
}

export function runAcceptanceCriteriaChecks(
  input: AcceptanceCriteriaCheckInput
): AcceptanceCriterionIssue[] {
  const issues: AcceptanceCriterionIssue[] = [];
  const criteria = input.acceptanceCriteria ?? [];
  if (criteria.length === 0) {
    return issues;
  }

  const allowedFiles = input.allowedFiles ?? [];

  for (const criterion of criteria) {
    const parsed = parseCriterion(criterion);
    if (parsed === undefined) {
      // Only deterministic exact-string criteria are enforced here.
      continue;
    }

    const targetPath = resolveTargetPath(criterion, allowedFiles);
    if (targetPath === undefined) {
      issues.push({
        criterion,
        detail: `Cannot determine target file for acceptance criterion from allowed files [${allowedFiles.join(', ')}]`,
      });
      continue;
    }

    const readResult = readFileFromCommit(
      input.repoPath,
      input.commitSha,
      targetPath
    );
    if (!readResult.ok) {
      issues.push({
        criterion,
        targetPath,
        detail: `Could not read ${targetPath} from commit ${input.commitSha}: ${readResult.error}`,
      });
      continue;
    }

    if (!checkContent(parsed.type, readResult.content, parsed.expected)) {
      issues.push({
        criterion,
        targetPath,
        detail: `File "${targetPath}" does not ${checkTypeLabel(parsed.type)} "${parsed.expected}"`,
      });
    }
  }

  return issues;
}
