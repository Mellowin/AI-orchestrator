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
import { join } from 'node:path';

let counter = 0;

function getCleanEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.AI_PROVIDER;
  delete env.MOCK_AI_RESPONSE;
  delete env.MOCK_REVIEWER_RESPONSE;
  delete env.MOCK_PROVIDER_RESPONSE;
  delete env.KIMI_API_KEY;
  delete env.KIMI_MODEL;
  delete env.KIMI_BASE_URL;
  delete env.KIMI_USER_AGENT;
  delete env.KIMI_FAKE_RESPONSE;
  delete env.KIMI_FAKE_RESPONSES;
  delete env.OPENAI_API_KEY;
  delete env.MOCK_AI;
  delete env.ALLOW_REAL_PROVIDER_RUN;
  delete env.ALLOW_REAL_PROVIDER;
  delete env.ALLOW_SANDBOX_APPLY_PREVIEW;
  delete env.ALLOW_REAL_REPO_APPLY;
  delete env.ALLOW_REAL_REPO_COMMIT;
  delete env.ALLOW_REAL_REPO_PUSH;
  delete env.SANDBOX_PROVIDER_RESPONSE;
  delete env.SANDBOX_ROOT;
  delete env.REAL_REPO_PROVIDER_RESPONSE;
  delete env.RUNS_DIR;
  delete env.REAL_REPO_AI_MAX_ATTEMPTS;
  delete env.REAL_REPO_REVIEWER_FAKE_RESPONSE;
  delete env.REAL_REPO_REVIEWER_NO_DEFAULT;
  delete env.REAL_REPO_REVIEWER_CAPTURE_INPUT_FILE;
  delete env.REAL_REPO_REVIEWER_FORCE_PROVIDER_ERROR;
  delete env.REAL_REPO_REVIEWER_FIX_TASK_FAKE_EXECUTOR_RESPONSE;
  delete env.REAL_REPO_ENABLE_REVIEWER_FIX_LOOP;
  delete env.REAL_REPO_REVIEWER_MAX_FIX_ATTEMPTS;
  delete env.REAL_BLOCK_TASK_KIMI_FAKE_RESPONSES;
  delete env.REAL_BLOCK_TASK_REVIEWER_FAKE_RESPONSES;
  delete env.REAL_BLOCK_TASK_FIX_KIMI_FAKE_RESPONSES;
  delete env.REAL_BLOCK_TASK_SECOND_REVIEWER_FAKE_RESPONSES;
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
  if (
    !env.REAL_REPO_REVIEWER_FAKE_RESPONSE &&
    !env.KIMI_FAKE_REVIEWER_RESPONSE &&
    env.REAL_REPO_REVIEWER_NO_DEFAULT !== '1' &&
    (env.ALLOW_REAL_PROVIDER === 'true' || env.ALLOW_REAL_PROVIDER === '1')
  ) {
    env.REAL_REPO_REVIEWER_FAKE_RESPONSE = JSON.stringify({
      decision: 'accept',
      confidence: 'high',
      blockingIssues: [],
      nonBlockingIssues: [],
      reviewSummary: 'Default test reviewer acceptance.',
      nextAction: 'continue',
    });
  }
  const result = spawnSync(
    `npx tsx "${join(process.cwd(), 'src', 'cli.ts')}" ${args.join(' ')}`,
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

function createTempEnv(allowedFiles?: string[]): {
  taskId: string;
  tasksFilePath: string;
  repoPath: string;
  runsDir: string;
  cleanup: () => void;
} {
  const id = `${Date.now()}-${counter++}`;
  const taskId = `rai-no-effect-${id}`;
  const tmpBase = join(process.cwd(), 'tmp');
  if (!existsSync(tmpBase)) {
    mkdirSync(tmpBase);
  }
  const tmpDir = mkdtempSync(join(tmpBase, `rai-ne-${id}-`));
  const repoPath = join(tmpDir, 'repo');
  const runsDir = join(tmpDir, 'runs');
  const originPath = join(tmpDir, 'origin.git');
  mkdirSync(repoPath);

  writeFileSync(join(repoPath, 'README.md'), '# hello\n', 'utf-8');
  writeFileSync(join(repoPath, 'part1.md'), '# part1\n', 'utf-8');

  spawnSync('git', ['init'], { cwd: repoPath, encoding: 'utf-8', shell: false });
  spawnSync('git', ['config', 'user.email', 'ci@example.com'], { cwd: repoPath, encoding: 'utf-8', shell: false });
  spawnSync('git', ['config', 'user.name', 'CI User'], { cwd: repoPath, encoding: 'utf-8', shell: false });
  spawnSync('git', ['add', '.'], { cwd: repoPath, encoding: 'utf-8', shell: false });
  spawnSync('git', ['commit', '-m', 'init', '--no-gpg-sign'], { cwd: repoPath, encoding: 'utf-8', shell: false });
  spawnSync('git', ['branch', '-m', 'main'], { cwd: repoPath, encoding: 'utf-8', shell: false });
  spawnSync('git', ['checkout', '-b', `ai/${taskId}`], { cwd: repoPath, encoding: 'utf-8', shell: false });
  spawnSync('git', ['init', '--bare', originPath], { encoding: 'utf-8', shell: false });
  spawnSync('git', ['remote', 'add', 'origin', originPath], { cwd: repoPath, encoding: 'utf-8', shell: false });

  const allowModify = allowedFiles ?? ['README.md', 'part1.md', 'part2.md'];

  const tasksFilePath = join(tmpDir, 'tasks.yaml');
  writeFileSync(
    tasksFilePath,
    `tasks:
  - id: ${taskId}
    title: "No-effect test"
    repo_path: "${repoPath.replace(/\\/g, '/')}"
    base_branch: "main"
    work_branch: "ai/${taskId}"
    goal: "Create or modify allowed files"
    context_files: []
    checks:
      - command: "node"
        args: ["-e", "process.exit(0)"]
    guardrails:
      allow_modify:
${allowModify.map((f) => `        - "${f}"`).join('\n')}
      deny_modify:
        - ".env"
        - ".env.*"
        - "node_modules/**"
      max_lines_changed: 150
      require_tests: false
      auto_commit: false
      auto_push: false
      auto_merge: false
`,
    'utf-8'
  );

  return {
    taskId,
    tasksFilePath,
    repoPath,
    runsDir,
    cleanup: () => {
      rmSync(tmpDir, { recursive: true, force: true });
    },
  };
}

describe('real-repo-run-ai no-effect output handling', () => {
  test('files: [] triggers PROVIDER_NO_EFFECT_OUTPUT retry and eventually success', () => {
    const { taskId, tasksFilePath, repoPath, runsDir, cleanup } = createTempEnv();
    try {
      const result = runCli(['real-repo-run-ai', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_PROVIDER: 'true',
        ALLOW_REAL_REPO_APPLY: 'true',
        ALLOW_REAL_REPO_COMMIT: 'true',
        ALLOW_REAL_REPO_PUSH: 'true',
        KIMI_API_KEY: 'fake',
        KIMI_BASE_URL: 'http://localhost:9999',
        RUNS_DIR: runsDir,
        REAL_REPO_AI_MAX_ATTEMPTS: '3',
        KIMI_FAKE_RESPONSES: JSON.stringify([
          buildFakeKimiOutput([]),
          buildFakeKimiOutput([{ path: 'part2.md', content: '# part2\n' }]),
        ]),
      });
      assert.strictEqual(result.status, 0, `Expected success after retry: ${result.stderr}`);
      assert(result.stderr.includes('Provider produced no effective changes'), `Expected no-effect detection: ${result.stderr}`);
      assert(result.stderr.includes('Requesting correction'), `Expected correction retry: ${result.stderr}`);
      assert(existsSync(join(repoPath, 'part2.md')), 'Expected part2.md to be created');

      const attemptDir = join(runsDir, taskId, 'attempt-1');
      assert(existsSync(join(attemptDir, 'provider-raw.txt')), 'Expected raw response evidence');
      assert(existsSync(join(attemptDir, 'parsed-kimi-output.json')), 'Expected parsed output evidence');
      assert(existsSync(join(attemptDir, 'proposed-files.json')), 'Expected proposed files evidence');
      assert(existsSync(join(attemptDir, 'apply-plan.json')), 'Expected apply plan evidence');
      assert(existsSync(join(attemptDir, 'post-apply-git.json')), 'Expected post-apply git evidence');
      const classification = JSON.parse(readFileSync(join(attemptDir, 'apply-plan.json'), 'utf-8'));
      assert.strictEqual(classification.classification, 'EMPTY_FILE_LIST');
    } finally {
      cleanup();
    }
  });

  test('identical existing file triggers PROVIDER_NO_EFFECT_OUTPUT retry', () => {
    const { taskId, tasksFilePath, repoPath, runsDir, cleanup } = createTempEnv();
    try {
      const result = runCli(['real-repo-run-ai', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_PROVIDER: 'true',
        ALLOW_REAL_REPO_APPLY: 'true',
        ALLOW_REAL_REPO_COMMIT: 'true',
        ALLOW_REAL_REPO_PUSH: 'true',
        KIMI_API_KEY: 'fake',
        KIMI_BASE_URL: 'http://localhost:9999',
        RUNS_DIR: runsDir,
        REAL_REPO_AI_MAX_ATTEMPTS: '3',
        KIMI_FAKE_RESPONSES: JSON.stringify([
          buildFakeKimiOutput([{ path: 'README.md', content: '# hello\n' }]),
          buildFakeKimiOutput([{ path: 'part2.md', content: '# part2\n' }]),
        ]),
      });
      assert.strictEqual(result.status, 0, `Expected success after retry: ${result.stderr}`);
      assert(result.stderr.includes('Provider produced no effective changes'), `Expected no-effect detection: ${result.stderr}`);
      const attemptDir = join(runsDir, taskId, 'attempt-1');
      const classification = JSON.parse(readFileSync(join(attemptDir, 'apply-plan.json'), 'utf-8'));
      assert.strictEqual(classification.classification, 'ALL_IDENTICAL');
    } finally {
      cleanup();
    }
  });

  test('all identical files trigger no-effect retry', () => {
    const { taskId, tasksFilePath, repoPath, runsDir, cleanup } = createTempEnv();
    try {
      const result = runCli(['real-repo-run-ai', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_PROVIDER: 'true',
        ALLOW_REAL_REPO_APPLY: 'true',
        ALLOW_REAL_REPO_COMMIT: 'true',
        ALLOW_REAL_REPO_PUSH: 'true',
        KIMI_API_KEY: 'fake',
        KIMI_BASE_URL: 'http://localhost:9999',
        RUNS_DIR: runsDir,
        REAL_REPO_AI_MAX_ATTEMPTS: '3',
        KIMI_FAKE_RESPONSES: JSON.stringify([
          buildFakeKimiOutput([
            { path: 'README.md', content: '# hello\n' },
            { path: 'part1.md', content: '# part1\n' },
          ]),
          buildFakeKimiOutput([{ path: 'part2.md', content: '# part2\n' }]),
        ]),
      });
      assert.strictEqual(result.status, 0, `Expected success after retry: ${result.stderr}`);
      const attemptDir = join(runsDir, taskId, 'attempt-1');
      const classification = JSON.parse(readFileSync(join(attemptDir, 'apply-plan.json'), 'utf-8'));
      assert.strictEqual(classification.classification, 'ALL_IDENTICAL');
    } finally {
      cleanup();
    }
  });

  test('mixed identical and effective applies only effective changes', () => {
    const { taskId, tasksFilePath, repoPath, runsDir, cleanup } = createTempEnv();
    try {
      const result = runCli(['real-repo-run-ai', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_PROVIDER: 'true',
        ALLOW_REAL_REPO_APPLY: 'true',
        ALLOW_REAL_REPO_COMMIT: 'true',
        ALLOW_REAL_REPO_PUSH: 'true',
        KIMI_API_KEY: 'fake',
        KIMI_BASE_URL: 'http://localhost:9999',
        RUNS_DIR: runsDir,
        KIMI_FAKE_RESPONSE: buildFakeKimiOutput([
          { path: 'README.md', content: '# hello\n' },
          { path: 'part2.md', content: '# part2\n' },
        ]),
      });
      assert.strictEqual(result.status, 0, `Expected success: ${result.stderr}`);
      assert(existsSync(join(repoPath, 'part2.md')), 'Expected part2.md to be created');
      const attemptDir = join(runsDir, taskId, 'attempt-1');
      const proposed = JSON.parse(readFileSync(join(attemptDir, 'proposed-files.json'), 'utf-8'));
      const byPath = new Map(proposed.map((f: { path: string; effect: string }) => [f.path, f]));
      assert.strictEqual(byPath.get('README.md').effect, 'identical');
      assert.strictEqual(byPath.get('part2.md').effect, 'create');
    } finally {
      cleanup();
    }
  });

  test('new empty file is classified as create, not identical', () => {
    const { taskId, tasksFilePath, repoPath, runsDir, cleanup } = createTempEnv(['README.md', 'part1.md', 'part2.md', 'empty.md']);
    try {
      const result = runCli(['real-repo-run-ai', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_PROVIDER: 'true',
        ALLOW_REAL_REPO_APPLY: 'true',
        ALLOW_REAL_REPO_COMMIT: 'true',
        ALLOW_REAL_REPO_PUSH: 'true',
        KIMI_API_KEY: 'fake',
        KIMI_BASE_URL: 'http://localhost:9999',
        RUNS_DIR: runsDir,
        KIMI_FAKE_RESPONSE: buildFakeKimiOutput([{ path: 'empty.md', content: '' }]),
      });
      assert.strictEqual(result.status, 0, `Expected success: ${result.stderr}`);
      assert(existsSync(join(repoPath, 'empty.md')), 'Expected empty.md to be created');
      const attemptDir = join(runsDir, taskId, 'attempt-1');
      const proposed = JSON.parse(readFileSync(join(attemptDir, 'proposed-files.json'), 'utf-8'));
      assert.strictEqual(proposed[0].effect, 'create');
      assert.strictEqual(proposed[0].proposed_lines, 0);
    } finally {
      cleanup();
    }
  });

  test('no-effect exhaustion ends as failed_max_attempts without commit or push', () => {
    const { taskId, tasksFilePath, repoPath, runsDir, cleanup } = createTempEnv();
    try {
      const result = runCli(['real-repo-run-ai', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_PROVIDER: 'true',
        ALLOW_REAL_REPO_APPLY: 'true',
        ALLOW_REAL_REPO_COMMIT: 'true',
        ALLOW_REAL_REPO_PUSH: 'true',
        KIMI_API_KEY: 'fake',
        KIMI_BASE_URL: 'http://localhost:9999',
        RUNS_DIR: runsDir,
        REAL_REPO_AI_MAX_ATTEMPTS: '2',
        KIMI_FAKE_RESPONSES: JSON.stringify([buildFakeKimiOutput([]), buildFakeKimiOutput([])]),
      });
      assert.notStrictEqual(result.status, 0, `Expected failure: ${result.stderr}`);
      assert(result.stderr.includes('Provider produced no effective changes after'), `Expected no-effect exhaustion message: ${result.stderr}`);
      assert(result.stderr.includes('No commit was made'), `Expected no commit: ${result.stderr}`);
      assert(result.stderr.includes('No push was performed'), `Expected no push: ${result.stderr}`);

      const branchCommits = spawnSync('git', ['rev-list', 'main..HEAD'], { cwd: repoPath, encoding: 'utf-8', shell: false });
      assert.strictEqual(branchCommits.stdout.trim(), '', 'Expected no local commits');
    } finally {
      cleanup();
    }
  });

  test('raw response evidence is saved locally and not committed to repo', () => {
    const { taskId, tasksFilePath, repoPath, runsDir, cleanup } = createTempEnv();
    try {
      runCli(['real-repo-run-ai', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_PROVIDER: 'true',
        ALLOW_REAL_REPO_APPLY: 'true',
        ALLOW_REAL_REPO_COMMIT: 'true',
        ALLOW_REAL_REPO_PUSH: 'true',
        KIMI_API_KEY: 'fake',
        KIMI_BASE_URL: 'http://localhost:9999',
        RUNS_DIR: runsDir,
        KIMI_FAKE_RESPONSE: buildFakeKimiOutput([{ path: 'part2.md', content: '# part2\n' }]),
      });
      const attemptDir = join(runsDir, taskId, 'attempt-1');
      const files = readdirSync(attemptDir);
      assert(files.includes('provider-raw.txt'));
      assert(!files.includes('provider-raw.txt.sha256')); // we use provider-raw.sha256
      assert(files.includes('provider-raw.sha256'));

      const repoFiles = spawnSync('git', ['ls-files'], { cwd: repoPath, encoding: 'utf-8', shell: false });
      assert(!repoFiles.stdout.includes('provider-raw.txt'), 'Raw evidence must not be tracked by git');
    } finally {
      cleanup();
    }
  });
});
