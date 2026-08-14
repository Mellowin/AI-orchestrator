import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export type ValidationFailureClassification =
  | 'REPAIRABLE_REPOSITORY_FAILURE'
  | 'EXTERNAL_BLOCKER';

export interface IntegratedValidationResult {
  ok: boolean;
  exitCode: number | null;
  command: string;
  output: string;
  classification: 'success' | ValidationFailureClassification;
  /** Files mentioned by the validator as the reason the branch is invalid. */
  changedFiles?: string[];
  /** Repository-maintenance files that a finalization repair may need to update. */
  maintenanceFiles?: string[];
  error?: string;
}

export interface RunIntegratedValidationOptions {
  /** Override the discovered command. */
  command?: string;
  /** Injected spawn implementation for tests. */
  spawnFn?: typeof spawnSync;
}

function parsePackageJsonScripts(repoPath: string): Record<string, string> | undefined {
  try {
    const pkgPath = join(repoPath, 'package.json');
    const raw = readFileSync(pkgPath, 'utf-8');
    const pkg = JSON.parse(raw) as Record<string, unknown>;
    const scripts = pkg.scripts;
    if (scripts && typeof scripts === 'object') {
      return scripts as Record<string, string>;
    }
  } catch {
    // ignore
  }
  return undefined;
}

function discoverValidationCommand(repoPath: string): string | undefined {
  const scripts = parsePackageJsonScripts(repoPath);
  if (scripts?.['verify:summary']) {
    return scripts['verify:summary'];
  }
  if (scripts?.['test:validation']) {
    return scripts['test:validation'];
  }
  // Fallback to the same verifier this repository uses.
  try {
    const defaultScript = join(repoPath, 'scripts', 'verify-testing-summary.mjs');
    readFileSync(defaultScript, 'utf-8');
    return `node scripts/verify-testing-summary.mjs`;
  } catch {
    return undefined;
  }
}

function splitCommand(command: string): { executable: string; args: string[] } {
  const trimmed = command.trim();
  if (trimmed.startsWith('node ')) {
    const rest = trimmed.slice('node '.length).trim();
    const parts = rest.split(/\s+/);
    return { executable: process.execPath, args: parts };
  }
  // For anything else, run the first token as the executable and the rest as args.
  const parts = trimmed.split(/\s+/);
  return { executable: parts[0], args: parts.slice(1) };
}

function extractNonSummaryFiles(output: string): string[] | undefined {
  const match = output.match(/Non-summary files changed after Last verified commit \([^)]*\):\s*([^\n]+)/i);
  if (!match) return undefined;
  return match[1]
    .split(',')
    .map((f) => f.trim())
    .filter((f) => f.length > 0);
}

function classifyFailure(output: string): {
  classification: ValidationFailureClassification;
  changedFiles?: string[];
  maintenanceFiles?: string[];
} {
  if (output.includes('TESTING_SUMMARY verification failed') && output.includes('Non-summary files changed')) {
    const changedFiles = extractNonSummaryFiles(output);
    return {
      classification: 'REPAIRABLE_REPOSITORY_FAILURE',
      changedFiles,
      maintenanceFiles: ['TESTING_SUMMARY.md'],
    };
  }

  if (output.includes('TESTING_SUMMARY verification failed')) {
    // Any TESTING_SUMMARY policy failure is considered repairable because the
    // fix is to update the lock file, not to change the underlying mission output.
    return {
      classification: 'REPAIRABLE_REPOSITORY_FAILURE',
      maintenanceFiles: ['TESTING_SUMMARY.md'],
    };
  }

  return { classification: 'EXTERNAL_BLOCKER' };
}

export function runIntegratedValidation(
  repoPath: string,
  options: RunIntegratedValidationOptions = {}
): IntegratedValidationResult {
  const spawnFn = options.spawnFn ?? spawnSync;
  const command = options.command ?? discoverValidationCommand(repoPath);

  if (!command) {
    // Integrated validation is a best-effort gate: if the repository does not
    // expose a configured validation command, we skip it rather than failing.
    return {
      ok: true,
      exitCode: 0,
      command: '',
      output: 'No integrated validation command configured; skipping',
      classification: 'success',
    };
  }

  const { executable, args } = splitCommand(command);
  const result = spawnFn(executable, args, {
    cwd: repoPath,
    encoding: 'utf-8',
    shell: false,
  });

  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`.trim();
  const exitCode = result.status ?? null;

  if (exitCode === 0) {
    return {
      ok: true,
      exitCode: 0,
      command,
      output,
      classification: 'success',
    };
  }

  const failure = classifyFailure(output);
  return {
    ok: false,
    exitCode,
    command,
    output,
    classification: failure.classification,
    changedFiles: failure.changedFiles,
    maintenanceFiles: failure.maintenanceFiles,
    error: output,
  };
}
