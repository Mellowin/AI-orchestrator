import { describe, test } from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

let counter = 0;

function getCleanEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  const toDelete = [
    'AI_PROVIDER',
    'MOCK_AI_RESPONSE',
    'MOCK_REVIEWER_RESPONSE',
    'MOCK_PROVIDER_RESPONSE',
    'KIMI_API_KEY',
    'KIMI_MODEL',
    'KIMI_BASE_URL',
    'KIMI_USER_AGENT',
    'KIMI_FAKE_RESPONSE',
    'KIMI_FAKE_RESPONSES',
    'OPENAI_API_KEY',
    'MOCK_AI',
    'ALLOW_REAL_PROVIDER_RUN',
    'ALLOW_REAL_PROVIDER',
    'ALLOW_SANDBOX_APPLY_PREVIEW',
    'ALLOW_REAL_REPO_APPLY',
    'ALLOW_REAL_REPO_COMMIT',
    'ALLOW_REAL_REPO_PUSH',
    'ALLOW_REAL_BLOCK_RUN_AI',
    'SANDBOX_PROVIDER_RESPONSE',
    'SANDBOX_ROOT',
    'REAL_REPO_PROVIDER_RESPONSE',
    'RUNS_DIR',
    'REAL_REPO_AI_MAX_ATTEMPTS',
    'REAL_REPO_REVIEWER_FAKE_RESPONSE',
    'REAL_REPO_REVIEWER_CAPTURE_INPUT_FILE',
    'REAL_REPO_REVIEWER_FORCE_PROVIDER_ERROR',
    'REAL_REPO_REVIEWER_FIX_TASK_FAKE_EXECUTOR_RESPONSE',
    'REAL_REPO_ENABLE_REVIEWER_FIX_LOOP',
    'REAL_REPO_REVIEWER_MAX_FIX_ATTEMPTS',
    'REAL_REPO_REVIEWER_SECOND_FAKE_RESPONSE',
    'REAL_REPO_REVIEWER_FIX_TASK_KIMI_FAKE_RESPONSE',
    'REAL_REPO_REVIEWER_FIX_TASK_KIMI_FAKE_RESPONSES',
    'REAL_BLOCK_TASK_KIMI_FAKE_RESPONSES',
    'REAL_BLOCK_TASK_REVIEWER_FAKE_RESPONSES',
    'REAL_BLOCK_TASK_FIX_KIMI_FAKE_RESPONSES',
    'REAL_BLOCK_TASK_SECOND_REVIEWER_FAKE_RESPONSES',
    'REAL_BLOCK_RUN_RESUME',
    'REAL_BLOCK_TASK_TIMEOUT_MS',
    'REAL_REVIEWER_PARSE_RETRIES',
    'REAL_BLOCK_ON_BLOCKED_TASK',
  ];
  for (const name of toDelete) {
    delete env[name];
  }
  env.AI_PROVIDER = 'mock';
  return env;
}

function runCli(
  args: string[],
  envOverrides: Record<string, string> = {}
): {
  status: number;
  stdout: string;
  stderr: string;
} {
  const env = { ...getCleanEnv(), ...envOverrides };
  const overriddenKeys = new Set(Object.keys(envOverrides));
  const leakedKeyPattern = /^(REAL_REPO_|REAL_BLOCK_|KIMI_|MOCK_|ALLOW_|SANDBOX_|OPENAI_|TASKS_FILE|RUNS_DIR|NODE_TEST_CONTEXT)/;
  for (const key of Object.keys(env)) {
    if (!overriddenKeys.has(key) && leakedKeyPattern.test(key)) {
      delete env[key];
    }
  }
  const quotedArgs = args.map((arg) => `"${arg}"`).join(' ');
  const result = spawnSync(
    `npx tsx "${join(process.cwd(), 'src', 'cli.ts')}" ${quotedArgs}`,
    {
      cwd: process.cwd(),
      env,
      encoding: 'utf-8',
      shell: true,
      timeout: 30000,
    }
  );
  return {
    status: result.status ?? 1,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
  };
}

function buildFakeKimiOutput(
  files: Array<{ path: string; content: string }>,
  notes?: string
): string {
  return JSON.stringify({ mode: 'file_update', files, notes });
}

