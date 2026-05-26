import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import type { RunState, RunStatus, Task } from './types.js';
import { config } from './config.js';

const VALID_STATUSES: RunStatus[] = [
  'pending',
  'running',
  'coding',
  'patching',
  'running_checks',
  'reviewing',
  'approved',
  'rejected',
  'failed',
  'failed_guardrails',
  'failed_max_attempts',
];

function validateTaskId(taskId: string): void {
  if (!taskId || taskId.length === 0) {
    throw new Error('taskId must not be empty');
  }
  if (!/^[a-zA-Z0-9_-]+$/.test(taskId)) {
    throw new Error(
      `Invalid taskId: "${taskId}". Only letters, digits, hyphens and underscores are allowed.`
    );
  }
}

export function getRunDir(taskId: string): string {
  validateTaskId(taskId);
  return resolve(config.runsDir, taskId);
}

export function getStatePath(taskId: string): string {
  validateTaskId(taskId);
  return join(getRunDir(taskId), 'state.json');
}

function isObject(val: unknown): val is Record<string, unknown> {
  return typeof val === 'object' && val !== null && !Array.isArray(val);
}

function validateRunState(state: unknown): void {
  if (!isObject(state)) {
    throw new Error('Invalid state.json: not an object');
  }

  if (!VALID_STATUSES.includes(state.status as RunStatus)) {
    throw new Error(
      `Invalid state.json: unknown status "${String(state.status)}"`
    );
  }

  if (
    typeof state.current_attempt !== 'number' ||
    !Number.isInteger(state.current_attempt) ||
    state.current_attempt < 0
  ) {
    throw new Error(
      'Invalid state.json: current_attempt must be a non-negative integer'
    );
  }

  const requiredStrings = [
    'task_id',
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
}

export function loadState(taskId: string): RunState | null {
  validateTaskId(taskId);
  const statePath = getStatePath(taskId);
  if (!existsSync(statePath)) {
    return null;
  }

  const content = readFileSync(statePath, 'utf-8');
  const parsed = JSON.parse(content) as unknown;
  validateRunState(parsed);

  if ((parsed as Record<string, unknown>).task_id !== taskId) {
    throw new Error(
      `Invalid state.json: task_id mismatch (expected "${taskId}", got "${String((parsed as Record<string, unknown>).task_id)}")`
    );
  }

  return parsed as RunState;
}

export function saveState(taskId: string, state: RunState): void {
  validateTaskId(taskId);
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
  validateTaskId(taskId);
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
  validateTaskId(taskId);
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
