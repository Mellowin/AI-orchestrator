import { describe, test } from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

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
): {
  status: number;
  stdout: string;
  stderr: string;
} {
  const env = { ...getCleanEnv(), ...envOverrides };
  // Sweep any leftover orchestrator/provider-related env vars that were not
  // explicitly set by the current test. This prevents order-dependent flakiness
  // caused by variables leaking from earlier tests in the same process.
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

function buildRejectReview(
  summary: string,
  blockingIssues: string[],
  fixTask: string
): string {
  return JSON.stringify({
    decision: 'reject',
    confidence: 'high',
    blockingIssues,
    nonBlockingIssues: [],
    reviewSummary: summary,
    nextAction: 'fix',
    fixTask,
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
  baseSha: string;
  cleanup: () => void;
}

function createTempBlockEnv(customTasks?: Record<string, unknown>[]): TempBlockEnv {
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
    title: 'Real block run AI test',
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
    tasks: customTasks ?? [
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
        allowed_files: ['feature.txt', 'fix.txt'],
        denied_files: [],
        max_lines_changed: 150,
        checks: [],
      },
    ],
  };

  const blockPath = join(tmpDir, 'block.json');
  writeFileSync(blockPath, JSON.stringify(blockDefinition, null, 2), 'utf-8');

  const baseShaResult = spawnSync('git', ['rev-parse', 'HEAD'], {
    cwd: repoPath,
    encoding: 'utf-8',
    shell: false,
  });
  const baseSha = baseShaResult.stdout.trim();

  return {
    blockId,
    blockPath,
    repoPath,
    originPath,
    runsDir,
    tmpDir,
    baseSha,
    cleanup: () => {
      rmSync(tmpDir, { recursive: true, force: true });
    },
  };
}

function setTaskChecks(
  env: TempBlockEnv,
  taskId: string,
  checks: string[]
): void {
  const definition = JSON.parse(readFileSync(env.blockPath, 'utf-8')) as Record<string, unknown>;
  const tasks = definition.tasks as Record<string, unknown>[];
  const task = tasks.find((t) => t.task_id === taskId);
  if (!task) {
    throw new Error(`Task ${taskId} not found in block definition`);
  }
  task.checks = checks;
  writeFileSync(env.blockPath, JSON.stringify(definition, null, 2), 'utf-8');
}

function getGitLogCount(repoPath: string): number {
  const result = spawnSync('git', ['log', '--oneline'], {
    cwd: repoPath,
    encoding: 'utf-8',
    shell: false,
  });
  return result.stdout.trim().split('\n').filter((l) => l.length > 0).length;
}

function createCommit(repoPath: string, message: string, files: Record<string, string>): string {
  for (const [relativePath, content] of Object.entries(files)) {
    const fullPath = join(repoPath, relativePath);
    const parent = dirname(fullPath);
    if (!existsSync(parent)) {
      mkdirSync(parent, { recursive: true });
    }
    writeFileSync(fullPath, content, 'utf-8');
  }
  const paths = Object.keys(files);
  const addResult = spawnSync('git', ['add', ...paths], {
    cwd: repoPath,
    encoding: 'utf-8',
    shell: false,
  });
  if (addResult.status !== 0) {
    throw new Error(`git add failed: ${addResult.stderr}`);
  }
  const commitResult = spawnSync('git', ['commit', '-m', message, '--no-gpg-sign'], {
    cwd: repoPath,
    encoding: 'utf-8',
    shell: false,
  });
  if (commitResult.status !== 0) {
    throw new Error(`git commit failed: ${commitResult.stderr}`);
  }
  const revResult = spawnSync('git', ['rev-parse', 'HEAD'], {
    cwd: repoPath,
    encoding: 'utf-8',
    shell: false,
  });
  if (revResult.status !== 0) {
    throw new Error(`git rev-parse failed: ${revResult.stderr}`);
  }
  return revResult.stdout.trim();
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

function getRealBlockRunAiBranchSource(): string {
  const source = readFileSync(join(process.cwd(), 'src', 'cli.ts'), 'utf-8');
  const start = source.indexOf("if (command === 'real-block-run-ai') {");
  if (start === -1) {
    throw new Error('real-block-run-ai branch not found in src/cli.ts');
  }
  const end = source.indexOf("if (command === 'real-block-run-ai-report') {", start);
  if (end === -1) {
    throw new Error('real-block-run-ai-report branch not found in src/cli.ts');
  }
  return source.slice(start, end);
}

describe('cli real-block-run-ai', () => {
  test('branch source does not use direct process.exit(', () => {
    const branch = getRealBlockRunAiBranchSource();
    assert(!branch.includes('process.exit('), 'Expected no direct process.exit call in real-block-run-ai branch');
  });

  test('branch source uses process.exitCode', () => {
    const branch = getRealBlockRunAiBranchSource();
    assert(branch.includes('process.exitCode'), 'Expected process.exitCode assignment in real-block-run-ai branch');
  });

  test('branch source uses break commandDispatch', () => {
    const branch = getRealBlockRunAiBranchSource();
    assert(branch.includes('break commandDispatch'), 'Expected break commandDispatch in real-block-run-ai branch');
  });

  test('missing block path refuses before provider call', () => {
    const result = runCli(['real-block-run-ai']);
    assert.notStrictEqual(result.status, 0);
    assert(result.stderr.includes('block definition path is required'), `Expected block path required: ${result.stderr}`);
    assert(result.stderr.includes('No provider call was made'), `Expected no provider call: ${result.stderr}`);
  });

  test('missing opt-in refuses before provider call', () => {
    const { blockPath, blockId, cleanup, runsDir } = createTempBlockEnv();
    try {
      const result = runCli(['real-block-run-ai', blockPath], {
        RUNS_DIR: runsDir,
        ALLOW_REAL_PROVIDER: 'true',
        ALLOW_REAL_REPO_APPLY: 'true',
        ALLOW_REAL_REPO_COMMIT: 'true',
        ALLOW_REAL_REPO_PUSH: 'true',
        KIMI_API_KEY: 'fake',
        KIMI_BASE_URL: 'http://localhost:9999',
      });
      assert.notStrictEqual(result.status, 0);
      const output = result.stdout + result.stderr;
      assert(
        output.includes('ALLOW_REAL_BLOCK_RUN_AI=true') || output.includes('REAL_BLOCK_RUN_AI=1'),
        `Expected opt-in refusal: ${output}`
      );
      assert(result.stderr.includes('No provider call was made'), `Expected no provider call: ${result.stderr}`);
      assert.strictEqual(getBlockState(runsDir, blockId), null, 'No state should be written');
    } finally {
      cleanup();
    }
  });

  test('REAL_BLOCK_RUN_AI=1 opt-in works', () => {
    const { blockId, blockPath, repoPath, runsDir, cleanup } = createTempBlockEnv();
    try {
      const beforeLogCount = getGitLogCount(repoPath);
      const result = runCli(['real-block-run-ai', blockPath], {
        REAL_BLOCK_RUN_AI: '1',
        ALLOW_REAL_PROVIDER: 'true',
        ALLOW_REAL_REPO_APPLY: 'true',
        ALLOW_REAL_REPO_COMMIT: 'true',
        ALLOW_REAL_REPO_PUSH: 'true',
        KIMI_API_KEY: 'fake',
        KIMI_BASE_URL: 'http://localhost:9999',
        RUNS_DIR: runsDir,
        REAL_BLOCK_TASK_KIMI_FAKE_RESPONSES: JSON.stringify([
          buildFakeKimiOutput([{ path: 'README.md', content: '# block updated\n' }]),
          buildFakeKimiOutput([{ path: 'feature.txt', content: 'feature\n' }]),
        ]),
        REAL_BLOCK_TASK_REVIEWER_FAKE_RESPONSES: JSON.stringify([
          buildAcceptReview('Task one looks good'),
          buildRejectReview('Needs fix', ['missing fix.txt'], 'add fix.txt'),
        ]),
        REAL_BLOCK_TASK_FIX_KIMI_FAKE_RESPONSES: JSON.stringify([
          null,
          buildFakeKimiOutput([{ path: 'fix.txt', content: 'fix applied\n' }]),
        ]),
        REAL_BLOCK_TASK_SECOND_REVIEWER_FAKE_RESPONSES: JSON.stringify([
          null,
          buildAcceptReview('Fix looks good'),
        ]),
      });
      assert.strictEqual(result.status, 0, `Expected success: ${result.stderr}`);
      assert.strictEqual(getGitLogCount(repoPath), beforeLogCount + 3);
      const state = getBlockState(runsDir, blockId);
      assert(state !== null);
      assert.strictEqual(state.status, 'completed');
    } finally {
      cleanup();
    }
  });

  function createTempBlockEnvWithTaskIds(taskIds: string[]): TempBlockEnv {
    const base = createTempBlockEnv();
    const definition = JSON.parse(readFileSync(base.blockPath, 'utf-8')) as Record<string, unknown>;
    const tasks = (definition.tasks as Record<string, unknown>[]).slice(0, taskIds.length);
    for (let i = 0; i < tasks.length; i++) {
      tasks[i].task_id = taskIds[i];
      tasks[i].title = `Task ${taskIds[i]}`;
    }
    definition.tasks = tasks;
    writeFileSync(base.blockPath, JSON.stringify(definition, null, 2), 'utf-8');
    return base;
  }

  test('malicious task id with shell metacharacters does not execute shell', () => {
    const maliciousId = 'task-evil;touch SHOULD_NOT_EXIST';
    const { blockPath, repoPath, runsDir, cleanup, blockId } = createTempBlockEnvWithTaskIds([
      maliciousId,
    ]);
    const shouldNotExistRepo = join(repoPath, 'SHOULD_NOT_EXIST');
    const shouldNotExistProject = join(process.cwd(), 'SHOULD_NOT_EXIST');
    const shouldNotExistTmp = join(runsDir, 'SHOULD_NOT_EXIST');
    try {
      const result = runCli(['real-block-run-ai', blockPath], baseBlockEnv({
        RUNS_DIR: runsDir,
        REAL_BLOCK_TASK_KIMI_FAKE_RESPONSES: JSON.stringify([
          buildFakeKimiOutput([{ path: 'README.md', content: '# block updated\n' }]),
        ]),
        REAL_BLOCK_TASK_REVIEWER_FAKE_RESPONSES: JSON.stringify([
          buildAcceptReview('Looks good'),
        ]),
      }));
      assert.notStrictEqual(result.status, 0, `Expected refusal or failure: ${result.stderr}`);
      assert(!existsSync(shouldNotExistRepo), 'SHOULD_NOT_EXIST must not be created in repo');
      assert(!existsSync(shouldNotExistProject), 'SHOULD_NOT_EXIST must not be created in project root');
      assert(!existsSync(shouldNotExistTmp), 'SHOULD_NOT_EXIST must not be created in runs dir');
    } finally {
      if (existsSync(shouldNotExistProject)) {
        rmSync(shouldNotExistProject, { force: true });
      }
      cleanup();
    }
  });

  function assertUnsafeTaskIdRejected(taskId: string): void {
    const { blockPath, repoPath, runsDir, cleanup, blockId } = createTempBlockEnvWithTaskIds([
      taskId,
    ]);
    const shouldNotExistRepo = join(repoPath, 'SHOULD_NOT_EXIST');
    const shouldNotExistProject = join(process.cwd(), 'SHOULD_NOT_EXIST');
    const shouldNotExistTmp = join(runsDir, 'SHOULD_NOT_EXIST');
    const beforeLogCount = getGitLogCount(repoPath);
    try {
      const result = runCli(['real-block-run-ai', blockPath], baseBlockEnv({
        RUNS_DIR: runsDir,
        REAL_BLOCK_TASK_KIMI_FAKE_RESPONSES: JSON.stringify([
          buildFakeKimiOutput([{ path: 'README.md', content: '# block updated\n' }]),
        ]),
        REAL_BLOCK_TASK_REVIEWER_FAKE_RESPONSES: JSON.stringify([
          buildAcceptReview('Looks good'),
        ]),
      }));
      assert.notStrictEqual(result.status, 0, `Expected refusal or failure: ${result.stderr}`);
      const output = result.stdout + result.stderr;
      assert(
        output.includes('task_id contains unsupported characters'),
        `Expected unsupported characters message: ${output}`
      );
      assert(
        result.stderr.includes('No provider call was made'),
        `Expected no provider call: ${result.stderr}`
      );
      assert.strictEqual(getGitLogCount(repoPath), beforeLogCount, 'No commits should be created');
      assert.strictEqual(getBlockState(runsDir, blockId), null, 'No block state should be written');
      assert(!existsSync(shouldNotExistRepo), 'SHOULD_NOT_EXIST must not be created in repo');
      assert(!existsSync(shouldNotExistProject), 'SHOULD_NOT_EXIST must not be created in project root');
      assert(!existsSync(shouldNotExistTmp), 'SHOULD_NOT_EXIST must not be created in runs dir');
    } finally {
      if (existsSync(shouldNotExistProject)) {
        rmSync(shouldNotExistProject, { force: true });
      }
      cleanup();
    }
  }

  test('task_id with slash is rejected before mutation', () => {
    assertUnsafeTaskIdRejected('task/evil');
  });

  test('task_id with backslash is rejected before mutation', () => {
    assertUnsafeTaskIdRejected('task\\evil');
  });

  test('task_id with dotdot is rejected before mutation', () => {
    assertUnsafeTaskIdRejected('../evil');
  });

  test('task_id with command substitution is rejected before mutation', () => {
    assertUnsafeTaskIdRejected('task-evil$(touch SHOULD_NOT_EXIST)');
  });

  test('task_id with spaces is rejected before mutation', () => {
    assertUnsafeTaskIdRejected('task evil');
  });

  test('unsafe block_id is rejected before mutation', () => {
    const base = createTempBlockEnv();
    const definition = JSON.parse(readFileSync(base.blockPath, 'utf-8')) as Record<string, unknown>;
    definition.block_id = '../evil';
    writeFileSync(base.blockPath, JSON.stringify(definition, null, 2), 'utf-8');
    const { blockPath, repoPath, runsDir, cleanup } = base;
    const shouldNotExistProject = join(process.cwd(), 'SHOULD_NOT_EXIST');
    const beforeLogCount = getGitLogCount(repoPath);
    try {
      const result = runCli(['real-block-run-ai', blockPath], baseBlockEnv({ RUNS_DIR: runsDir }));
      assert.notStrictEqual(result.status, 0, `Expected refusal or failure: ${result.stderr}`);
      const output = result.stdout + result.stderr;
      assert(
        output.includes('block_id contains unsupported characters'),
        `Expected unsupported characters message: ${output}`
      );
      assert(
        result.stderr.includes('No provider call was made'),
        `Expected no provider call: ${result.stderr}`
      );
      assert.strictEqual(getGitLogCount(repoPath), beforeLogCount, 'No commits should be created');
      assert(!existsSync(shouldNotExistProject), 'SHOULD_NOT_EXIST must not be created in project root');
      assert.strictEqual(getBlockState(runsDir, base.blockId), null, 'No block state should be written');
    } finally {
      if (existsSync(shouldNotExistProject)) {
        rmSync(shouldNotExistProject, { force: true });
      }
      cleanup();
    }
  });

  test('two tasks complete with second task fix loop accepted', () => {
    const env = createTempBlockEnv();
    setTaskChecks(env, 'task-two', [
      "node -e console.log('typecheck');process.exit(0)",
      "node -e console.log('build');process.exit(0)",
      "node -e console.log('test');process.exit(0)",
    ]);
    const { blockId, blockPath, repoPath, runsDir, cleanup } = env;
    try {
      const beforeLogCount = getGitLogCount(repoPath);
      const result = runCli(['real-block-run-ai', blockPath], baseBlockEnv({
        RUNS_DIR: runsDir,
        REAL_BLOCK_TASK_KIMI_FAKE_RESPONSES: JSON.stringify([
          buildFakeKimiOutput([{ path: 'README.md', content: '# block updated\n' }]),
          buildFakeKimiOutput([{ path: 'feature.txt', content: 'feature\n' }]),
        ]),
        REAL_BLOCK_TASK_REVIEWER_FAKE_RESPONSES: JSON.stringify([
          buildAcceptReview('Task one looks good with sk-fake-accept-secret'),
          buildRejectReview('Needs fix', ['missing fix.txt'], 'add fix.txt'),
        ]),
        REAL_BLOCK_TASK_FIX_KIMI_FAKE_RESPONSES: JSON.stringify([
          null,
          buildFakeKimiOutput([{ path: 'fix.txt', content: 'fix applied\n' }]),
        ]),
        REAL_BLOCK_TASK_SECOND_REVIEWER_FAKE_RESPONSES: JSON.stringify([
          null,
          buildAcceptReview('Fix looks good with Bearer fake-token'),
        ]),
      }));

      assert.strictEqual(result.status, 0, `Expected success: ${result.stderr}`);
      assert.strictEqual(getGitLogCount(repoPath), beforeLogCount + 3, `Expected three new commits: init=${beforeLogCount}, after=${getGitLogCount(repoPath)}`);

      const state = getBlockState(runsDir, blockId);
      assert(state !== null, 'Block state should exist');
      assert.strictEqual(state.status, 'completed');
      assert.strictEqual(state.block_id, blockId);
      assert(typeof state.statePath === 'string' && state.statePath.length > 0, 'statePath should be persisted');

      const summary = state.summary as Record<string, unknown>;
      assert.strictEqual(summary.totalTasks, 2);
      assert.strictEqual(summary.completedTasks, 2);
      assert.strictEqual(summary.acceptedTasks, 1);
      assert.strictEqual(summary.fixedTasks, 1);

      const taskResults = state.taskResults as Record<string, unknown>[];
      assert.strictEqual(taskResults.length, 2);

      const taskOne = taskResults[0];
      assert.strictEqual(taskOne.status, 'accepted');
      assert.strictEqual(taskOne.taskId, 'task-one');
      assert.strictEqual(taskOne.reviewerGateStatus, 'accepted');
      assert.strictEqual(taskOne.reviewerSummary, 'Task one looks good with [REDACTED]');
      assert.strictEqual(taskOne.fixAttempted, false);
      assert.strictEqual(taskOne.finalStatus, 'accepted');
      assert.strictEqual(taskOne.nextAction, 'continue');
      assert.strictEqual(taskOne.childStateTaskId, 'task-one');

      const taskTwo = taskResults[1];
      assert.strictEqual(taskTwo.status, 'fixed_and_accepted');
      assert.strictEqual(taskTwo.taskId, 'task-two');
      assert.strictEqual(taskTwo.reviewerGateStatus, 'fix_required');
      assert.strictEqual(taskTwo.fixAttempted, true);
      assert(typeof taskTwo.fixTaskId === 'string' && (taskTwo.fixTaskId as string).startsWith('fix-'), `Expected fixTaskId: ${taskTwo.fixTaskId}`);
      assert.strictEqual(taskTwo.fixRunnerStatus, 'executed');
      assert.strictEqual(taskTwo.fixRunnerNextAction, 'review_fix_result');
      assert.strictEqual(taskTwo.secondReviewerGateStatus, 'accepted');
      assert.strictEqual(taskTwo.secondReviewerSummary, 'Fix looks good with [REDACTED]');
      assert(typeof taskTwo.originalCommitSha === 'string' && (taskTwo.originalCommitSha as string).length === 40, 'Original commit SHA should be 40 chars');
      assert(typeof taskTwo.fixCommitSha === 'string' && (taskTwo.fixCommitSha as string).length === 40, 'Fix commit SHA should be 40 chars');
      assert.notStrictEqual(taskTwo.originalCommitSha, taskTwo.fixCommitSha, 'Fix commit should differ from original');
      assert.strictEqual(taskTwo.finalStatus, 'accepted');
      assert.strictEqual(taskTwo.nextAction, 'continue');
      assert.strictEqual(taskTwo.childStateTaskId, 'task-two');

      assert(taskTwo.fixCheckSummary, 'Fixed task should have actual fix check summary');
      assert.strictEqual(taskTwo.fixCheckSummary.typecheck, 'pass');
      assert.strictEqual(taskTwo.fixCheckSummary.build, 'pass');
      assert.strictEqual(taskTwo.fixCheckSummary.test, 'pass');
      assert.deepStrictEqual(taskTwo.fixCheckSummary.tests, { total: 3, suites: 0, failures: 0 });

      const reportResult = runCli(['real-block-run-ai-report', state.statePath as string], baseBlockEnv({ RUNS_DIR: runsDir }));
      assert.strictEqual(reportResult.status, 0, `Report command should succeed: ${reportResult.stderr}`);
      const reportOutput = reportResult.stdout;
      assert(reportOutput.includes('task-two — fixed_and_accepted'), `Report should show task-two fixed_and_accepted: ${reportOutput}`);
      assert(reportOutput.includes('fixCheckSummary:'), `Report should include fixCheckSummary section: ${reportOutput}`);
      assert(reportOutput.includes('typecheck: pass'), `Report should show typecheck pass: ${reportOutput}`);
      assert(reportOutput.includes('build: pass'), `Report should show build pass: ${reportOutput}`);
      assert(reportOutput.includes('test: pass'), `Report should show test pass: ${reportOutput}`);
      assert(reportOutput.includes('tests: total=3 suites=0 failures=0'), `Report should show test counts: ${reportOutput}`);
      assert(reportOutput.includes(taskTwo.fixCommitSha as string), `Report should show fix commit SHA: ${reportOutput}`);

      const output = result.stdout;
      assert(output.includes(blockId), `CLI output should include block id: ${output}`);
      assert(output.includes('Status: completed'), `CLI output should include status: ${output}`);
      assert(output.includes(state.statePath as string), `CLI output should include state path: ${output}`);
      assert(output.includes('task-one: accepted'), `CLI output should include task-one status: ${output}`);
      assert(output.includes('task-two: fixed_and_accepted'), `CLI output should include task-two status: ${output}`);
      assert(output.includes(taskOne.originalCommitSha as string), `CLI output should include original commit: ${output}`);
      assert(output.includes(taskTwo.fixCommitSha as string), `CLI output should include fix commit: ${output}`);

      const combinedOutput = output + result.stderr;
      assert(!combinedOutput.includes('sk-fake-accept-secret'), 'CLI output should redact secrets');
      assert(!combinedOutput.includes('Bearer fake-token'), 'CLI output should redact tokens');

      const stateRaw = JSON.stringify(state);
      assert(!stateRaw.includes('fix applied'), 'Block state should not contain raw file content');
      assert(!stateRaw.includes('sk-fake-accept-secret'), 'Block state should not contain raw secrets');
      assert(!stateRaw.includes('Bearer fake-token'), 'Block state should not contain raw tokens');
      assert(!stateRaw.includes('runState'), 'Block state should not contain raw executor runState');
      assert(!stateRaw.includes('choices'), 'Block state should not contain raw provider response');
    } finally {
      cleanup();
    }
  });

  test('second reviewer reject blocks the whole block without recursive fix', () => {
    const { blockId, blockPath, repoPath, runsDir, cleanup } = createTempBlockEnv();
    try {
      const beforeLogCount = getGitLogCount(repoPath);
      const result = runCli(['real-block-run-ai', blockPath], baseBlockEnv({
        RUNS_DIR: runsDir,
        REAL_BLOCK_TASK_KIMI_FAKE_RESPONSES: JSON.stringify([
          buildFakeKimiOutput([{ path: 'README.md', content: '# block updated\n' }]),
          buildFakeKimiOutput([{ path: 'feature.txt', content: 'feature\n' }]),
        ]),
        REAL_BLOCK_TASK_REVIEWER_FAKE_RESPONSES: JSON.stringify([
          buildAcceptReview('Task one looks good'),
          buildRejectReview('Needs fix', ['missing fix.txt with sk-fake-secret'], 'add fix.txt'),
        ]),
        REAL_BLOCK_TASK_FIX_KIMI_FAKE_RESPONSES: JSON.stringify([
          null,
          buildFakeKimiOutput([{ path: 'fix.txt', content: 'fix applied\n' }]),
        ]),
        REAL_BLOCK_TASK_SECOND_REVIEWER_FAKE_RESPONSES: JSON.stringify([
          null,
          buildRejectReview('Still needs more', ['still missing more'], 'add more tests'),
        ]),
      }));

      assert.notStrictEqual(result.status, 0, `Expected failure: ${result.stderr}`);
      assert.strictEqual(getGitLogCount(repoPath), beforeLogCount + 3, 'Should create task1, task2 original, and one fix commit only');

      const state = getBlockState(runsDir, blockId);
      assert(state !== null);
      assert.strictEqual(state.status, 'blocked');
      const summary = state.summary as Record<string, unknown>;
      assert.strictEqual(summary.blockedTaskId, 'task-two');
      assert.strictEqual(summary.acceptedTasks, 1);
      assert.strictEqual(summary.fixedTasks, 0);
      assert(typeof summary.stoppedReason === 'string' && (summary.stoppedReason as string).length > 0, 'stoppedReason should be set');

      const taskResults = state.taskResults as Record<string, unknown>[];
      assert.strictEqual(taskResults.length, 2);
      assert.strictEqual(taskResults[0].status, 'accepted');

      const taskTwo = taskResults[1];
      assert.strictEqual(taskTwo.status, 'fix_required');
      assert.strictEqual(taskTwo.reviewerGateStatus, 'fix_required');
      assert.strictEqual(taskTwo.fixAttempted, true);
      assert.strictEqual(taskTwo.secondReviewerGateStatus, 'fix_required');
      assert.strictEqual(taskTwo.finalStatus, 'fix_required');
      assert.strictEqual(taskTwo.nextAction, 'manual_followup');

      const output = result.stdout;
      assert(output.includes('Status: blocked'), `CLI output should include blocked status: ${output}`);
      assert(output.includes('task-two: fix_required'), `CLI output should include task-two status: ${output}`);
      assert(output.includes('Stopped reason:'), `CLI output should include stopped reason: ${output}`);

      const stateRaw = JSON.stringify(state);
      assert(!stateRaw.includes('sk-fake-secret'), 'Block state should redact secrets');
      assert(!stateRaw.includes('fix applied'), 'Block state should not contain raw file content');
    } finally {
      cleanup();
    }
  });


  test('max_fix_attempts=2 from block review_policy is passed and no infinite loop on repeated reject', () => {
    const base = createTempBlockEnv();
    const { blockId, blockPath, repoPath, runsDir, cleanup } = base;
    const definition = JSON.parse(readFileSync(base.blockPath, 'utf-8')) as Record<string, unknown>;
    (definition.review_policy as Record<string, unknown>).max_fix_attempts = 2;
    writeFileSync(base.blockPath, JSON.stringify(definition, null, 2), 'utf-8');

    try {
      const beforeLogCount = getGitLogCount(repoPath);
      const result = runCli(['real-block-run-ai', blockPath], baseBlockEnv({
        RUNS_DIR: runsDir,
        REAL_BLOCK_TASK_KIMI_FAKE_RESPONSES: JSON.stringify([
          buildFakeKimiOutput([{ path: 'README.md', content: '# block updated\n' }]),
          buildFakeKimiOutput([{ path: 'feature.txt', content: 'feature\n' }]),
        ]),
        REAL_BLOCK_TASK_REVIEWER_FAKE_RESPONSES: JSON.stringify([
          buildAcceptReview('Task one looks good'),
          buildRejectReview('Needs fix', ['missing fix.txt'], 'add fix.txt'),
        ]),
        REAL_BLOCK_TASK_FIX_KIMI_FAKE_RESPONSES: JSON.stringify([
          null,
          buildFakeKimiOutput([{ path: 'fix.txt', content: 'fix applied\n' }]),
        ]),
        REAL_BLOCK_TASK_SECOND_REVIEWER_FAKE_RESPONSES: JSON.stringify([
          null,
          buildRejectReview('Still needs more', ['still missing more'], 'add more tests'),
        ]),
      }));

      assert.notStrictEqual(result.status, 0, `Expected failure: ${result.stderr}`);
      assert.strictEqual(getGitLogCount(repoPath), beforeLogCount + 3, 'Should create task1, task2 original, and one fix commit only; no infinite loop');

      const state = getBlockState(runsDir, blockId);
      assert(state !== null);
      assert.strictEqual(state.status, 'blocked');
      const summary = state.summary as Record<string, unknown>;
      assert.strictEqual(summary.blockedTaskId, 'task-two');
      assert.strictEqual(summary.acceptedTasks, 1);
      assert.strictEqual(summary.fixedTasks, 0);

      const taskResults = state.taskResults as Record<string, unknown>[];
      assert.strictEqual(taskResults.length, 2);
      assert.strictEqual(taskResults[0].status, 'accepted');

      const taskTwo = taskResults[1];
      assert.strictEqual(taskTwo.status, 'fix_required');
      assert.strictEqual(taskTwo.fixAttempted, true);
      assert.strictEqual(taskTwo.finalStatus, 'fix_required');
      assert.strictEqual(taskTwo.nextAction, 'manual_followup');
    } finally {
      cleanup();
    }
  });

  test('fix execution guardrails failure blocks the block safely', () => {
    const { blockId, blockPath, repoPath, runsDir, cleanup } = createTempBlockEnv();
    try {
      const beforeLogCount = getGitLogCount(repoPath);
      const result = runCli(['real-block-run-ai', blockPath], baseBlockEnv({
        RUNS_DIR: runsDir,
        REAL_BLOCK_TASK_KIMI_FAKE_RESPONSES: JSON.stringify([
          buildFakeKimiOutput([{ path: 'README.md', content: '# block updated\n' }]),
          buildFakeKimiOutput([{ path: 'feature.txt', content: 'feature\n' }]),
        ]),
        REAL_BLOCK_TASK_REVIEWER_FAKE_RESPONSES: JSON.stringify([
          buildAcceptReview('Task one looks good'),
          buildRejectReview('Needs fix', ['missing fix.txt'], 'add fix.txt'),
        ]),
        REAL_BLOCK_TASK_FIX_KIMI_FAKE_RESPONSES: JSON.stringify([
          null,
          buildFakeKimiOutput([{ path: '.env', content: 'SECRET=1\n' }]),
        ]),
      }));

      assert.notStrictEqual(result.status, 0, `Expected failure: ${result.stderr}`);
      assert.strictEqual(getGitLogCount(repoPath), beforeLogCount + 2, 'Should create task1 and task2 original commits only');

      const state = getBlockState(runsDir, blockId);
      assert(state !== null);
      assert.strictEqual(state.status, 'blocked');
      const summary = state.summary as Record<string, unknown>;
      assert.strictEqual(summary.blockedTaskId, 'task-two');
      assert.strictEqual(summary.acceptedTasks, 1);
      assert.strictEqual(summary.fixedTasks, 0);

      const taskResults = state.taskResults as Record<string, unknown>[];
      assert.strictEqual(taskResults.length, 2);
      assert.strictEqual(taskResults[0].status, 'accepted');

      const taskTwo = taskResults[1];
      assert.strictEqual(taskTwo.status, 'blocked');
      assert.strictEqual(taskTwo.reviewerGateStatus, 'fix_required');
      assert.strictEqual(taskTwo.fixAttempted, true);
      assert.strictEqual(taskTwo.fixRunnerStatus, 'blocked');
      assert.strictEqual(taskTwo.finalStatus, 'blocked');
      assert.strictEqual(taskTwo.nextAction, 'block');
      assert(typeof taskTwo.reason === 'string' && (taskTwo.reason as string).includes('guardrails'), `Expected blocked reason: ${taskTwo.reason}`);
    } finally {
      cleanup();
    }
  });

  test('empty allowed_files blocks execution before apply/commit/push', () => {
    const tmpBase = join(process.cwd(), 'tmp');
    if (!existsSync(tmpBase)) {
      mkdirSync(tmpBase);
    }
    const tmpDir = mkdtempSync(join(tmpBase, `rbrai-empty-allowed-${Date.now()}-`));
    const repoPath = join(tmpDir, 'repo');
    const originPath = join(tmpDir, 'origin.git');
    const runsDir = join(tmpDir, 'runs');
    mkdirSync(repoPath);

    writeFileSync(join(repoPath, 'README.md'), '# hello\n', 'utf-8');
    spawnSync('git', ['init'], { cwd: repoPath, encoding: 'utf-8', shell: false });
    spawnSync('git', ['config', 'user.email', 'ci@example.com'], { cwd: repoPath, encoding: 'utf-8', shell: false });
    spawnSync('git', ['config', 'user.name', 'CI User'], { cwd: repoPath, encoding: 'utf-8', shell: false });
    spawnSync('git', ['add', '.'], { cwd: repoPath, encoding: 'utf-8', shell: false });
    spawnSync('git', ['commit', '-m', 'init', '--no-gpg-sign'], { cwd: repoPath, encoding: 'utf-8', shell: false });
    spawnSync('git', ['branch', '-m', 'main'], { cwd: repoPath, encoding: 'utf-8', shell: false });
    spawnSync('git', ['checkout', '-b', 'ai/block-work'], { cwd: repoPath, encoding: 'utf-8', shell: false });
    spawnSync('git', ['init', '--bare', originPath], { encoding: 'utf-8', shell: false });
    spawnSync('git', ['remote', 'add', 'origin', originPath], { cwd: repoPath, encoding: 'utf-8', shell: false });

    const blockId = `block-empty-allowed-${Date.now()}`;
    const blockPath = join(tmpDir, 'block.json');
    const blockDefinition = {
      block_id: blockId,
      title: 'Empty allowed files test',
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
          goal: 'Update README with block content',
          allowed_files: [],
          denied_files: [],
          max_lines_changed: 150,
          checks: [],
        },
      ],
    };
    writeFileSync(blockPath, JSON.stringify(blockDefinition, null, 2), 'utf-8');

    const cleanup = (): void => {
      rmSync(tmpDir, { recursive: true, force: true });
    };

    try {
      const beforeLogCount = getGitLogCount(repoPath);
      const initialReadme = readFileSync(join(repoPath, 'README.md'), 'utf-8');

      const result = runCli(['real-block-run-ai', blockPath], baseBlockEnv({
        RUNS_DIR: runsDir,
        REAL_BLOCK_TASK_KIMI_FAKE_RESPONSES: JSON.stringify([
          buildFakeKimiOutput([{ path: 'README.md', content: '# block updated\n' }]),
        ]),
        REAL_BLOCK_TASK_REVIEWER_FAKE_RESPONSES: JSON.stringify([
          buildAcceptReview('Looks good'),
        ]),
      }));

      const output = result.stdout + result.stderr;
      assert.notStrictEqual(result.status, 0, `Expected failure: ${output}`);
      assert(output.includes('Guardrails failed'), `Expected guardrails failure: ${output}`);
      assert(output.includes('outside allow_modify'), `Expected outside allow_modify reason: ${output}`);
      assert(output.includes('No apply was performed'), `Expected no apply message: ${output}`);
      assert(output.includes('No commit was made'), `Expected no commit message: ${output}`);
      assert(output.includes('No push was performed'), `Expected no push message: ${output}`);
      assert(output.includes('No merge was performed'), `Expected no merge message: ${output}`);
      assert(output.includes('No main touch was performed'), `Expected no main touch message: ${output}`);

      assert.strictEqual(getGitLogCount(repoPath), beforeLogCount, 'No commits should be created');
      assert.strictEqual(
        readFileSync(join(repoPath, 'README.md'), 'utf-8'),
        initialReadme,
        'README.md should not be modified'
      );

      const statusResult = spawnSync('git', ['status', '--porcelain'], {
        cwd: repoPath,
        encoding: 'utf-8',
        shell: false,
      });
      assert.strictEqual(statusResult.stdout.trim(), '', 'Working tree should be clean');

      const state = getBlockState(runsDir, blockId);
      assert(state !== null, 'Block state should be written for failed task');
      assert.notStrictEqual(state.status, 'completed');
      assert.notStrictEqual(state.status, 'pushed');

      const taskResults = state.taskResults as Record<string, unknown>[];
      assert.strictEqual(taskResults.length, 1);
      assert.notStrictEqual(taskResults[0].status, 'accepted');
      assert.notStrictEqual(taskResults[0].status, 'fixed_and_accepted');
      assert.notStrictEqual(taskResults[0].status, 'pushed');

      const remoteRefs = spawnSync('git', ['ls-remote', 'origin'], {
        cwd: repoPath,
        encoding: 'utf-8',
        shell: false,
      });
      assert.strictEqual(remoteRefs.stdout.trim(), '', 'No refs should be pushed to origin');
    } finally {
      cleanup();
    }
  });

  test('reviewer block_for_human stops block without fix attempt', () => {
    const { blockId, blockPath, repoPath, runsDir, cleanup } = createTempBlockEnv();
    try {
      const beforeLogCount = getGitLogCount(repoPath);
      const result = runCli(['real-block-run-ai', blockPath], baseBlockEnv({
        RUNS_DIR: runsDir,
        REAL_BLOCK_TASK_KIMI_FAKE_RESPONSES: JSON.stringify([
          buildFakeKimiOutput([{ path: 'README.md', content: '# block updated\n' }]),
          buildFakeKimiOutput([{ path: 'feature.txt', content: 'feature\n' }]),
        ]),
        REAL_BLOCK_TASK_REVIEWER_FAKE_RESPONSES: JSON.stringify([
          buildAcceptReview('Task one looks good'),
          buildBlockReview('Human review required', ['api_key=fake-reviewer-key']),
        ]),
      }));

      assert.notStrictEqual(result.status, 0, `Expected failure: ${result.stderr}`);
      assert.strictEqual(getGitLogCount(repoPath), beforeLogCount + 2, 'Should create task1 and task2 original commits only');

      const state = getBlockState(runsDir, blockId);
      assert(state !== null);
      assert.strictEqual(state.status, 'blocked');
      assert.strictEqual((state.summary as Record<string, unknown>).blockedTaskId, 'task-two');

      const taskResults = state.taskResults as Record<string, unknown>[];
      assert.strictEqual(taskResults.length, 2);
      assert.strictEqual(taskResults[0].status, 'accepted');

      const taskTwo = taskResults[1];
      assert.strictEqual(taskTwo.status, 'blocked');
      assert.strictEqual(taskTwo.reviewerGateStatus, 'blocked');
      assert.strictEqual(taskTwo.fixAttempted, false);
      assert.strictEqual(taskTwo.finalStatus, 'blocked');
      assert.strictEqual(taskTwo.nextAction, 'block');

      const stateRaw = JSON.stringify(state);
      assert(!stateRaw.includes('api_key=fake-reviewer-key'), 'Block state should redact secrets');
      assert(!stateRaw.includes('runState'), 'Block state should not contain raw executor runState');
    } finally {
      cleanup();
    }
  });

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

  function acceptedTaskResult(
    taskId: string,
    commitSha: string
  ): Record<string, unknown> {
    return {
      taskId,
      title: `Task ${taskId}`,
      status: 'accepted',
      originalCommitSha: commitSha,
      fixAttempted: false,
      reviewerGateStatus: 'accepted',
      finalStatus: 'accepted',
      nextAction: 'continue',
      childStateTaskId: taskId,
    };
  }

  function fixedTaskResult(
    taskId: string,
    originalSha: string,
    fixSha: string
  ): Record<string, unknown> {
    return {
      taskId,
      title: `Task ${taskId}`,
      status: 'fixed_and_accepted',
      originalCommitSha: originalSha,
      fixCommitSha: fixSha,
      fixAttempted: true,
      reviewerGateStatus: 'fix_required',
      fixRunnerStatus: 'executed',
      secondReviewerGateStatus: 'accepted',
      finalStatus: 'accepted',
      nextAction: 'continue',
      childStateTaskId: taskId,
    };
  }

  test('incomplete existing state refuses without resume', () => {
    const { blockId, blockPath, repoPath, runsDir, cleanup } = createTempBlockEnv();
    const partialState = buildBaseState(
      blockId,
      'Test block',
      runsDir,
      'blocked',
      [acceptedTaskResult('task-one', 'a'.repeat(40))]
    );
    writeBlockState(runsDir, blockId, partialState);
    const beforeLogCount = getGitLogCount(repoPath);
    try {
      const result = runCli(['real-block-run-ai', blockPath], baseBlockEnv({ RUNS_DIR: runsDir }));
      assert.notStrictEqual(result.status, 0, `Expected refusal: ${result.stderr}`);
      const output = result.stdout + result.stderr;
      assert(
        output.includes('Enable resume mode') || output.includes('REAL_BLOCK_RUN_RESUME'),
        `Expected resume instructions: ${output}`
      );
      assert.strictEqual(getGitLogCount(repoPath), beforeLogCount, 'No commits should be created');
    } finally {
      cleanup();
    }
  });

  test('completed existing state refuses rerun without resume', () => {
    const { blockId, blockPath, repoPath, runsDir, cleanup } = createTempBlockEnv();
    const completedState = buildBaseState(
      blockId,
      'Test block',
      runsDir,
      'completed',
      [
        acceptedTaskResult('task-one', 'a'.repeat(40)),
        fixedTaskResult('task-two', 'b'.repeat(40), 'c'.repeat(40)),
      ]
    );
    writeBlockState(runsDir, blockId, completedState);
    const beforeLogCount = getGitLogCount(repoPath);
    try {
      const result = runCli(['real-block-run-ai', blockPath], baseBlockEnv({ RUNS_DIR: runsDir }));
      assert.notStrictEqual(result.status, 0, `Expected refusal: ${result.stderr}`);
      const output = result.stdout + result.stderr;
      assert(output.includes('already completed'), `Expected already completed: ${output}`);
      assert.strictEqual(getGitLogCount(repoPath), beforeLogCount, 'No commits should be created');
    } finally {
      cleanup();
    }
  });

  test('resume completes after partial failure without duplicating task 1', () => {
    const { blockId, blockPath, repoPath, runsDir, cleanup } = createTempBlockEnv();
    try {
      const beforeLogCount = getGitLogCount(repoPath);

      // First run: task1 accepted, task2 fails before commit due to invalid Kimi response.
      const firstResult = runCli(['real-block-run-ai', blockPath], baseBlockEnv({
        RUNS_DIR: runsDir,
        REAL_BLOCK_TASK_KIMI_FAKE_RESPONSES: JSON.stringify([
          buildFakeKimiOutput([{ path: 'README.md', content: '# block updated\n' }]),
          'not-valid-json',
        ]),
        REAL_BLOCK_TASK_REVIEWER_FAKE_RESPONSES: JSON.stringify([
          buildAcceptReview('Looks good'),
          null,
        ]),
      }));
      assert.notStrictEqual(firstResult.status, 0, `Expected first run failure: ${firstResult.stderr}`);
      const afterFirstLogCount = getGitLogCount(repoPath);
      assert.strictEqual(afterFirstLogCount, beforeLogCount + 1, 'First run should create only task 1 commit');

      const firstState = getBlockState(runsDir, blockId);
      assert(firstState !== null);
      assert.strictEqual(firstState.status, 'failed');
      const firstTaskOneSha = (firstState.taskResults[0] as Record<string, unknown>).originalCommitSha as string;

      // Resume: task2 now succeeds via fix-loop accepted.
      const resumeResult = runCli(['real-block-run-ai', blockPath, '--resume'], baseBlockEnv({
        RUNS_DIR: runsDir,
        REAL_BLOCK_TASK_KIMI_FAKE_RESPONSES: JSON.stringify([
          buildFakeKimiOutput([{ path: 'README.md', content: '# block updated\n' }]),
          buildFakeKimiOutput([{ path: 'feature.txt', content: 'feature\n' }]),
        ]),
        REAL_BLOCK_TASK_REVIEWER_FAKE_RESPONSES: JSON.stringify([
          buildAcceptReview('Looks good'),
          buildRejectReview('Needs fix', ['missing fix.txt'], 'add fix.txt'),
        ]),
        REAL_BLOCK_TASK_FIX_KIMI_FAKE_RESPONSES: JSON.stringify([
          null,
          buildFakeKimiOutput([{ path: 'fix.txt', content: 'fix applied\n' }]),
        ]),
        REAL_BLOCK_TASK_SECOND_REVIEWER_FAKE_RESPONSES: JSON.stringify([
          null,
          buildAcceptReview('Fix looks good'),
        ]),
      }));
      assert.strictEqual(resumeResult.status, 0, `Expected resume success: ${resumeResult.stderr}`);
      assert.strictEqual(getGitLogCount(repoPath), beforeLogCount + 3, 'Resume should add task2 original+fix, not duplicate task1');

      const resumedState = getBlockState(runsDir, blockId);
      assert(resumedState !== null);
      assert.strictEqual(resumedState.status, 'completed');
      assert.strictEqual(resumedState.resumed, true);
      assert(typeof resumedState.resumeStartedAt === 'string', 'resumeStartedAt should be set');
      assert.strictEqual(resumedState.startedAt, firstState.startedAt, 'Original startedAt should be preserved');

      const summary = resumedState.summary as Record<string, unknown>;
      assert.strictEqual(summary.totalTasks, 2);
      assert.strictEqual(summary.completedTasks, 2);
      assert.strictEqual(summary.acceptedTasks, 1);
      assert.strictEqual(summary.fixedTasks, 1);

      const taskResults = resumedState.taskResults as Record<string, unknown>[];
      assert.strictEqual(taskResults.length, 2);
      assert.strictEqual(taskResults[0].status, 'accepted');
      assert.strictEqual(taskResults[0].originalCommitSha, firstTaskOneSha, 'Task 1 SHA should be preserved');
      assert.strictEqual(taskResults[1].status, 'fixed_and_accepted');

      const output = resumeResult.stdout + resumeResult.stderr;
      assert(output.includes('Resume mode enabled'), `Output should mention resume mode: ${output}`);
      assert(output.includes('Skipped tasks: task-one'), `Output should list skipped task: ${output}`);
      assert(output.includes('Next task: task-two'), `Output should list next task: ${output}`);
    } finally {
      cleanup();
    }
  });

  test('REAL_BLOCK_RUN_RESUME=1 env flag enables resume', () => {
    const { blockId, blockPath, repoPath, runsDir, cleanup } = createTempBlockEnv();
    try {
      const beforeLogCount = getGitLogCount(repoPath);
      runCli(['real-block-run-ai', blockPath], baseBlockEnv({
        RUNS_DIR: runsDir,
        REAL_BLOCK_TASK_KIMI_FAKE_RESPONSES: JSON.stringify([
          buildFakeKimiOutput([{ path: 'README.md', content: '# block updated\n' }]),
          'not-valid-json',
        ]),
        REAL_BLOCK_TASK_REVIEWER_FAKE_RESPONSES: JSON.stringify([
          buildAcceptReview('Looks good'),
          null,
        ]),
      }));

      const resumeResult = runCli(['real-block-run-ai', blockPath], baseBlockEnv({
        RUNS_DIR: runsDir,
        REAL_BLOCK_RUN_RESUME: '1',
        REAL_BLOCK_TASK_KIMI_FAKE_RESPONSES: JSON.stringify([
          buildFakeKimiOutput([{ path: 'README.md', content: '# block updated\n' }]),
          buildFakeKimiOutput([{ path: 'feature.txt', content: 'feature\n' }]),
        ]),
        REAL_BLOCK_TASK_REVIEWER_FAKE_RESPONSES: JSON.stringify([
          buildAcceptReview('Looks good'),
          buildAcceptReview('Task two looks good'),
        ]),
      }));
      assert.strictEqual(resumeResult.status, 0, `Expected resume success: ${resumeResult.stderr}`);
      assert.strictEqual(getGitLogCount(repoPath), beforeLogCount + 2, 'Resume should create task2 commit only');
    } finally {
      cleanup();
    }
  });

  test('resume on completed state exits 0 without rerun', () => {
    const { blockId, blockPath, repoPath, runsDir, cleanup } = createTempBlockEnv();
    const completedState = buildBaseState(
      blockId,
      'Test block',
      runsDir,
      'completed',
      [
        acceptedTaskResult('task-one', 'a'.repeat(40)),
        acceptedTaskResult('task-two', 'b'.repeat(40)),
      ]
    );
    writeBlockState(runsDir, blockId, completedState);
    const beforeLogCount = getGitLogCount(repoPath);
    try {
      const result = runCli(['real-block-run-ai', blockPath, '--resume'], baseBlockEnv({ RUNS_DIR: runsDir }));
      assert.strictEqual(result.status, 0, `Expected no-op success: ${result.stderr}`);
      assert.strictEqual(getGitLogCount(repoPath), beforeLogCount, 'No commits should be created');
      assert(result.stdout.includes('already completed') || result.stderr.includes('already completed'), `Expected already completed message: ${result.stdout}${result.stderr}`);
    } finally {
      cleanup();
    }
  });

  test('resume blocks safely on unknown task id in existing state', () => {
    const { blockId, blockPath, repoPath, runsDir, cleanup } = createTempBlockEnv();
    const badState = buildBaseState(
      blockId,
      'Test block',
      runsDir,
      'blocked',
      [
        acceptedTaskResult('task-one', 'a'.repeat(40)),
        {
          taskId: 'unknown-task',
          title: 'Unknown',
          status: 'accepted',
          originalCommitSha: 'b'.repeat(40),
          fixAttempted: false,
          finalStatus: 'accepted',
          nextAction: 'continue',
          childStateTaskId: 'unknown-task',
        },
      ]
    );
    writeBlockState(runsDir, blockId, badState);
    const beforeLogCount = getGitLogCount(repoPath);
    try {
      const result = runCli(['real-block-run-ai', blockPath, '--resume'], baseBlockEnv({ RUNS_DIR: runsDir }));
      assert.notStrictEqual(result.status, 0, `Expected safe failure: ${result.stderr}`);
      const output = result.stdout + result.stderr;
      assert(output.includes('unknown task id'), `Expected unknown task id error: ${output}`);
      assert.strictEqual(getGitLogCount(repoPath), beforeLogCount, 'No commits should be created');
    } finally {
      cleanup();
    }
  });

  test('resume blocks safely on mismatched block_id in existing state', () => {
    const { blockId, blockPath, repoPath, runsDir, cleanup } = createTempBlockEnv();
    const badState = buildBaseState(
      'different-block-id',
      'Test block',
      runsDir,
      'blocked',
      [acceptedTaskResult('task-one', 'a'.repeat(40))]
    );
    writeBlockState(runsDir, blockId, badState);
    const beforeLogCount = getGitLogCount(repoPath);
    try {
      const result = runCli(['real-block-run-ai', blockPath, '--resume'], baseBlockEnv({ RUNS_DIR: runsDir }));
      assert.notStrictEqual(result.status, 0, `Expected safe failure: ${result.stderr}`);
      const output = result.stdout + result.stderr;
      assert(output.includes('does not match block_id'), `Expected block_id mismatch error: ${output}`);
      assert.strictEqual(getGitLogCount(repoPath), beforeLogCount, 'No commits should be created');
    } finally {
      cleanup();
    }
  });

  test('resume blocks safely when accepted task is missing commit SHA', () => {
    const { blockId, blockPath, repoPath, runsDir, cleanup } = createTempBlockEnv();
    const badResult = acceptedTaskResult('task-one', 'a'.repeat(40));
    delete badResult.originalCommitSha;
    const badState = buildBaseState(
      blockId,
      'Test block',
      runsDir,
      'blocked',
      [badResult]
    );
    writeBlockState(runsDir, blockId, badState);
    const beforeLogCount = getGitLogCount(repoPath);
    try {
      const result = runCli(['real-block-run-ai', blockPath, '--resume'], baseBlockEnv({ RUNS_DIR: runsDir }));
      assert.notStrictEqual(result.status, 0, `Expected safe failure: ${result.stderr}`);
      const output = result.stdout + result.stderr;
      assert(output.includes('completed task without valid commit SHA'), `Expected missing SHA error: ${output}`);
      assert.strictEqual(getGitLogCount(repoPath), beforeLogCount, 'No commits should be created');
    } finally {
      cleanup();
    }
  });

  test('resume blocks safely on corrupt state file', () => {
    const { blockId, blockPath, repoPath, runsDir, cleanup } = createTempBlockEnv();
    const dir = join(runsDir, 'block', blockId);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(join(dir, 'state.json'), JSON.stringify('not a valid state object'), 'utf-8');
    const beforeLogCount = getGitLogCount(repoPath);
    try {
      const result = runCli(['real-block-run-ai', blockPath, '--resume'], baseBlockEnv({ RUNS_DIR: runsDir }));
      assert.notStrictEqual(result.status, 0, `Expected safe failure: ${result.stderr}`);
      const output = result.stdout + result.stderr;
      assert(output.includes('not a valid object'), `Expected invalid state error: ${output}`);
      assert.strictEqual(getGitLogCount(repoPath), beforeLogCount, 'No commits should be created');
    } finally {
      cleanup();
    }
  });

  test('missing provider flag blocks before mutation', () => {
    const { blockId, blockPath, repoPath, runsDir, cleanup } = createTempBlockEnv();
    const beforeLogCount = getGitLogCount(repoPath);
    try {
      const result = runCli(['real-block-run-ai', blockPath], {
        RUNS_DIR: runsDir,
        ALLOW_REAL_BLOCK_RUN_AI: 'true',
        ALLOW_REAL_REPO_APPLY: 'true',
        ALLOW_REAL_REPO_COMMIT: 'true',
        ALLOW_REAL_REPO_PUSH: 'true',
        KIMI_API_KEY: 'fake',
        KIMI_BASE_URL: 'http://localhost:9999',
      });
      assert.notStrictEqual(result.status, 0, `Expected refusal: ${result.stderr}`);
      const output = result.stdout + result.stderr;
      assert(output.includes('ALLOW_REAL_PROVIDER'), `Expected provider flag refusal: ${output}`);
      assert(result.stderr.includes('No provider call was made'), `Expected no provider call: ${result.stderr}`);
      assert.strictEqual(getGitLogCount(repoPath), beforeLogCount, 'No commits should be created');
      assert.strictEqual(getBlockState(runsDir, blockId), null, 'No block state should be written');
    } finally {
      cleanup();
    }
  });

  test('missing KIMI_API_KEY blocks before mutation', () => {
    const { blockId, blockPath, repoPath, runsDir, cleanup } = createTempBlockEnv();
    const beforeLogCount = getGitLogCount(repoPath);
    try {
      const result = runCli(['real-block-run-ai', blockPath], baseBlockEnv({
        RUNS_DIR: runsDir,
        KIMI_API_KEY: '',
      }));
      assert.notStrictEqual(result.status, 0, `Expected refusal: ${result.stderr}`);
      const output = result.stdout + result.stderr;
      assert(output.includes('KIMI_API_KEY'), `Expected KIMI_API_KEY refusal: ${output}`);
      assert.strictEqual(getGitLogCount(repoPath), beforeLogCount, 'No commits should be created');
      assert.strictEqual(getBlockState(runsDir, blockId), null, 'No block state should be written');
    } finally {
      cleanup();
    }
  });

  test('invalid block JSON blocks before mutation', () => {
    const { blockPath, repoPath, runsDir, cleanup, blockId } = createTempBlockEnv();
    writeFileSync(blockPath, 'not-valid-json', 'utf-8');
    const beforeLogCount = getGitLogCount(repoPath);
    try {
      const result = runCli(['real-block-run-ai', blockPath], baseBlockEnv({ RUNS_DIR: runsDir }));
      assert.notStrictEqual(result.status, 0, `Expected refusal: ${result.stderr}`);
      const output = result.stdout + result.stderr;
      assert(output.includes('JSON') || output.includes('json'), `Expected JSON error: ${output}`);
      assert.strictEqual(getGitLogCount(repoPath), beforeLogCount, 'No commits should be created');
      assert.strictEqual(getBlockState(runsDir, blockId), null, 'No block state should be written');
    } finally {
      cleanup();
    }
  });

  test('non-git repo path blocks before mutation', () => {
    const { blockPath, repoPath, runsDir, cleanup, tmpDir, blockId } = createTempBlockEnv();
    const nonGitPath = join(tmpDir, 'not-a-repo');
    mkdirSync(nonGitPath);
    const definition = JSON.parse(readFileSync(blockPath, 'utf-8')) as Record<string, unknown>;
    definition.repo_path = nonGitPath.replace(/\\/g, '/');
    writeFileSync(blockPath, JSON.stringify(definition, null, 2), 'utf-8');
    const beforeLogCount = getGitLogCount(repoPath);
    try {
      const result = runCli(['real-block-run-ai', blockPath], baseBlockEnv({ RUNS_DIR: runsDir }));
      assert.notStrictEqual(result.status, 0, `Expected refusal: ${result.stderr}`);
      const output = result.stdout + result.stderr;
      assert(output.includes('not a git repository'), `Expected non-git error: ${output}`);
      assert.strictEqual(getGitLogCount(repoPath), beforeLogCount, 'No commits should be created');
      assert.strictEqual(getBlockState(runsDir, blockId), null, 'No block state should be written');
    } finally {
      cleanup();
    }
  });

  test('invalid branch config blocks before mutation', () => {
    const { blockPath, repoPath, runsDir, cleanup, blockId } = createTempBlockEnv();
    const definition = JSON.parse(readFileSync(blockPath, 'utf-8')) as Record<string, unknown>;
    definition.work_branch = 'main';
    writeFileSync(blockPath, JSON.stringify(definition, null, 2), 'utf-8');
    const beforeLogCount = getGitLogCount(repoPath);
    try {
      const result = runCli(['real-block-run-ai', blockPath], baseBlockEnv({ RUNS_DIR: runsDir }));
      assert.notStrictEqual(result.status, 0, `Expected refusal: ${result.stderr}`);
      const output = result.stdout + result.stderr;
      assert(output.includes('work_branch'), `Expected branch config error: ${output}`);
      assert.strictEqual(getGitLogCount(repoPath), beforeLogCount, 'No commits should be created');
      assert.strictEqual(getBlockState(runsDir, blockId), null, 'No block state should be written');
    } finally {
      cleanup();
    }
  });

  test('fake response array length mismatch blocks before mutation', () => {
    const { blockId, blockPath, repoPath, runsDir, cleanup } = createTempBlockEnv();
    const beforeLogCount = getGitLogCount(repoPath);
    try {
      const result = runCli(['real-block-run-ai', blockPath], baseBlockEnv({
        RUNS_DIR: runsDir,
        REAL_BLOCK_TASK_KIMI_FAKE_RESPONSES: JSON.stringify(['only-one']),
      }));
      assert.notStrictEqual(result.status, 0, `Expected refusal: ${result.stderr}`);
      const output = result.stdout + result.stderr;
      assert(output.includes('length'), `Expected length mismatch error: ${output}`);
      assert.strictEqual(getGitLogCount(repoPath), beforeLogCount, 'No commits should be created');
      assert.strictEqual(getBlockState(runsDir, blockId), null, 'No block state should be written');
    } finally {
      cleanup();
    }
  });

  test('readiness failure output is JSON parseable', () => {
    const { blockPath, runsDir, cleanup, blockId } = createTempBlockEnv();
    try {
      const result = runCli(['real-block-run-ai', blockPath], {
        RUNS_DIR: runsDir,
        ALLOW_REAL_BLOCK_RUN_AI: 'true',
        ALLOW_REAL_REPO_APPLY: 'true',
        ALLOW_REAL_REPO_COMMIT: 'true',
        ALLOW_REAL_REPO_PUSH: 'true',
        KIMI_API_KEY: 'fake',
        KIMI_BASE_URL: 'http://localhost:9999',
      });
      assert.notStrictEqual(result.status, 0);
      const report = JSON.parse(result.stdout) as Record<string, unknown>;
      assert.strictEqual(report.ready, false);
      assert(Array.isArray(report.reasons));
      assert.strictEqual(getBlockState(runsDir, blockId), null, 'No block state should be written');
    } finally {
      cleanup();
    }
  });

  test('readiness failure output redacts secrets', () => {
    const { blockPath, runsDir, cleanup, tmpDir, blockId } = createTempBlockEnv();
    const definition = JSON.parse(readFileSync(blockPath, 'utf-8')) as Record<string, unknown>;
    definition.block_id = 'block-sk-fake-run-secret';
    definition.repo_path = join(tmpDir, 'repo-sk-fake-run-secret').replace(/\\/g, '/');
    writeFileSync(blockPath, JSON.stringify(definition, null, 2), 'utf-8');
    try {
      const result = runCli(['real-block-run-ai', blockPath], baseBlockEnv({ RUNS_DIR: runsDir }));
      assert.notStrictEqual(result.status, 0);
      const output = result.stdout + result.stderr;
      assert(!output.includes('sk-fake-run-secret'), 'Secret should be redacted in output');
      assert.strictEqual(getBlockState(runsDir, blockId), null, 'No block state should be written');
    } finally {
      cleanup();
    }
  });

  test('readiness failure does not spawn child runner', () => {
    const { blockPath, repoPath, runsDir, cleanup, blockId } = createTempBlockEnv();
    const beforeLogCount = getGitLogCount(repoPath);
    try {
      const result = runCli(['real-block-run-ai', blockPath], {
        RUNS_DIR: runsDir,
        ALLOW_REAL_BLOCK_RUN_AI: 'true',
        ALLOW_REAL_REPO_APPLY: 'true',
        ALLOW_REAL_REPO_COMMIT: 'true',
        ALLOW_REAL_REPO_PUSH: 'true',
        KIMI_API_KEY: 'fake',
        KIMI_BASE_URL: 'http://localhost:9999',
      });
      assert.notStrictEqual(result.status, 0);
      assert.strictEqual(getGitLogCount(repoPath), beforeLogCount, 'No commits should be created');
      assert.strictEqual(getBlockState(runsDir, blockId), null, 'No block state should be written');
      const childRunDir = join(runsDir, 'task-one');
      assert(!existsSync(childRunDir), 'No child task run state should be written');
    } finally {
      cleanup();
    }
  });

  test('completed state resume exits 0 without provider env', () => {
    const { blockId, blockPath, repoPath, runsDir, cleanup } = createTempBlockEnv();
    const completedState = buildBaseState(
      blockId,
      'Test block',
      runsDir,
      'completed',
      [
        acceptedTaskResult('task-one', 'a'.repeat(40)),
        acceptedTaskResult('task-two', 'b'.repeat(40)),
      ]
    );
    writeBlockState(runsDir, blockId, completedState);
    const beforeLogCount = getGitLogCount(repoPath);
    try {
      const result = runCli(['real-block-run-ai', blockPath, '--resume'], {
        RUNS_DIR: runsDir,
        ALLOW_REAL_BLOCK_RUN_AI: 'true',
      });
      assert.strictEqual(result.status, 0, `Expected no-op success: ${result.stderr}`);
      assert.strictEqual(getGitLogCount(repoPath), beforeLogCount, 'No commits should be created');
      const output = result.stdout + result.stderr;
      assert(output.includes('already completed'), `Expected already completed message: ${output}`);
    } finally {
      cleanup();
    }
  });

  test('generated per-task tasks.yaml contains context_files from allowed_files', () => {
    const { blockId, blockPath, runsDir, cleanup } = createTempBlockEnvWithTaskIds(['task-one']);
    try {
      const result = runCli(['real-block-run-ai', blockPath], baseBlockEnv({
        RUNS_DIR: runsDir,
        REAL_BLOCK_TASK_KIMI_FAKE_RESPONSES: JSON.stringify([
          buildFakeKimiOutput([{ path: 'README.md', content: '# block updated\n' }]),
        ]),
        REAL_BLOCK_TASK_REVIEWER_FAKE_RESPONSES: JSON.stringify([
          buildAcceptReview('Looks good'),
        ]),
      }));
      assert.strictEqual(result.status, 0, `Expected success: ${result.stderr}`);
      const tasksFilePath = join(runsDir, 'block', blockId, 'task-one.tasks.yaml');
      assert(existsSync(tasksFilePath), 'Per-task tasks.yaml should be written');
      const tasksObject = JSON.parse(readFileSync(tasksFilePath, 'utf-8')) as Record<string, unknown>;
      const task = (tasksObject.tasks as Record<string, unknown>[])[0];
      assert(Array.isArray(task.context_files), 'context_files should be an array');
      assert((task.context_files as string[]).includes('README.md'), 'context_files should include README.md');
      assert.strictEqual((task.context_files as string[]).length, 1, 'context_files should match allowed_files length');
    } finally {
      cleanup();
    }
  });

  function writeChildRunState(
    runsDir: string,
    taskId: string,
    state: Record<string, unknown>
  ): void {
    const runDir = join(runsDir, 'tasks', taskId);
    if (!existsSync(runDir)) {
      mkdirSync(runDir, { recursive: true });
    }
    writeFileSync(join(runDir, 'state.json'), JSON.stringify(state, null, 2), 'utf-8');
  }

  function buildChildAcceptedState(
    taskId: string,
    repoPath: string,
    commitSha: string
  ): Record<string, unknown> {
    const now = new Date().toISOString();
    return {
      task_id: taskId,
      status: 'pushed',
      current_attempt: 1,
      branch: 'ai/block-work',
      repo_path: repoPath.replace(/\\/g, '/'),
      created_at: now,
      updated_at: now,
      commit_sha: commitSha,
      pushed_remote: 'origin',
      pushed_ref: 'ai/block-work',
      reviewer_gate: {
        status: 'accepted',
        source: 'reviewer',
        nextAction: 'continue',
        blockingIssues: [],
        nonBlockingIssues: [],
        reviewSummary: 'Looks good',
      },
    };
  }

  function buildChildFixedState(
    taskId: string,
    repoPath: string,
    originalSha: string,
    fixSha: string,
    fixCheckSummary?: Record<string, unknown>
  ): Record<string, unknown> {
    const base = buildChildAcceptedState(taskId, repoPath, originalSha);
    return {
      ...base,
      reviewer_gate: {
        status: 'fix_required',
        source: 'reviewer',
        nextAction: 'fix',
        blockingIssues: ['needs fix'],
        nonBlockingIssues: [],
        reviewSummary: 'Needs fix',
        fixTask: 'apply fix',
      },
      reviewer_fix_task_second_review: {
        fixTaskId: `fix-${taskId}-reviewer-1`,
        parentTaskId: taskId,
        attempt: 1,
        fixCommitSha: fixSha,
        reviewerGate: {
          status: 'accepted',
          source: 'reviewer',
          nextAction: 'continue',
          blockingIssues: [],
          nonBlockingIssues: [],
          reviewSummary: 'Fix looks good',
        },
        checkSummary: fixCheckSummary,
        finalStatus: 'accepted',
        nextAction: 'continue',
        reason: 'Second reviewer gate accepted the fix commit.',
      },
    };
  }

  function buildChildFixRequiredState(
    taskId: string,
    repoPath: string,
    originalSha: string
  ): Record<string, unknown> {
    const base = buildChildAcceptedState(taskId, repoPath, originalSha);
    return {
      ...base,
      reviewer_gate: {
        status: 'fix_required',
        source: 'reviewer',
        nextAction: 'fix',
        blockingIssues: ['needs fix'],
        nonBlockingIssues: [],
        reviewSummary: 'Needs fix',
        fixTask: 'apply fix',
      },
    };
  }

  test('resume with no existing state starts fresh and completes', () => {
    const { blockId, blockPath, repoPath, runsDir, cleanup } = createTempBlockEnv();
    try {
      const beforeLogCount = getGitLogCount(repoPath);
      const result = runCli(['real-block-run-ai', blockPath, '--resume'], baseBlockEnv({
        RUNS_DIR: runsDir,
        REAL_BLOCK_TASK_KIMI_FAKE_RESPONSES: JSON.stringify([
          buildFakeKimiOutput([{ path: 'README.md', content: '# block updated\n' }]),
          buildFakeKimiOutput([{ path: 'feature.txt', content: 'feature\n' }]),
        ]),
        REAL_BLOCK_TASK_REVIEWER_FAKE_RESPONSES: JSON.stringify([
          buildAcceptReview('Task one looks good'),
          buildRejectReview('Needs fix', ['missing fix.txt'], 'add fix.txt'),
        ]),
        REAL_BLOCK_TASK_FIX_KIMI_FAKE_RESPONSES: JSON.stringify([
          null,
          buildFakeKimiOutput([{ path: 'fix.txt', content: 'fix applied\n' }]),
        ]),
        REAL_BLOCK_TASK_SECOND_REVIEWER_FAKE_RESPONSES: JSON.stringify([
          null,
          buildAcceptReview('Fix looks good'),
        ]),
      }));
      assert.strictEqual(result.status, 0, `Expected success: ${result.stderr}`);
      assert.strictEqual(getGitLogCount(repoPath), beforeLogCount + 3, 'Fresh resume should create task1, task2 original, and fix commits');
      const state = getBlockState(runsDir, blockId);
      assert(state !== null);
      assert.strictEqual(state.status, 'completed');
      const summary = state.summary as Record<string, unknown>;
      assert.strictEqual(summary.totalTasks, 2);
      assert.strictEqual(summary.completedTasks, 2);
      assert.strictEqual(summary.acceptedTasks, 1);
      assert.strictEqual(summary.fixedTasks, 1);
    } finally {
      cleanup();
    }
  });

  test('resume finalizes fixed_and_accepted task from child state without duplicate commits', () => {
    const { blockId, blockPath, repoPath, runsDir, baseSha, cleanup } = createTempBlockEnv();
    const originalSha = createCommit(repoPath, 'task-two original', { 'task-two.txt': 'original' });
    const fixSha = createCommit(repoPath, 'task-two fix', { 'task-two.txt': 'fixed' });
    const checkSummary = {
      typecheck: 'pass',
      build: 'pass',
      test: 'pass',
      tests: { total: 3, suites: 0, failures: 0 },
    };
    const partialState = buildBaseState(
      blockId,
      'Test block',
      runsDir,
      'blocked',
      [acceptedTaskResult('task-one', baseSha)]
    );
    writeBlockState(runsDir, blockId, partialState);
    writeChildRunState(runsDir, 'task-two', buildChildFixedState('task-two', repoPath, originalSha, fixSha, checkSummary));

    try {
      const beforeLogCount = getGitLogCount(repoPath);
      const result = runCli(['real-block-run-ai', blockPath, '--resume'], baseBlockEnv({ RUNS_DIR: runsDir }));
      assert.strictEqual(result.status, 0, `Expected resume success: ${result.stderr}`);
      assert.strictEqual(getGitLogCount(repoPath), beforeLogCount, 'Resume should not create any new commits');

      const state = getBlockState(runsDir, blockId);
      assert(state !== null);
      assert.strictEqual(state.status, 'completed');
      assert.strictEqual(state.resumed, true);

      const summary = state.summary as Record<string, unknown>;
      assert.strictEqual(summary.totalTasks, 2);
      assert.strictEqual(summary.completedTasks, 2);
      assert.strictEqual(summary.acceptedTasks, 1);
      assert.strictEqual(summary.fixedTasks, 1);

      const taskResults = state.taskResults as Record<string, unknown>[];
      assert.strictEqual(taskResults.length, 2);
      assert.strictEqual(taskResults[0].status, 'accepted');

      const taskTwo = taskResults[1];
      assert.strictEqual(taskTwo.status, 'fixed_and_accepted');
      assert.strictEqual(taskTwo.originalCommitSha, originalSha);
      assert.strictEqual(taskTwo.fixCommitSha, fixSha);
      assert.deepStrictEqual(taskTwo.fixCheckSummary, checkSummary);

      const reportResult = runCli(['real-block-run-ai-report', state.statePath as string], baseBlockEnv({ RUNS_DIR: runsDir }));
      assert.strictEqual(reportResult.status, 0, `Report should succeed: ${reportResult.stderr}`);
      const reportOutput = reportResult.stdout;
      assert(reportOutput.includes('task-two — fixed_and_accepted'), `Report should show fixed task: ${reportOutput}`);
      assert(reportOutput.includes('fixCommitSha:'), `Report should include fixCommitSha: ${reportOutput}`);
      assert(reportOutput.includes(fixSha), `Report should include fix SHA: ${reportOutput}`);
      assert(reportOutput.includes('fixCheckSummary:'), `Report should include fixCheckSummary: ${reportOutput}`);
      assert(reportOutput.includes('typecheck: pass'), `Report should include check summary: ${reportOutput}`);

      const stateRaw = JSON.stringify(state);
      assert(!stateRaw.includes('sk-fake-secret'), 'State should not leak secrets');
    } finally {
      cleanup();
    }
  });

  test('resume blocks safely on incomplete child state for pending task', () => {
    const { blockId, blockPath, repoPath, runsDir, baseSha, cleanup } = createTempBlockEnv();
    const originalSha = 'b'.repeat(40);
    const partialState = buildBaseState(
      blockId,
      'Test block',
      runsDir,
      'blocked',
      [acceptedTaskResult('task-one', baseSha)]
    );
    writeBlockState(runsDir, blockId, partialState);
    writeChildRunState(runsDir, 'task-two', buildChildFixRequiredState('task-two', repoPath, originalSha));

    try {
      const beforeLogCount = getGitLogCount(repoPath);
      const result = runCli(['real-block-run-ai', blockPath, '--resume'], baseBlockEnv({ RUNS_DIR: runsDir }));
      assert.notStrictEqual(result.status, 0, `Expected safe failure: ${result.stderr}`);
      assert.strictEqual(getGitLogCount(repoPath), beforeLogCount, 'No new commits should be created');

      const state = getBlockState(runsDir, blockId);
      assert(state !== null);
      assert.strictEqual(state.status, 'blocked');
      const summary = state.summary as Record<string, unknown>;
      assert.strictEqual(summary.blockedTaskId, 'task-two');
      const output = result.stdout + result.stderr;
      assert(output.includes('incomplete child state'), `Expected incomplete child state message: ${output}`);
      assert(output.includes('No provider call was made'), `Expected no provider call message: ${output}`);
    } finally {
      cleanup();
    }
  });

  function writeCorruptChildRunState(
    runsDir: string,
    taskId: string,
    content: string
  ): void {
    const runDir = join(runsDir, 'tasks', taskId);
    if (!existsSync(runDir)) {
      mkdirSync(runDir, { recursive: true });
    }
    writeFileSync(join(runDir, 'state.json'), content, 'utf-8');
  }

  function buildChildAcceptedStateMissingSha(
    taskId: string,
    repoPath: string
  ): Record<string, unknown> {
    const state = buildChildAcceptedState(taskId, repoPath, 'placeholder');
    delete (state as Record<string, unknown>).commit_sha;
    return state;
  }

  function buildChildFixedStateMissingFixSha(
    taskId: string,
    repoPath: string,
    originalSha: string
  ): Record<string, unknown> {
    const state = buildChildFixedState(taskId, repoPath, originalSha, 'placeholder');
    const secondReview = state.reviewer_fix_task_second_review as Record<string, unknown>;
    delete secondReview.fixCommitSha;
    return state;
  }

  test('resume blocks safely on corrupted child state JSON', () => {
    const { blockId, blockPath, repoPath, runsDir, baseSha, cleanup } = createTempBlockEnv();
    const partialState = buildBaseState(
      blockId,
      'Test block',
      runsDir,
      'blocked',
      [acceptedTaskResult('task-one', baseSha)]
    );
    writeBlockState(runsDir, blockId, partialState);
    writeCorruptChildRunState(runsDir, 'task-two', '{ not valid json');

    try {
      const beforeLogCount = getGitLogCount(repoPath);
      const result = runCli(['real-block-run-ai', blockPath, '--resume'], baseBlockEnv({ RUNS_DIR: runsDir }));
      assert.notStrictEqual(result.status, 0, `Expected safe failure: ${result.stderr}`);
      assert.strictEqual(getGitLogCount(repoPath), beforeLogCount, 'No commits should be created');

      const state = getBlockState(runsDir, blockId);
      assert(state !== null);
      assert.strictEqual(state.status, 'blocked');
      const summary = state.summary as Record<string, unknown>;
      assert.strictEqual(summary.blockedTaskId, 'task-two');

      const output = result.stdout + result.stderr;
      assert(output.includes('Corrupted child state'), `Expected corrupted child state message: ${output}`);
      assert(output.includes('No provider call was made'), `Expected no provider call message: ${output}`);
    } finally {
      cleanup();
    }
  });

  test('resume blocks safely on corrupted block state JSON before provider call', () => {
    const { blockId, blockPath, repoPath, runsDir, cleanup } = createTempBlockEnv();
    const dir = join(runsDir, 'block', blockId);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(join(dir, 'state.json'), '{ invalid block state', 'utf-8');

    try {
      const beforeLogCount = getGitLogCount(repoPath);
      const result = runCli(['real-block-run-ai', blockPath, '--resume'], baseBlockEnv({ RUNS_DIR: runsDir }));
      assert.notStrictEqual(result.status, 0, `Expected safe failure: ${result.stderr}`);
      assert.strictEqual(getGitLogCount(repoPath), beforeLogCount, 'No commits should be created');

      const output = result.stdout + result.stderr;
      assert(output.includes('valid JSON'), `Expected invalid JSON message: ${output}`);
      assert(output.includes('No provider call was made'), `Expected no provider call message: ${output}`);
    } finally {
      cleanup();
    }
  });

  test('resume blocks safely when child state task_id mismatches expected task', () => {
    const { blockId, blockPath, repoPath, runsDir, baseSha, cleanup } = createTempBlockEnv();
    const partialState = buildBaseState(
      blockId,
      'Test block',
      runsDir,
      'blocked',
      [acceptedTaskResult('task-one', baseSha)]
    );
    writeBlockState(runsDir, blockId, partialState);
    writeChildRunState(runsDir, 'task-two', buildChildAcceptedState('wrong-task', repoPath, 'b'.repeat(40)));

    try {
      const beforeLogCount = getGitLogCount(repoPath);
      const result = runCli(['real-block-run-ai', blockPath, '--resume'], baseBlockEnv({ RUNS_DIR: runsDir }));
      assert.notStrictEqual(result.status, 0, `Expected safe failure: ${result.stderr}`);
      assert.strictEqual(getGitLogCount(repoPath), beforeLogCount, 'No commits should be created');

      const state = getBlockState(runsDir, blockId);
      assert(state !== null);
      assert.strictEqual(state.status, 'blocked');
      const summary = state.summary as Record<string, unknown>;
      assert.strictEqual(summary.blockedTaskId, 'task-two');

      const output = result.stdout + result.stderr;
      assert(output.includes('task_id mismatch'), `Expected task_id mismatch message: ${output}`);
      assert(output.includes('No provider call was made'), `Expected no provider call message: ${output}`);
    } finally {
      cleanup();
    }
  });

  test('resume blocks safely when child state repo_path mismatches block repo_path', () => {
    const { blockId, blockPath, repoPath, runsDir, tmpDir, baseSha, cleanup } = createTempBlockEnv();
    const partialState = buildBaseState(
      blockId,
      'Test block',
      runsDir,
      'blocked',
      [acceptedTaskResult('task-one', baseSha)]
    );
    writeBlockState(runsDir, blockId, partialState);
    const foreignRepoPath = join(tmpDir, 'foreign-repo');
    writeChildRunState(runsDir, 'task-two', buildChildAcceptedState('task-two', foreignRepoPath, 'b'.repeat(40)));

    try {
      const beforeLogCount = getGitLogCount(repoPath);
      const result = runCli(['real-block-run-ai', blockPath, '--resume'], baseBlockEnv({ RUNS_DIR: runsDir }));
      assert.notStrictEqual(result.status, 0, `Expected safe failure: ${result.stderr}`);
      assert.strictEqual(getGitLogCount(repoPath), beforeLogCount, 'No commits should be created');

      const state = getBlockState(runsDir, blockId);
      assert(state !== null);
      assert.strictEqual(state.status, 'blocked');
      const summary = state.summary as Record<string, unknown>;
      assert.strictEqual(summary.blockedTaskId, 'task-two');

      const output = result.stdout + result.stderr;
      assert(output.includes('repo_path mismatch'), `Expected repo_path mismatch message: ${output}`);
      assert(output.includes('No provider call was made'), `Expected no provider call message: ${output}`);
    } finally {
      cleanup();
    }
  });

  test('resume blocks safely when completed accepted child state is missing commit_sha', () => {
    const { blockId, blockPath, repoPath, runsDir, baseSha, cleanup } = createTempBlockEnv();
    const partialState = buildBaseState(
      blockId,
      'Test block',
      runsDir,
      'blocked',
      [acceptedTaskResult('task-one', baseSha)]
    );
    writeBlockState(runsDir, blockId, partialState);
    writeChildRunState(runsDir, 'task-two', buildChildAcceptedStateMissingSha('task-two', repoPath));

    try {
      const beforeLogCount = getGitLogCount(repoPath);
      const result = runCli(['real-block-run-ai', blockPath, '--resume'], baseBlockEnv({ RUNS_DIR: runsDir }));
      assert.notStrictEqual(result.status, 0, `Expected safe failure: ${result.stderr}`);
      assert.strictEqual(getGitLogCount(repoPath), beforeLogCount, 'No commits should be created');

      const state = getBlockState(runsDir, blockId);
      assert(state !== null);
      assert.strictEqual(state.status, 'blocked');
      const summary = state.summary as Record<string, unknown>;
      assert.strictEqual(summary.blockedTaskId, 'task-two');

      const output = result.stdout + result.stderr;
      assert(output.includes('missing a valid original commit SHA'), `Expected missing original SHA message: ${output}`);
      assert(output.includes('No provider call was made'), `Expected no provider call message: ${output}`);
    } finally {
      cleanup();
    }
  });

  test('resume blocks safely when completed fixed child state is missing fixCommitSha', () => {
    const { blockId, blockPath, repoPath, runsDir, baseSha, cleanup } = createTempBlockEnv();
    const originalSha = createCommit(repoPath, 'task-two original', { 'task-two.txt': 'original' });
    const partialState = buildBaseState(
      blockId,
      'Test block',
      runsDir,
      'blocked',
      [acceptedTaskResult('task-one', baseSha)]
    );
    writeBlockState(runsDir, blockId, partialState);
    writeChildRunState(runsDir, 'task-two', buildChildFixedStateMissingFixSha('task-two', repoPath, originalSha));

    try {
      const beforeLogCount = getGitLogCount(repoPath);
      const result = runCli(['real-block-run-ai', blockPath, '--resume'], baseBlockEnv({ RUNS_DIR: runsDir }));
      assert.notStrictEqual(result.status, 0, `Expected safe failure: ${result.stderr}`);
      assert.strictEqual(getGitLogCount(repoPath), beforeLogCount, 'No commits should be created');

      const state = getBlockState(runsDir, blockId);
      assert(state !== null);
      assert.strictEqual(state.status, 'blocked');
      const summary = state.summary as Record<string, unknown>;
      assert.strictEqual(summary.blockedTaskId, 'task-two');

      const output = result.stdout + result.stderr;
      assert(output.includes('missing a valid fix commit SHA'), `Expected missing fix SHA message: ${output}`);
      assert(output.includes('No provider call was made'), `Expected no provider call message: ${output}`);
    } finally {
      cleanup();
    }
  });

  test('resume error output redacts token-like text from corrupted child state', () => {
    const { blockId, blockPath, repoPath, runsDir, cleanup } = createTempBlockEnv();
    const secret = 'sk-fake-child-secret';
    const partialState = buildBaseState(
      blockId,
      'Test block',
      runsDir,
      'blocked',
      [acceptedTaskResult('task-one', 'a'.repeat(40))]
    );
    writeBlockState(runsDir, blockId, partialState);
    writeCorruptChildRunState(runsDir, 'task-two', `{"token":"${secret}","not":"valid`);

    try {
      const beforeLogCount = getGitLogCount(repoPath);
      const result = runCli(['real-block-run-ai', blockPath, '--resume'], baseBlockEnv({ RUNS_DIR: runsDir }));
      assert.notStrictEqual(result.status, 0, `Expected safe failure: ${result.stderr}`);
      assert.strictEqual(getGitLogCount(repoPath), beforeLogCount, 'No commits should be created');

      const output = result.stdout + result.stderr;
      assert(!output.includes(secret), `Secret should be redacted in output: ${output}`);
      assert(output.includes('No provider call was made'), `Expected no provider call message: ${output}`);
    } finally {
      cleanup();
    }
  });

  function addTaskToBlock(blockPath: string, taskId: string): void {
    const definition = JSON.parse(readFileSync(blockPath, 'utf-8')) as Record<string, unknown>;
    const tasks = definition.tasks as Record<string, unknown>[];
    tasks.push({
      task_id: taskId,
      title: `Task ${taskId}`,
      goal: `Goal ${taskId}`,
      allowed_files: ['README.md'],
      denied_files: [],
      max_lines_changed: 150,
      checks: [],
    });
    definition.tasks = tasks;
    writeFileSync(blockPath, JSON.stringify(definition, null, 2), 'utf-8');
  }

  test('pause after accepted task exits 0 and stops before next task', () => {
    const { blockId, blockPath, repoPath, runsDir, cleanup } = createTempBlockEnv();
    try {
      const beforeLogCount = getGitLogCount(repoPath);
      const result = runCli(['real-block-run-ai', blockPath, '--pause-after-task', 'task-one'], baseBlockEnv({
        RUNS_DIR: runsDir,
        REAL_BLOCK_TASK_KIMI_FAKE_RESPONSES: JSON.stringify([
          buildFakeKimiOutput([{ path: 'README.md', content: '# one\n' }]),
          buildFakeKimiOutput([{ path: 'feature.txt', content: 'feature\n' }]),
        ]),
        REAL_BLOCK_TASK_REVIEWER_FAKE_RESPONSES: JSON.stringify([
          buildAcceptReview('Task one good'),
          buildAcceptReview('Task two good'),
        ]),
      }));

      assert.strictEqual(result.status, 0, `Expected pause success: ${result.stderr}`);
      assert.strictEqual(getGitLogCount(repoPath), beforeLogCount + 1, 'Only task-one commit should be created');

      const state = getBlockState(runsDir, blockId);
      assert(state !== null);
      assert.strictEqual(state.status, 'paused');

      const summary = state.summary as Record<string, unknown>;
      assert.strictEqual(summary.completedTasks, 1);
      assert.strictEqual(summary.acceptedTasks, 1);
      assert.strictEqual(summary.fixedTasks, 0);

      const taskResults = state.taskResults as Record<string, unknown>[];
      assert.strictEqual(taskResults.length, 1);
      assert.strictEqual(taskResults[0].status, 'accepted');

      const output = result.stdout + result.stderr;
      assert(output.includes('Paused after task task-one'), `Expected pause message: ${output}`);
      assert(output.includes('--resume'), `Expected resume command: ${output}`);
      assert(output.includes('No provider call was made'), `Expected no provider call message: ${output}`);
    } finally {
      cleanup();
    }
  });

  test('resume after pause completes remaining tasks without duplicate commits', () => {
    const { blockId, blockPath, repoPath, runsDir, cleanup } = createTempBlockEnv();
    try {
      const beforeLogCount = getGitLogCount(repoPath);
      const pauseResult = runCli(['real-block-run-ai', blockPath, '--pause-after-task', 'task-one'], baseBlockEnv({
        RUNS_DIR: runsDir,
        REAL_BLOCK_TASK_KIMI_FAKE_RESPONSES: JSON.stringify([
          buildFakeKimiOutput([{ path: 'README.md', content: '# one\n' }]),
          buildFakeKimiOutput([{ path: 'feature.txt', content: 'feature\n' }]),
        ]),
        REAL_BLOCK_TASK_REVIEWER_FAKE_RESPONSES: JSON.stringify([
          buildAcceptReview('Task one good'),
          buildAcceptReview('Task two good'),
        ]),
      }));
      assert.strictEqual(pauseResult.status, 0, `Expected pause success: ${pauseResult.stderr}`);

      const afterPauseLogCount = getGitLogCount(repoPath);
      assert.strictEqual(afterPauseLogCount, beforeLogCount + 1, 'Only task-one commit should be created on pause');

      const resumeResult = runCli(['real-block-run-ai', blockPath, '--resume'], baseBlockEnv({
        RUNS_DIR: runsDir,
        REAL_BLOCK_TASK_KIMI_FAKE_RESPONSES: JSON.stringify([
          buildFakeKimiOutput([{ path: 'README.md', content: '# one\n' }]),
          buildFakeKimiOutput([{ path: 'feature.txt', content: 'feature\n' }]),
        ]),
        REAL_BLOCK_TASK_REVIEWER_FAKE_RESPONSES: JSON.stringify([
          buildAcceptReview('Task one good'),
          buildAcceptReview('Task two good'),
        ]),
      }));
      assert.strictEqual(resumeResult.status, 0, `Expected resume success: ${resumeResult.stderr}`);
      assert.strictEqual(getGitLogCount(repoPath), afterPauseLogCount + 1, 'Only task-two commit should be added on resume');

      const state = getBlockState(runsDir, blockId);
      assert(state !== null);
      assert.strictEqual(state.status, 'completed');

      const summary = state.summary as Record<string, unknown>;
      assert.strictEqual(summary.completedTasks, 2);
      assert.strictEqual(summary.acceptedTasks, 2);

      const taskResults = state.taskResults as Record<string, unknown>[];
      assert.strictEqual(taskResults.length, 2);
      assert.strictEqual(taskResults[0].status, 'accepted');
      assert.strictEqual(taskResults[1].status, 'accepted');
    } finally {
      cleanup();
    }
  });

  test('pause after fixed_and_accepted task persists fix details and stops before next task', () => {
    const { blockId, blockPath, repoPath, runsDir, cleanup } = createTempBlockEnv();
    addTaskToBlock(blockPath, 'task-three');

    try {
      const beforeLogCount = getGitLogCount(repoPath);
      const result = runCli(['real-block-run-ai', blockPath, '--pause-after-task', 'task-two'], baseBlockEnv({
        RUNS_DIR: runsDir,
        REAL_BLOCK_TASK_KIMI_FAKE_RESPONSES: JSON.stringify([
          buildFakeKimiOutput([{ path: 'README.md', content: '# one\n' }]),
          buildFakeKimiOutput([{ path: 'feature.txt', content: 'feature\n' }]),
          buildFakeKimiOutput([{ path: 'README.md', content: '# three\n' }]),
        ]),
        REAL_BLOCK_TASK_REVIEWER_FAKE_RESPONSES: JSON.stringify([
          buildAcceptReview('Task one good'),
          buildRejectReview('Task two needs fix', ['missing fix.txt'], 'add fix.txt'),
          buildAcceptReview('Task three good'),
        ]),
        REAL_BLOCK_TASK_FIX_KIMI_FAKE_RESPONSES: JSON.stringify([
          null,
          buildFakeKimiOutput([{ path: 'fix.txt', content: 'fix\n' }]),
          null,
        ]),
        REAL_BLOCK_TASK_SECOND_REVIEWER_FAKE_RESPONSES: JSON.stringify([
          null,
          buildAcceptReview('Task two fix good'),
          null,
        ]),
      }));

      assert.strictEqual(result.status, 0, `Expected pause success: ${result.stderr}`);
      assert.strictEqual(getGitLogCount(repoPath), beforeLogCount + 3, 'task-one + task-two original + task-two fix commits');

      const state = getBlockState(runsDir, blockId);
      assert(state !== null);
      assert.strictEqual(state.status, 'paused');

      const summary = state.summary as Record<string, unknown>;
      assert.strictEqual(summary.completedTasks, 2);
      assert.strictEqual(summary.acceptedTasks, 1);
      assert.strictEqual(summary.fixedTasks, 1);

      const taskResults = state.taskResults as Record<string, unknown>[];
      assert.strictEqual(taskResults.length, 2);
      assert.strictEqual(taskResults[0].status, 'accepted');

      const taskTwo = taskResults[1];
      assert.strictEqual(taskTwo.status, 'fixed_and_accepted');
      assert.strictEqual(typeof taskTwo.fixCommitSha, 'string');
      assert.strictEqual((taskTwo.fixCommitSha as string).length, 40);
      assert.strictEqual(typeof taskTwo.originalCommitSha, 'string');
      assert.deepStrictEqual(taskTwo.fixCheckSummary, {
        typecheck: 'not_run',
        build: 'not_run',
        test: 'not_run',
      });

      const output = result.stdout + result.stderr;
      assert(output.includes('Paused after task task-two'), `Expected pause message: ${output}`);
    } finally {
      cleanup();
    }
  });

  test('block report shows paused state and resume command', () => {
    const { blockId, blockPath, runsDir, cleanup } = createTempBlockEnv();
    try {
      const pauseResult = runCli(['real-block-run-ai', blockPath, '--pause-after-task', 'task-one'], baseBlockEnv({
        RUNS_DIR: runsDir,
        REAL_BLOCK_TASK_KIMI_FAKE_RESPONSES: JSON.stringify([
          buildFakeKimiOutput([{ path: 'README.md', content: '# one\n' }]),
          buildFakeKimiOutput([{ path: 'feature.txt', content: 'feature\n' }]),
        ]),
        REAL_BLOCK_TASK_REVIEWER_FAKE_RESPONSES: JSON.stringify([
          buildAcceptReview('Task one good'),
          buildAcceptReview('Task two good'),
        ]),
      }));
      assert.strictEqual(pauseResult.status, 0, `Expected pause success: ${pauseResult.stderr}`);

      const state = getBlockState(runsDir, blockId);
      assert(state !== null);
      const statePath = state.statePath as string;

      const reportResult = runCli(['real-block-run-ai-report', statePath], baseBlockEnv({ RUNS_DIR: runsDir }));
      assert.strictEqual(reportResult.status, 0, `Report should succeed: ${reportResult.stderr}`);
      const reportOutput = reportResult.stdout;
      assert(reportOutput.includes('Status: paused'), `Report should show paused status: ${reportOutput}`);
      assert(reportOutput.includes('task-one — accepted'), `Report should show completed task: ${reportOutput}`);
      assert(reportOutput.includes('Resume with:'), `Report should show resume command: ${reportOutput}`);
    } finally {
      cleanup();
    }
  });

  test('pause-after-task with unknown task id fails before provider call', () => {
    const { blockId, blockPath, repoPath, runsDir, cleanup } = createTempBlockEnv();
    try {
      const beforeLogCount = getGitLogCount(repoPath);
      const result = runCli(['real-block-run-ai', blockPath, '--pause-after-task', 'nonexistent-task'], baseBlockEnv({
        RUNS_DIR: runsDir,
      }));
      assert.notStrictEqual(result.status, 0, `Expected failure: ${result.stderr}`);
      assert.strictEqual(getGitLogCount(repoPath), beforeLogCount, 'No commits should be created');

      const output = result.stdout + result.stderr;
      assert(output.includes('not found in block definition'), `Expected not found message: ${output}`);
      assert(output.includes('No provider call was made'), `Expected no provider call message: ${output}`);
      assert.strictEqual(getBlockState(runsDir, blockId), null, 'No block state should be written');
    } finally {
      cleanup();
    }
  });

  test('pause-after-task does not mask task failure', () => {
    const { blockId, blockPath, repoPath, runsDir, cleanup } = createTempBlockEnv();
    try {
      const beforeLogCount = getGitLogCount(repoPath);
      const result = runCli(['real-block-run-ai', blockPath, '--pause-after-task', 'task-one'], baseBlockEnv({
        RUNS_DIR: runsDir,
        REAL_BLOCK_TASK_KIMI_FAKE_RESPONSES: JSON.stringify([
          buildFakeKimiOutput([{ path: 'README.md', content: '# one\n' }]),
          null,
        ]),
        REAL_BLOCK_TASK_REVIEWER_FAKE_RESPONSES: JSON.stringify([
          buildBlockReview('Blocked for human', ['needs review']),
          null,
        ]),
      }));
      assert.notStrictEqual(result.status, 0, `Expected failure: ${result.stderr}`);
      const afterLogCount = getGitLogCount(repoPath);
      assert(afterLogCount >= beforeLogCount, 'Log count should not decrease');
      assert.strictEqual(afterLogCount, beforeLogCount + 1, 'Task-one commit may be created, but task-two should not run');

      const state = getBlockState(runsDir, blockId);
      assert(state !== null);
      assert.strictEqual(state.status, 'blocked');
      const summary = state.summary as Record<string, unknown>;
      assert.strictEqual(summary.blockedTaskId, 'task-one');

      const output = result.stdout + result.stderr;
      assert(!output.includes('Paused after task'), `Should not report paused: ${output}`);
    } finally {
      cleanup();
    }
  });

  test('pause-after-task via env var stops after target task', () => {
    const { blockId, blockPath, repoPath, runsDir, cleanup } = createTempBlockEnv();
    try {
      const beforeLogCount = getGitLogCount(repoPath);
      const result = runCli(['real-block-run-ai', blockPath], baseBlockEnv({
        RUNS_DIR: runsDir,
        REAL_BLOCK_RUN_PAUSE_AFTER_TASK_ID: 'task-one',
        REAL_BLOCK_TASK_KIMI_FAKE_RESPONSES: JSON.stringify([
          buildFakeKimiOutput([{ path: 'README.md', content: '# one\n' }]),
          buildFakeKimiOutput([{ path: 'feature.txt', content: 'feature\n' }]),
        ]),
        REAL_BLOCK_TASK_REVIEWER_FAKE_RESPONSES: JSON.stringify([
          buildAcceptReview('Task one good'),
          buildAcceptReview('Task two good'),
        ]),
      }));

      assert.strictEqual(result.status, 0, `Expected pause success: ${result.stderr}`);
      assert.strictEqual(getGitLogCount(repoPath), beforeLogCount + 1, 'Only task-one commit should be created');

      const state = getBlockState(runsDir, blockId);
      assert(state !== null);
      assert.strictEqual(state.status, 'paused');
      const summary = state.summary as Record<string, unknown>;
      assert.strictEqual(summary.completedTasks, 1);
    } finally {
      cleanup();
    }
  });

  test('pause-after-task CLI flag overrides env var', () => {
    const { blockId, blockPath, repoPath, runsDir, cleanup } = createTempBlockEnv();
    try {
      const beforeLogCount = getGitLogCount(repoPath);
      const result = runCli(['real-block-run-ai', blockPath, '--pause-after-task', 'task-one'], baseBlockEnv({
        RUNS_DIR: runsDir,
        REAL_BLOCK_RUN_PAUSE_AFTER_TASK_ID: 'task-two',
        REAL_BLOCK_TASK_KIMI_FAKE_RESPONSES: JSON.stringify([
          buildFakeKimiOutput([{ path: 'README.md', content: '# one\n' }]),
          buildFakeKimiOutput([{ path: 'feature.txt', content: 'feature\n' }]),
        ]),
        REAL_BLOCK_TASK_REVIEWER_FAKE_RESPONSES: JSON.stringify([
          buildAcceptReview('Task one good'),
          buildAcceptReview('Task two good'),
        ]),
      }));

      assert.strictEqual(result.status, 0, `Expected pause success: ${result.stderr}`);
      assert.strictEqual(getGitLogCount(repoPath), beforeLogCount + 1, 'Only task-one commit should be created');

      const state = getBlockState(runsDir, blockId);
      assert(state !== null);
      assert.strictEqual(state.status, 'paused');
      const summary = state.summary as Record<string, unknown>;
      assert.strictEqual(summary.completedTasks, 1);

      const output = result.stdout + result.stderr;
      assert(output.includes('Paused after task task-one'), `Expected pause after task-one: ${output}`);
    } finally {
      cleanup();
    }
  });

  test('pause state and output do not leak token-like text', () => {
    const { blockId, blockPath, repoPath, runsDir, cleanup } = createTempBlockEnv();
    const secret = 'sk-fake-pause-secret';
    try {
      const beforeLogCount = getGitLogCount(repoPath);
      const result = runCli(['real-block-run-ai', blockPath, '--pause-after-task', 'task-one'], baseBlockEnv({
        RUNS_DIR: runsDir,
        KIMI_API_KEY: secret,
        REAL_BLOCK_TASK_KIMI_FAKE_RESPONSES: JSON.stringify([
          buildFakeKimiOutput([{ path: 'README.md', content: '# one\n' }]),
          buildFakeKimiOutput([{ path: 'feature.txt', content: 'feature\n' }]),
        ]),
        REAL_BLOCK_TASK_REVIEWER_FAKE_RESPONSES: JSON.stringify([
          buildAcceptReview('Task one good'),
          buildAcceptReview('Task two good'),
        ]),
      }));

      assert.strictEqual(result.status, 0, `Expected pause success: ${result.stderr}`);
      assert.strictEqual(getGitLogCount(repoPath), beforeLogCount + 1, 'Only task-one commit should be created');

      const output = result.stdout + result.stderr;
      assert(!output.includes(secret), `Secret should not leak to output: ${output}`);

      const state = getBlockState(runsDir, blockId);
      assert(state !== null);
      const stateRaw = JSON.stringify(state);
      assert(!stateRaw.includes(secret), `Secret should not leak to state: ${stateRaw}`);
    } finally {
      cleanup();
    }
  });

  function getBlockLockPath(runsDir: string, blockId: string): string {
    return join(runsDir, 'block', blockId, 'run.lock');
  }

  function writeBlockLock(
    runsDir: string,
    blockId: string,
    metadata: Record<string, unknown>
  ): void {
    const lockPath = getBlockLockPath(runsDir, blockId);
    const dir = join(runsDir, 'block', blockId);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(lockPath, JSON.stringify(metadata, null, 2), 'utf-8');
  }

  test('block run creates and releases lock on success', () => {
    const { blockId, blockPath, repoPath, runsDir, cleanup } = createTempBlockEnv();
    try {
      const lockPath = getBlockLockPath(runsDir, blockId);
      const result = runCli(['real-block-run-ai', blockPath], baseBlockEnv({
        RUNS_DIR: runsDir,
        REAL_BLOCK_TASK_KIMI_FAKE_RESPONSES: JSON.stringify([
          buildFakeKimiOutput([{ path: 'README.md', content: '# one\n' }]),
          buildFakeKimiOutput([{ path: 'feature.txt', content: 'feature\n' }]),
        ]),
        REAL_BLOCK_TASK_REVIEWER_FAKE_RESPONSES: JSON.stringify([
          buildAcceptReview('Task one good'),
          buildAcceptReview('Task two good'),
        ]),
      }));
      assert.strictEqual(result.status, 0, `Expected success: ${result.stderr}`);
      assert(!existsSync(lockPath), 'Lock should be released after success');
    } finally {
      cleanup();
    }
  });

  test('block run releases lock after pause', () => {
    const { blockId, blockPath, repoPath, runsDir, cleanup } = createTempBlockEnv();
    try {
      const lockPath = getBlockLockPath(runsDir, blockId);
      const result = runCli(['real-block-run-ai', blockPath, '--pause-after-task', 'task-one'], baseBlockEnv({
        RUNS_DIR: runsDir,
        REAL_BLOCK_TASK_KIMI_FAKE_RESPONSES: JSON.stringify([
          buildFakeKimiOutput([{ path: 'README.md', content: '# one\n' }]),
          buildFakeKimiOutput([{ path: 'feature.txt', content: 'feature\n' }]),
        ]),
        REAL_BLOCK_TASK_REVIEWER_FAKE_RESPONSES: JSON.stringify([
          buildAcceptReview('Task one good'),
          buildAcceptReview('Task two good'),
        ]),
      }));
      assert.strictEqual(result.status, 0, `Expected pause success: ${result.stderr}`);
      assert(!existsSync(lockPath), 'Lock should be released after pause');
    } finally {
      cleanup();
    }
  });

  test('block run releases lock after task failure', () => {
    const { blockId, blockPath, repoPath, runsDir, cleanup } = createTempBlockEnv();
    try {
      const lockPath = getBlockLockPath(runsDir, blockId);
      const result = runCli(['real-block-run-ai', blockPath, '--pause-after-task', 'task-one'], baseBlockEnv({
        RUNS_DIR: runsDir,
        REAL_BLOCK_TASK_KIMI_FAKE_RESPONSES: JSON.stringify([
          buildFakeKimiOutput([{ path: 'README.md', content: '# one\n' }]),
          null,
        ]),
        REAL_BLOCK_TASK_REVIEWER_FAKE_RESPONSES: JSON.stringify([
          buildBlockReview('Blocked for human', ['needs review']),
          null,
        ]),
      }));
      assert.notStrictEqual(result.status, 0, `Expected failure: ${result.stderr}`);
      assert(!existsSync(lockPath), 'Lock should be released after failure');
    } finally {
      cleanup();
    }
  });

  test('block run refuses if lock exists before provider call', () => {
    const { blockId, blockPath, repoPath, runsDir, cleanup } = createTempBlockEnv();
    try {
      const beforeLogCount = getGitLogCount(repoPath);
      writeBlockLock(runsDir, blockId, {
        pid: 99999,
        command: 'real-block-run-ai',
        blockId,
        createdAt: new Date().toISOString(),
      });
      const result = runCli(['real-block-run-ai', blockPath], baseBlockEnv({ RUNS_DIR: runsDir }));
      assert.notStrictEqual(result.status, 0, `Expected lock refusal: ${result.stderr}`);
      assert.strictEqual(getGitLogCount(repoPath), beforeLogCount, 'No commits should be created');

      const output = result.stdout + result.stderr;
      assert(output.includes('Another run appears to be active'), `Expected lock conflict message: ${output}`);
      assert(output.includes('No provider call was made'), `Expected no provider call message: ${output}`);
    } finally {
      cleanup();
    }
  });

  test('resume refuses if block lock exists before provider call', () => {
    const { blockId, blockPath, repoPath, runsDir, cleanup } = createTempBlockEnv();
    try {
      const beforeLogCount = getGitLogCount(repoPath);
      writeBlockLock(runsDir, blockId, {
        pid: 99999,
        command: 'real-block-run-ai',
        blockId,
        createdAt: new Date().toISOString(),
      });
      const result = runCli(['real-block-run-ai', blockPath, '--resume'], baseBlockEnv({ RUNS_DIR: runsDir }));
      assert.notStrictEqual(result.status, 0, `Expected lock refusal: ${result.stderr}`);
      assert.strictEqual(getGitLogCount(repoPath), beforeLogCount, 'No commits should be created');

      const output = result.stdout + result.stderr;
      assert(output.includes('Another run appears to be active'), `Expected lock conflict message: ${output}`);
    } finally {
      cleanup();
    }
  });

  test('block lock conflict redacts token-like text', () => {
    const { blockId, blockPath, repoPath, runsDir, cleanup } = createTempBlockEnv();
    const secret = 'sk-fake-lock-secret';
    try {
      writeBlockLock(runsDir, blockId, {
        pid: 99999,
        command: 'real-block-run-ai',
        blockId: `${blockId}-${secret}`,
        createdAt: new Date().toISOString(),
      });
      const result = runCli(['real-block-run-ai', blockPath], baseBlockEnv({ RUNS_DIR: runsDir }));
      assert.notStrictEqual(result.status, 0, `Expected lock refusal: ${result.stderr}`);
      const output = result.stdout + result.stderr;
      assert(!output.includes(secret), `Secret should be redacted: ${output}`);
    } finally {
      cleanup();
    }
  });

  test('block state save leaves no temp files', () => {
    const { blockId, blockPath, repoPath, runsDir, cleanup } = createTempBlockEnv();
    try {
      const result = runCli(['real-block-run-ai', blockPath], baseBlockEnv({
        RUNS_DIR: runsDir,
        REAL_BLOCK_TASK_KIMI_FAKE_RESPONSES: JSON.stringify([
          buildFakeKimiOutput([{ path: 'README.md', content: '# one\n' }]),
          buildFakeKimiOutput([{ path: 'feature.txt', content: 'feature\n' }]),
        ]),
        REAL_BLOCK_TASK_REVIEWER_FAKE_RESPONSES: JSON.stringify([
          buildAcceptReview('Task one good'),
          buildAcceptReview('Task two good'),
        ]),
      }));
      assert.strictEqual(result.status, 0, `Expected success: ${result.stderr}`);
      const blockDir = join(runsDir, 'block', blockId);
      const tmpFiles = readdirSync(blockDir).filter((name) => name.includes('.tmp.'));
      assert.strictEqual(tmpFiles.length, 0, `Expected no temp files, found: ${tmpFiles.join(', ')}`);
    } finally {
      cleanup();
    }
  });
});


