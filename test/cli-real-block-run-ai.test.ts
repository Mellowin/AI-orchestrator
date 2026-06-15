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
    'REAL_REPO_REVIEWER_SECOND_FAKE_RESPONSE',
    'REAL_REPO_REVIEWER_FIX_TASK_KIMI_FAKE_RESPONSE',
    'REAL_REPO_REVIEWER_FIX_TASK_KIMI_FAKE_RESPONSES',
    'REAL_BLOCK_TASK_KIMI_FAKE_RESPONSES',
    'REAL_BLOCK_TASK_REVIEWER_FAKE_RESPONSES',
    'REAL_BLOCK_TASK_FIX_KIMI_FAKE_RESPONSES',
    'REAL_BLOCK_TASK_SECOND_REVIEWER_FAKE_RESPONSES',
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
        allowed_files: ['feature.txt', 'fix.txt'],
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

describe('cli real-block-run-ai', () => {
  test('missing block path refuses before provider call', () => {
    const result = runCli(['real-block-run-ai']);
    assert.notStrictEqual(result.status, 0);
    assert(result.stderr.includes('block definition path is required'), `Expected block path required: ${result.stderr}`);
    assert(result.stderr.includes('No provider call was made'), `Expected no provider call: ${result.stderr}`);
  });

  test('missing opt-in refuses before provider call', () => {
    const { blockPath, cleanup } = createTempBlockEnv();
    try {
      const result = runCli(['real-block-run-ai', blockPath], {
        ALLOW_REAL_PROVIDER: 'true',
        ALLOW_REAL_REPO_APPLY: 'true',
        ALLOW_REAL_REPO_COMMIT: 'true',
        ALLOW_REAL_REPO_PUSH: 'true',
        KIMI_API_KEY: 'fake',
        KIMI_BASE_URL: 'http://localhost:9999',
      });
      assert.notStrictEqual(result.status, 0);
      assert(
        result.stderr.includes('ALLOW_REAL_BLOCK_RUN_AI=true') || result.stderr.includes('REAL_BLOCK_RUN_AI=1'),
        `Expected opt-in refusal: ${result.stderr}`
      );
      assert(result.stderr.includes('No provider call was made'), `Expected no provider call: ${result.stderr}`);
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

  test('two tasks complete with second task fix loop accepted', () => {
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
          buildFakeKimiOutput([{ path: 'fix.txt', content: 'fix applied\n' }]),
        ]),
        REAL_BLOCK_TASK_SECOND_REVIEWER_FAKE_RESPONSES: JSON.stringify([
          null,
          buildAcceptReview('Fix looks good'),
        ]),
      }));

      assert.strictEqual(result.status, 0, `Expected success: ${result.stderr}`);
      assert.strictEqual(getGitLogCount(repoPath), beforeLogCount + 3, `Expected three new commits: init=${beforeLogCount}, after=${getGitLogCount(repoPath)}`);

      const state = getBlockState(runsDir, blockId);
      assert(state !== null, 'Block state should exist');
      assert.strictEqual(state.status, 'completed');
      assert.strictEqual(state.block_id, blockId);
      assert.strictEqual((state.summary as Record<string, unknown>).totalTasks, 2);
      assert.strictEqual((state.summary as Record<string, unknown>).acceptedTasks, 1);
      assert.strictEqual((state.summary as Record<string, unknown>).fixedTasks, 1);

      const taskResults = state.taskResults as Record<string, unknown>[];
      assert.strictEqual(taskResults.length, 2);
      assert.strictEqual(taskResults[0].status, 'accepted');
      assert.strictEqual(taskResults[0].taskId, 'task-one');
      assert.strictEqual(taskResults[1].status, 'fixed_and_accepted');
      assert.strictEqual(taskResults[1].taskId, 'task-two');
      assert(typeof taskResults[1].fixCommitSha === 'string' && (taskResults[1].fixCommitSha as string).length === 40, 'Fix commit SHA should be 40 chars');
      assert.notStrictEqual(taskResults[0].originalCommitSha, taskResults[1].originalCommitSha, 'Each task should have its own commit');

      const stateRaw = JSON.stringify(state);
      assert(!stateRaw.includes('fix applied'), 'Block state should not contain raw file content');
      assert(!stateRaw.includes('sk-fake'), 'Block state should not contain raw secrets');
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
      assert.strictEqual((state.summary as Record<string, unknown>).blockedTaskId, 'task-two');
      assert.strictEqual((state.summary as Record<string, unknown>).acceptedTasks, 1);
      assert.strictEqual((state.summary as Record<string, unknown>).fixedTasks, 0);

      const taskResults = state.taskResults as Record<string, unknown>[];
      assert.strictEqual(taskResults.length, 2);
      assert.strictEqual(taskResults[0].status, 'accepted');
      assert.strictEqual(taskResults[1].status, 'fix_required');

      const stateRaw = JSON.stringify(state);
      assert(!stateRaw.includes('sk-fake-secret'), 'Block state should redact secrets');
      assert(!stateRaw.includes('fix applied'), 'Block state should not contain raw file content');
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
      assert.strictEqual((state.summary as Record<string, unknown>).blockedTaskId, 'task-two');
      assert.strictEqual((state.summary as Record<string, unknown>).acceptedTasks, 1);
      assert.strictEqual((state.summary as Record<string, unknown>).fixedTasks, 0);

      const taskResults = state.taskResults as Record<string, unknown>[];
      assert.strictEqual(taskResults.length, 2);
      assert.strictEqual(taskResults[0].status, 'accepted');
      assert.strictEqual(taskResults[1].status, 'blocked');
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
      assert.strictEqual(taskResults[1].status, 'blocked');

      const stateRaw = JSON.stringify(state);
      assert(!stateRaw.includes('api_key=fake-reviewer-key'), 'Block state should redact secrets');
    } finally {
      cleanup();
    }
  });
});
