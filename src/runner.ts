import { sync as spawnSync } from 'cross-spawn';
import { isAbsolute, normalize, resolve } from 'node:path';
import { realpathSync } from 'node:fs';
import type { Check, RunResult, ValidationResult } from './types.js';

export interface CheckValidationResult extends ValidationResult {
  normalizedCwd?: string;
}

const SHELL_OPERATORS = new Set(['&&', '||', ';', '|', '>', '<', '`', '$()']);

function isShellOperator(value: string): boolean {
  return SHELL_OPERATORS.has(value);
}

const SHELL_METACHARACTERS = /&&|\|\||;|\||>|<|\$\(|`/;

function containsShellSyntax(value: string): boolean {
  return SHELL_METACHARACTERS.test(value);
}

function validateCommandString(value: string): boolean {
  if (!value || value.length === 0) {
    return false;
  }
  if (value.includes('/') || value.includes('\\')) {
    return false;
  }
  if (containsShellSyntax(value)) {
    return false;
  }
  if (value === 'cd') {
    return false;
  }
  return true;
}

function isWithinRepo(repoPath: string, targetPath: string): boolean {
  const normalizedRepo = normalize(resolve(repoPath)).replace(/\\/g, '/');
  const normalizedTarget = normalize(resolve(targetPath)).replace(/\\/g, '/');
  if (normalizedTarget === normalizedRepo) {
    return true;
  }
  return (
    normalizedTarget.startsWith(normalizedRepo + '/') ||
    normalizedTarget.startsWith(normalizedRepo + '\\')
  );
}

export function parseShellCheckString(input: string): Check {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new Error('Check string is empty');
  }

  const parts = trimmed.split(/\s+/);
  if (!validateCommandString(parts[0])) {
    throw new Error(
      `Unsupported shell syntax or command in check: "${input}". Use structured check with command, args and cwd.`
    );
  }

  for (const part of parts.slice(1)) {
    if (isShellOperator(part)) {
      throw new Error(
        `Unsupported shell syntax in check: "${input}". Use structured check with command, args and cwd.`
      );
    }
  }

  return { command: parts[0], args: parts.slice(1) };
}

export function validateCheck(
  repoPath: string,
  check: Check
): CheckValidationResult {
  if (!check || typeof check !== 'object') {
    return { ok: false, reason: 'Check is not an object' };
  }

  if (
    !check.command ||
    typeof check.command !== 'string' ||
    check.command.length === 0
  ) {
    return { ok: false, reason: 'Check command must be a non-empty string' };
  }
  if (!validateCommandString(check.command)) {
    return {
      ok: false,
      reason: `Unsupported shell syntax or command: "${check.command}". Use structured check with command, args and cwd.`,
    };
  }

  if (
    !Array.isArray(check.args) ||
    !check.args.every((a) => typeof a === 'string')
  ) {
    return { ok: false, reason: 'Check args must be an array of strings' };
  }

  let normalizedCwd: string | undefined;
  if (check.cwd !== undefined) {
    if (typeof check.cwd !== 'string' || check.cwd.length === 0) {
      return { ok: false, reason: 'Check cwd must be a non-empty string' };
    }
    if (isAbsolute(check.cwd)) {
      return { ok: false, reason: 'Check cwd must be a relative path' };
    }

    const cwdSegments = normalize(check.cwd)
      .split(/[/\\]+/)
      .filter((s) => s.length > 0);
    if (cwdSegments.includes('..')) {
      return {
        ok: false,
        reason: 'Check cwd must not contain ".." segments',
      };
    }

    const resolvedCwd = resolve(repoPath, check.cwd);
    if (!isWithinRepo(repoPath, resolvedCwd)) {
      return {
        ok: false,
        reason: 'Check cwd must be inside the repository root',
      };
    }

    try {
      const realCwd = realpathSync(resolvedCwd);
      if (!isWithinRepo(repoPath, realCwd)) {
        return {
          ok: false,
          reason: 'Check cwd resolves outside the repository root via symlink',
        };
      }
    } catch {
      // Directory does not exist; the resolved path check above is sufficient.
    }

    normalizedCwd = resolvedCwd;
  }

  return { ok: true, normalizedCwd };
}

export function runChecks(repoPath: string, checks: Check[]): RunResult {
  let logs = '';

  const env = { ...process.env };
  delete env.TASKS_FILE;
  delete env.AI_PROVIDER;
  delete env.MOCK_AI_RESPONSE;
  delete env.KIMI_API_KEY;
  delete env.KIMI_MODEL;
  delete env.KIMI_BASE_URL;
  delete env.KIMI_USER_AGENT;
  delete env.OPENAI_API_KEY;
  delete env.MOCK_AI;

  for (const check of checks) {
    const validation = validateCheck(repoPath, check);
    if (!validation.ok) {
      logs += (validation.reason ?? 'Invalid check') + '\n';
      return { success: false, logs, failedStep: check };
    }

    const startTime = Date.now();
    const result = spawnSync(check.command, check.args, {
      cwd: validation.normalizedCwd ?? repoPath,
      shell: false,
      encoding: 'utf-8',
      env,
    });
    const durationMs = Date.now() - startTime;

    if (result.stdout) {
      logs += result.stdout;
    }
    if (result.stderr) {
      logs += result.stderr;
    }

    if (result.status !== 0) {
      logs += `Check "${check.command} ${check.args.join(' ')}" exited with code ${result.status ?? 'null'} after ${durationMs}ms\n`;
      return { success: false, logs, failedStep: check };
    }
  }

  return { success: true, logs };
}
