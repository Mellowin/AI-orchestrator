import { matchesPattern } from './guardrails.js';
import type { AutopilotPlanTask } from './autopilot-plan/types.js';

export interface TaskScopeValidationIssue {
  field: string;
  message: string;
  taskId?: string;
  allowedPattern?: string;
  deniedPattern?: string;
}

function normalizePattern(pattern: string): string {
  return pattern.replace(/\\/g, '/');
}

function segmentToRegex(segment: string): RegExp {
  let regex = '';
  for (let i = 0; i < segment.length; i++) {
    const c = segment[i];
    if (c === '*') {
      regex += '[^/]*';
    } else if (/[.+^${}()|[\]\\]/.test(c)) {
      regex += '\\' + c;
    } else {
      regex += c;
    }
  }
  return new RegExp(`^${regex}$`);
}

function generateSegmentWitnesses(pattern: string, replacements: string[]): string[] {
  const parts = pattern.split('*');
  if (parts.length === 1) return [pattern];
  const results: string[] = [];
  function build(index: number, current: string) {
    if (index === parts.length - 1) {
      results.push(current + parts[index]);
      return;
    }
    for (const replacement of replacements) {
      build(index + 1, current + parts[index] + replacement);
    }
  }
  build(0, '');
  return results;
}

function segmentMatches(a: string, b: string): boolean {
  if (a === '*' || b === '*') return true;
  const aHasWild = a.includes('*');
  const bHasWild = b.includes('*');
  if (!aHasWild && !bHasWild) return a === b;
  if (!aHasWild) return segmentToRegex(b).test(a);
  if (!bHasWild) return segmentToRegex(a).test(b);

  // Both segments contain wildcards. Try to construct a concrete witness that
  // matches both patterns, using each pattern's literal fragments plus a small
  // set of generic fillers for every wildcard position.
  const candidates = new Set(['', 'x', 'xy', '1', '12']);
  for (const fragment of a.split('*')) {
    if (fragment) candidates.add(fragment);
  }
  for (const fragment of b.split('*')) {
    if (fragment) candidates.add(fragment);
  }
  const replacements = Array.from(candidates);

  let checked = 0;
  const maxWitnesses = 200;

  for (const witness of generateSegmentWitnesses(a, replacements)) {
    if (segmentToRegex(b).test(witness)) return true;
    if (++checked >= maxWitnesses) break;
  }
  for (const witness of generateSegmentWitnesses(b, replacements)) {
    if (segmentToRegex(a).test(witness)) return true;
    if (++checked >= maxWitnesses) break;
  }
  return false;
}

/**
 * Returns true when two glob-like path patterns may refer to the same file.
 * Supports `*`, `**`, and Unix-style `/` separators. Backslashes are normalized
 * to forward slashes before comparison.
 */
export function patternsOverlap(a: string, b: string): boolean {
  const aNorm = normalizePattern(a);
  const bNorm = normalizePattern(b);
  const aParts = aNorm.split('/');
  const bParts = bNorm.split('/');
  const dp: boolean[][] = Array(aParts.length + 1)
    .fill(null)
    .map(() => Array(bParts.length + 1).fill(false));
  dp[0][0] = true;

  for (let i = 0; i <= aParts.length; i += 1) {
    for (let j = 0; j <= bParts.length; j += 1) {
      if (!dp[i][j]) continue;

      // `**` matches zero or more segments in the other pattern.
      if (i < aParts.length && aParts[i] === '**') {
        for (let k = 0; k <= bParts.length - j; k += 1) {
          dp[i + 1][j + k] = true;
        }
      }
      if (j < bParts.length && bParts[j] === '**') {
        for (let k = 0; k <= aParts.length - i; k += 1) {
          dp[i + k][j + 1] = true;
        }
      }

      // Single-segment wildcards and literals advance one segment each.
      if (i < aParts.length && j < bParts.length && segmentMatches(aParts[i], bParts[j])) {
        dp[i + 1][j + 1] = true;
      }
    }
  }

  return dp[aParts.length][bParts.length];
}

function isAllowedPatternDangerous(pattern: string): boolean {
  const normalized = normalizePattern(pattern);
  if (normalized === '.env' || normalized === '.env.local' || normalized.startsWith('.env/')) {
    return true;
  }
  if (normalized === '.git' || normalized.startsWith('.git/')) {
    return true;
  }
  if (normalized === 'node_modules' || normalized.startsWith('node_modules/')) {
    return true;
  }
  return false;
}

