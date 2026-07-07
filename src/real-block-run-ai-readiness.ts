import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { loadBlockDefinition } from './block/block-loader.js';
import type { BlockDefinition } from './block/block-types.js';
import { redactSecrets } from './sandbox-preflight-repair.js';
import {
  resolveTaskTimeoutMs,
  resolveReviewerParseRetries,
  resolveOnBlockedTask,
} from './real-block-task-timeout.js';
import type { RealBlockRunState } from './real-block-run-ai-state.js';
import {
  getBlockStatePath,
  isCompletedTaskStatus,
  loadExistingBlockState,
} from './real-block-run-ai-state.js';

export interface ReadinessReport {
  ready: boolean;
  mode: 'fresh' | 'resume' | 'completed_noop';
  blockId?: string;
  blockTitle?: string;
  repoPath?: string;
  taskCount?: number;
  statePath?: string;
  existingState: 'none' | 'completed' | 'incomplete' | 'invalid';
  skippedTaskIds?: string[];
  nextTaskId?: string;
  reasons: string[];
}

function isResumeEnabled(options?: { resume?: boolean }): boolean {
  return (options?.resume ?? false) || process.env.REAL_BLOCK_RUN_RESUME === '1';
}

function addReason(report: ReadinessReport, reason: string): void {
  report.reasons.push(redactSecrets(reason));
}

function checkEnv(report: ReadinessReport): void {
  const allow = process.env.ALLOW_REAL_BLOCK_RUN_AI === 'true';
  const legacy = process.env.REAL_BLOCK_RUN_AI === '1';
  if (!allow && !legacy) {
    addReason(report, 'ALLOW_REAL_BLOCK_RUN_AI=true (or REAL_BLOCK_RUN_AI=1) is required');
  }

  const requiredTrueFlags = [
    'ALLOW_REAL_REPO_APPLY',
    'ALLOW_REAL_REPO_COMMIT',
    'ALLOW_REAL_REPO_PUSH',
  ];
  for (const name of requiredTrueFlags) {
    if (process.env[name] !== 'true') {
      addReason(report, `${name}=true is required`);
    }
  }

  const allowRealProvider = process.env.ALLOW_REAL_PROVIDER === 'true' || process.env.ALLOW_REAL_PROVIDER === '1';
  if (!allowRealProvider) {
    addReason(report, 'ALLOW_REAL_PROVIDER=true or ALLOW_REAL_PROVIDER=1 is required');
  }

  if (!process.env.KIMI_API_KEY || process.env.KIMI_API_KEY.trim() === '') {
    addReason(report, 'KIMI_API_KEY env var is required');
  }
  if (!process.env.KIMI_BASE_URL || process.env.KIMI_BASE_URL.trim() === '') {
    addReason(report, 'KIMI_BASE_URL env var is required');
  }
}

function checkReviewPolicy(block: BlockDefinition, report: ReadinessReport): void {
  try {
    resolveTaskTimeoutMs(block);
    resolveReviewerParseRetries(block);
    resolveOnBlockedTask(block);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    addReason(report, message);
  }
}

function checkRepo(block: BlockDefinition, report: ReadinessReport): void {
  const repoPath = resolve(block.repo_path);
  report.repoPath = repoPath;

  if (!existsSync(repoPath)) {
    addReason(report, 'Repository path does not exist');
    return;
  }

  if (!existsSync(resolve(repoPath, '.git'))) {
    addReason(report, 'Repository path is not a git repository');
    return;
  }

  if (block.work_branch === 'main') {
    addReason(report, 'work_branch must not be "main"');
  }
  if (!block.work_branch || block.work_branch.length === 0) {
    addReason(report, 'work_branch must not be empty');
  }
  if (block.work_branch === block.base_branch) {
    addReason(report, 'work_branch must not equal base_branch');
  }

  const baseCheck = spawnSync(
    'git',
    ['show-ref', '--verify', `refs/heads/${block.base_branch}`],
    {
      cwd: repoPath,
      encoding: 'utf-8',
      shell: false,
    }
  );
  if (baseCheck.status !== 0) {
    addReason(report, 'base_branch does not exist in repository');
  }
}

