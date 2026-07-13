import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { ReliabilityScenarioPatch } from './types.js';

export function applyScenarioPatch(repoPath: string, patch: ReliabilityScenarioPatch): void {
  const targetPath = join(repoPath, patch.path);
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