/**
 * Validate a single task's file scope. Checks that allowed_files is non-empty,
 * denied_files is an array (undefined becomes []), patterns are relative,
 * allowed_files and denied_files do not overlap, and at least one allowed
 * pattern is not denied (writable scope exists).
 */
export function validateTaskScope(
  task: Pick<AutopilotPlanTask, 'id' | 'allowed_files' | 'denied_files'>,
  prefix = 'task'
): TaskScopeValidationIssue[] {
  const issues: TaskScopeValidationIssue[] = [];

  if (!Array.isArray(task.allowed_files) || task.allowed_files.length === 0) {
    issues.push({
      field: `${prefix}.allowed_files`,
      message: 'Task allowed_files must be a non-empty array',
      taskId: task.id,
    });
    return issues;
  }

  const allowedPatterns: string[] = [];
  for (const pattern of task.allowed_files) {
    if (typeof pattern !== 'string' || pattern.length === 0) {
      issues.push({
        field: `${prefix}.allowed_files`,
        message: 'allowed_files entries must be non-empty strings',
        taskId: task.id,
      });
      continue;
    }
    const normalized = normalizePattern(pattern);
    if (normalized.startsWith('/')) {
      issues.push({
        field: `${prefix}.allowed_files`,
        message: `allowed_files must be a relative path: ${pattern}`,
        taskId: task.id,
      });
      continue;
    }
    if (normalized.includes('..')) {
      issues.push({
        field: `${prefix}.allowed_files`,
        message: `allowed_files must not contain parent traversal: ${pattern}`,
        taskId: task.id,
      });
      continue;
    }
    if (isAllowedPatternDangerous(normalized)) {
      issues.push({
        field: `${prefix}.allowed_files`,
        message: `allowed_files must not target sensitive system paths: ${pattern}`,
        taskId: task.id,
      });
      continue;
    }
    allowedPatterns.push(normalized);
  }

  const deniedPatterns: string[] = [];
  const deniedPatternsRaw = task.denied_files ?? [];
  if (!Array.isArray(deniedPatternsRaw)) {
    issues.push({
      field: `${prefix}.denied_files`,
      message: 'denied_files must be an array of strings',
      taskId: task.id,
    });
  } else {
    for (const pattern of deniedPatternsRaw) {
      if (typeof pattern !== 'string' || pattern.length === 0) {
        issues.push({
          field: `${prefix}.denied_files`,
          message: 'denied_files entries must be non-empty strings',
          taskId: task.id,
        });
        continue;
      }
      const normalized = normalizePattern(pattern);
      if (normalized.startsWith('/')) {
        issues.push({
          field: `${prefix}.denied_files`,
          message: `denied_files must be a relative path: ${pattern}`,
          taskId: task.id,
        });
        continue;
      }
      if (normalized.includes('..')) {
        issues.push({
          field: `${prefix}.denied_files`,
          message: `denied_files must not contain parent traversal: ${pattern}`,
          taskId: task.id,
        });
        continue;
      }
      deniedPatterns.push(normalized);
    }
  }

  // Detect contradictions between allowed and denied patterns.
  for (const allowed of allowedPatterns) {
    for (const denied of deniedPatterns) {
      if (patternsOverlap(allowed, denied)) {
        issues.push({
          field: `${prefix}.scope`,
          message: `Task ${task.id} has contradictory guardrails: allowed pattern "${allowed}" overlaps denied pattern "${denied}"`,
          taskId: task.id,
          allowedPattern: allowed,
          deniedPattern: denied,
        });
      }
    }
  }

  // Ensure at least one allowed pattern is not covered by any denied pattern.
  if (allowedPatterns.length > 0) {
    const hasWritableScope = allowedPatterns.some((allowed) =>
      deniedPatterns.every((denied) => !patternsOverlap(allowed, denied))
    );
    if (!hasWritableScope) {
      issues.push({
        field: `${prefix}.scope`,
        message: `Task ${task.id} has no writable scope: every allowed pattern is denied`,
        taskId: task.id,
      });
    }
  }

  return issues;
}