describe('dependency-aware block execution', () => {
  test('failed task blocks only descendants; unrelated tasks continue and are accepted', () => {
    const tasks = [
      {
        task_id: 'task-a',
        title: 'Task A',
        goal: 'Update A',
        allowed_files: ['a.txt'],
        denied_files: [],
        max_lines_changed: 150,
        checks: [],
      },
      {
        task_id: 'task-b',
        title: 'Task B',
        goal: 'Update B',
        allowed_files: ['b.txt'],
        denied_files: [],
        max_lines_changed: 150,
        checks: [],
        depends_on: ['task-a'],
      },
      {
        task_id: 'task-c',
        title: 'Task C',
        goal: 'Update C',
        allowed_files: ['c.txt'],
        denied_files: [],
        max_lines_changed: 150,
        checks: [],
      },
    ];
    const { blockId, blockPath, repoPath, runsDir, cleanup } = createTempBlockEnv(tasks);
    try {
      const beforeLogCount = getGitLogCount(repoPath);

      const result = runCli(['real-block-run-ai', blockPath], baseBlockEnv({
        RUNS_DIR: runsDir,
        REAL_BLOCK_TASK_KIMI_FAKE_RESPONSES: JSON.stringify([
          'not-valid-json', // task-a fails
          buildFakeKimiOutput([{ path: 'b.txt', content: 'b content\n' }]), // task-b would run if no deps
          buildFakeKimiOutput([{ path: 'c.txt', content: 'c content\n' }]), // task-c succeeds
        ]),
        REAL_BLOCK_TASK_REVIEWER_FAKE_RESPONSES: JSON.stringify([
          null,
          null,
          buildAcceptReview('Task C good'),
        ]),
      }));

      const output = result.stdout + result.stderr;
      const state = getBlockState(runsDir, blockId);
      assert(state !== null, `Expected block state; output: ${output}`);
      assert.strictEqual(state.status, 'completed_with_caveats', `Expected caveated completion: ${output}`);

      const taskResults = state.taskResults as Array<Record<string, unknown>>;
      assert.strictEqual(taskResults.length, 3);

      const taskA = taskResults.find((t) => t.taskId === 'task-a');
      const taskB = taskResults.find((t) => t.taskId === 'task-b');
      const taskC = taskResults.find((t) => t.taskId === 'task-c');

      assert.ok(taskA, 'task-a result must exist');
      assert.ok(taskB, 'task-b result must exist');
      assert.ok(taskC, 'task-c result must exist');

      assert.strictEqual(taskA.status, 'failed', 'task-a must be failed');
      assert.strictEqual(taskB.status, 'blocked_skipped', 'task-b must be skipped because task-a failed');
      assert.strictEqual(taskC.status, 'accepted', 'task-c must be accepted independently');

      // Task C's commit should be present; task A and B should not add successful commits.
      const afterLogCount = getGitLogCount(repoPath);
      assert.strictEqual(afterLogCount, beforeLogCount + 1, 'Only task-c should create a commit');

      // The summary should reflect one completed independent task and one skipped dependent task.
      const summary = state.summary as Record<string, unknown>;
      assert.strictEqual(summary.acceptedTasks, 1);
      assert.strictEqual(summary.skippedBlockedTasks, 1);
      assert.strictEqual(summary.completedTasks, 2);
    } finally {
      cleanup();
    }
  });
});
