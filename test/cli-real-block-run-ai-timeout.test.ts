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
import { createServer } from 'node:net';

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
    'REAL_REPO_REVIEWER_NO_DEFAULT',
    'REAL_REPO_REVIEWER_CAPTURE_INPUT_FILE',
    'REAL_REPO_REVIEWER_FORCE_PROVIDER_ERROR',
    'REAL_REPO_REVIEWER_FIX_TASK_FAKE_EXECUTOR_RESPONSE',
    'REAL_REPO_ENABLE_REVIEWER_FIX_LOOP',
    'REAL_REPO_REVIEWER_MAX_FIX_ATTEMPTS',
    'REAL_REPO_REVIEWER_SECOND_FAKE_RESPONSE',
    'REAL_REPO_REVIEWER_SECOND_KIMI_FAKE_RESPONSE',
    'REAL_REPO_REVIEWER_SECOND_FORCE_PROVIDER_ERROR',
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
      timeout: 120000,
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

interface TempBlockEnv {
  blockId: string;
  blockPath: string;
  repoPath: string;
  originPath: string;
  runsDir: string;
  tmpDir: string;
  cleanup: () => void;
}

function createTempBlockEnv(policy: { taskTimeoutMs?: number } = {}): TempBlockEnv {
  const id = `${Date.now()}-${counter++}`;
  const blockId = `block-timeout-${id}`;
  const tmpBase = join(process.cwd(), 'tmp');
  if (!existsSync(tmpBase)) {
    mkdirSync(tmpBase);
  }
  const tmpDir = mkdtempSync(join(tmpBase, `rbrai-timeout-${id}-`));
  const repoPath = join(tmpDir, 'repo');
  const originPath = join(tmpDir, 'origin.git');
  const runsDir = join(tmpDir, 'runs');
  mkdirSync(repoPath);

  writeFileSync(join(repoPath, 'README.md'), '# hello\n', 'utf-8');
  // Check fails unless README.md contains the required sentence.
  writeFileSync(
    join(repoPath, 'check.cjs'),
    "require('fs').readFileSync('README.md','utf8').includes('required sentence')||process.exit(1)",
    'utf-8'
  );

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
    title: 'Real block run AI timeout test',
    repo_path: repoPath.replace(/\\/g, '/'),
    base_branch: 'main',
    work_branch: 'ai/block-work',
    providers: {
      coder: { provider: 'fake', model: 'kimi-k2.6' },
      reviewer: { provider: 'fake', model: 'gpt-4o' },
    },
    review_policy: {
      require_deterministic_checks: false,
      max_fix_attempts: 2,
      reviewer_mode: 'single' as const,
      task_timeout_ms: policy.taskTimeoutMs,
    },
    tasks: [
      {
        task_id: 'task-one',
        title: 'Update README',
        goal: 'Update README with the required sentence',
        allowed_files: ['README.md', 'check.cjs'],
        denied_files: [],
        max_lines_changed: 150,
        checks: ['node check.cjs'],
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

function getChildState(runsDir: string, taskId: string): Record<string, unknown> | null {
  const statePath = join(runsDir, 'tasks', taskId, 'state.json');
  if (!existsSync(statePath)) {
    return null;
  }
  return JSON.parse(readFileSync(statePath, 'utf-8'));
}

function getBareRefs(originPath: string): string[] {
  const result = spawnSync('git', ['--git-dir', originPath, 'show-ref'], {
    encoding: 'utf-8',
    shell: false,
  });
  return result.stdout.trim().split('\n').filter((l) => l.length > 0);
}

function startHangingServer(): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve, reject) => {
    const server = createServer((socket) => {
      // Accept the connection and never respond so that the HTTP client hangs
      // until its outer timeout fires.
      socket.setTimeout(0);
    });
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        server.close(() => reject(new Error('Failed to get server address')));
        return;
      }
      resolve({
        url: `http://127.0.0.1:${address.port}`,
        close: () => new Promise((res) => server.close(() => res())),
      });
    });
  });
}

function baseBlockEnv(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    ALLOW_REAL_BLOCK_RUN_AI: 'true',
    ALLOW_REAL_PROVIDER: 'true',
    ALLOW_REAL_REPO_APPLY: 'true',
    ALLOW_REAL_REPO_COMMIT: 'true',
    ALLOW_REAL_REPO_PUSH: 'true',
    KIMI_API_KEY: 'fake',
    ...overrides,
  };
}

describe('cli real-block-run-ai timeout', () => {
  test('proof-8 regression: timeout after push is detected and bounded continuations do not duplicate commits', async () => {
    const env = createTempBlockEnv({ taskTimeoutMs: 2000 });
    const server = await startHangingServer();
    try {
      const beforeLogCount = getGitLogCount(env.repoPath);

      const result = runCli(['real-block-run-ai', env.blockPath], baseBlockEnv({
        RUNS_DIR: env.runsDir,
        KIMI_BASE_URL: server.url,
        REAL_BLOCK_TASK_KIMI_FAKE_RESPONSES: JSON.stringify([
          JSON.stringify([
            buildFakeKimiOutput([{ path: 'README.md', content: '# initial missing required sentence\n' }]),
            buildFakeKimiOutput([{ path: 'README.md', content: '# repaired\nrequired sentence\n' }]),
          ]),
        ]),
      }));

      // The parent must detect the timeout and give up after bounded continuations.
      assert.notStrictEqual(result.status, 0, `Expected failure after max continuations: ${result.stderr}`);
      assert(
        result.stderr.includes('timed out'),
        `Expected parent timeout detection in stderr: ${result.stderr}`
      );

      const blockState = getBlockState(env.runsDir, env.blockId);
      assert(blockState !== null, 'Block state should be saved');
      assert.strictEqual(blockState.status, 'failed', `Expected block status failed: ${JSON.stringify(blockState)}`);

      const taskResults = blockState.taskResults as Array<Record<string, unknown>>;
      assert.strictEqual(taskResults.length, 1);
      const taskResult = taskResults[0];
      assert.strictEqual(taskResult.status, 'failed');
      assert(
        taskResult.timeoutEvidence !== undefined,
        `Task result should record timeout evidence: ${JSON.stringify(taskResult)}`
      );
      const evidence = taskResult.timeoutEvidence as Record<string, number>;
      assert.strictEqual(evidence.timeoutMs, 2000);
      assert.strictEqual(evidence.continuationCount, 2);
      assert(evidence.totalElapsedMs > 0, 'total_elapsed_ms should be positive');
      assert(
        typeof taskResult.reason === 'string' && !taskResult.reason.includes('exit code 1'),
        `Task result reason should describe timeout, not plain exit code 1: ${taskResult.reason}`
      );

      // The original task commit must exist exactly once and be pushed.
      assert.strictEqual(
        getGitLogCount(env.repoPath),
        beforeLogCount + 1,
        'Only one task commit should exist; continuation must not re-commit'
      );
      const refs = getBareRefs(env.originPath);
      const branchRef = refs.find((r) => r.includes('refs/heads/ai/block-work'));
      assert(branchRef, `Work branch should be pushed: ${refs.join(', ')}`);

      // The child state must reflect the pushed phase with timeout budget fields.
      const childState = getChildState(env.runsDir, 'task-one');
      assert(childState !== null, 'Child state should be saved');
      assert.strictEqual(childState.status, 'pushed');
      assert.strictEqual(childState.task_phase, 'reviewer_pending');
      assert.strictEqual(childState.timeout_ms, 2000);
      assert.strictEqual(childState.continuation_count, 2);
    } finally {
      await server.close();
      env.cleanup();
    }
  });
});
