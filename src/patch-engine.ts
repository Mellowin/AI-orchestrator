import {
  copyFileSync,
  existsSync,
  mkdirSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import type { FileUpdate, PatchManifestEntry } from './types.js';

function normalizePath(filePath: string): string {
  return filePath.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+/g, '/');
}

function validateUpdatePath(filePath: string, repoPath: string): void {
  if (!filePath || filePath.length === 0) {
    throw new Error('Update path must not be empty');
  }
  if (isAbsolute(filePath)) {
    throw new Error(`Absolute paths are not allowed: ${filePath}`);
  }
  if (filePath.includes('..')) {
    throw new Error(`Path traversal detected: ${filePath}`);
  }
  if (filePath.includes('\\')) {
    throw new Error(`Backslash not allowed, use unix paths: ${filePath}`);
  }

  const resolvedFile = resolve(repoPath, filePath);
  const resolvedRepo = resolve(repoPath);
  const rel = relative(resolvedRepo, resolvedFile);

  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`File path escapes repo_path: ${filePath}`);
  }
}

export function applyFileUpdates(
  repoPath: string,
  updates: FileUpdate[],
  runDir: string
): PatchManifestEntry[] {
  const seen = new Set<string>();
  for (const update of updates) {
    validateUpdatePath(update.path, repoPath);
    const normalized = normalizePath(update.path);
    if (seen.has(normalized)) {
      throw new Error(`Duplicate file update: ${update.path}`);
    }
    seen.add(normalized);
  }

  const manifest: PatchManifestEntry[] = [];
  const backupDir = join(runDir, 'backup');

  if (!existsSync(backupDir)) {
    mkdirSync(backupDir, { recursive: true });
  }

  try {
    for (const update of updates) {
      const fullPath = resolve(repoPath, update.path);
      const existedBefore = existsSync(fullPath);
      const backupPath = `${join(backupDir, encodeURIComponent(update.path))}.backup`;

      if (existedBefore) {
        const backupParent = dirname(backupPath);
        if (!existsSync(backupParent)) {
          mkdirSync(backupParent, { recursive: true });
        }
        copyFileSync(fullPath, backupPath);
      }

      // Register in manifest BEFORE writing, so rollback knows about this file
      // even if writeFileSync throws.
      manifest.push({
        path: update.path,
        existedBefore,
        backupPath: existedBefore ? backupPath : '',
      });

      const parentDir = dirname(fullPath);
      if (!existsSync(parentDir)) {
        mkdirSync(parentDir, { recursive: true });
      }

      writeFileSync(fullPath, update.content, 'utf-8');
    }
  } catch (err) {
    rollbackFileUpdates(repoPath, manifest);
    throw err;
  }

  return manifest;
}

export function rollbackFileUpdates(
  repoPath: string,
  manifest: PatchManifestEntry[]
): void {
  for (let i = manifest.length - 1; i >= 0; i--) {
    const entry = manifest[i];
    validateUpdatePath(entry.path, repoPath);
    const fullPath = resolve(repoPath, entry.path);

    if (entry.existedBefore) {
      if (!entry.backupPath || !existsSync(entry.backupPath)) {
        throw new Error(
          `Rollback failed: backup missing for ${entry.path}`
        );
      }
      copyFileSync(entry.backupPath, fullPath);
    } else {
      if (existsSync(fullPath)) {
        unlinkSync(fullPath);
      }
    }
  }
}
