import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  copyFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve, sep } from 'node:path';

const ALWAYS_EXCLUDED_NAMES = new Set(['node_modules', 'runs', '.env']);

function isExcluded(name: string, includeGit: boolean): boolean {
  if (name === '.git') return !includeGit;
  if (ALWAYS_EXCLUDED_NAMES.has(name)) return true;
  if (name.startsWith('.env.')) return true;
  return false;
}

function validatePath(path: string): void {
  if (path.includes('..')) {
    throw new Error(`Path traversal not allowed: ${path}`);
  }
}

function copyDirectoryRecursive(
  src: string,
  dest: string,
  includeGit: boolean
): void {
  mkdirSync(dest, { recursive: true });
  for (const entry of readdirSync(src)) {
    if (isExcluded(entry, includeGit)) {
      continue;
    }
    const srcPath = join(src, entry);
    const destPath = join(dest, entry);
    const stats = statSync(srcPath);
    if (stats.isDirectory()) {
      copyDirectoryRecursive(srcPath, destPath, includeGit);
    } else if (stats.isFile()) {
      copyFileSync(srcPath, destPath);
    }
    // Symlinks are intentionally skipped.
  }
}

function scrubGitConfig(sandboxRepoPath: string): void {
  const configPath = join(sandboxRepoPath, '.git', 'config');
  if (!existsSync(configPath)) {
    return;
  }

  const content = readFileSync(configPath, 'utf-8');
  const scrubbed = content.replace(
    /^([ \t]*)(url|pushurl)[ \t]*=.*$/gm,
    '$1url = [REDACTED_REMOTE_URL]'
  );
  writeFileSync(configPath, scrubbed, 'utf-8');
}

export interface SandboxRepoResult {
  sandboxRepoPath: string;
  cleanup: () => void;
}

export interface CreateSandboxRepoCopyOptions {
  preserveGit?: boolean;
}

export function createSandboxRepoCopy(
  sourceRepoPath: string,
  sandboxRoot: string,
  options?: CreateSandboxRepoCopyOptions
): SandboxRepoResult {
  validatePath(sourceRepoPath);
  validatePath(sandboxRoot);

  if (!existsSync(sourceRepoPath)) {
    throw new Error(`Source repo does not exist: ${sourceRepoPath}`);
  }

  if (!existsSync(join(sourceRepoPath, '.git'))) {
    throw new Error(`Source repo is not a git repository: ${sourceRepoPath}`);
  }

  if (!existsSync(sandboxRoot)) {
    throw new Error(`Sandbox root does not exist: ${sandboxRoot}`);
  }

  const resolvedSource = resolve(sourceRepoPath);
  const resolvedSandboxRoot = resolve(sandboxRoot);

  if (resolvedSandboxRoot === resolvedSource) {
    throw new Error(
      `sandboxRoot must not be inside the source repo: ${sandboxRoot}`
    );
  }

  if (
    resolvedSandboxRoot === resolvedSource + sep ||
    resolvedSandboxRoot.startsWith(resolvedSource + sep)
  ) {
    throw new Error(
      `sandboxRoot must not be inside the source repo: ${sandboxRoot}`
    );
  }

  const includeGit = options?.preserveGit ?? false;
  const sandboxRepoPath = mkdtempSync(join(sandboxRoot, 'sandbox-'));
  copyDirectoryRecursive(sourceRepoPath, sandboxRepoPath, includeGit);

  if (includeGit) {
    scrubGitConfig(sandboxRepoPath);
  }

  return {
    sandboxRepoPath,
    cleanup: () => {
      rmSync(sandboxRepoPath, { recursive: true, force: true });
    },
  };
}