function buildAcceptReview(summary: string): string {
  return JSON.stringify({
    decision: 'accept',
    confidence: 'high',
    blockingIssues: [],
    nonBlockingIssues: [],
    reviewSummary: summary,
    nextAction: 'continue',
  });
}

function buildBlockReview(summary: string, blockingIssues: string[]): string {
  return JSON.stringify({
    decision: 'block_for_human',
    confidence: 'high',
    blockingIssues,
    nonBlockingIssues: [],
    reviewSummary: summary,
    nextAction: 'block',
  });
}

interface TempBlockEnv {
  blockId: string;
  blockPath: string;
  repoPath: string;
  originPath: string;
  runsDir: string;
  tmpDir: string;
  cleanup: () => void;
}

function createTempBlockEnv(policy: {
  onBlockedTask?: 'stop' | 'continue' | 'skip';
  taskTimeoutMs?: number;
} = {}): TempBlockEnv {
  const id = `${Date.now()}-${counter++}`;
  const blockId = `block-resume-${id}`;
  const tmpBase = join(process.cwd(), 'tmp');
  if (!existsSync(tmpBase)) {
    mkdirSync(tmpBase);
  }
  const tmpDir = mkdtempSync(join(tmpBase, `rbrai-resume-${id}-`));
  const repoPath = join(tmpDir, 'repo');
  const originPath = join(tmpDir, 'origin.git');
  const runsDir = join(tmpDir, 'runs');
  mkdirSync(repoPath);

  writeFileSync(join(repoPath, 'README.md'), '# hello\n', 'utf-8');

  spawnSync('git', ['init'], {
    cwd: repoPath,
    encoding: 'utf-8',
    shell: false,
  });
  spawnSync('git', ['config', 'user.email', 'ci@example.com'], {
    cwd: repoPath,
    encoding: 'utf-8',
    shell: false,
  });
  spawnSync('git', ['config', 'user.name', 'CI User'], {
    cwd: repoPath,
    encoding: 'utf-8',
    shell: false,
  });
  spawnSync('git', ['add', '.'], {
    cwd: repoPath,
    encoding: 'utf-8',
    shell: false,
  });
  spawnSync('git', ['commit', '-m', 'init', '--no-gpg-sign'], {
    cwd: repoPath,
    encoding: 'utf-8',
    shell: false,
  });
  spawnSync('git', ['branch', '-m', 'main'], {
    cwd: repoPath,
    encoding: 'utf-8',
    shell: false,
  });
  spawnSync('git', ['checkout', '-b', 'ai/block-work'], {
    cwd: repoPath,
    encoding: 'utf-8',
    shell: false,
  });

  spawnSync('git', ['init', '--bare', originPath], {
    encoding: 'utf-8',
    shell: false,
  });
  spawnSync('git', ['remote', 'add', 'origin', originPath], {
    cwd: repoPath,
    encoding: 'utf-8',
    shell: false,
  });

  const blockDefinition = {
    block_id: blockId,
    title: 'Real block run AI resume test',
    repo_path: repoPath.replace(/\\/g, '/'),
    base_branch: 'main',
    work_branch: 'ai/block-work',
    providers: {
      coder: { provider: 'kimi', model: 'kimi-k2.6' },
      reviewer: { provider: 'fake', model: 'gpt-4o' },
    },
    review_policy: {
      require_deterministic_checks: false,
      max_fix_attempts: 1,
      reviewer_mode: 'single' as const,
      on_blocked_task: policy.onBlockedTask,
      task_timeout_ms: policy.taskTimeoutMs,
    },
    tasks: [
      {
        task_id: 'task-one',
        title: 'Update README',
        goal: 'Update README with block content',
        allowed_files: ['README.md'],
        denied_files: [],
        max_lines_changed: 150,
        checks: [],
      },
      {
        task_id: 'task-two',
        title: 'Add feature',
        goal: 'Add feature file',
        allowed_files: ['feature.txt'],
        denied_files: [],
        max_lines_changed: 150,
        checks: [],
      },
    ],
  };

  const blockPath = join(tmpDir, 'block.json');
  writeFileSync(blockPath, JSON.stringify(blockDefinition, null, 2), 'utf-8');

  return {
    blockId,
    blockPath,
    repoPath,
    originPath,
    runsDir,
    tmpDir,
    cleanup: () => {
      rmSync(tmpDir, { recursive: true, force: true });
    },
  };
}

