import type { FileUpdate } from '../types.js';

export interface RepairSafetyViolation {
  type: 'test_removal' | 'assertion_removal' | 'skip_only_todo' | 'ci_suppression' | 'verification_disabled' | 'large_deletion' | 'secret_like' | 'workflow_modified' | 'token_exposed' | 'broad_any' | 'force_push' | 'merge' | 'destructive';
  message: string;
  file?: string;
  line?: string;
}

const SECRET_LIKE_PATTERN = /(password|secret|token|api[_-]?key|private[_-]?key)\s*[:=]\s*['"`][a-zA-Z0-9_\-+/=]{16,}/i;
const SKIP_ONLY_TODO_PATTERN = /\.(skip|only|todo)\s*\(/i;
const CI_SUPPRESSION_PATTERN = /(?:\|\|\s*true|continue-on-error:\s*true|fail-fast:\s*false|if:\s*always\(\)\s*#.*ignore|set\s+\+e)/i;
const VERIFICATION_DISABLED_PATTERN = /(?:verify-testing-summary|tsc --noEmit|npm test)\s*(?:#.*disable|#.*skip|#.*ignore)/i;
const FORCE_PUSH_PATTERN = /git\s+push\s+--force|git\s+push\s+origin\s+\+\w+/i;
const MERGE_PATTERN = /git\s+merge|github\.merge|merge\s+pull\s+request/i;
const TOKEN_EXPOSURE_PATTERN = /(ghp_|github_pat_|gho_|ghu_|ghs_|ghr_)[a-zA-Z0-9_]{20,}/i;

export function checkRepairSafety(files: FileUpdate[], allowedFiles: string[], allowWorkflowFiles = false): RepairSafetyViolation[] {
  const violations: RepairSafetyViolation[] = [];

  for (const file of files) {
    const path = file.path;
    const content = typeof file.content === 'string' ? file.content : '';

    if (!allowedFiles.some((allowed) => path === allowed || path.startsWith(`${allowed}/`))) {
      violations.push({
        type: 'destructive',
        message: `Proposed file ${path} is outside the allowed repair scope`,
        file: path,
      });
    }

    if (!allowWorkflowFiles && path.startsWith('.github/workflows/')) {
      violations.push({
        type: 'workflow_modified',
        message: `Proposed modification to GitHub workflow file ${path} is not allowed`,
        file: path,
      });
    }

    if (path.endsWith('.test.ts') || path.endsWith('.test.js')) {
      if (SKIP_ONLY_TODO_PATTERN.test(content)) {
        violations.push({
          type: 'skip_only_todo',
          message: `Suspicious test control call detected in ${path}`,
          file: path,
        });
      }
    }

    if (/remove\s+(?:the\s+)?test|delete\s+(?:the\s+)?test|drop\s+(?:the\s+)?test/i.test(content)) {
      violations.push({
        type: 'test_removal',
        message: `Proposed patch appears to remove or delete tests in ${path}`,
        file: path,
      });
    }

    if (/assert\.|expect\(.*\)\.(to|toEqual|toBe|toStrictEqual|toMatch)/i.test(content)) {
      if (/remove\s+assert|delete\s+assert|comment\s+out\s+assert/i.test(content)) {
        violations.push({
          type: 'assertion_removal',
          message: `Proposed patch appears to remove assertions in ${path}`,
          file: path,
        });
      }
    }

    if (CI_SUPPRESSION_PATTERN.test(content)) {
      violations.push({
        type: 'ci_suppression',
        message: `Suspicious CI failure suppression pattern in ${path}`,
        file: path,
      });
    }

    if (VERIFICATION_DISABLED_PATTERN.test(content)) {
      violations.push({
        type: 'verification_disabled',
        message: `Suspicious verification disable pattern in ${path}`,
        file: path,
      });
    }

    if (path !== 'TESTING_SUMMARY.md') {
      if (FORCE_PUSH_PATTERN.test(content)) {
        violations.push({
          type: 'force_push',
          message: `Force-push detected in proposed patch in ${path}`,
          file: path,
        });
      }

      if (MERGE_PATTERN.test(content)) {
        violations.push({
          type: 'merge',
          message: `Merge operation detected in proposed patch in ${path}`,
          file: path,
        });
      }
    }

    if (TOKEN_EXPOSURE_PATTERN.test(content)) {
      violations.push({
        type: 'token_exposed',
        message: `Token-like string exposed in proposed patch in ${path}`,
        file: path,
      });
    }

    if (SECRET_LIKE_PATTERN.test(content)) {
      violations.push({
        type: 'secret_like',
        message: `Secret-like key/value pattern in proposed patch in ${path}`,
        file: path,
      });
    }

    if (/\bany\b/.test(content) && /as\s+any|:\s*any/.test(content)) {
      if (!content.includes('justification') && !content.includes('TODO: replace any')) {
        violations.push({
          type: 'broad_any',
          message: `Broad 'any' cast without justification in ${path}`,
          file: path,
        });
      }
    }
  }

  return violations;
}
