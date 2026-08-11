import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadBlockDefinition } from './block/block-loader.js';
import type { BlockDefinition, BlockTaskDefinition } from './block/block-types.js';
import {
  prepareFreshBlockRun,
  verifyTaskResultHistory,
} from './block/block-state-consistency.js';
import { buildSingleTaskYaml, buildTaskExecutorInput } from './task-executor-input.js';

import { redactSecrets } from './sandbox-preflight-repair.js';
import { checkRealBlockRunReadiness } from './real-block-run-ai-readiness.js';
import {
  resolveTaskTimeoutMs,
  resolveReviewerParseRetries,
  resolveOnBlockedTask,
} from './real-block-task-timeout.js';
import type { ReviewerEvidence } from './reviewer-evidence.js';
import { buildDependencyEvidence } from './reviewer/dependency-evidence.js';
import type { ProviderAttempt, TaskRunPhase } from './types.js';
import type {
  RealBlockRunState,
  RealBlockRunSummary,
  RealBlockRunTaskResult,
} from './real-block-run-ai-state.js';
import {
  getBlockRunDir,
  getBlockStatePath,
  getRunsDir,
  isCompletedTaskStatus,
  isSkippedBlockedTaskStatus,
  loadExistingBlockState,
} from './real-block-run-ai-state.js';
import {
  acquireRunLock,
  formatRunLockError,
  releaseRunLock,
  RunLockError,
  getRepoRunLockPath,
} from './run-lock.js';
import { writeJsonAtomic } from './state-atomic-write.js';
import { runGitHealthPreflight, formatGitHealthPreflightError } from './git-health-preflight.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '..');

export function resolveTaskBaseSha(repoPath: string, workBranch: string, baseBranch: string): string {
  const candidates = [
    workBranch,
    `refs/heads/${workBranch}`,
    `refs/remotes/origin/${workBranch}`,
    baseBranch,
    `refs/heads/${baseBranch}`,
    `refs/remotes/origin/${baseBranch}`,
  ];
  for (const ref of candidates) {
    const result = spawnSync('git', ['rev-parse', ref], {
      cwd: repoPath,
      encoding: 'utf-8',
      shell: false,
    });
    if (result.status === 0) {
      const sha = result.stdout.trim();
      if (/^[0-9a-f]{40}$/i.test(sha)) {
        return sha;
      }
    }
  }
  return '';
}

export function sanitizeTaskId(taskId: string): string {
  return taskId.replace(/[^a-zA-Z0-9_-]/g, '_');
}

// Continuation budget for a single task run. A task may be re-spawned up to
// MAX_TASK_CONTINUATIONS times, but the cumulative wall time must stay under
// TOTAL_TASK_CEILING_MS.
const MAX_TASK_CONTINUATIONS = 2;
const TOTAL_TASK_CEILING_MS = 900000;

type RunSingleTaskResult =
  | { kind: 'completed'; exitCode: number; state: Record<string, unknown> | null }
  | { kind: 'timeout'; state: Record<string, unknown> | null; elapsedMs: number }
  | { kind: 'error'; error: string; state: Record<string, unknown> | null };

interface FakeResponseArrays {
  kimi?: (string | undefined)[];
  reviewer?: (string | undefined)[];
  fixKimi?: (string | undefined)[];
  secondReviewer?: (string | undefined)[];
}

const FAKE_RESPONSE_ENV_NAMES: (keyof FakeResponseArrays)[] = [
  'kimi',
  'reviewer',
  'fixKimi',
  'secondReviewer',
];