function parseOptionalStringArray(
  raw: string | undefined
): { ok: false; reason: string } | { ok: true; values: (string | undefined)[] } {
  if (raw === undefined || raw.trim() === '') {
    return { ok: true, values: [] };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, reason: 'Invalid JSON in fake response array' };
  }
  if (!Array.isArray(parsed)) {
    return { ok: false, reason: 'Fake response env var must be a JSON array' };
  }
  return {
    ok: true,
    values: parsed.map((item) =>
      item === undefined || item === null ? undefined : String(item)
    ),
  };
}

function checkFakeResponseArrays(
  block: BlockDefinition,
  report: ReadinessReport
): void {
  const names = [
    'REAL_BLOCK_TASK_KIMI_FAKE_RESPONSES',
    'REAL_BLOCK_TASK_REVIEWER_FAKE_RESPONSES',
    'REAL_BLOCK_TASK_FIX_KIMI_FAKE_RESPONSES',
    'REAL_BLOCK_TASK_SECOND_REVIEWER_FAKE_RESPONSES',
  ];
  for (const name of names) {
    const raw = process.env[name];
    if (raw === undefined || raw.trim() === '') {
      continue;
    }
    const result = parseOptionalStringArray(raw);
    if (!result.ok) {
      addReason(report, result.reason);
      continue;
    }
    if (result.values.length !== block.tasks.length) {
      addReason(
        report,
        `${name} length (${result.values.length}) does not match task count (${block.tasks.length})`
      );
    }
  }
}

function checkExistingState(
  block: BlockDefinition,
  report: ReadinessReport,
  resume: boolean,
  preloaded?: RealBlockRunState | null
): void {
  let existing: RealBlockRunState | null;
  if (preloaded !== undefined) {
    existing = preloaded;
  } else {
    try {
      existing = loadExistingBlockState(block);
    } catch (err) {
      report.existingState = 'invalid';
      const msg = err instanceof Error ? err.message : 'Existing block state is invalid';
      addReason(report, msg);
      return;
    }
  }

  if (existing === null) {
    report.existingState = 'none';
    report.mode = 'fresh';
    return;
  }

  if (existing.status === 'completed' || existing.status === 'completed_with_caveats') {
    report.existingState = 'completed';
    if (resume) {
      report.mode = 'completed_noop';
      report.skippedTaskIds = block.tasks.map((t) => t.task_id);
    } else {
      addReason(report, 'Block run already completed. Enable resume mode for status.');
    }
    return;
  }

  report.existingState = 'incomplete';
  if (!resume) {
    addReason(report, 'Existing block run is incomplete. Enable resume mode to continue.');
    return;
  }

  report.mode = 'resume';
  const skippedTaskIds: string[] = [];
  for (const result of existing.taskResults) {
    if (isCompletedTaskStatus(result.status)) {
      skippedTaskIds.push(result.taskId);
    }
  }
  report.skippedTaskIds = skippedTaskIds;

  const nextTask = block.tasks.find(
    (t) => !skippedTaskIds.includes(t.task_id)
  );
  report.nextTaskId = nextTask?.task_id;
}

export function checkRealBlockRunReadiness(
  blockPath: string,
  options?: { resume?: boolean }
): ReadinessReport {
  const report: ReadinessReport = {
    ready: false,
    mode: 'fresh',
    existingState: 'none',
    reasons: [],
  };

  const resume = isResumeEnabled(options);

  let block: BlockDefinition;
  try {
    block = loadBlockDefinition(blockPath);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Block definition is invalid';
    addReason(report, msg);
    return report;
  }

  report.blockId = block.block_id;
  report.blockTitle = block.title;
  report.taskCount = block.tasks.length;
  report.statePath = getBlockStatePath(block);

  let existingState: RealBlockRunState | null = null;
  let existingStateError = false;
  try {
    existingState = loadExistingBlockState(block);
  } catch (err) {
    existingStateError = true;
    report.existingState = 'invalid';
    const msg = err instanceof Error ? err.message : 'Existing block state is invalid';
    addReason(report, msg);
  }

  if (!existingStateError && existingState !== null && (existingState.status === 'completed' || existingState.status === 'completed_with_caveats') && resume) {
    report.existingState = 'completed';
    report.mode = 'completed_noop';
    report.ready = true;
    report.skippedTaskIds = block.tasks.map((t) => t.task_id);
    return report;
  }

  checkEnv(report);
  checkReviewPolicy(block, report);
  checkRepo(block, report);
  if (!existingStateError) {
    checkExistingState(block, report, resume, existingState);
  }
  checkFakeResponseArrays(block, report);

  report.ready = report.reasons.length === 0;
  return report;
}
