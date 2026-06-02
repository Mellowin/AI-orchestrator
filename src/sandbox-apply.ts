import { existsSync } from 'node:fs';
import { applyFileUpdates, rollbackFileUpdates } from './patch-engine.js';
import type { FileUpdate } from './types.js';

export interface SandboxApplyResult {
  appliedFiles: string[];
  rollback: () => void;
}

export function applyToSandboxRepo(
  sandboxRepoPath: string,
  files: FileUpdate[]
): SandboxApplyResult {
  if (!existsSync(sandboxRepoPath)) {
    throw new Error(`Sandbox repo does not exist: ${sandboxRepoPath}`);
  }

  if (!Array.isArray(files)) {
    throw new Error('Files must be an array');
  }

  // Use the sandbox itself as the runDir so backups are scoped to it.
  const manifest = applyFileUpdates(sandboxRepoPath, files, sandboxRepoPath);
  const appliedFiles = manifest.map((m) => m.path);

  return {
    appliedFiles,
    rollback: () => {
      rollbackFileUpdates(sandboxRepoPath, manifest);
    },
  };
}
