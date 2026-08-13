import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import type { RunState, RunStatus, Task } from './types.js';
import { config } from './config.js';
import { writeJsonAtomic } from './state-atomic-write.js';

const VALID_STATUSES: RunStatus[] = [
  'pending',
  'coding',
  'patching',
  'running_checks',
  'reviewing',
  'approved',
  'rejected',
  'failed_guardrails',
  'failed_max_attempts',
  'failed',
  'pushed',
  'blocked',
];

const VALID_TASK_PHASES: import('./types.js').TaskRunPhase[] = [
  'generating',
  'checking',
  'repairing',
  'committed',
  'pushed',
  'reviewer_pending',
  'reviewer_fix_pending',
  'fix_pushed',
  'second_review_pending',
  'accepted',
  'blocked',
  'failed',
];

const VALID_PROVIDER_ATTEMPT_TYPES: import('./types.js').ProviderAttemptType[] = [
  'initial_coder',
  'sandbox_repair',
  'reviewer',
  'reviewer_fix_coder',
  'second_reviewer',
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

export function getRunDir(taskId: string, runsDir?: string): string {
  validateTaskId(taskId);
  return resolve(runsDir ?? config.runsDir, taskId);
}

export function getStatePath(taskId: string, runsDir?: string): string {
  validateTaskId(taskId);
  return join(getRunDir(taskId, runsDir), 'state.json');
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
    state.task_phase !== undefined &&
    !VALID_TASK_PHASES.includes(state.task_phase as import('./types.js').TaskRunPhase)
  ) {
    throw new Error(
      `Invalid state.json: unknown task_phase "${String(state.task_phase)}"`
    );
  }

  if (state.provider_attempts !== undefined) {
    if (!Array.isArray(state.provider_attempts)) {
      throw new Error('Invalid state.json: provider_attempts must be an array');
    }
    for (let i = 0; i < state.provider_attempts.length; i++) {
      const pa = state.provider_attempts[i];
      if (!isObject(pa)) {
        throw new Error(`Invalid state.json: provider_attempts[${i}] is not an object`);
      }
      if (
        pa.type !== undefined &&
        !VALID_PROVIDER_ATTEMPT_TYPES.includes(pa.type as import('./types.js').ProviderAttemptType)
      ) {
        throw new Error(
          `Invalid state.json: unknown provider_attempts[${i}].type "${String(pa.type)}"`
        );
      }
    }
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

export function loadState(taskId: string, runsDir?: string): RunState | null {
  validateTaskId(taskId);
  const statePath = getStatePath(taskId, runsDir);
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

export function saveState(taskId: string, state: RunState, runsDir?: string): void {
  validateTaskId(taskId);
  const runDir = getRunDir(taskId, runsDir);
  if (!existsSync(runDir)) {
    mkdirSync(runDir, { recursive: true });
  }

  const statePath = getStatePath(taskId, runsDir);
  writeJsonAtomic(statePath, state);
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

export function initAttemptDir(taskId: string, attempt: number, runsDir?: string): string {
  validateTaskId(taskId);
  const attemptDir = join(getRunDir(taskId, runsDir), `attempt-${attempt}`);
  if (!existsSync(attemptDir)) {
    mkdirSync(attemptDir, { recursive: true });
  }
  return attemptDir;
}

export function writeAttemptFile(
  taskId: string,
  attempt: number,
  filename: string,
  data: string,
  runsDir?: string
): void {
  validateTaskId(taskId);
  if (isAbsolute(filename)) {
    throw new Error(`Absolute paths are not allowed in filename: ${filename}`);
  }
  if (filename.includes('..')) {
    throw new Error(`Invalid filename: ${filename}`);
  }

  const attemptDir = initAttemptDir(taskId, attempt, runsDir);
  const filePath = join(attemptDir, filename);
  writeFileSync(filePath, data, 'utf-8');
}
