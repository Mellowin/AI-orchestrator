import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve, normalize } from 'node:path';
import type { BlockDefinition, BlockState, BlockTaskState, BlockTaskStatus } from './block-types.js';

const BLOCK_RUNS_DIR = process.env.BLOCK_RUNS_DIR || join(process.cwd(), 'runs', 'blocks');

export function getBlockRunDir(blockId: string): string {
  if (!blockId || typeof blockId !== 'string') {
    throw new Error('blockId is required');
  }
  const normalized = blockId.trim().replace(/[\\/]/g, '_');
  return join(BLOCK_RUNS_DIR, normalized);
}

function getBlockStatePath(blockId: string): string {
  return join(getBlockRunDir(blockId), 'block-state.json');
}

function validatePathSafe(filePath: string): void {
  const resolved = resolve(normalize(filePath));
  const runsDirResolved = resolve(normalize(BLOCK_RUNS_DIR));
  if (!resolved.startsWith(runsDirResolved)) {
    throw new Error('Block state path is outside allowed runs directory');
  }
}

export function initBlockState(definition: BlockDefinition): BlockState {
  const now = new Date().toISOString();

  const tasks: BlockTaskState[] = definition.tasks.map((task) => ({
    task_id: task.task_id,
    status: 'pending' as BlockTaskStatus,
    current_attempt: 0,
    fix_attempts: 0,
    commit_sha: null,
    pushed_ref: null,
    reviewer_decision: null,
    reviewer_summary: null,
    blocking_issues: [],
    updated_at: now,
  }));

  return {
    block_id: definition.block_id,
    title: definition.title,
    status: 'pending',
    repo_path: definition.repo_path,
    base_branch: definition.base_branch,
    work_branch: definition.work_branch,
    current_task_id: tasks.length > 0 ? tasks[0].task_id : null,
    created_at: now,
    updated_at: now,
    tasks,
    safety_note: 'This block state does not contain API keys, provider output, or git credentials.',
    review_policy: definition.review_policy,
  };
}

export function loadBlockState(blockId: string): BlockState | null {
  const statePath = getBlockStatePath(blockId);
  if (!existsSync(statePath)) {
    return null;
  }
  const raw = readFileSync(statePath, 'utf-8');
  return JSON.parse(raw) as BlockState;
}

export function saveBlockState(state: BlockState): void {
  const statePath = getBlockStatePath(state.block_id);
  validatePathSafe(statePath);

  const dir = getBlockRunDir(state.block_id);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const tempPath = statePath + '.tmp';
  writeFileSync(tempPath, JSON.stringify(state, null, 2), 'utf-8');
  renameSync(tempPath, statePath);
}

export function updateBlockState(blockId: string, updater: (state: BlockState) => BlockState): BlockState {
  const state = loadBlockState(blockId);
  if (!state) {
    throw new Error(`Block state not found: ${blockId}`);
  }
  const updated = updater(state);
  updated.updated_at = new Date().toISOString();
  saveBlockState(updated);
  return updated;
}
