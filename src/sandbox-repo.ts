import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  statSync,
  copyFileSync,
  rmSync,
} from 'node:fs';
import { join, resolve, sep } from 'node:path';

const EXCLUDED_NAMES = new Set(['.git', 'node_modules', 'runs', '.env']);

function isExcluded(name: string): boolean {
  if (EXCLUDED_NAMES.has(name)) return true;
  if (name.startsWith('.env.')) return true;
  return false;
}

function validatePath(path: string): void {
  if (path.includes('..')) {
    throw new Error(`Path traversal not allowed: ${path}`);
  }
}

function copyDirectoryRecursive(src: string, dest: string): void {
  mkdirSync(dest, { recursive: true });
  for (const entry of readdirSync(src)) {
    if (isExcluded(entry)) {
      continue;
    }
    const srcPath = join(src, entry);
    const destPath = join(dest, entry);
    const stats = statSync(srcPath);
    if (stats.isDirectory()) {
      copyDirectoryRecursive(srcPath, destPath);
    } else if (stats.isFile()) {
      copyFileSync(srcPath, destPath);
    }
    // Symlinks are intentionally skipped.
  }
}

export interface SandboxRepoResult {
  sandboxRepoPath: string;
  cleanup: () => void;
}

export function createSandboxRepoCopy(
  sourceRepoPath: string,
  sandboxRoot: string
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

  const sandboxRepoPath = mkdtempSync(join(sandboxRoot, 'sandbox-'));
  copyDirectoryRecursive(sourceRepoPath, sandboxRepoPath);

  return {
    sandboxRepoPath,
    cleanup: () => {
      rmSync(sandboxRepoPath, { recursive: true, force: true });
    },
  };
}
