import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadBlockDefinition } from './block/block-loader.js';
import type { BlockDefinition, BlockTaskDefinition } from './block/block-types.js';
import { config } from './config.js';
import { loadState } from './state-manager.js';
import { redactSecrets } from './sandbox-preflight-repair.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '..');

export interface RealBlockRunTaskResult {
  taskId: string;
  title: string;
  status: 'accepted' | 'fixed_and_accepted' | 'blocked' | 'fix_required' | 'failed';
  originalCommitSha?: string;
  fixCommitSha?: string;
  reason?: string;
}

export interface RealBlockRunSummary {
  totalTasks: number;
  acceptedTasks: number;
  fixedTasks: number;
  blockedTaskId?: string;
  failedTaskId?: string;
}

export interface RealBlockRunState {
  block_id: string;
  title: string;
  status: 'completed' | 'blocked' | 'failed';
  currentTaskId: string | null;
  taskResults: RealBlockRunTaskResult[];
  summary: RealBlockRunSummary;
  startedAt: string;
  finishedAt?: string;
  safetyNote: string;
}

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

function sanitizeBlockId(blockId: string): string {
  return blockId.replace(/[^a-zA-Z0-9_-]/g, '_');
}

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
        context_files: [],
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

function getRunsDir(): string {
  return resolve(process.env.RUNS_DIR ?? config.runsDir);
}

function getBlockRunDir(block: BlockDefinition): string {
  const runsDir = getRunsDir();
  return join(runsDir, 'block', sanitizeBlockId(block.block_id));
}

