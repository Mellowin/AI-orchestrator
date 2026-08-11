import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * Environment variable that overrides the top-level execution workspace root.
 * Mission execution repositories and per-task candidate workspaces are placed
 * under this root, but human-readable reports remain in the configured output
 * directory. The override is optional; the default is a short persistent path
 * in the user's home directory.
 */
export const AI_ORCHESTRATOR_WORKSPACE_ROOT_ENV = 'AI_ORCHESTRATOR_WORKSPACE_ROOT';

/**
 * Return the top-level execution workspace root. Honors
 * `AI_ORCHESTRATOR_WORKSPACE_ROOT` when set; otherwise uses a short persistent
 * path under the user's home directory.
 */
export function getDefaultWorkspaceRoot(): string {
  const envRoot = process.env[AI_ORCHESTRATOR_WORKSPACE_ROOT_ENV]?.trim();
  if (envRoot) {
    return resolve(envRoot);
  }
  return resolve(homedir(), '.ai-orchestrator', 'w');
}

/**
 * Create a deterministic short identifier for a mission run. The human-readable
 * `run_id` is preserved in state and reports, but the short id is used for the
 * machine-oriented execution workspace path.
 */
export function makeShortRunId(runId: string): string {
  return createHash('sha256').update(runId).digest('hex').slice(0, 12);
}

/**
 * Mission-specific workspace root that contains the execution repo (`repo/`)
 * and per-task candidate workspaces (`t/`).
 */
export function makeMissionWorkspaceRoot(topLevelRoot: string, shortRunId: string): string {
  return resolve(topLevelRoot, 'm', shortRunId);
}

/**
 * Path to the cloned mission execution repository.
 */
export function makeMissionRepoPath(missionWorkspaceRoot: string): string {
  return resolve(missionWorkspaceRoot, 'repo');
}

/**
 * Deterministic short identifier for a task candidate workspace. Bounded in
 * length regardless of how long the human task id is.
 */
export function makeShortTaskId(taskId: string): string {
  return createHash('sha256').update(taskId).digest('hex').slice(0, 10);
}

/**
 * Path to a per-task candidate workspace inside the mission workspace root.
 */
export function makeCandidatePath(missionWorkspaceRoot: string, shortTaskId: string): string {
  return resolve(missionWorkspaceRoot, 't', shortTaskId);
}
