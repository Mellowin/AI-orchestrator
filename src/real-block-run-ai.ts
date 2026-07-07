import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadBlockDefinition } from './block/block-loader.js';
import type { BlockDefinition, BlockTaskDefinition } from './block/block-types.js';
import {
  prepareFreshBlockRun,
  verifyTaskResultHistory,
} from './block/block-state-consistency.js';

import { redactSecrets } from './sandbox-preflight-repair.js';
import { checkRealBlockRunReadiness } from './real-block-run-ai-readiness.js';
import {
  resolveTaskTimeoutMs,
  resolveReviewerParseRetries,
  resolveOnBlockedTask,
} from './real-block-task-timeout.js';
import type { ReviewerEvidence } from './reviewer-evidence.js';
import type { ProviderAttempt } from './types.js';
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
} from './run-lock.js';
import { writeJsonAtomic } from './state-atomic-write.js';
import { runGitHealthPreflight, formatGitHealthPreflightError } from './git-health-preflight.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '..');

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

function buildSingleTaskYaml(block: BlockDefinition, task: BlockTaskDefinition): string {
  const taskObject = {
    tasks: [
      {
        id: task.task_id,
        title: task.title,
        repo_path: resolve(block.repo_path).replace(/\\/g, '/'),
        base_branch: block.base_branch,
        work_branch: block.work_branch,
        goal: task.goal,
        context_files: task.allowed_files.filter((file) => existsSync(resolve(block.repo_path, file))),
        checks:
          task.checks.length > 0
            ? task.checks.map((line) => {
                const parts = line.trim().split(/\s+/);
                return { command: parts[0], args: parts.slice(1) };
              })
            : [{ command: 'node', args: ['-e', 'process.exit(0)'] }],
        guardrails: {
          allow_modify: task.allowed_files,
          deny_modify: task.denied_files.length > 0 ? task.denied_files : ['.env', '.env.*', 'node_modules/**'],
          max_lines_changed: task.max_lines_changed,
          require_tests: false,
          auto_commit: false,
          auto_push: false,
          auto_merge: false,
        },
      },
    ],
  };
  return JSON.stringify(taskObject, null, 2);
}

function saveBlockState(block: BlockDefinition, state: RealBlockRunState): void {
  const dir = getBlockRunDir(block);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
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

function runSingleTask(
  block: BlockDefinition,
  task: BlockTaskDefinition,
  index: number,
  arrays: FakeResponseArrays,
  timeoutMs: number
): { exitCode: number; state: Record<string, unknown> | null } {
  const runsDir = getRunsDir();
  const blockRunDir = getBlockRunDir(block);
  const childRunsDir = getChildRunsDir(runsDir);

  // Child real-repo-run-ai writes state to runs/tasks/<task_id>/state.json.
  // If a previous block used the same task_id, stale state would be reused.
  // Clean the per-task run directory under the child namespace before each
  // task so every block run is fresh without touching runs/block/**.
  const staleTaskRunDir = join(childRunsDir, task.task_id);
  if (existsSync(staleTaskRunDir)) {
    rmSync(staleTaskRunDir, { recursive: true, force: true });
  }

  const tasksFilePath = join(blockRunDir, `${task.task_id}.tasks.yaml`);
  writeFileSync(tasksFilePath, buildSingleTaskYaml(block, task), 'utf-8');

  const env = buildBaseChildEnv();
  env.TASKS_FILE = tasksFilePath;
  env.RUNS_DIR = childRunsDir;
  env.REAL_REPO_ENABLE_REVIEWER_FIX_LOOP = '1';

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
  if (typeof fixKimiResponse === 'string') {
    env.REAL_REPO_REVIEWER_FIX_TASK_KIMI_FAKE_RESPONSE = fixKimiResponse;
  }

  const secondReviewerResponse = getTaskFakeResponse(arrays, 'secondReviewer', index);
  if (typeof secondReviewerResponse === 'string') {
    env.REAL_REPO_REVIEWER_SECOND_FAKE_RESPONSE = secondReviewerResponse;
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
    }
  );

  if (result.status !== 0) {
    const output = (result.stderr || result.stdout || '').trim();
    console.error(`[real-block-run-ai] Task ${task.task_id} runner exited with code ${result.status}`);
    if (output) {
      console.error(`[real-block-run-ai] Task ${task.task_id} runner output:`);
      console.error(redactSecrets(output));
    }
  }

  const childLoad = loadChildState(task.task_id, runsDir);
  const state = childLoad.kind === 'loaded' ? childLoad.state : null;
  return { exitCode: result.status ?? 1, state };
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

function deriveTaskResult(
  task: BlockTaskDefinition,
  run: { exitCode: number; state: Record<string, unknown> | null }
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

  if (reviewerGate !== undefined) {
    const status = reviewerGate.status;
    if (status === 'accepted') {
      base.status = 'accepted';
      base.finalStatus = 'accepted';
      base.nextAction = 'continue';
      base.checksResult = 'pass';
      base.reason = getGateSummary(reviewerGate) ?? 'Reviewer gate accepted.';
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

  const runStatus = state.status;
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
    base.status = 'accepted';
    base.finalStatus = 'accepted';
    base.nextAction = 'continue';
    base.checksResult = 'pass';
    base.reason = 'Task pushed without reviewer gate.';
    return base;
  }

  base.checksResult = run.exitCode === 0 ? 'pass' : 'fail';
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

    const onBlockedTask = resolveOnBlockedTask(block);
    for (const result of blockState.taskResults) {
      if (isCompletedTaskStatus(result.status)) {
        skippedTaskIds.push(result.taskId);
      } else if (isSkippedBlockedTaskStatus(result.status) && onBlockedTask === 'continue') {
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

    const onBlockedTask = resolveOnBlockedTask(block);

    if (existingResult !== undefined) {
      const canSkip =
        isCompletedTaskStatus(existingResult.status) ||
        (isSkippedBlockedTaskStatus(existingResult.status) && onBlockedTask === 'continue');
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

    let taskResult: RealBlockRunTaskResult;
    const hasStaleIncompleteResult =
      existingResult !== undefined && !isCompletedTaskStatus(existingResult.status);
    const childLoad =
      resume && !hasStaleIncompleteResult
        ? loadChildState(task.task_id, getRunsDir())
        : { kind: 'missing' as const };

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
      if (!isCompletedTaskStatus(derived.status)) {
        return blockResumeFailure(
          block,
          blockState,
          task.task_id,
          `Task ${task.task_id} has incomplete child state (${derived.status}); resume cannot continue safely.`
        );
      }

      const shaError = validateCompletedChildResult(derived, block.repo_path);
      if (shaError) {
        return blockResumeFailure(block, blockState, task.task_id, shaError);
      }

      taskResult = derived;
    } else {
      const run = runSingleTask(block, task, i, arrays, resolveTaskTimeoutMs(block));
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

  if (!stopped && blockState.summary.completedTasks === block.tasks.length) {
    blockState.status = skippedBlockedCount > 0 ? 'completed_with_caveats' : 'completed';
    blockState.summary.stoppedReason = skippedBlockedCount > 0
      ? `All tasks finished; ${skippedBlockedCount} task(s) blocked/skipped.`
      : 'All tasks completed.';
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
