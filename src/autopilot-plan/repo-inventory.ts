import { spawnSync } from 'node:child_process';
import { statSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Maximum number of file paths to include in the planner repository inventory.
 * Keeps prompts bounded for large repositories while still covering typical
 * source/config/documentation trees.
 */
export const REPO_INVENTORY_CAP = 2000;

const EXCLUDED_PREFIXES = [
  '.git/',
  '.git\\',
  'node_modules/',
  'node_modules\\',
  '.env',
  'dist/',
  'dist\\',
  'tmp/',
  'tmp\\',
  'reports/',
  'reports\\',
  '.ai-orchestrator/',
  '.ai-orchestrator\\',
  'coverage/',
  'coverage\\',
  '.nyc_output/',
  '.nyc_output\\',
  '.vite/',
  '.vite\\',
  '.esbuild/',
  '.esbuild\\',
  'out/',
  'out\\',
  'build/',
  'build\\',
  '.next/',
  '.next\\',
];

function shouldExclude(file: string): boolean {
  const normalized = file.replace(/\\/g, '/');
  for (const prefix of EXCLUDED_PREFIXES) {
    const normPrefix = prefix.replace(/\\/g, '/');
    if (normalized === normPrefix.slice(0, -1) || normalized.startsWith(normPrefix)) {
      return true;
    }
  }
  return false;
}

function isDirectory(repoPath: string, file: string): boolean {
  try {
    return statSync(resolve(repoPath, file)).isDirectory();
  } catch {
    return false;
  }
}

export interface RepoInventory {
  files: string[];
  total: number;
  truncated: boolean;
  /** Human-readable note for prompt caveats when the inventory is truncated. */
  note: string;
}

/**
 * Build a bounded, read-only inventory of repository files for the planner.
 *
 * Uses `git ls-files` from the repository root so only tracked files are
 * considered. Ignored/generated directories such as `.git`, `node_modules`,
 * `.env*`, `dist`, `tmp`, `reports`, and execution workspaces are filtered out.
 */
export function buildRepoInventory(repoPath: string): RepoInventory {
  const result = spawnSync('git', ['-C', repoPath, 'ls-files'], {
    encoding: 'utf-8',
    shell: false,
  });

  if (result.status !== 0) {
    return {
      files: [],
      total: 0,
      truncated: false,
      note: `Repository inventory unavailable: ${result.stderr?.trim() || 'git ls-files failed'}`,
    };
  }

  const allLines = result.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const filtered: string[] = [];
  for (const file of allLines) {
    if (shouldExclude(file)) continue;
    if (isDirectory(repoPath, file)) continue;
    filtered.push(file);
  }

  const total = filtered.length;
  const truncated = total > REPO_INVENTORY_CAP;
  const files = filtered.slice(0, REPO_INVENTORY_CAP);

  return {
    files,
    total,
    truncated,
    note: truncated
      ? `Repository inventory truncated to ${REPO_INVENTORY_CAP} of ${total} tracked files. Only the first ${REPO_INVENTORY_CAP} paths are shown; prefer widely-known source/config files when selecting context.`
      : `Repository inventory contains ${total} tracked files.`,
  };
}