function getGitLogCount(repoPath: string): number {
  const result = spawnSync('git', ['log', '--oneline'], {
    cwd: repoPath,
    encoding: 'utf-8',
    shell: false,
  });
  return result.stdout.trim().split('\n').filter((l) => l.length > 0).length;
}

function getBlockState(runsDir: string, blockId: string): Record<string, unknown> | null {
  const statePath = join(runsDir, 'block', blockId, 'state.json');
  if (!existsSync(statePath)) {
    return null;
  }
  return JSON.parse(readFileSync(statePath, 'utf-8'));
}

function baseBlockEnv(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    ALLOW_REAL_BLOCK_RUN_AI: 'true',
    ALLOW_REAL_PROVIDER: 'true',
    ALLOW_REAL_REPO_APPLY: 'true',
    ALLOW_REAL_REPO_COMMIT: 'true',
    ALLOW_REAL_REPO_PUSH: 'true',
    KIMI_API_KEY: 'fake',
    KIMI_BASE_URL: 'http://localhost:9999',
    ...overrides,
  };
}

describe('cli real-block-run-ai resume', () => {
  test('blocked task + default policy stops', () => {
    const { blockId, blockPath, repoPath, runsDir, cleanup } = createTempBlockEnv();
    try {
      const result = runCli(['real-block-run-ai', blockPath], baseBlockEnv({
        RUNS_DIR: runsDir,
        REAL_BLOCK_TASK_KIMI_FAKE_RESPONSES: JSON.stringify([
          buildFakeKimiOutput([{ path: 'README.md', content: '# block updated\n' }]),
          buildFakeKimiOutput([{ path: 'feature.txt', content: 'feature\n' }]),
        ]),
        REAL_BLOCK_TASK_REVIEWER_FAKE_RESPONSES: JSON.stringify([
          buildBlockReview('Block task one', ['reason']),
          buildAcceptReview('Looks good'),
        ]),
      }));
      assert.notStrictEqual(result.status, 0, `Expected stop: ${result.stderr}`);
      const state = getBlockState(runsDir, blockId);
      assert(state !== null);
      assert.strictEqual(state.status, 'blocked');
      const taskResults = state.taskResults as Array<Record<string, unknown>>;
      assert.strictEqual(taskResults.length, 1);
      assert.strictEqual(taskResults[0].status, 'blocked');
    } finally {
      cleanup();
    }
  });

  test('blocked task + on_blocked_task=continue proceeds to next task', () => {
    const { blockId, blockPath, repoPath, runsDir, cleanup } = createTempBlockEnv({ onBlockedTask: 'continue' });
    try {
      const beforeLogCount = getGitLogCount(repoPath);
      const result = runCli(['real-block-run-ai', blockPath], baseBlockEnv({
        RUNS_DIR: runsDir,
        REAL_BLOCK_TASK_KIMI_FAKE_RESPONSES: JSON.stringify([
          buildFakeKimiOutput([{ path: 'README.md', content: '# block updated\n' }]),
          buildFakeKimiOutput([{ path: 'feature.txt', content: 'feature\n' }]),
        ]),
        REAL_BLOCK_TASK_REVIEWER_FAKE_RESPONSES: JSON.stringify([
          buildBlockReview('Block task one', ['reason']),
          buildAcceptReview('Task two looks good'),
        ]),
      }));
      assert.notStrictEqual(result.status, 0, `Expected non-zero exit because a task was blocked/skipped: ${result.stderr}`);
      assert.strictEqual(getGitLogCount(repoPath), beforeLogCount + 2);
      const state = getBlockState(runsDir, blockId);
      assert(state !== null);
      assert.strictEqual(state.status, 'completed_with_caveats');
      assert.strictEqual(state.summary.skippedBlockedTasks, 1);
      const taskResults = state.taskResults as Array<Record<string, unknown>>;
      assert.strictEqual(taskResults.length, 2);
      assert.strictEqual(taskResults[0].status, 'blocked_skipped');
      assert.strictEqual(taskResults[1].status, 'accepted');
    } finally {
      cleanup();
    }
  });

  test('resume after blocked child does not corrupt previous task state', () => {
    const env = createTempBlockEnv({ onBlockedTask: 'continue' });
    try {
      // First run stops after task one because pause-after-task.
      const first = runCli(['real-block-run-ai', env.blockPath, '--pause-after-task', 'task-one'], baseBlockEnv({
        RUNS_DIR: env.runsDir,
        REAL_BLOCK_TASK_KIMI_FAKE_RESPONSES: JSON.stringify([
          buildFakeKimiOutput([{ path: 'README.md', content: '# block updated\n' }]),
          buildFakeKimiOutput([{ path: 'feature.txt', content: 'feature\n' }]),
        ]),
        REAL_BLOCK_TASK_REVIEWER_FAKE_RESPONSES: JSON.stringify([
          buildAcceptReview('Task one looks good'),
          buildAcceptReview('Task two looks good'),
        ]),
      }));
      assert.strictEqual(first.status, 0, `Expected pause: ${first.stderr}`);
      let state = getBlockState(env.runsDir, env.blockId);
      assert.strictEqual(state?.status, 'paused');

      // Resume should complete task two.
      const second = runCli(['real-block-run-ai', env.blockPath, '--resume'], baseBlockEnv({
        RUNS_DIR: env.runsDir,
        REAL_BLOCK_TASK_KIMI_FAKE_RESPONSES: JSON.stringify([
          buildFakeKimiOutput([{ path: 'README.md', content: '# block updated\n' }]),
          buildFakeKimiOutput([{ path: 'feature.txt', content: 'feature\n' }]),
        ]),
        REAL_BLOCK_TASK_REVIEWER_FAKE_RESPONSES: JSON.stringify([
          buildAcceptReview('Task one looks good'),
          buildAcceptReview('Task two looks good'),
        ]),
      }));
      assert.strictEqual(second.status, 0, `Expected resume success: ${second.stderr}`);
      state = getBlockState(env.runsDir, env.blockId);
      assert.strictEqual(state?.status, 'completed');
      const taskResults = state?.taskResults as Array<Record<string, unknown>>;
      assert.strictEqual(taskResults.length, 2);
      assert.strictEqual(taskResults[0].status, 'accepted');
      assert.strictEqual(taskResults[1].status, 'accepted');
    } finally {
      env.cleanup();
    }
  });

  test('no commit/push is reported for blocked-before-apply task', () => {
    const env = createTempBlockEnv();
    try {
      const result = runCli(['real-block-run-ai', env.blockPath], baseBlockEnv({
        RUNS_DIR: env.runsDir,
        REAL_BLOCK_TASK_KIMI_FAKE_RESPONSES: JSON.stringify([
          buildFakeKimiOutput([{ path: '.env', content: 'SECRET=leak\n' }]),
          null,
        ]),
        REAL_BLOCK_TASK_REVIEWER_FAKE_RESPONSES: JSON.stringify([
          null,
          null,
        ]),
      }));
      assert.notStrictEqual(result.status, 0);
      const state = getBlockState(env.runsDir, env.blockId);
      assert(state !== null, `Expected block state to be saved. stdout: ${result.stdout}\nstderr: ${result.stderr}`);
      const taskResults = state?.taskResults as Array<Record<string, unknown>>;
      assert(taskResults !== undefined);
      assert.strictEqual(taskResults[0].codeApplied, false);
      assert.strictEqual(taskResults[0].pushed, false);
      assert.strictEqual(taskResults[0].status, 'failed');
    } finally {
      env.cleanup();
    }
  });

  test('task_timeout_ms is resolved and used', () => {
    const env = createTempBlockEnv({ taskTimeoutMs: 300000 });
    try {
      const result = runCli(['real-block-run-ai-checklist', env.blockPath], baseBlockEnv({
        RUNS_DIR: env.runsDir,
      }));
      assert.strictEqual(result.status, 0, `Expected checklist success: ${result.stderr}`);
      const report = JSON.parse(result.stdout);
      assert.strictEqual(report.resolvedTaskTimeoutMs, 300000);
      assert.strictEqual(report.resolvedReviewerParseRetries, 2);
      assert.strictEqual(report.resolvedOnBlockedTask, 'stop');
    } finally {
      env.cleanup();
    }
  });
});
