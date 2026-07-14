import { readFileSync, writeFileSync, existsSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, normalize, relative, resolve } from 'node:path';
import type { ReliabilityScenarioPatch } from './types.js';

const PATH_ERROR = 'RELIABILITY_PATCH_PATH_OUTSIDE_REPO';

/**
 * Resolve a scenario patch path strictly inside the repo clone.
 *
 * Rejects absolute paths, traversal segments, Windows drive paths, UNC paths,
 * and any target that resolves outside `repoPath` (including symlink escapes).
 */
export function resolvePatchTarget(repoPath: string, patchPath: string): string {
  if (typeof patchPath !== 'string' || patchPath.length === 0) {
    throw new Error(PATH_ERROR);
  }

  // Null bytes are never valid in a path.
  if (patchPath.includes('\0')) {
    throw new Error(PATH_ERROR);
  }

  // Reject Windows drive paths (e.g. C:\file or C:/file) on every platform.
  if (/^[A-Za-z]:[\\/]?/.test(patchPath)) {
    throw new Error(PATH_ERROR);
  }

  // Reject UNC paths and backslash-absolute paths.
  if (patchPath.startsWith('\\\\') || patchPath.startsWith('\\')) {
    throw new Error(PATH_ERROR);
  }

  // Reject POSIX-absolute paths.
  if (patchPath.startsWith('/')) {
    throw new Error(PATH_ERROR);
  }

  // Reject traversal segments regardless of which separator is used.
  if (patchPath.split(/[\\/]/).some((segment) => segment === '..')) {
    throw new Error(PATH_ERROR);
  }

  const repoReal = realpathSync(resolve(repoPath));
  const normalized = normalize(patchPath);
  if (isAbsolute(normalized)) {
    throw new Error(PATH_ERROR);
  }

  const target = resolve(repoReal, normalized);
  const rel = relative(repoReal, target);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(PATH_ERROR);
  }

  // Guard against symlink escapes: if the target or its parent already exists,
  // ensure the realpath also stays inside the repo.
  if (existsSync(target)) {
    const realTarget = realpathSync(target);
    const realRel = relative(repoReal, realTarget);
    if (realRel.startsWith('..') || isAbsolute(realRel)) {
      throw new Error(PATH_ERROR);
    }
  } else {
    const parent = dirname(target);
    if (existsSync(parent)) {
      const realParent = realpathSync(parent);
      const parentRel = relative(repoReal, realParent);
      if (parentRel.startsWith('..') || isAbsolute(parentRel)) {
        throw new Error(PATH_ERROR);
      }
    }
  }

  return target;
}

export function applyScenarioPatch(repoPath: string, patch: ReliabilityScenarioPatch): void {
  const targetPath = resolvePatchTarget(repoPath, patch.path);

  if (!existsSync(targetPath) && !patch.overwrite) {
    throw new Error(`Cannot patch missing file: ${patch.path}`);
  }

  if (patch.overwrite) {
    writeFileSync(targetPath, patch.replace, 'utf-8');
    return;
  }

  let original = readFileSync(targetPath, 'utf-8');
  // Normalize line endings so patch strings with \n work on Windows clones.
  const hadCrLf = original.includes('\r\n');
  original = original.replace(/\r\n/g, '\n');
  const search = patch.search ?? '';
  if (!original.includes(search)) {
    throw new Error(`Patch search string not found in ${patch.path}`);
  }
  let updated = original.split(search).join(patch.replace);
  if (hadCrLf) {
    updated = updated.replace(/\n/g, '\r\n');
  }
  writeFileSync(targetPath, updated, 'utf-8');
}

export function applyScenarioPatches(repoPath: string, patches: ReliabilityScenarioPatch[]): void {
  for (const patch of patches) {
    applyScenarioPatch(repoPath, patch);
  }
}
