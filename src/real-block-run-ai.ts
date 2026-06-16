import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadBlockDefinition } from './block/block-loader.js';
import type { BlockDefinition, BlockTaskDefinition } from './block/block-types.js';
import { loadState } from './state-manager.js';
import { redactSecrets } from './sandbox-preflight-repair.js';
import { checkRealBlockRunReadiness } from './real-block-run-ai-readiness.js';
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
  loadExistingBlockState,
} from './real-block-run-ai-state.js';

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
  return parsed.map((item) =>
    item === undefined || item === null
      ? undefined
      : String(item)
  );
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
): string | undefined {
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
  const statePath = getBlockStatePath(block);
  const tmpPath = `${statePath}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(state, null, 2), 'utf-8');
  renameSync(tmpPath, statePath);
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

function runSingleTask(
  block: BlockDefinition,
  task: BlockTaskDefinition,
  index: number,
  arrays: FakeResponseArrays
): { exitCode: number; state: Record<string, unknown> | null } {
  const runsDir = getRunsDir();
  const blockRunDir = getBlockRunDir(block);
  const tasksFilePath = join(blockRunDir, `${task.task_id}.tasks.yaml`);
  writeFileSync(tasksFilePath, buildSingleTaskYaml(block, task), 'utf-8');

  const env = buildBaseChildEnv();
  env.TASKS_FILE = tasksFilePath;
  env.RUNS_DIR = runsDir;
  env.REAL_REPO_ENABLE_REVIEWER_FIX_LOOP = '1';

  const kimiResponse = getTaskFakeResponse(arrays, 'kimi', index);
  if (kimiResponse !== undefined) {
    env.KIMI_FAKE_RESPONSE = kimiResponse;
  }

  const reviewerResponse = getTaskFakeResponse(arrays, 'reviewer', index);
  if (reviewerResponse !== undefined) {
    env.REAL_REPO_REVIEWER_FAKE_RESPONSE = reviewerResponse;
  }

  const fixKimiResponse = getTaskFakeResponse(arrays, 'fixKimi', index);
  if (fixKimiResponse !== undefined) {
    env.REAL_REPO_REVIEWER_FIX_TASK_KIMI_FAKE_RESPONSE = fixKimiResponse;
  }

  const secondReviewerResponse = getTaskFakeResponse(arrays, 'secondReviewer', index);
  if (secondReviewerResponse !== undefined) {
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
      timeout: 120000,
    }
  );

  if (result.status !== 0) {
    const output = (result.stderr || result.stdout || '').trim();
    if (output) {
      console.error(`[real-block-run-ai] Task ${task.task_id} runner output:`);
      console.error(redactSecrets(output));
    }
  }

  const state = loadState(task.task_id, runsDir) as Record<string, unknown> | null;
  return { exitCode: result.status ?? 1, state };
}

function getStateString(
  state: Record<string, unknown>,
  key: string
): string | undefined {
  const value = state[key];
  return typeof value === 'string' ? value : undefined;
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
  base.originalCommitSha = getStateString(state, 'commit_sha');

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

    const secondGate = secondReview.reviewerGate as Record<string, unknown> | undefined;
    base.secondReviewerGateStatus = getGateStatus(secondGate);
    base.secondReviewerSummary = getGateSummary(secondGate);

    const finalStatus = secondReview.finalStatus;
    if (finalStatus === 'accepted') {
      base.status = 'fixed_and_accepted';
      base.finalStatus = 'accepted';
      base.nextAction = 'continue';
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
      base.reason = getGateSummary(reviewerGate) ?? 'Reviewer gate accepted.';
      return base;
    }

    if (status === 'fix_required') {
      base.fixAttempted = controlledRun !== undefined;
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
    base.reason = getGateSummary(reviewerGate) ?? 'Reviewer gate blocked.';
    return base;
  }

  const runStatus = state.status;
  if (runStatus === 'pushed' && run.exitCode === 0) {
    base.status = 'accepted';
    base.finalStatus = 'accepted';
    base.nextAction = 'continue';
    base.reason = 'Task pushed without reviewer gate.';
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
  lines.push(
    `[real-block-run-ai] Summary: total=${state.summary.totalTasks} completed=${state.summary.completedTasks} accepted=${state.summary.acceptedTasks} fixed=${state.summary.fixedTasks}`
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
    ];
    if (task.originalCommitSha) {
      parts.push(`original=${task.originalCommitSha}`);
    }
    if (task.fixCommitSha) {
      parts.push(`fix=${task.fixCommitSha}`);
    }
    if (task.fixAttempted) {
      parts.push(`fixAttempted=true`);
    }
    lines.push(`[real-block-run-ai] ${parts.join(' ')}`);
  }

  console.log(lines.join('\n'));
}

export async function runRealBlockRunAI(
  blockPath: string,
  options?: { resume?: boolean }
): Promise<{ exitCode: number; blockState: RealBlockRunState | null }> {
  const resume = (options?.resume ?? false) || process.env.REAL_BLOCK_RUN_RESUME === '1';
  const readiness = checkRealBlockRunReadiness(blockPath, { resume });

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
  const arrays = loadFakeResponseArrays(block);
  validateFakeResponseArrays(block, arrays);

  const existingState = loadExistingBlockState(block);

  if (existingState !== null && !resume) {
    if (existingState.status === 'completed') {
      throw new Error(
        `Block run already completed. State: ${existingState.statePath}`
      );
    }
    throw new Error(
      `Block run already exists with status ${existingState.status}. Enable resume mode (REAL_BLOCK_RUN_RESUME=1) to continue. State: ${existingState.statePath}`
    );
  }

  const now = new Date().toISOString();
  const blockRunDir = getBlockRunDir(block);
  if (!existsSync(blockRunDir)) {
    mkdirSync(blockRunDir, { recursive: true });
  }

  let blockState: RealBlockRunState;
  const skippedTaskIds: string[] = [];

  if (existingState !== null && resume) {
    if (existingState.status === 'completed') {
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

    if (existingResult !== undefined && isCompletedTaskStatus(existingResult.status)) {
      continue;
    }

    blockState.currentTaskId = task.task_id;
    saveBlockState(block, blockState);

    const run = runSingleTask(block, task, i, arrays);
    const taskResult = deriveTaskResult(task, run);

    if (existingResultIndex >= 0) {
      blockState.taskResults[existingResultIndex] = taskResult;
    } else {
      blockState.taskResults.push(taskResult);
    }

    if (
      taskResult.status !== 'accepted' &&
      taskResult.status !== 'fixed_and_accepted'
    ) {
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
  }

  const acceptedCount = blockState.taskResults.filter(
    (r) => r.status === 'accepted'
  ).length;
  const fixedCount = blockState.taskResults.filter(
    (r) => r.status === 'fixed_and_accepted'
  ).length;

  blockState.currentTaskId = null;
  blockState.finishedAt = new Date().toISOString();
  blockState.summary.acceptedTasks = acceptedCount;
  blockState.summary.fixedTasks = fixedCount;
  blockState.summary.completedTasks = acceptedCount + fixedCount;

  if (!stopped && blockState.summary.completedTasks === block.tasks.length) {
    blockState.status = 'completed';
    blockState.summary.stoppedReason = 'All tasks completed.';
  } else {
    const lastResult = blockState.taskResults[blockState.taskResults.length - 1];
    const stopReason = lastResult?.reason ?? 'Block stopped.';
    const stopTaskId = lastResult?.taskId ?? 'unknown';
    blockState.summary.stoppedReason = `Task ${stopTaskId} ${blockState.status}: ${stopReason}`;
  }
  saveBlockState(block, blockState);

  printBlockRunSummary(blockState);

  return { exitCode: blockState.status === 'completed' ? 0 : 1, blockState };
}