function getBlockStatePath(block: BlockDefinition): string {
  return join(getBlockRunDir(block), 'state.json');
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
  const command = `npx tsx "${cliPath.replace(/"/g, '\\"')}" real-repo-run-ai "${task.task_id.replace(/"/g, '\\"')}"`;
  const result = spawnSync(command, {
    cwd: projectRoot,
    env,
    encoding: 'utf-8',
    shell: true,
    timeout: 120000,
  });

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

function deriveTaskResult(
  task: BlockTaskDefinition,
  run: { exitCode: number; state: Record<string, unknown> | null }
): RealBlockRunTaskResult {
  const result: RealBlockRunTaskResult = {
    taskId: task.task_id,
    title: task.title,
    status: 'failed',
  };

  if (run.state === null) {
    result.reason = redactSecrets(
      run.exitCode === 0
        ? 'Task finished but no state was persisted.'
        : `Task runner exited with code ${run.exitCode} and no state was persisted.`
    );
    return result;
  }

  const state = run.state;
  result.originalCommitSha =
    typeof state.commit_sha === 'string' ? state.commit_sha : undefined;

  const secondReview = state.reviewer_fix_task_second_review as
    | Record<string, unknown>
    | undefined;
  if (secondReview !== undefined) {
    result.fixCommitSha =
      typeof secondReview.fixCommitSha === 'string'
        ? secondReview.fixCommitSha
        : undefined;
    const finalStatus = secondReview.finalStatus;
    if (finalStatus === 'accepted') {
      result.status = 'fixed_and_accepted';
      result.reason = redactSecrets(
        typeof secondReview.reason === 'string'
          ? secondReview.reason
          : 'Fix commit accepted by second reviewer gate.'
      );
      return result;
    }
    if (finalStatus === 'fix_required') {
      result.status = 'fix_required';
      result.reason = redactSecrets(
        typeof secondReview.reason === 'string'
          ? secondReview.reason
          : 'Second reviewer gate requested further fixes; max attempts reached.'
      );
      return result;
    }
    result.status = 'blocked';
    result.reason = redactSecrets(
      typeof secondReview.reason === 'string'
        ? secondReview.reason
        : 'Second reviewer gate blocked the fix commit.'
    );
    return result;
  }

  const reviewerGate = state.reviewer_gate as Record<string, unknown> | undefined;
  if (reviewerGate !== undefined) {
    const status = reviewerGate.status;
    if (status === 'accepted') {
      result.status = 'accepted';
      result.reason = redactSecrets(
        typeof reviewerGate.reviewSummary === 'string'
          ? reviewerGate.reviewSummary
          : 'Reviewer gate accepted.'
      );
      return result;
    }

    const controlledRun = state.reviewer_fix_task_controlled_run as
      | Record<string, unknown>
      | undefined;

    if (status === 'fix_required') {
      if (controlledRun === undefined) {
        result.status = 'fix_required';
        result.reason = redactSecrets(
          'Reviewer gate requested fixes but fix execution was not configured for this task.'
        );
        return result;
      }
      const runnerStatus = controlledRun.runnerResultStatus;
      if (runnerStatus === 'blocked') {
        result.status = 'blocked';
        result.reason = redactSecrets(
          'Fix execution was blocked by guardrails or safety checks.'
        );
        return result;
      }
      if (runnerStatus === 'executed') {
        result.status = 'fix_required';
        result.reason = redactSecrets(
          'Fix execution completed but second review was not available.'
        );
        return result;
      }
      result.status = 'failed';
      result.reason = redactSecrets(
        `Unexpected fix runner status: ${String(runnerStatus)}`
      );
      return result;
    }

    result.status = 'blocked';
    result.reason = redactSecrets(
      typeof reviewerGate.reviewSummary === 'string'
        ? reviewerGate.reviewSummary
        : 'Reviewer gate blocked.'
    );
    return result;
  }

  const runStatus = state.status;
  if (runStatus === 'pushed' && run.exitCode === 0) {
    result.status = 'accepted';
    result.reason = 'Task pushed without reviewer gate.';
    return result;
  }

  result.reason = redactSecrets(
    `Task ended with status ${String(runStatus)} and exit code ${run.exitCode}.`
  );
  return result;
}

function assertRequiredEnv(name: string): void {
  const value = process.env[name];
  if (value !== 'true') {
    throw new Error(`${name}=true is required`);
  }
}

export async function runRealBlockRunAI(
  blockPath: string
): Promise<{ exitCode: number; blockState: RealBlockRunState }> {
  assertRequiredEnv('ALLOW_REAL_BLOCK_RUN_AI');
  assertRequiredEnv('ALLOW_REAL_PROVIDER');
  assertRequiredEnv('ALLOW_REAL_REPO_APPLY');
  assertRequiredEnv('ALLOW_REAL_REPO_COMMIT');
  assertRequiredEnv('ALLOW_REAL_REPO_PUSH');

  const apiKey = process.env.KIMI_API_KEY?.trim();
  if (!apiKey) {
    throw new Error('KIMI_API_KEY env var is required');
  }
  const baseUrl = process.env.KIMI_BASE_URL?.trim();
  if (!baseUrl) {
    throw new Error('KIMI_BASE_URL env var is required');
  }

  const block = loadBlockDefinition(blockPath);
  const repoPath = resolve(block.repo_path);
  if (!existsSync(repoPath)) {
    throw new Error(`Repository path does not exist: ${repoPath}`);
  }

  const arrays = loadFakeResponseArrays(block);
  validateFakeResponseArrays(block, arrays);

  const now = new Date().toISOString();
  const blockState: RealBlockRunState = {
    block_id: block.block_id,
    title: block.title,
    status: 'blocked',
    currentTaskId: null,
    taskResults: [],
    summary: {
      totalTasks: block.tasks.length,
      acceptedTasks: 0,
      fixedTasks: 0,
    },
    startedAt: now,
    safetyNote:
      'This command does not merge, push to main, or modify the base branch. Each task runs on the configured work_branch.',
  };

  const blockRunDir = getBlockRunDir(block);
  if (!existsSync(blockRunDir)) {
    mkdirSync(blockRunDir, { recursive: true });
  }

  let allComplete = true;

  for (let i = 0; i < block.tasks.length; i++) {
    const task = block.tasks[i];
    blockState.currentTaskId = task.task_id;
    saveBlockState(block, blockState);

    const run = runSingleTask(block, task, i, arrays);
    const taskResult = deriveTaskResult(task, run);
    blockState.taskResults.push(taskResult);

    if (taskResult.status === 'accepted') {
      blockState.summary.acceptedTasks += 1;
    } else if (taskResult.status === 'fixed_and_accepted') {
      blockState.summary.fixedTasks += 1;
    } else {
      allComplete = false;
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

  blockState.currentTaskId = null;
  blockState.finishedAt = new Date().toISOString();
  if (allComplete) {
    blockState.status = 'completed';
  }
  saveBlockState(block, blockState);

  return { exitCode: blockState.status === 'completed' ? 0 : 1, blockState };
}
