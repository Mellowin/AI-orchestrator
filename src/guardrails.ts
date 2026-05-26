import { isAbsolute } from 'node:path';
import type { DiffStat, Guardrails, ValidationResult } from './types.js';

function patternToRegExp(pattern: string): RegExp {
  let regex = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        regex += '.*';
        i++; // skip second *
      } else {
        regex += '[^/]*';
      }
    } else if (/[.+^${}()|[\]\\]/.test(c)) {
      regex += '\\' + c;
    } else {
      regex += c;
    }
  }
  return new RegExp(`^${regex}$`);
}

function matchesPattern(file: string, pattern: string): boolean {
  const regex = patternToRegExp(pattern);
  return regex.test(file);
}

export function validateFileList(
  files: string[],
  guardrails: Guardrails
): ValidationResult {
  for (const file of files) {
    if (isAbsolute(file)) {
      return { ok: false, reason: `Absolute path not allowed: ${file}` };
    }
    if (file.includes('..')) {
      return { ok: false, reason: `Path traversal not allowed: ${file}` };
    }
    if (file.includes('\\')) {
      return {
        ok: false,
        reason: `Backslash not allowed, use unix paths: ${file}`,
      };
    }

    for (const pattern of guardrails.deny_modify) {
      if (matchesPattern(file, pattern)) {
        return { ok: false, reason: `Forbidden file touched: ${file}` };
      }
    }

    if (guardrails.allow_modify !== undefined) {
      let allowed = false;
      for (const pattern of guardrails.allow_modify) {
        if (matchesPattern(file, pattern)) {
          allowed = true;
          break;
        }
      }
      if (!allowed) {
        return { ok: false, reason: `File is outside allow_modify: ${file}` };
      }
    }
  }

  return { ok: true };
}

export function validateDiffSize(
  diffStat: DiffStat,
  maxLines?: number
): ValidationResult {
  if (diffStat.binaryFiles.length > 0) {
    return {
      ok: false,
      reason: `Binary files detected: ${diffStat.binaryFiles.join(', ')}`,
    };
  }

  if (
    maxLines !== undefined &&
    diffStat.insertions + diffStat.deletions > maxLines
  ) {
    return {
      ok: false,
      reason: `Diff too large: ${diffStat.insertions + diffStat.deletions} lines (max ${maxLines})`,
    };
  }

  return { ok: true };
}

export function validateTestsPresent(
  changedFiles: string[],
  requireTests: boolean
): ValidationResult {
  if (!requireTests) {
    return { ok: true };
  }

  const hasTests = changedFiles.some(
    (f) => f.includes('.test.') || f.includes('.spec.')
  );

  if (!hasTests) {
    return {
      ok: false,
      reason: 'Tests required but no .test. or .spec. files found',
    };
  }

  return { ok: true };
}
