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
): { status: number; stdout: string; stderr: string } {
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

interface TempBlockEnv {
  blockId: string;
  blockPath: string;
  repoPath: string;
  originPath: string;
  runsDir: string;
  tmpDir: string;
  cleanup: () => void;
}

function createTempBlockEnv(taskId: string): TempBlockEnv {
  const id = `${Date.now()}-${counter++}`;
  const blockId = `block-ns-${id}`;
  const tmpBase = join(process.cwd(), 'tmp');
  if (!existsSync(tmpBase)) {
    mkdirSync(tmpBase);
  }
  const tmpDir = mkdtempSync(join(tmpBase, `rbrai-ns-${id}-`));
  const repoPath = join(tmpDir, 'repo');
  const originPath = join(tmpDir, 'origin.git');
  const runsDir = join(tmpDir, 'runs');
  mkdirSync(repoPath);

  writeFileSync(join(repoPath, 'README.md'), '# hello\n', 'utf-8');

  spawnSync('git', ['init'], { cwd: repoPath, encoding: 'utf-8', shell: false });
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
    title: 'Namespace isolation test',
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
      on_blocked_task: 'stop' as const,
      task_timeout_ms: 120000,
    },
    tasks: [
      {
        task_id: taskId,
        title: 'Update README',
        goal: 'Update README with block content',
        allowed_files: ['README.md'],
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

describe('real-block-run-ai child namespace isolation', () => {
  test('task_id "block" does not delete current block state', () => {
    const { blockId, blockPath, runsDir, cleanup } = createTempBlockEnv('block');
    try {
      const result = runCli(['real-block-run-ai', blockPath], baseBlockEnv({
        RUNS_DIR: runsDir,
        REAL_BLOCK_TASK_KIMI_FAKE_RESPONSES: JSON.stringify([
          buildFakeKimiOutput([{ path: 'README.md', content: '# updated\n' }]),
        ]),
        REAL_BLOCK_TASK_REVIEWER_FAKE_RESPONSES: JSON.stringify([
          buildAcceptReview('Looks good'),
        ]),
      }));
      assert.strictEqual(result.status, 0, `Expected success: ${result.stderr}`);

      const state = getBlockState(runsDir, blockId);
      assert(state !== null, 'Block state must survive task_id "block"');
      assert.strictEqual(state.status, 'completed');

      const childStatePath = join(runsDir, 'tasks', 'block', 'state.json');
      assert(existsSync(childStatePath), 'Child state should live under tasks namespace');
    } finally {
      cleanup();
    }
  });

  test('child state cleanup only affects child task namespace', () => {
    const taskId = 'normal-task';
    const { blockId, blockPath, runsDir, cleanup } = createTempBlockEnv(taskId);
    try {
      // Plant a stale marker file in the child namespace.
      const staleChildDir = join(runsDir, 'tasks', taskId);
      mkdirSync(staleChildDir, { recursive: true });
      writeFileSync(join(staleChildDir, 'stale-marker.txt'), 'old', 'utf-8');

      const result = runCli(['real-block-run-ai', blockPath], baseBlockEnv({
        RUNS_DIR: runsDir,
        REAL_BLOCK_TASK_KIMI_FAKE_RESPONSES: JSON.stringify([
          buildFakeKimiOutput([{ path: 'README.md', content: '# updated\n' }]),
        ]),
        REAL_BLOCK_TASK_REVIEWER_FAKE_RESPONSES: JSON.stringify([
          buildAcceptReview('Looks good'),
        ]),
      }));
      assert.strictEqual(result.status, 0, `Expected success: ${result.stderr}`);

      const state = getBlockState(runsDir, blockId);
      assert(state !== null);
      assert.strictEqual(state.status, 'completed');

      const childStatePath = join(runsDir, 'tasks', taskId, 'state.json');
      assert(existsSync(childStatePath), 'Fresh child state should exist');
      assert(!existsSync(join(staleChildDir, 'stale-marker.txt')), 'Stale child marker should be cleaned');

      const blockRunDir = join(runsDir, 'block', blockId);
      assert(existsSync(blockRunDir), 'Block namespace must not be affected');
    } finally {
      cleanup();
    }
  });
});
