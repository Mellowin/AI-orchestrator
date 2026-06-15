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
    'REAL_BLOCK_RUN_AI',
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
): {
  status: number;
  stdout: string;
  stderr: string;
} {
  const env = { ...getCleanEnv(), ...envOverrides };
  const quotedArgs = args.map((arg) => `"${arg}"`).join(' ');
  const result = spawnSync(
    `npx tsx "${join(process.cwd(), 'src', 'cli.ts')}" ${quotedArgs}`,
    {
      cwd: process.cwd(),
      env,
      encoding: 'utf-8',
      shell: true,
      timeout: 15000,
    }
  );
  return {
    status: result.status ?? 1,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
  };
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

function createTempBlockEnv(): TempBlockEnv {
  const id = `${Date.now()}-${counter++}`;
  const blockId = `block-${id}`;
  const tmpBase = join(process.cwd(), 'tmp');
  if (!existsSync(tmpBase)) {
    mkdirSync(tmpBase);
  }
  const tmpDir = mkdtempSync(join(tmpBase, `rbrai-${id}-`));
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

  const blockDefinition = {
    block_id: blockId,
    title: 'Readiness test block',
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
    },
    tasks: [
      {
        task_id: 'task-one',
        title: 'Update README',
        goal: 'Update README',
        allowed_files: ['README.md'],
        denied_files: [],
        max_lines_changed: 150,
        checks: [],
      },
      {
        task_id: 'task-two',
        title: 'Add feature',
        goal: 'Add feature',
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

function blockStateExists(runsDir: string, blockId: string): boolean {
  return existsSync(join(runsDir, 'block', blockId, 'state.json'));
}

function baseReadinessEnv(
  runsDir: string,
  overrides: Record<string, string> = {}
): Record<string, string> {
  return {
    ALLOW_REAL_BLOCK_RUN_AI: 'true',
    ALLOW_REAL_PROVIDER: 'true',
    ALLOW_REAL_REPO_APPLY: 'true',
    ALLOW_REAL_REPO_COMMIT: 'true',
    ALLOW_REAL_REPO_PUSH: 'true',
    KIMI_API_KEY: 'fake',
    KIMI_BASE_URL: 'http://localhost:9999',
    RUNS_DIR: runsDir,
    ...overrides,
  };
}

function parseReport(result: ReturnType<typeof runCli>): Record<string, unknown> {
  try {
    return JSON.parse(result.stdout) as Record<string, unknown>;
  } catch {
    throw new Error(`Failed to parse readiness output: ${result.stdout}`);
  }
}

function acceptedResult(taskId: string, sha: string): Record<string, unknown> {
  return {
    taskId,
    title: `Task ${taskId}`,
    status: 'accepted',
    originalCommitSha: sha,
    fixAttempted: false,
    reviewerGateStatus: 'accepted',
    finalStatus: 'accepted',
    nextAction: 'continue',
    childStateTaskId: taskId,
  };
}

function writeBlockState(
  runsDir: string,
  blockId: string,
  state: Record<string, unknown>
): void {
  const dir = join(runsDir, 'block', blockId);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(join(dir, 'state.json'), JSON.stringify(state, null, 2), 'utf-8');
}

function buildBaseState(
  blockId: string,
  title: string,
  runsDir: string,
  status: string,
  taskResults: Record<string, unknown>[]
): Record<string, unknown> {
  const accepted = taskResults.filter(
    (r) => r.status === 'accepted' || r.status === 'fixed_and_accepted'
  ).length;
  const fixed = taskResults.filter((r) => r.status === 'fixed_and_accepted').length;
  return {
    block_id: blockId,
    title,
    status,
    currentTaskId: null,
    statePath: join(runsDir, 'block', blockId, 'state.json'),
    taskResults,
    summary: {
      totalTasks: 2,
      acceptedTasks: accepted,
      fixedTasks: fixed,
      completedTasks: accepted,
    },
    startedAt: '2024-01-01T00:00:00.000Z',
    safetyNote: 'Test safety note',
  };
}

describe('cli real-block-run-ai-readiness', () => {
  test('valid fresh block with required env returns ready true', () => {
    const { blockPath, blockId, repoPath, runsDir, cleanup } = createTempBlockEnv();
    try {
      const beforeLogCount = getGitLogCount(repoPath);
      const result = runCli(
        ['real-block-run-ai-readiness', blockPath],
        baseReadinessEnv(runsDir)
      );
      assert.strictEqual(result.status, 0, `Expected ready: ${result.stderr}`);
      const report = parseReport(result);
      assert.strictEqual(report.ready, true);
      assert.strictEqual(report.mode, 'fresh');
      assert.strictEqual(report.blockId, blockId);
      assert.strictEqual(report.taskCount, 2);
      assert.strictEqual(report.existingState, 'none');
      assert(Array.isArray(report.reasons));
      assert.strictEqual(report.reasons.length, 0);
      assert.strictEqual(getGitLogCount(repoPath), beforeLogCount, 'No commits should be created');
      assert(!blockStateExists(runsDir, blockId), 'No state file should be written');
    } finally {
      cleanup();
    }
  });

  test('missing opt-in returns ready false', () => {
    const { blockPath, repoPath, runsDir, cleanup } = createTempBlockEnv();
    try {
      const result = runCli(
        ['real-block-run-ai-readiness', blockPath],
        baseReadinessEnv(runsDir, { ALLOW_REAL_BLOCK_RUN_AI: '' })
      );
      assert.notStrictEqual(result.status, 0);
      const report = parseReport(result);
      assert.strictEqual(report.ready, false);
      assert(
        (report.reasons as string[]).some((r) => r.includes('ALLOW_REAL_BLOCK_RUN_AI')),
        `Expected opt-in reason: ${JSON.stringify(report.reasons)}`
      );
      assert.strictEqual(getGitLogCount(repoPath), 1, 'No commits should be created');
    } finally {
      cleanup();
    }
  });

  test('missing provider flag returns ready false', () => {
    const { blockPath, runsDir, cleanup } = createTempBlockEnv();
    try {
      const result = runCli(
        ['real-block-run-ai-readiness', blockPath],
        baseReadinessEnv(runsDir, { ALLOW_REAL_PROVIDER: '' })
      );
      assert.notStrictEqual(result.status, 0);
      const report = parseReport(result);
      assert.strictEqual(report.ready, false);
      assert((report.reasons as string[]).some((r) => r.includes('ALLOW_REAL_PROVIDER')));
    } finally {
      cleanup();
    }
  });

  test('missing KIMI_API_KEY returns ready false', () => {
    const { blockPath, runsDir, cleanup } = createTempBlockEnv();
    try {
      const result = runCli(
        ['real-block-run-ai-readiness', blockPath],
        baseReadinessEnv(runsDir, { KIMI_API_KEY: '' })
      );
      assert.notStrictEqual(result.status, 0);
      const report = parseReport(result);
      assert.strictEqual(report.ready, false);
      assert((report.reasons as string[]).some((r) => r.includes('KIMI_API_KEY')));
    } finally {
      cleanup();
    }
  });

  test('missing KIMI_BASE_URL returns ready false', () => {
    const { blockPath, runsDir, cleanup } = createTempBlockEnv();
    try {
      const result = runCli(
        ['real-block-run-ai-readiness', blockPath],
        baseReadinessEnv(runsDir, { KIMI_BASE_URL: '' })
      );
      assert.notStrictEqual(result.status, 0);
      const report = parseReport(result);
      assert.strictEqual(report.ready, false);
      assert((report.reasons as string[]).some((r) => r.includes('KIMI_BASE_URL')));
    } finally {
      cleanup();
    }
  });

  test('invalid block JSON returns ready false', () => {
    const { blockPath, repoPath, runsDir, cleanup } = createTempBlockEnv();
    writeFileSync(blockPath, 'not json', 'utf-8');
    try {
      const result = runCli(
        ['real-block-run-ai-readiness', blockPath],
        baseReadinessEnv(runsDir)
      );
      assert.notStrictEqual(result.status, 0);
      const report = parseReport(result);
      assert.strictEqual(report.ready, false);
      assert.strictEqual(getGitLogCount(repoPath), 1);
    } finally {
      cleanup();
    }
  });

  test('unsafe block_id returns ready false and does not echo raw id', () => {
    const { blockPath, repoPath, runsDir, cleanup } = createTempBlockEnv();
    const definition = JSON.parse(readFileSync(blockPath, 'utf-8')) as Record<string, unknown>;
    definition.block_id = '../evil';
    writeFileSync(blockPath, JSON.stringify(definition), 'utf-8');
    try {
      const result = runCli(
        ['real-block-run-ai-readiness', blockPath],
        baseReadinessEnv(runsDir)
      );
      assert.notStrictEqual(result.status, 0);
      const report = parseReport(result);
      assert.strictEqual(report.ready, false);
      const output = result.stdout + result.stderr;
      assert(!output.includes('../evil'), 'Raw unsafe id should not be echoed');
    } finally {
      cleanup();
    }
  });

  test('unsafe task_id returns ready false and does not echo raw id', () => {
    const { blockPath, repoPath, runsDir, cleanup } = createTempBlockEnv();
    const definition = JSON.parse(readFileSync(blockPath, 'utf-8')) as Record<string, unknown>;
    const tasks = definition.tasks as Record<string, unknown>[];
    tasks[0].task_id = 'task-evil;touch SHOULD_NOT_EXIST';
    writeFileSync(blockPath, JSON.stringify(definition), 'utf-8');
    try {
      const result = runCli(
        ['real-block-run-ai-readiness', blockPath],
        baseReadinessEnv(runsDir)
      );
      assert.notStrictEqual(result.status, 0);
      const report = parseReport(result);
      assert.strictEqual(report.ready, false);
      const output = result.stdout + result.stderr;
      assert(!output.includes('task-evil'), 'Raw unsafe id should not be echoed');
      assert(!output.includes('SHOULD_NOT_EXIST'), 'Raw unsafe id should not be echoed');
      assert(!existsSync(join(repoPath, 'SHOULD_NOT_EXIST')), 'No shell command should run');
    } finally {
      cleanup();
    }
  });

  test('missing repo path returns ready false', () => {
    const { blockPath, runsDir, cleanup } = createTempBlockEnv();
    const definition = JSON.parse(readFileSync(blockPath, 'utf-8')) as Record<string, unknown>;
    definition.repo_path = '/nonexistent/repo/path';
    writeFileSync(blockPath, JSON.stringify(definition), 'utf-8');
    try {
      const result = runCli(
        ['real-block-run-ai-readiness', blockPath],
        baseReadinessEnv(runsDir)
      );
      assert.notStrictEqual(result.status, 0);
      const report = parseReport(result);
      assert.strictEqual(report.ready, false);
      assert((report.reasons as string[]).some((r) => r.includes('Repository path')));
    } finally {
      cleanup();
    }
  });

  test('non-git repo path returns ready false', () => {
    const { blockPath, runsDir, cleanup, tmpDir } = createTempBlockEnv();
    const nonGitPath = join(tmpDir, 'not-a-repo');
    mkdirSync(nonGitPath);
    const definition = JSON.parse(readFileSync(blockPath, 'utf-8')) as Record<string, unknown>;
    definition.repo_path = nonGitPath.replace(/\\/g, '/');
    writeFileSync(blockPath, JSON.stringify(definition), 'utf-8');
    try {
      const result = runCli(
        ['real-block-run-ai-readiness', blockPath],
        baseReadinessEnv(runsDir)
      );
      assert.notStrictEqual(result.status, 0);
      const report = parseReport(result);
      assert.strictEqual(report.ready, false);
      assert((report.reasons as string[]).some((r) => r.includes('not a git repository')));
    } finally {
      cleanup();
    }
  });

  test('work_branch main returns ready false', () => {
    const { blockPath, runsDir, cleanup } = createTempBlockEnv();
    const definition = JSON.parse(readFileSync(blockPath, 'utf-8')) as Record<string, unknown>;
    definition.work_branch = 'main';
    writeFileSync(blockPath, JSON.stringify(definition), 'utf-8');
    try {
      const result = runCli(
        ['real-block-run-ai-readiness', blockPath],
        baseReadinessEnv(runsDir)
      );
      assert.notStrictEqual(result.status, 0);
      const report = parseReport(result);
      assert.strictEqual(report.ready, false);
      assert((report.reasons as string[]).some((r) => r.includes('work_branch')));
    } finally {
      cleanup();
    }
  });

  test('work_branch equal base_branch returns ready false', () => {
    const { blockPath, runsDir, cleanup } = createTempBlockEnv();
    const definition = JSON.parse(readFileSync(blockPath, 'utf-8')) as Record<string, unknown>;
    definition.work_branch = 'main';
    definition.base_branch = 'main';
    writeFileSync(blockPath, JSON.stringify(definition), 'utf-8');
    try {
      const result = runCli(
        ['real-block-run-ai-readiness', blockPath],
        baseReadinessEnv(runsDir)
      );
      assert.notStrictEqual(result.status, 0);
      const report = parseReport(result);
      assert.strictEqual(report.ready, false);
      assert((report.reasons as string[]).some((r) => r.includes('work_branch')));
    } finally {
      cleanup();
    }
  });

  test('existing incomplete state without resume returns ready false', () => {
    const { blockId, blockPath, repoPath, runsDir, cleanup } = createTempBlockEnv();
    const state = buildBaseState(blockId, 'Test', runsDir, 'blocked', [
      acceptedResult('task-one', 'a'.repeat(40)),
    ]);
    writeBlockState(runsDir, blockId, state);
    try {
      const beforeLogCount = getGitLogCount(repoPath);
      const result = runCli(
        ['real-block-run-ai-readiness', blockPath],
        baseReadinessEnv(runsDir)
      );
      assert.notStrictEqual(result.status, 0);
      const report = parseReport(result);
      assert.strictEqual(report.ready, false);
      assert.strictEqual(report.existingState, 'incomplete');
      assert((report.reasons as string[]).some((r) => r.includes('resume')));
      assert.strictEqual(getGitLogCount(repoPath), beforeLogCount);
      assert(blockStateExists(runsDir, blockId), 'Existing state should remain');
    } finally {
      cleanup();
    }
  });

  test('existing incomplete state with resume returns ready true', () => {
    const { blockId, blockPath, repoPath, runsDir, cleanup } = createTempBlockEnv();
    const state = buildBaseState(blockId, 'Test', runsDir, 'blocked', [
      acceptedResult('task-one', 'a'.repeat(40)),
    ]);
    writeBlockState(runsDir, blockId, state);
    try {
      const beforeLogCount = getGitLogCount(repoPath);
      const result = runCli(
        ['real-block-run-ai-readiness', blockPath, '--resume'],
        baseReadinessEnv(runsDir)
      );
      assert.strictEqual(result.status, 0, `Expected ready: ${result.stderr}`);
      const report = parseReport(result);
      assert.strictEqual(report.ready, true);
      assert.strictEqual(report.mode, 'resume');
      assert.strictEqual(report.existingState, 'incomplete');
      assert.deepStrictEqual(report.skippedTaskIds, ['task-one']);
      assert.strictEqual(report.nextTaskId, 'task-two');
      assert.strictEqual(getGitLogCount(repoPath), beforeLogCount);
    } finally {
      cleanup();
    }
  });

  test('existing completed state without resume returns ready false', () => {
    const { blockId, blockPath, repoPath, runsDir, cleanup } = createTempBlockEnv();
    const state = buildBaseState(blockId, 'Test', runsDir, 'completed', [
      acceptedResult('task-one', 'a'.repeat(40)),
      acceptedResult('task-two', 'b'.repeat(40)),
    ]);
    writeBlockState(runsDir, blockId, state);
    try {
      const beforeLogCount = getGitLogCount(repoPath);
      const result = runCli(
        ['real-block-run-ai-readiness', blockPath],
        baseReadinessEnv(runsDir)
      );
      assert.notStrictEqual(result.status, 0);
      const report = parseReport(result);
      assert.strictEqual(report.ready, false);
      assert.strictEqual(report.existingState, 'completed');
      assert.strictEqual(getGitLogCount(repoPath), beforeLogCount);
    } finally {
      cleanup();
    }
  });

  test('existing completed state with resume returns ready completed_noop', () => {
    const { blockId, blockPath, repoPath, runsDir, cleanup } = createTempBlockEnv();
    const state = buildBaseState(blockId, 'Test', runsDir, 'completed', [
      acceptedResult('task-one', 'a'.repeat(40)),
      acceptedResult('task-two', 'b'.repeat(40)),
    ]);
    writeBlockState(runsDir, blockId, state);
    try {
      const beforeLogCount = getGitLogCount(repoPath);
      const result = runCli(
        ['real-block-run-ai-readiness', blockPath, '--resume'],
        baseReadinessEnv(runsDir)
      );
      assert.strictEqual(result.status, 0, `Expected ready: ${result.stderr}`);
      const report = parseReport(result);
      assert.strictEqual(report.ready, true);
      assert.strictEqual(report.mode, 'completed_noop');
      assert.strictEqual(report.existingState, 'completed');
      assert.strictEqual(getGitLogCount(repoPath), beforeLogCount);
    } finally {
      cleanup();
    }
  });

  test('corrupt state returns ready false', () => {
    const { blockId, blockPath, repoPath, runsDir, cleanup } = createTempBlockEnv();
    const dir = join(runsDir, 'block', blockId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'state.json'), JSON.stringify('not an object'), 'utf-8');
    try {
      const beforeLogCount = getGitLogCount(repoPath);
      const result = runCli(
        ['real-block-run-ai-readiness', blockPath, '--resume'],
        baseReadinessEnv(runsDir)
      );
      assert.notStrictEqual(result.status, 0);
      const report = parseReport(result);
      assert.strictEqual(report.ready, false);
      assert.strictEqual(report.existingState, 'invalid');
      assert.strictEqual(getGitLogCount(repoPath), beforeLogCount);
    } finally {
      cleanup();
    }
  });

  test('fake response array length mismatch returns ready false', () => {
    const { blockPath, runsDir, cleanup } = createTempBlockEnv();
    try {
      const result = runCli(
        ['real-block-run-ai-readiness', blockPath],
        baseReadinessEnv(runsDir, {
          REAL_BLOCK_TASK_KIMI_FAKE_RESPONSES: JSON.stringify(['only-one']),
        })
      );
      assert.notStrictEqual(result.status, 0);
      const report = parseReport(result);
      assert.strictEqual(report.ready, false);
      assert((report.reasons as string[]).some((r) => r.includes('length')));
    } finally {
      cleanup();
    }
  });

  test('secrets are redacted in output', () => {
    const { blockPath, runsDir, cleanup, tmpDir } = createTempBlockEnv();
    const definition = JSON.parse(readFileSync(blockPath, 'utf-8')) as Record<string, unknown>;
    definition.block_id = 'block-sk-fake-readiness-secret';
    definition.repo_path = join(tmpDir, 'repo-sk-fake-readiness-secret').replace(/\\/g, '/');
    writeFileSync(blockPath, JSON.stringify(definition), 'utf-8');
    try {
      const result = runCli(
        ['real-block-run-ai-readiness', blockPath],
        baseReadinessEnv(runsDir)
      );
      assert.notStrictEqual(result.status, 0);
      const output = result.stdout + result.stderr;
      assert(!output.includes('sk-fake-readiness-secret'), 'Secret should be redacted in output');
    } finally {
      cleanup();
    }
  });
});
