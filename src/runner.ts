import { sync as spawnSync } from 'cross-spawn';
import type { Check, RunResult } from './types.js';

function validateCheck(check: Check): { ok: boolean } {
  if (!check.command || check.command.length === 0) {
    return { ok: false };
  }
  if (check.command.includes('/') || check.command.includes('\\')) {
    return { ok: false };
  }
  if (
    !Array.isArray(check.args) ||
    !check.args.every((a) => typeof a === 'string')
  ) {
    return { ok: false };
  }
  return { ok: true };
}

export function runChecks(repoPath: string, checks: Check[]): RunResult {
  let logs = '';

  for (const check of checks) {
    const validation = validateCheck(check);
    if (!validation.ok) {
      return { success: false, logs, failedStep: check };
    }

    const result = spawnSync(check.command, check.args, {
      cwd: repoPath,
      shell: false,
      encoding: 'utf-8',
    });

    if (result.stdout) {
      logs += result.stdout;
    }
    if (result.stderr) {
      logs += result.stderr;
    }

    if (result.status !== 0) {
      return { success: false, logs, failedStep: check };
    }
  }

  return { success: true, logs };
}
