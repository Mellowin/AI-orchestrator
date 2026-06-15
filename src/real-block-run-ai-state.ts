import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { loadBlockDefinition } from './block/block-loader.js';
import type { BlockDefinition } from './block/block-types.js';
import { config } from './config.js';

export interface RealBlockRunTaskResult {
  taskId: string;
  title: string;
  status: 'accepted' | 'fixed_and_accepted' | 'blocked' | 'fix_required' | 'failed';
  originalCommitSha?: string;
  fixCommitSha?: string;
  reviewerGateStatus?: string;
  reviewerSummary?: string;
  fixAttempted: boolean;
  fixTaskId?: string;
  fixRunnerStatus?: string;
  fixRunnerNextAction?: string;
  secondReviewerGateStatus?: string;
  secondReviewerSummary?: string;
  finalStatus: string;
  nextAction: string;
  reason?: string;
  childStateTaskId: string;
}

export interface RealBlockRunSummary {
  totalTasks: number;
  acceptedTasks: number;
  fixedTasks: number;
  completedTasks: number;
  blockedTaskId?: string;
  failedTaskId?: string;
  stoppedReason?: string;
}

export interface RealBlockRunState {
  block_id: string;
  title: string;
  status: 'completed' | 'blocked' | 'failed';
  currentTaskId: string | null;
  statePath: string;
  taskResults: RealBlockRunTaskResult[];
  summary: RealBlockRunSummary;
  startedAt: string;
  finishedAt?: string;
  safetyNote: string;
  resumed?: boolean;
  resumeStartedAt?: string;
}

function isObject(val: unknown): val is Record<string, unknown> {
  return typeof val === 'object' && val !== null && !Array.isArray(val);
}

function sanitizeBlockId(blockId: string): string {
  return blockId.replace(/[^a-zA-Z0-9_-]/g, '_');
}

export function getRunsDir(): string {
  return resolve(process.env.RUNS_DIR ?? config.runsDir);
}

export function getBlockRunDir(block: BlockDefinition): string {
  const runsDir = getRunsDir();
  return join(runsDir, 'block', sanitizeBlockId(block.block_id));
}

export function getBlockStatePath(block: BlockDefinition): string {
  return join(getBlockRunDir(block), 'state.json');
}

export function isCompletedTaskStatus(
  status: string | undefined
): status is 'accepted' | 'fixed_and_accepted' {
  return status === 'accepted' || status === 'fixed_and_accepted';
}

function validateBlockRunState(
  parsed: unknown,
  block: BlockDefinition
): RealBlockRunState {
  if (!isObject(parsed)) {
    throw new Error('Existing block state file is not a valid object');
  }

  if (parsed.block_id !== block.block_id) {
    throw new Error('Existing block state file does not match block_id');
  }

  const validStatuses = ['completed', 'blocked', 'failed'];
  if (typeof parsed.status !== 'string' || !validStatuses.includes(parsed.status)) {
    throw new Error('Existing block state file has invalid status');
  }

  if (!Array.isArray(parsed.taskResults)) {
    throw new Error('Existing block state file has invalid taskResults');
  }

  const validTaskIds = new Set(block.tasks.map((t) => t.task_id));
  for (let i = 0; i < parsed.taskResults.length; i++) {
    const result = parsed.taskResults[i];
    if (!isObject(result)) {
      throw new Error(`Existing block state task result ${i} is not an object`);
    }
    if (typeof result.taskId !== 'string') {
      throw new Error(`Existing block state task result ${i} is missing taskId`);
    }
    if (!validTaskIds.has(result.taskId)) {
      throw new Error('Existing block state contains unknown task id');
    }
    if (typeof result.status !== 'string') {
      throw new Error(`Existing block state task result ${i} is missing status`);
    }
    if (isCompletedTaskStatus(result.status)) {
      if (typeof result.originalCommitSha !== 'string' || result.originalCommitSha.length !== 40) {
        throw new Error('Existing block state has completed task without valid commit SHA');
      }
      if (
        result.status === 'fixed_and_accepted' &&
        (typeof result.fixCommitSha !== 'string' || result.fixCommitSha.length !== 40)
      ) {
        throw new Error('Existing block state has fixed task without valid fix commit SHA');
      }
    }
  }

  return parsed as unknown as RealBlockRunState;
}

export function loadExistingBlockState(
  block: BlockDefinition
): RealBlockRunState | null {
  const statePath = getBlockStatePath(block);
  if (!existsSync(statePath)) {
    return null;
  }

  let raw: string;
  try {
    raw = readFileSync(statePath, 'utf-8');
  } catch {
    throw new Error('Existing block state file could not be read');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('Existing block state file is not valid JSON');
  }

  return validateBlockRunState(parsed, block);
}
