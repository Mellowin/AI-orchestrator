import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import type { RunState, Task } from './types.js';
import { config } from './config.js';

export function getRunDir(taskId: string): string {
  return resolve(config.runsDir, taskId);
}

export function getStatePath(taskId: string): string {
  return join(getRunDir(taskId), 'state.json');
}

export function loadState(taskId: string): RunState | null {
  const statePath = getStatePath(taskId);
  if (!existsSync(statePath)) {
    return null;
  }

  const content = readFileSync(statePath, 'utf-8');
  const parsed = JSON.parse(content) as unknown;
  validateRunState(parsed);
  return parsed as RunState;
}

function isObject(val: unknown): val is Record<string, unknown> {
  return typeof val === 'object' && val !== null && !Array.isArray(val);
}

function validateRunState(state: unknown): void {
  if (!isObject(state)) {
    throw new Error('Invalid state.json: not an object');
  }

  const requiredStrings = [
    'task_id',
    'status',
    'branch',
    'repo_path',
    'created_at',
    'updated_at',
  ] as const;

  for (const key of requiredStrings) {
    if (typeof state[key] !== 'string') {
      throw new Error(`Invalid state.json: missing or invalid "${key}"`);
    }
  }

  if (typeof state.current_attempt !== 'number') {
    throw new Error('Invalid state.json: missing or invalid "current_attempt"');
  }
}

export function saveState(taskId: string, state: RunState): void {
  const runDir = getRunDir(taskId);
  if (!existsSync(runDir)) {
    mkdirSync(runDir, { recursive: true });
  }

  const statePath = getStatePath(taskId);
  const tmpPath = `${statePath}.tmp`;
  const data = JSON.stringify(state, null, 2);

  writeFileSync(tmpPath, data, 'utf-8');
  renameSync(tmpPath, statePath);
}

export function initState(task: Task): RunState {
  const now = new Date().toISOString();
  return {
    task_id: task.id,
    status: 'pending',
    current_attempt: 0,
    branch: task.work_branch,
    repo_path: task.repo_path,
    created_at: now,
    updated_at: now,
  };
}

export function initAttemptDir(taskId: string, attempt: number): string {
  const attemptDir = join(getRunDir(taskId), `attempt-${attempt}`);
  if (!existsSync(attemptDir)) {
    mkdirSync(attemptDir, { recursive: true });
  }
  return attemptDir;
}

export function writeAttemptFile(
  taskId: string,
  attempt: number,
  filename: string,
  data: string
): void {
  if (isAbsolute(filename)) {
    throw new Error(`Absolute paths are not allowed in filename: ${filename}`);
  }
  if (filename.includes('..')) {
    throw new Error(`Invalid filename: ${filename}`);
  }

  const attemptDir = initAttemptDir(taskId, attempt);
  const filePath = join(attemptDir, filename);
  writeFileSync(filePath, data, 'utf-8');
}