function parseOptionalStringArray(
  name: string,
  raw: string | undefined
): (string | undefined)[] | undefined {
  if (raw === undefined || raw.trim() === '') {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Invalid JSON in ${name}: ${redactSecrets(raw)}`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`${name} must be a JSON array`);
  }
  return parsed.map((item) => {
    if (item === undefined || item === null) return undefined;
    if (Array.isArray(item)) return JSON.stringify(item);
    return String(item);
  });
}

function loadFakeResponseArrays(block: BlockDefinition): FakeResponseArrays {
  return {
    kimi: parseOptionalStringArray(
      'REAL_BLOCK_TASK_KIMI_FAKE_RESPONSES',
      process.env.REAL_BLOCK_TASK_KIMI_FAKE_RESPONSES
    ),
    reviewer: parseOptionalStringArray(
      'REAL_BLOCK_TASK_REVIEWER_FAKE_RESPONSES',
      process.env.REAL_BLOCK_TASK_REVIEWER_FAKE_RESPONSES
    ),
    fixKimi: parseOptionalStringArray(
      'REAL_BLOCK_TASK_FIX_KIMI_FAKE_RESPONSES',
      process.env.REAL_BLOCK_TASK_FIX_KIMI_FAKE_RESPONSES
    ),
    secondReviewer: parseOptionalStringArray(
      'REAL_BLOCK_TASK_SECOND_REVIEWER_FAKE_RESPONSES',
      process.env.REAL_BLOCK_TASK_SECOND_REVIEWER_FAKE_RESPONSES
    ),
  };
}

function validateFakeResponseArrays(
  block: BlockDefinition,
  arrays: FakeResponseArrays
): void {
  for (const name of FAKE_RESPONSE_ENV_NAMES) {
    const arr = arrays[name];
    if (arr === undefined) {
      continue;
    }
    if (arr.length !== block.tasks.length) {
      throw new Error(
        `${name} array length (${arr.length}) does not match block task count (${block.tasks.length})`
      );
    }
  }
}

function getTaskFakeResponse(
  arrays: FakeResponseArrays,
  name: keyof FakeResponseArrays,
  index: number
): string | string[] | undefined {
  const arr = arrays[name];
  if (arr === undefined) {
    return undefined;
  }
  return arr[index];
}

function saveBlockState(block: BlockDefinition, state: RealBlockRunState): void {
  const dir = getBlockRunDir(block);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  const allAttempts: unknown[] = [];
  for (const result of state.taskResults) {
    if (Array.isArray(result.reviewerFixAttempts)) {
      allAttempts.push(...result.reviewerFixAttempts);
    }
  }
  if (allAttempts.length > 0) {
    state.reviewer_fix_attempts = allAttempts;
  } else {
    delete (state as unknown as Record<string, unknown>).reviewer_fix_attempts;
  }
  writeJsonAtomic(getBlockStatePath(block), state);
}

function buildBaseChildEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  const varsToClear = [
    'TASKS_FILE',
    'RUNS_DIR',
    'KIMI_FAKE_RESPONSE',
    'KIMI_FAKE_RESPONSES',
    'REAL_REPO_REVIEWER_FAKE_RESPONSE',
    'REAL_REPO_ENABLE_REVIEWER_FIX_LOOP',
    'REAL_REPO_REVIEWER_FIX_TASK_KIMI_FAKE_RESPONSE',
    'REAL_REPO_REVIEWER_FIX_TASK_KIMI_FAKE_RESPONSES',
    'REAL_REPO_REVIEWER_SECOND_FAKE_RESPONSE',
    'REAL_REPO_REVIEWER_FIX_TASK_FAKE_EXECUTOR_RESPONSE',
  ];
  for (const name of varsToClear) {
    delete env[name];
  }
  return env;
}

function getChildRunsDir(runsDir: string): string {
  return join(runsDir, 'tasks');
}

function looksLikeJsonArrayString(value: string): boolean {
  return value.trim().startsWith('[');
}

function runSingleTask(
  block: BlockDefinition,
  task: BlockTaskDefinition,
  index: number,
  arrays: FakeResponseArrays,
  timeoutMs: number,
  resume = false
): RunSingleTaskResult {
  const runsDir = getRunsDir();
  const blockRunDir = getBlockRunDir(block);
  const childRunsDir = getChildRunsDir(runsDir);

  // Child real-repo-run-ai writes state to runs/tasks/<task_id>/state.json.
  // Only remove stale child state when starting a fresh task run. Resume and
  // continuation passes must reuse the existing child state so the child CLI can
  // pick up where it left off.
  if (!resume) {
    const staleTaskRunDir = join(childRunsDir, task.task_id);
    if (existsSync(staleTaskRunDir)) {
      rmSync(staleTaskRunDir, { recursive: true, force: true });
    }
  }

  const debugYamlPath = join(blockRunDir, `${task.task_id}.tasks.debug.yaml`);
  writeFileSync(debugYamlPath, buildSingleTaskYaml(block, task), 'utf-8');

  const taskBaseSha = resolveTaskBaseSha(resolve(block.repo_path), block.work_branch, block.base_branch);
  const candidatePath = join(blockRunDir, 'workspaces', sanitizeTaskId(task.task_id));
  const candidateParent = join(blockRunDir, 'workspaces');
  if (!existsSync(candidateParent)) {
    mkdirSync(candidateParent, { recursive: true });
  }
  const taskExecutorInput = buildTaskExecutorInput(block, task, {
    taskBaseSha,
    candidatePath,
    runId: randomUUID(),
    attempt: resume ? undefined : undefined,
  });

  const env = buildBaseChildEnv();
  // Deprecated: TASKS_FILE is kept for backward compatibility only. The child
  // process now receives the canonical task configuration via stdin as JSON.
  env.TASKS_FILE = debugYamlPath;
  env.REAL_REPO_TASK_EXECUTOR_INPUT_STDIN = '1';
  env.RUNS_DIR = childRunsDir;
  env.REAL_REPO_ENABLE_REVIEWER_FIX_LOOP = '1';

  if (resume) {
    env.REAL_REPO_RUN_RESUME = '1';
    env.REAL_REPO_RUN_RESUME_TIMEOUT_MS = String(timeoutMs);
  }

  const blockMaxFixAttempts =
    typeof block.review_policy?.max_fix_attempts === 'number' &&
    Number.isInteger(block.review_policy.max_fix_attempts) &&
    block.review_policy.max_fix_attempts >= 1 &&
    block.review_policy.max_fix_attempts <= 5
      ? block.review_policy.max_fix_attempts
      : 1;
  env.REAL_REPO_REVIEWER_MAX_FIX_ATTEMPTS = String(blockMaxFixAttempts);

  env.REAL_REVIEWER_PARSE_RETRIES = String(resolveReviewerParseRetries(block));

  const kimiResponse = getTaskFakeResponse(arrays, 'kimi', index);
  if (kimiResponse !== undefined) {
    if (Array.isArray(kimiResponse)) {
      env.KIMI_FAKE_RESPONSES = JSON.stringify(kimiResponse);
    } else if (
      typeof kimiResponse === 'string' &&
      kimiResponse.trim().startsWith('[')
    ) {
      env.KIMI_FAKE_RESPONSES = kimiResponse;
    } else {
      env.KIMI_FAKE_RESPONSE = kimiResponse;
    }
  }

  const reviewerResponse = getTaskFakeResponse(arrays, 'reviewer', index);
  if (typeof reviewerResponse === 'string') {
    env.REAL_REPO_REVIEWER_FAKE_RESPONSE = reviewerResponse;
  }

  const fixKimiResponse = getTaskFakeResponse(arrays, 'fixKimi', index);
  if (fixKimiResponse !== undefined) {
    if (Array.isArray(fixKimiResponse)) {
      env.REAL_REPO_REVIEWER_FIX_TASK_KIMI_FAKE_RESPONSES = JSON.stringify(fixKimiResponse);
    } else if (typeof fixKimiResponse === 'string' && looksLikeJsonArrayString(fixKimiResponse)) {
      env.REAL_REPO_REVIEWER_FIX_TASK_KIMI_FAKE_RESPONSES = fixKimiResponse;
    } else if (typeof fixKimiResponse === 'string') {
      env.REAL_REPO_REVIEWER_FIX_TASK_KIMI_FAKE_RESPONSE = fixKimiResponse;
    }
  }

  const secondReviewerResponse = getTaskFakeResponse(arrays, 'secondReviewer', index);
  if (secondReviewerResponse !== undefined) {
    if (Array.isArray(secondReviewerResponse)) {
      env.REAL_REPO_REVIEWER_SECOND_FAKE_RESPONSES = JSON.stringify(secondReviewerResponse);
    } else if (typeof secondReviewerResponse === 'string' && looksLikeJsonArrayString(secondReviewerResponse)) {
      env.REAL_REPO_REVIEWER_SECOND_FAKE_RESPONSES = secondReviewerResponse;
    } else if (typeof secondReviewerResponse === 'string') {
      env.REAL_REPO_REVIEWER_SECOND_FAKE_RESPONSE = secondReviewerResponse;
    }
  }

  // If a previous child process was killed (e.g. by timeout) it could not
  // release its repo run lock. The parent controls task execution order, so it
  // is safe to remove any leftover lock for this task before spawning again.
  const repoRunLockPath = getRepoRunLockPath(
    resolve(block.repo_path),
    block.work_branch,
    childRunsDir
  );
  if (existsSync(repoRunLockPath)) {
    try {
      unlinkSync(repoRunLockPath);
    } catch {
      // ignore
    }
  }

  const cliPath = join(projectRoot, 'src', 'cli.ts');
  const tsxCliPath = join(projectRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const result = spawnSync(
    process.execPath,
    [tsxCliPath, cliPath, 'real-repo-run-ai', task.task_id],
    {
      cwd: projectRoot,
      env,
      encoding: 'utf-8',
      shell: false,
      timeout: timeoutMs,
      input: JSON.stringify(taskExecutorInput),
    }
  );

  const childLoad = loadChildState(task.task_id, runsDir);
  const state = childLoad.kind === 'loaded' ? childLoad.state : null;

  if (result.error) {
    const err = result.error as NodeJS.ErrnoException;
    const isTimeout = err.code === 'ETIMEDOUT' || err.message?.includes('ETIMEDOUT');
    if (isTimeout) {
      const elapsedMs =
        typeof state?.total_elapsed_ms === 'number' && typeof state?.timeout_ms === 'number'
          ? state.total_elapsed_ms + state.timeout_ms
          : timeoutMs;
      console.error(`[real-block-run-ai] Task ${task.task_id} runner timed out after ${timeoutMs} ms`);
      return { kind: 'timeout', state, elapsedMs };
    }
    console.error(`[real-block-run-ai] Task ${task.task_id} runner spawn error: ${redactSecrets(err.message ?? String(result.error))}`);
    return { kind: 'error', error: err.message ?? String(result.error), state };
  }

  if (result.status !== 0) {
    const output = (result.stderr || result.stdout || '').trim();
    console.error(`[real-block-run-ai] Task ${task.task_id} runner exited with code ${result.status}`);
    if (output) {
      console.error(`[real-block-run-ai] Task ${task.task_id} runner output:`);
      console.error(redactSecrets(output));
    }
  }

  return { kind: 'completed', exitCode: result.status ?? 1, state };
}

function executeTaskWithContinuations(
  block: BlockDefinition,
  task: BlockTaskDefinition,
  index: number,
  arrays: FakeResponseArrays,
  timeoutMs: number,
  resumeChild: boolean
): { exitCode: number; state: Record<string, unknown> | null; timedOut: boolean } {
  let totalElapsedMs = 0;
  let continuationCount = 0;
  let currentResume = resumeChild;

  while (true) {
    const run = runSingleTask(block, task, index, arrays, timeoutMs, currentResume);

    if (run.kind === 'timeout') {
      const elapsedThisPass = run.elapsedMs ?? timeoutMs;
      totalElapsedMs += elapsedThisPass;

      if (run.state !== null) {
        run.state.total_elapsed_ms = totalElapsedMs;
        run.state.timeout_ms = timeoutMs;
      }

      if (continuationCount >= MAX_TASK_CONTINUATIONS) {
        console.error(
          `[real-block-run-ai] Task ${task.task_id} exceeded max continuations (${MAX_TASK_CONTINUATIONS}); treating as failed.`
        );
        if (run.state !== null) {
          run.state.continuation_count = continuationCount;
          const childStatePath = join(getRunsDir(), 'tasks', task.task_id, 'state.json');
          try {
            writeJsonAtomic(childStatePath, run.state);
          } catch {
            // State persistence failure is tolerable here; the block state will still record timeout evidence.
          }
        }
        return { exitCode: 1, state: run.state, timedOut: true };
      }

      if (totalElapsedMs >= TOTAL_TASK_CEILING_MS) {
        console.error(
          `[real-block-run-ai] Task ${task.task_id} exceeded total time ceiling (${TOTAL_TASK_CEILING_MS}ms); treating as failed.`
        );
        if (run.state !== null) {
          run.state.continuation_count = continuationCount;
          const childStatePath = join(getRunsDir(), 'tasks', task.task_id, 'state.json');
          try {
            writeJsonAtomic(childStatePath, run.state);
          } catch {
            // Tolerable; block state records the evidence.
          }
        }
        return { exitCode: 1, state: run.state, timedOut: true };
      }

      continuationCount += 1;
      if (run.state !== null) {
        run.state.continuation_count = continuationCount;
        const childStatePath = join(getRunsDir(), 'tasks', task.task_id, 'state.json');
        try {
          writeJsonAtomic(childStatePath, run.state);
        } catch {
          // Tolerable; the next continuation will recompute from elapsed time if needed.
        }
      }
      currentResume = true;
      console.error(
        `[real-block-run-ai] Task ${task.task_id} timed out; continuation ${continuationCount}/${MAX_TASK_CONTINUATIONS} (${totalElapsedMs}ms elapsed)`
      );
      continue;
    }

    if (run.kind === 'error') {
      return { exitCode: 1, state: run.state, timedOut: false };
    }

    return { exitCode: run.exitCode, state: run.state, timedOut: false };
  }
}

function getStateString(
  state: Record<string, unknown>,
  key: string
): string | undefined {
  const value = state[key];
  return typeof value === 'string' ? value : undefined;
}

type ChildStateLoadResult =
  | { kind: 'missing' }
  | { kind: 'loaded'; state: Record<string, unknown> }
  | { kind: 'corrupted'; error: string };

function isObject(val: unknown): val is Record<string, unknown> {
  return typeof val === 'object' && val !== null && !Array.isArray(val);
}

function loadChildState(
  taskId: string,
  runsDir: string
): ChildStateLoadResult {
  const statePath = join(getChildRunsDir(runsDir), taskId, 'state.json');
  if (!existsSync(statePath)) {
    return { kind: 'missing' };
  }

  let raw: string;
  try {
    raw = readFileSync(statePath, 'utf-8');
  } catch {
    return { kind: 'corrupted', error: 'Child state file could not be read' };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kind: 'corrupted', error: 'Child state file is not valid JSON' };
  }

  if (!isObject(parsed)) {
    return { kind: 'corrupted', error: 'Child state is not a valid object' };
  }

  return { kind: 'loaded', state: parsed };
}

interface ValidChildState {
  valid: true;
  state: Record<string, unknown>;
}

interface InvalidChildState {
  valid: false;
  reason: string;
}

type ChildStateValidationResult = ValidChildState | InvalidChildState;

function validateChildState(
  task: BlockTaskDefinition,
  block: BlockDefinition,
  state: Record<string, unknown>
): ChildStateValidationResult {
  const stateTaskId = state.task_id;
  if (typeof stateTaskId !== 'string' || stateTaskId !== task.task_id) {
    return {
      valid: false,
      reason: `Child state task_id mismatch for task ${task.task_id}: expected ${task.task_id}, got ${String(stateTaskId)}`,
    };
  }

  const stateRepoPath = state.repo_path;
  if (typeof stateRepoPath === 'string' && stateRepoPath.trim().length > 0) {
    const expectedRepoPath = resolve(block.repo_path);
    const actualRepoPath = resolve(stateRepoPath);
    if (expectedRepoPath !== actualRepoPath) {
      return {
        valid: false,
        reason: `Child state repo_path mismatch for task ${task.task_id}`,
      };
    }
  }

  return { valid: true, state };
}

function validateCompletedChildResult(
  result: RealBlockRunTaskResult,
  repoPath: string
): string | undefined {
  const history = verifyTaskResultHistory(result, repoPath);
  if (!history.ok) {
    return history.reason;
  }
  if (result.status === 'accepted') {
    if (
      typeof result.originalCommitSha !== 'string' ||
      result.originalCommitSha.length !== 40
    ) {
      return `Completed accepted task ${result.taskId} is missing a valid original commit SHA`;
    }
  }

  if (result.status === 'fixed_and_accepted') {
    if (
      typeof result.originalCommitSha !== 'string' ||
      result.originalCommitSha.length !== 40
    ) {
      return `Completed fixed task ${result.taskId} is missing a valid original commit SHA`;
    }
    if (
      typeof result.fixCommitSha !== 'string' ||
      result.fixCommitSha.length !== 40
    ) {
      return `Completed fixed task ${result.taskId} is missing a valid fix commit SHA`;
    }
  }

  return undefined;
}

function blockResumeFailure(
  block: BlockDefinition,
  blockState: RealBlockRunState,
  taskId: string,
  reason: string
): { exitCode: number; blockState: RealBlockRunState } {
  blockState.status = 'blocked';
  blockState.summary.blockedTaskId = taskId;
  blockState.currentTaskId = null;
  blockState.finishedAt = new Date().toISOString();
  blockState.summary.stoppedReason = redactSecrets(reason);
  saveBlockState(block, blockState);
  console.error('[real-block-run-ai] Resume blocked: cannot continue safely');
  console.error(`[real-block-run-ai] Reason: ${redactSecrets(reason)}`);
  console.error('[real-block-run-ai] No provider call was made');
  console.error('[real-block-run-ai] No apply was performed');
  console.error('[real-block-run-ai] No commit was made');
  console.error('[real-block-run-ai] No push was performed');
  console.error('[real-block-run-ai] No merge was performed');
  printBlockRunSummary(blockState);
  return { exitCode: 1, blockState };
}

function getGateSummary(gate: Record<string, unknown> | undefined): string | undefined {
  if (gate === undefined) {
    return undefined;
  }
  const summary = gate.reviewSummary;
  return typeof summary === 'string' ? redactSecrets(summary) : undefined;
}

function getGateStatus(gate: Record<string, unknown> | undefined): string | undefined {
  if (gate === undefined) {
    return undefined;
  }
  const status = gate.status;
  return typeof status === 'string' ? status : undefined;
}

function isBlockingStatus(status: string): boolean {
  return status === 'blocked' || status === 'failed' || status === 'fix_required';
}

function deriveTaskResult(
  task: BlockTaskDefinition,
  run: { exitCode: number; state: Record<string, unknown> | null; timedOut?: boolean }
): RealBlockRunTaskResult {
  const base: RealBlockRunTaskResult = {
    taskId: task.task_id,
    title: task.title,
    status: 'failed',
    fixAttempted: false,
    finalStatus: 'failed',
    nextAction: 'block',
    childStateTaskId: task.task_id,
    codeApplied: false,
    pushed: false,
    checksResult: 'unknown',
  };

  if (run.state === null) {
    base.reason = redactSecrets(
      run.exitCode === 0
        ? 'Task finished but no state was persisted.'
        : `Task runner exited with code ${run.exitCode} and no state was persisted.`
    );
    return base;
  }

  const state = run.state;
  const runStatus = state.status;
  const commitSha = getStateString(state, 'commit_sha');
  base.originalCommitSha = commitSha;
  base.codeApplied = typeof commitSha === 'string' && commitSha.length === 40;
  base.pushed = state.status === 'pushed' && run.exitCode === 0;

  const providerAttempts = state.provider_attempts;
  if (Array.isArray(providerAttempts)) {
    base.providerAttempts = providerAttempts as ProviderAttempt[];
  }

  const rollback = state.rollback as Record<string, unknown> | undefined;
  if (rollback !== undefined) {
    base.rollbackPolicy =
      typeof rollback.policy === 'string' ? rollback.policy : undefined;
    base.rollbackReason =
      typeof rollback.reason === 'string' ? redactSecrets(rollback.reason) : undefined;
  }

  const reviewerGate = state.reviewer_gate as Record<string, unknown> | undefined;
  const controlledRun = state.reviewer_fix_task_controlled_run as
    | Record<string, unknown>
    | undefined;
  const secondReview = state.reviewer_fix_task_second_review as
    | Record<string, unknown>
    | undefined;

  if (reviewerGate !== undefined) {
    base.reviewerGateStatus = getGateStatus(reviewerGate);
    base.reviewerSummary = getGateSummary(reviewerGate);
    const parseAttempts = reviewerGate.parseAttempts;
    if (typeof parseAttempts === 'number') {
      base.parseAttempts = parseAttempts;
    }
  }

  if (controlledRun !== undefined) {
    base.fixAttempted = true;
    base.fixRunnerStatus =
      typeof controlledRun.runnerResultStatus === 'string'
        ? controlledRun.runnerResultStatus
        : undefined;
    base.fixRunnerNextAction =
      typeof controlledRun.runnerResultNextAction === 'string'
        ? controlledRun.runnerResultNextAction
        : undefined;

    const persistedState = controlledRun.persistedState as
      | Record<string, unknown>
      | undefined;
    if (persistedState !== undefined) {
      const pendingTaskId = persistedState.taskId;
      if (typeof pendingTaskId === 'string') {
        base.fixTaskId = pendingTaskId;
      }
    }
  }

  const childFixAttempts = state.reviewer_fix_attempts;
  if (Array.isArray(childFixAttempts)) {
    base.reviewerFixAttempts = childFixAttempts;
  }

  if (secondReview !== undefined) {
    base.fixAttempted = true;
    base.fixCommitSha =
      typeof secondReview.fixCommitSha === 'string'
        ? secondReview.fixCommitSha
        : undefined;
    const fixTaskId = secondReview.fixTaskId;
    if (typeof fixTaskId === 'string') {
      base.fixTaskId = fixTaskId;
    }

    const checkSummary = secondReview.checkSummary;
    if (
      checkSummary !== null &&
      typeof checkSummary === 'object' &&
      !Array.isArray(checkSummary)
    ) {
      base.fixCheckSummary = checkSummary as ReviewerEvidence['checkSummary'];
    }

    const secondGate = secondReview.reviewerGate as Record<string, unknown> | undefined;
    base.secondReviewerGateStatus = getGateStatus(secondGate);
    base.secondReviewerSummary = getGateSummary(secondGate);

    const finalStatus = secondReview.finalStatus;
    if (finalStatus === 'accepted') {
      base.status = 'fixed_and_accepted';
      base.finalStatus = 'accepted';
      base.nextAction = 'continue';
      base.checksResult = 'pass';
      base.reason = redactSecrets(
        typeof secondReview.reason === 'string'
          ? secondReview.reason
          : 'Fix commit accepted by second reviewer gate.'
      );
      return base;
    }
    if (finalStatus === 'fix_required') {
      base.status = 'fix_required';
      base.finalStatus = 'fix_required';
      base.nextAction = 'manual_followup';
      base.checksResult = 'pass';
      base.reason = redactSecrets(
        typeof secondReview.reason === 'string'
          ? secondReview.reason
          : 'Second reviewer gate requested further fixes; max attempts reached.'
      );
      return base;
    }
    base.status = 'blocked';
    base.finalStatus = 'blocked';
    base.nextAction = 'block';
    base.checksResult = 'pass';
    base.reason = redactSecrets(
      typeof secondReview.reason === 'string'
        ? secondReview.reason
        : 'Second reviewer gate blocked the fix commit.'
    );
    return base;
  }

  const persistedFixCheckSummary = state.fix_check_summary as Record<string, unknown> | undefined;
  if (
    persistedFixCheckSummary !== undefined &&
    typeof persistedFixCheckSummary === 'object' &&
    !Array.isArray(persistedFixCheckSummary)
  ) {
    base.fixCheckSummary = persistedFixCheckSummary as ReviewerEvidence['checkSummary'];
  }

  // A child task that reached a reviewer gate but was ultimately blocked (e.g.
  // max fix attempts reached, guardrails blocked a fix, or no fix loop configured)
  // reports state.status === 'blocked' while reviewer_gate may still be
  // 'fix_required'. Respect the terminal child status.
  if (runStatus === 'blocked') {
    base.status = 'blocked';
    base.finalStatus = 'blocked';
    base.nextAction = 'block';
    base.checksResult = 'pass';
    base.fixAttempted = reviewerGate?.status === 'fix_required';
    base.reason = redactSecrets(
      typeof state.safety_note === 'string'
        ? state.safety_note
        : (getGateSummary(reviewerGate) ?? 'Task blocked during review.')
    );
    return base;
  }

  if (reviewerGate !== undefined) {
    const status = reviewerGate.status;
    if (status === 'accepted') {
      const isFixed = state.fixed_and_accepted === true;
      base.status = isFixed ? 'fixed_and_accepted' : 'accepted';
      base.finalStatus = 'accepted';
      base.nextAction = 'continue';
      base.checksResult = 'pass';
      base.reason = getGateSummary(reviewerGate) ?? 'Reviewer gate accepted.';
      if (isFixed) {
        base.fixAttempted = true;
        base.fixCommitSha = commitSha;
      }
      return base;
    }

    if (status === 'fix_required') {
      base.fixAttempted = controlledRun !== undefined;
      base.checksResult = 'pass';
      if (controlledRun === undefined) {
        base.status = 'fix_required';
        base.finalStatus = 'fix_required';
        base.nextAction = 'manual_followup';
        base.reason = redactSecrets(
          'Reviewer gate requested fixes but fix execution was not configured for this task.'
        );
        return base;
      }
      const runnerStatus = controlledRun.runnerResultStatus;
      if (runnerStatus === 'blocked') {
        base.status = 'blocked';
        base.finalStatus = 'blocked';
        base.nextAction = 'block';
        base.reason = redactSecrets(
          'Fix execution was blocked by guardrails or safety checks.'
        );
        return base;
      }
      if (runnerStatus === 'executed') {
        base.status = 'fix_required';
        base.finalStatus = 'fix_required';
        base.nextAction = 'manual_followup';
        base.reason = redactSecrets(
          'Fix execution completed but second review was not available.'
        );
        return base;
      }
      base.status = 'failed';
      base.finalStatus = 'failed';
      base.nextAction = 'block';
      base.reason = redactSecrets(
        `Unexpected fix runner status: ${String(runnerStatus)}`
      );
      return base;
    }

    base.status = 'blocked';
    base.finalStatus = 'blocked';
    base.nextAction = 'block';
    base.checksResult = 'pass';
    base.reason = getGateSummary(reviewerGate) ?? 'Reviewer gate blocked.';
    return base;
  }

  // Default fallback: handle terminal state.status values that were not already
  // processed above.
  if (runStatus === 'failed_guardrails') {
    base.status = 'failed';
    base.finalStatus = 'failed';
    base.nextAction = 'block';
    base.checksResult = 'fail';
    const safetyNote = typeof state.safety_note === 'string' ? state.safety_note : undefined;
    base.reason = redactSecrets(safetyNote ?? 'Guardrails rejected provider output');
    return base;
  }

  if (runStatus === 'blocked') {
    base.status = 'blocked';
    base.finalStatus = 'blocked';
    base.nextAction = 'block';
    base.codeApplied = typeof commitSha === 'string' && commitSha.length === 40;
    base.pushed = false;
    base.checksResult = 'blocked';

    const safetyReasons = state.safety_policy_reasons;
    const safetyNote =
      typeof state.safety_note === 'string' ? state.safety_note : undefined;
    const blockedBy =
      typeof state.blocked_by === 'string' ? state.blocked_by : 'policy';

    let reason: string;
    if (Array.isArray(safetyReasons) && safetyReasons.length > 0) {
      reason = `${blockedBy}: ${safetyReasons.join('; ')}`;
    } else if (safetyNote) {
      reason = safetyNote;
    } else {
      reason = 'Task was blocked before apply.';
    }
    base.reason = redactSecrets(reason);
    return base;
  }

  if (runStatus === 'pushed' && run.exitCode === 0) {
    const phase = state.task_phase as TaskRunPhase | undefined;
    // A pushed commit is only final acceptance when the child has reached the
    // accepted phase, when there is no persisted phase information (legacy
    // state), or when no reviewer gate was configured at all.
    const isAcceptedPhase = phase === 'accepted' || phase === undefined || phase === null;
    const hasReviewerGate = reviewerGate !== undefined;
    const noReviewerFinalPush = !hasReviewerGate && phase === 'pushed';
    if (isAcceptedPhase || noReviewerFinalPush) {
      base.status = 'accepted';
      base.finalStatus = 'accepted';
      base.nextAction = 'continue';
      base.checksResult = 'pass';
      base.reason = 'Task pushed without reviewer gate.';
      return base;
    }
  }

  base.checksResult = run.exitCode === 0 ? 'pass' : 'fail';

  if (run.timedOut) {
    const timeoutMs = typeof state.timeout_ms === 'number' ? state.timeout_ms : 0;
    const totalElapsedMs =
      typeof state.total_elapsed_ms === 'number' ? state.total_elapsed_ms : 0;
    const continuationCount =
      typeof state.continuation_count === 'number' ? state.continuation_count : 0;
    base.timeoutEvidence = {
      totalElapsedMs,
      timeoutMs,
      continuationCount,
    };
    base.reason = redactSecrets(
      `Task timed out after ${totalElapsedMs}ms (timeout_ms=${timeoutMs}, continuation_count=${continuationCount}).`
    );
    return base;
  }

  base.reason = redactSecrets(
    `Task ended with status ${String(runStatus)} and exit code ${run.exitCode}.`
  );
  return base;
}

function printBlockRunSummary(state: RealBlockRunState): void {
  const lines: string[] = [];
  lines.push(`[real-block-run-ai] Block: ${state.block_id}`);
  lines.push(`[real-block-run-ai] Status: ${state.status}`);
  lines.push(`[real-block-run-ai] State path: ${state.statePath}`);
  const skipped = state.summary.skippedBlockedTasks ?? 0;
  lines.push(
    `[real-block-run-ai] Summary: total=${state.summary.totalTasks} completed=${state.summary.completedTasks} accepted=${state.summary.acceptedTasks} fixed=${state.summary.fixedTasks} skippedBlocked=${skipped}`
  );

  if (state.summary.stoppedReason) {
    lines.push(`[real-block-run-ai] Stopped reason: ${redactSecrets(state.summary.stoppedReason)}`);
  }

  lines.push('[real-block-run-ai] Task results:');
  for (const task of state.taskResults) {
    const parts: string[] = [
      `  ${task.taskId}: ${task.status}`,
      `final=${task.finalStatus}`,
      `next=${task.nextAction}`,
      `applied=${task.codeApplied ?? false}`,
      `pushed=${task.pushed ?? false}`,
      `checks=${task.checksResult ?? 'unknown'}`,
    ];
    if (task.originalCommitSha) {
      parts.push(`original=${task.originalCommitSha}`);
    }
    if (task.fixCommitSha) {
      parts.push(`fix=${task.fixCommitSha}`);
    }
    if (task.parseAttempts !== undefined) {
      parts.push(`parseAttempts=${task.parseAttempts}`);
    }
    if (task.fixAttempted) {
      parts.push(`fixAttempted=true`);
    }
    if (task.reviewerGateStatus) {
      parts.push(`reviewer=${task.reviewerGateStatus}`);
    }
    if (task.providerAttempts && task.providerAttempts.length > 0) {
      const failed = task.providerAttempts.filter((a) => !a.ok).length;
      parts.push(`providerAttempts=${task.providerAttempts.length}`);
      if (failed > 0) {
        parts.push(`providerFailures=${failed}`);
      }
    }
    lines.push(`[real-block-run-ai] ${parts.join(' ')}`);
  }

  console.log(lines.join('\n'));
}

export async function runRealBlockRunAI(
  blockPath: string,
  options?: { resume?: boolean; pauseAfterTaskId?: string; fresh?: boolean }
): Promise<{ exitCode: number; blockState: RealBlockRunState | null }> {
  const resume = (options?.resume ?? false) || process.env.REAL_BLOCK_RUN_RESUME === '1';
  const pauseAfterTaskId =
    options?.pauseAfterTaskId ?? process.env.REAL_BLOCK_RUN_PAUSE_AFTER_TASK_ID;
  const fresh = options?.fresh ?? false;

  if (fresh && resume) {
    console.error('[real-block-run-ai] Error: --fresh and --resume cannot be used together');
    console.error('[real-block-run-ai] No provider call was made');
    console.error('[real-block-run-ai] No apply was performed');
    console.error('[real-block-run-ai] No commit was made');
    console.error('[real-block-run-ai] No push was performed');
    console.error('[real-block-run-ai] No merge was performed');
    console.error('[real-block-run-ai] No checkout was performed');
    console.error('[real-block-run-ai] No main touch was performed');
    return { exitCode: 1, blockState: null };
  }

  if (fresh) {
    const block = loadBlockDefinition(blockPath);
    const removed = prepareFreshBlockRun(block, getRunsDir());
    console.error('[real-block-run-ai] Fresh mode: removed stale state');
    console.error(`[real-block-run-ai]   block state: ${removed.blockStatePath}`);
    for (const path of removed.taskStatePaths) {
      console.error(`[real-block-run-ai]   task state: ${path}`);
    }
  }

  const readiness = checkRealBlockRunReadiness(blockPath, { resume: resume && !fresh });

  if (!readiness.ready) {
    console.log(redactSecrets(JSON.stringify(readiness, null, 2)));
    console.error('[real-block-run-ai] Readiness check failed');
    console.error('[real-block-run-ai] No provider call was made');
    console.error('[real-block-run-ai] No apply was performed');
    console.error('[real-block-run-ai] No commit was made');
    console.error('[real-block-run-ai] No push was performed');
    console.error('[real-block-run-ai] No merge was performed');
    console.error('[real-block-run-ai] No checkout was performed');
    console.error('[real-block-run-ai] No main touch was performed');
    return { exitCode: 1, blockState: null };
  }

  if (readiness.mode === 'completed_noop') {
    const block = loadBlockDefinition(blockPath);
    const existingState = loadExistingBlockState(block);
    if (existingState !== null) {
      console.error('[real-block-run-ai] Resume mode: block already completed.');
      printBlockRunSummary(existingState);
      return { exitCode: 0, blockState: existingState };
    }
  }

  const block = loadBlockDefinition(blockPath);

  const gitHealth = runGitHealthPreflight({
    repoPath: block.repo_path,
    workBranch: block.work_branch,
    baseBranch: block.base_branch,
  });
  if (!gitHealth.ok) {
    console.error(`[real-block-run-ai] ${formatGitHealthPreflightError(gitHealth.issues)}`);
    console.error('[real-block-run-ai] No provider call was made');
    console.error('[real-block-run-ai] No apply was performed');
    console.error('[real-block-run-ai] No commit was made');
    console.error('[real-block-run-ai] No push was performed');
    console.error('[real-block-run-ai] No merge was performed');
    console.error('[real-block-run-ai] No checkout was performed');
    console.error('[real-block-run-ai] No main touch was performed');
    return { exitCode: 1, blockState: null };
  }

  if (pauseAfterTaskId !== undefined && pauseAfterTaskId.trim() !== '') {
    const found = block.tasks.some((t) => t.task_id === pauseAfterTaskId);
    if (!found) {
      const safeTaskId = redactSecrets(pauseAfterTaskId);
      console.error(
        `[real-block-run-ai] Error: pause-after-task target "${safeTaskId}" not found in block definition`
      );
      console.error('[real-block-run-ai] No provider call was made');
      console.error('[real-block-run-ai] No apply was performed');
      console.error('[real-block-run-ai] No commit was made');
      console.error('[real-block-run-ai] No push was performed');
      console.error('[real-block-run-ai] No merge was performed');
      return { exitCode: 1, blockState: null };
    }
  }

  const arrays = loadFakeResponseArrays(block);
  validateFakeResponseArrays(block, arrays);

  const existingState = loadExistingBlockState(block);

  if (existingState !== null && !resume) {
    if (existingState.status === 'completed' || existingState.status === 'completed_with_caveats') {
      throw new Error(
        `Block run already completed. State: ${existingState.statePath}`
      );
    }
    throw new Error(
      `Block run already exists with status ${existingState.status}. Enable resume mode (REAL_BLOCK_RUN_RESUME=1) to continue. State: ${existingState.statePath}`
    );
  }

  const lockPath = join(getBlockRunDir(block), 'run.lock');
  try {
    acquireRunLock(lockPath, {
      pid: process.pid,
      command: 'real-block-run-ai',
      blockId: block.block_id,
      createdAt: new Date().toISOString(),
    });
  } catch (err) {
    const message =
      err instanceof RunLockError
        ? formatRunLockError(err.lockPath, err.metadata)
        : err instanceof Error
        ? err.message
        : String(err);
    console.error(`[real-block-run-ai] ${redactSecrets(message)}`);
    console.error('[real-block-run-ai] No provider call was made');
    console.error('[real-block-run-ai] No apply was performed');
    console.error('[real-block-run-ai] No commit was made');
    console.error('[real-block-run-ai] No push was performed');
    console.error('[real-block-run-ai] No merge was performed');
    return { exitCode: 1, blockState: null };
  }

  try {
    const now = new Date().toISOString();
    const blockRunDir = getBlockRunDir(block);
  if (!existsSync(blockRunDir)) {
    mkdirSync(blockRunDir, { recursive: true });
  }

  let blockState: RealBlockRunState;
  const skippedTaskIds: string[] = [];

  if (existingState !== null && resume) {
    if (existingState.status === 'completed' || existingState.status === 'completed_with_caveats') {
      console.error('[real-block-run-ai] Resume mode: block already completed.');
      printBlockRunSummary(existingState);
      return { exitCode: 0, blockState: existingState };
    }

    blockState = {
      ...existingState,
      currentTaskId: null,
      resumed: true,
      resumeStartedAt: now,
    };

    for (const result of blockState.taskResults) {
      if (isCompletedTaskStatus(result.status)) {
        skippedTaskIds.push(result.taskId);
      } else if (isSkippedBlockedTaskStatus(result.status)) {
        // Intentionally skipped tasks (e.g. descendants of failed tasks) are not re-run.
        skippedTaskIds.push(result.taskId);
      }
    }

    const nextTask = block.tasks.find(
      (t) => !skippedTaskIds.includes(t.task_id)
    );
    console.error('[real-block-run-ai] Resume mode enabled');
    console.error(
      `[real-block-run-ai] Skipped tasks: ${skippedTaskIds.join(', ') || 'none'}`
    );
    console.error(`[real-block-run-ai] Next task: ${nextTask?.task_id ?? 'none'}`);
  } else {
    blockState = {
      block_id: block.block_id,
      title: block.title,
      status: 'blocked',
      currentTaskId: null,
      statePath: getBlockStatePath(block),
      taskResults: [],
      summary: {
        totalTasks: block.tasks.length,
        acceptedTasks: 0,
        fixedTasks: 0,
        completedTasks: 0,
        skippedBlockedTasks: 0,
      },
      startedAt: now,
      safetyNote:
        'This command does not merge, push to main, or modify the base branch. Each task runs on the configured work_branch.',
    };
  }

  let stopped = false;

  for (let i = 0; i < block.tasks.length; i++) {
    const task = block.tasks[i];
    const existingResultIndex = blockState.taskResults.findIndex(
      (r) => r.taskId === task.task_id
    );
    const existingResult =
      existingResultIndex >= 0 ? blockState.taskResults[existingResultIndex] : undefined;

    if (existingResult !== undefined) {
      const canSkip =
        isCompletedTaskStatus(existingResult.status) ||
        isSkippedBlockedTaskStatus(existingResult.status);
      if (canSkip) {
        const history = verifyTaskResultHistory(existingResult, block.repo_path);
        if (!history.ok) {
          return blockResumeFailure(block, blockState, task.task_id, history.reason || 'stale completed task state');
        }
        continue;
      }
    }

    blockState.currentTaskId = task.task_id;
    saveBlockState(block, blockState);

    // Dependency-aware execution: skip tasks whose required ancestors failed,
    // were blocked, or were skipped because an ancestor failed.
    const blockingDeps = (task.depends_on ?? []).filter((depId) => {
      const depResult = blockState.taskResults.find((r) => r.taskId === depId);
      if (depResult === undefined) {
        // An unresolved dependency (missing or out-of-order) must block the task.
        return true;
      }
      return isBlockingStatus(depResult.status) || isSkippedBlockedTaskStatus(depResult.status);
    });
    if (blockingDeps.length > 0) {
      const skippedResult: RealBlockRunTaskResult = {
        taskId: task.task_id,
        title: task.title,
        status: 'blocked_skipped',
        finalStatus: 'blocked_skipped',
        nextAction: 'continue',
        reason: redactSecrets(
          `Skipped because dependency task(s) failed or were blocked: ${blockingDeps.join(', ')}`
        ),
        fixAttempted: false,
        childStateTaskId: task.task_id,
        codeApplied: false,
        pushed: false,
        checksResult: 'unknown',
      };
      if (existingResultIndex >= 0) {
        blockState.taskResults[existingResultIndex] = skippedResult;
      } else {
        blockState.taskResults.push(skippedResult);
      }
      saveBlockState(block, blockState);
      continue;
    }

    // Build read-only dependency evidence from accepted ancestor tasks so that
    // reviewers and fix coders can verify consistency without broadening the
    // current task's write scope.
    try {
      task.dependency_evidence = buildDependencyEvidence({
        repoPath: block.repo_path,
        currentTaskId: task.task_id,
        tasks: block.tasks.map((t) => ({
          id: t.task_id,
          depends_on: t.depends_on,
          allowed_files: t.allowed_files,
        })),
        taskStates: blockState.taskResults.map((r) => ({
          task_id: r.taskId,
          status: r.status,
          commit_sha: r.originalCommitSha,
          fix_commit_sha: r.fixCommitSha,
        })),
      });
    } catch (depErr) {
      const reason = depErr instanceof Error ? depErr.message : String(depErr);
      const blockedResult: RealBlockRunTaskResult = {
        taskId: task.task_id,
        title: task.title,
        status: 'blocked',
        finalStatus: 'blocked',
        nextAction: 'block',
        reason: redactSecrets(reason),
        fixAttempted: false,
        childStateTaskId: task.task_id,
        codeApplied: false,
        pushed: false,
        checksResult: 'unknown',
      };
      if (existingResultIndex >= 0) {
        blockState.taskResults[existingResultIndex] = blockedResult;
      } else {
        blockState.taskResults.push(blockedResult);
      }
      saveBlockState(block, blockState);
      stopped = true;
      blockState.status = 'blocked';
      blockState.summary.blockedTaskId = task.task_id;
      break;
    }

    let taskResult: RealBlockRunTaskResult;
    const childLoad = resume ? loadChildState(task.task_id, getRunsDir()) : { kind: 'missing' as const };

    if (childLoad.kind === 'corrupted') {
      return blockResumeFailure(
        block,
        blockState,
        task.task_id,
        `Corrupted child state for task ${task.task_id}: ${childLoad.error}. Cannot resume safely.`
      );
    }

    if (childLoad.kind === 'loaded') {
      const validation = validateChildState(task, block, childLoad.state);
      if (!validation.valid) {
        return blockResumeFailure(block, blockState, task.task_id, validation.reason);
      }

      const derived = deriveTaskResult(task, { exitCode: 0, state: validation.state });
      if (isCompletedTaskStatus(derived.status)) {
        const shaError = validateCompletedChildResult(derived, block.repo_path);
        if (shaError) {
          return blockResumeFailure(block, blockState, task.task_id, shaError);
        }
        taskResult = derived;
      } else {
        const run = executeTaskWithContinuations(
          block,
          task,
          i,
          arrays,
          resolveTaskTimeoutMs(block),
          true
        );
        taskResult = deriveTaskResult(task, run);
      }
    } else {
      const run = executeTaskWithContinuations(
        block,
        task,
        i,
        arrays,
        resolveTaskTimeoutMs(block),
        false
      );
      taskResult = deriveTaskResult(task, run);
    }

    if (existingResultIndex >= 0) {
      blockState.taskResults[existingResultIndex] = taskResult;
    } else {
      blockState.taskResults.push(taskResult);
    }

    if (
      taskResult.status !== 'accepted' &&
      taskResult.status !== 'fixed_and_accepted'
    ) {
      const hasDependencies = block.tasks.some(
        (t) => (t.depends_on ?? []).length > 0
      );
      if (hasDependencies) {
        // Dependency-aware mode: a failed/blocked task stops only its descendants.
        // The current task keeps its actual status and the loop continues with unrelated tasks.
        saveBlockState(block, blockState);
        continue;
      }

      const onBlockedTask = resolveOnBlockedTask(block);
      const shouldContinue =
        onBlockedTask === 'continue' &&
        (taskResult.status === 'blocked' || taskResult.status === 'fix_required');

      if (shouldContinue) {
        // Mark the task as skipped-blocked so resume does not re-run it,
        // but keep the original derived status fields for reporting.
        const skippedResult: RealBlockRunTaskResult = {
          ...taskResult,
          status: 'blocked_skipped',
          finalStatus: taskResult.status,
          nextAction: 'continue',
          reason: redactSecrets(
            taskResult.reason ?? `Task ${task.task_id} blocked; continuing per on_blocked_task policy.`
          ),
        };
        const skipResultIndex = blockState.taskResults.findIndex(
          (r) => r.taskId === task.task_id
        );
        if (skipResultIndex >= 0) {
          blockState.taskResults[skipResultIndex] = skippedResult;
        } else {
          blockState.taskResults.push(skippedResult);
        }
        saveBlockState(block, blockState);
        continue;
      }

      stopped = true;
      if (taskResult.status === 'failed') {
        blockState.status = 'failed';
        blockState.summary.failedTaskId = task.task_id;
      } else {
        blockState.status = 'blocked';
        blockState.summary.blockedTaskId = task.task_id;
      }
      saveBlockState(block, blockState);
      break;
    }

    saveBlockState(block, blockState);

    if (pauseAfterTaskId === task.task_id) {
      const acceptedCount = blockState.taskResults.filter(
        (r) => r.status === 'accepted'
      ).length;
      const fixedCount = blockState.taskResults.filter(
        (r) => r.status === 'fixed_and_accepted'
      ).length;
      const skippedBlockedCount = blockState.taskResults.filter(
        (r) => r.status === 'blocked_skipped'
      ).length;

      blockState.currentTaskId = null;
      blockState.finishedAt = new Date().toISOString();
      blockState.summary.acceptedTasks = acceptedCount;
      blockState.summary.fixedTasks = fixedCount;
      blockState.summary.skippedBlockedTasks = skippedBlockedCount;
      blockState.summary.completedTasks = acceptedCount + fixedCount + skippedBlockedCount;
      blockState.status = 'paused';
      const resumeCommand = `npx tsx src/cli.ts real-block-run-ai ${blockPath} --resume`;
      blockState.summary.stoppedReason = `Paused after task ${task.task_id}. Resume with: ${resumeCommand}`;
      saveBlockState(block, blockState);
      printBlockRunSummary(blockState);
      console.error(`[real-block-run-ai] Paused after task ${task.task_id}`);
      console.error(`[real-block-run-ai] Resume with: ${resumeCommand}`);
      console.error('[real-block-run-ai] No provider call was made for remaining tasks');
      console.error('[real-block-run-ai] No apply was performed for remaining tasks');
      console.error('[real-block-run-ai] No commit was made for remaining tasks');
      console.error('[real-block-run-ai] No push was performed for remaining tasks');
      console.error('[real-block-run-ai] No merge was performed for remaining tasks');
      return { exitCode: 0, blockState };
    }
  }

  const acceptedCount = blockState.taskResults.filter(
    (r) => r.status === 'accepted'
  ).length;
  const fixedCount = blockState.taskResults.filter(
    (r) => r.status === 'fixed_and_accepted'
  ).length;
  const skippedBlockedCount = blockState.taskResults.filter(
    (r) => r.status === 'blocked_skipped'
  ).length;

  blockState.currentTaskId = null;
  blockState.finishedAt = new Date().toISOString();
  blockState.summary.acceptedTasks = acceptedCount;
  blockState.summary.fixedTasks = fixedCount;
  blockState.summary.skippedBlockedTasks = skippedBlockedCount;
  blockState.summary.completedTasks = acceptedCount + fixedCount + skippedBlockedCount;

  const hasBlockingTasks = blockState.taskResults.some((r) => isBlockingStatus(r.status));
  const allTasksProcessed = blockState.taskResults.length === block.tasks.length;

  if (!stopped && allTasksProcessed && !hasBlockingTasks) {
    blockState.status = skippedBlockedCount > 0 ? 'completed_with_caveats' : 'completed';
    blockState.summary.stoppedReason = skippedBlockedCount > 0
      ? `All tasks finished; ${skippedBlockedCount} task(s) blocked/skipped.`
      : 'All tasks completed.';
  } else if (!stopped && allTasksProcessed && hasBlockingTasks) {
    // Dependency-aware mode: some tasks failed/blocked but unrelated tasks continued.
    // A block with any failed/blocked task is a failed block; it must not be promoted to a PR.
    blockState.status = 'failed';
    const blockingCount = blockState.taskResults.filter((r) => isBlockingStatus(r.status)).length;
    blockState.summary.stoppedReason = `All tasks processed; ${blockingCount} task(s) failed/blocked and ${skippedBlockedCount} dependent task(s) skipped.`;
  } else {
    const lastResult = blockState.taskResults[blockState.taskResults.length - 1];
    const stopReason = lastResult?.reason ?? 'Block stopped.';
    const stopTaskId = lastResult?.taskId ?? 'unknown';
    blockState.summary.stoppedReason = `Task ${stopTaskId} ${blockState.status}: ${stopReason}`;
  }
  saveBlockState(block, blockState);

  printBlockRunSummary(blockState);

  return { exitCode: blockState.status === 'completed' ? 0 : 1, blockState };
  } finally {
    releaseRunLock(lockPath);
  }
}
