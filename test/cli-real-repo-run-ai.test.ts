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
import { getRepoRunLockPath } from '../src/run-lock.js';
import { dirname, join } from 'node:path';

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
  delete env.KIMI_FAKE_REVIEWER_RESPONSE;
  delete env.REAL_REPO_REVIEWER_NO_DEFAULT;
  delete env.REAL_REPO_REVIEWER_CAPTURE_INPUT_FILE;
  delete env.REAL_REPO_REVIEWER_FORCE_PROVIDER_ERROR;
  delete env.REAL_REPO_REVIEWER_FIX_TASK_FAKE_EXECUTOR_RESPONSE;
  delete env.REAL_REPO_ENABLE_REVIEWER_FIX_LOOP;
  delete env.REAL_REPO_REVIEWER_MAX_FIX_ATTEMPTS;
  delete env.REAL_REPO_REVIEWER_SECOND_FAKE_RESPONSE;
  delete env.REAL_REPO_REVIEWER_SECOND_KIMI_FAKE_RESPONSE;
  delete env.REAL_REPO_REVIEWER_SECOND_FORCE_PROVIDER_ERROR;
  delete env.REAL_REPO_REVIEWER_FIX_TASK_KIMI_FAKE_RESPONSE;
  delete env.REAL_REPO_REVIEWER_FIX_TASK_KIMI_FAKE_RESPONSES;
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
      timeout: 15000,
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

function createTempEnv(checks: string[] = [], checkObjects?: Array<{ command: string; args: string[] }>): {
  taskId: string;
  tasksFilePath: string;
  repoPath: string;
  originPath: string;
  runsDir: string;
  cleanup: () => void;
} {
  const id = `${Date.now()}-${counter++}`;
  const taskId = `rai-${id}`;
  const tmpBase = join(process.cwd(), 'tmp');
  if (!existsSync(tmpBase)) {
    mkdirSync(tmpBase);
  }
  const tmpDir = mkdtempSync(join(tmpBase, `rai-${id}-`));
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
  spawnSync('git', ['checkout', '-b', `ai/${taskId}`], {
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

  const checkLines = checkObjects && checkObjects.length > 0
    ? checkObjects.map((c) => `    - command: "${c.command}"\n      args: [${c.args.map((a) => `"${a}"`).join(', ')}]`).join('\n')
    : checks.length > 0
      ? checks.map((c) => `    - command: "${c.split(' ')[0]}"\n      args: [${c.split(' ').slice(1).map((a) => `"${a}"`).join(', ')}]`).join('\n')
      : '    - command: "node"\n      args: ["-e", "process.exit(0)"]';

  const tasksFilePath = join(tmpDir, 'tasks.yaml');
  writeFileSync(
    tasksFilePath,
    `tasks:
  - id: ${taskId}
    title: "Run AI test"
    repo_path: "${repoPath.replace(/\\/g, '/')}"
    base_branch: "main"
    work_branch: "ai/${taskId}"
    goal: "Test goal"
    context_files: []
    checks:
${checkLines}
    guardrails:
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
    originPath,
    runsDir,
    cleanup: () => {
      rmSync(tmpDir, { recursive: true, force: true });
    },
  };
}

const ZERO_SHA = '0000000000000000000000000000000000000000';

function corruptLocalBranchRef(repoPath: string, branch: string): void {
  writeFileSync(
    join(repoPath, '.git', 'refs', 'heads', branch),
    `${ZERO_SHA}\n`,
    'utf-8'
  );
}

function corruptRemoteBaseRef(repoPath: string, branch: string): void {
  const remoteDir = join(repoPath, '.git', 'refs', 'remotes', 'origin');
  if (!existsSync(remoteDir)) {
    mkdirSync(remoteDir, { recursive: true });
  }
  writeFileSync(
    join(remoteDir, branch),
    `${ZERO_SHA}\n`,
    'utf-8'
  );
}

function invalidateHead(repoPath: string): void {
  writeFileSync(join(repoPath, '.git', 'HEAD'), 'ref: refs/heads/nonexistent\n', 'utf-8');
}

function getCurrentBranch(repoPath: string): string {
  const result = spawnSync('git', ['branch', '--show-current'], {
    cwd: repoPath,
    encoding: 'utf-8',
    shell: false,
  });
  return result.stdout.trim();
}

function getBareRefs(originPath: string): string[] {
  const result = spawnSync('git', ['--git-dir', originPath, 'show-ref'], {
    encoding: 'utf-8',
    shell: false,
  });
  return result.stdout.trim().split('\n').filter((l) => l.length > 0);
}

function getGitPorcelain(repoPath: string): string {
  const result = spawnSync('git', ['status', '--porcelain', '--untracked-files=all'], {
    cwd: repoPath,
    encoding: 'utf-8',
    shell: false,
  });
  return result.stdout.trim();
}

function getGitLogCount(repoPath: string): number {
  const result = spawnSync('git', ['log', '--oneline'], {
    cwd: repoPath,
    encoding: 'utf-8',
    shell: false,
  });
  return result.stdout.trim().split('\n').filter((l) => l.length > 0).length;
}

function setupCheckFile(repoPath: string): void {
  writeFileSync(join(repoPath, 'check.cjs'), `require('fs').readFileSync('README.md','utf8').includes('fail')&&process.exit(1)`, 'utf-8');
  spawnSync('git', ['add', 'check.cjs'], { cwd: repoPath, shell: false, encoding: 'utf-8' });
  spawnSync('git', ['commit', '-m', 'add check', '--no-gpg-sign'], { cwd: repoPath, shell: false, encoding: 'utf-8' });
}

function setupCheckFileWithSecrets(repoPath: string): void {
  writeFileSync(join(repoPath, 'check-secret.cjs'), `require('fs').readFileSync('README.md','utf8').includes('fail')&&(console.error('sk-fake-e2e-secret Bearer fake-e2e-token api_key=fake-e2e-key'),process.exit(1))`, 'utf-8');
  spawnSync('git', ['add', 'check-secret.cjs'], { cwd: repoPath, shell: false, encoding: 'utf-8' });
  spawnSync('git', ['commit', '-m', 'add check', '--no-gpg-sign'], { cwd: repoPath, shell: false, encoding: 'utf-8' });
}

function setupFixFailingCheck(repoPath: string): void {
  writeFileSync(join(repoPath, 'check-fix.cjs'), `require('fs').existsSync('fix.txt')&&process.exit(1)`, 'utf-8');
  spawnSync('git', ['add', 'check-fix.cjs'], { cwd: repoPath, shell: false, encoding: 'utf-8' });
  spawnSync('git', ['commit', '-m', 'add fix check', '--no-gpg-sign'], { cwd: repoPath, shell: false, encoding: 'utf-8' });
}

function loadStateFromPath(runsDir: string, taskId: string): unknown {
  const statePath = join(runsDir, taskId, 'state.json');
  if (!existsSync(statePath)) {
    return null;
  }
  return JSON.parse(readFileSync(statePath, 'utf-8'));
}

function getCommittedFiles(repoPath: string): string[] {
  const result = spawnSync('git', ['diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD'], {
    cwd: repoPath,
    encoding: 'utf-8',
    shell: false,
  });
  return result.stdout.trim().split('\n').filter((l) => l.length > 0);
}

function getRealRepoRunAiBranchSource(): string {
  const source = readFileSync(join(process.cwd(), 'src', 'cli.ts'), 'utf-8');
  const start = source.indexOf("if (command === 'real-repo-run-ai') {");
  if (start === -1) {
    throw new Error('real-repo-run-ai branch not found in src/cli.ts');
  }
  const end = source.indexOf("if (command === 'real-repo-run-ai-readiness') {", start);
  if (end === -1) {
    throw new Error('real-repo-run-ai-readiness branch not found in src/cli.ts');
  }
  return source.slice(start, end);
}

describe('cli real-repo-run-ai', () => {
  test('branch source does not use direct process.exit(', () => {
    const branch = getRealRepoRunAiBranchSource();
    assert(!branch.includes('process.exit('), 'Expected no direct process.exit call in real-repo-run-ai branch');
  });

  test('branch source uses process.exitCode', () => {
    const branch = getRealRepoRunAiBranchSource();
    assert(branch.includes('process.exitCode'), 'Expected process.exitCode assignment in real-repo-run-ai branch');
  });

  test('branch source uses break commandDispatch', () => {
    const branch = getRealRepoRunAiBranchSource();
    assert(branch.includes('break commandDispatch'), 'Expected break commandDispatch in real-repo-run-ai branch');
  });

  test('missing taskId refuses', () => {
    const result = runCli(['real-repo-run-ai']);
    assert.notStrictEqual(result.status, 0);
    assert(result.stderr.includes('task id is required'), `Expected task id required: ${result.stderr}`);
  });

  test('success path with fake setup exits 0', () => {
    const { taskId, tasksFilePath, cleanup } = createTempEnv();
    try {
      const result = runCli(['real-repo-run-ai', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_PROVIDER: 'true',
        ALLOW_REAL_REPO_APPLY: 'true',
        ALLOW_REAL_REPO_COMMIT: 'true',
        ALLOW_REAL_REPO_PUSH: 'true',
        KIMI_API_KEY: 'fake',
        KIMI_BASE_URL: 'http://localhost:9999',
        KIMI_FAKE_RESPONSE: buildFakeKimiOutput([{ path: 'README.md', content: '# modified\n' }]),
      });
      assert.strictEqual(result.status, 0, `Expected success: ${result.stderr}`);
    } finally {
      cleanup();
    }
  });

  test('failure path with guardrails violation exits non-zero', () => {
    const { taskId, tasksFilePath, cleanup } = createTempEnv();
    try {
      const result = runCli(['real-repo-run-ai', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_PROVIDER: 'true',
        ALLOW_REAL_REPO_APPLY: 'true',
        ALLOW_REAL_REPO_COMMIT: 'true',
        ALLOW_REAL_REPO_PUSH: 'true',
        KIMI_API_KEY: 'fake',
        KIMI_BASE_URL: 'http://localhost:9999',
        KIMI_FAKE_RESPONSE: buildFakeKimiOutput([{ path: '.env', content: 'SECRET=1\n' }]),
      });
      assert.notStrictEqual(result.status, 0, `Expected failure: ${result.stderr}`);
      assert(result.stderr.includes('Guardrails failed'), `Expected guardrails failure: ${result.stderr}`);
    } finally {
      cleanup();
    }
  });

  test('missing ALLOW_REAL_PROVIDER refuses before provider call', () => {
    const { taskId, tasksFilePath, cleanup } = createTempEnv();
    try {
      const result = runCli(['real-repo-run-ai', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_REPO_APPLY: 'true',
        ALLOW_REAL_REPO_COMMIT: 'true',
        ALLOW_REAL_REPO_PUSH: 'true',
      });
      assert.notStrictEqual(result.status, 0);
      assert(result.stderr.includes('ALLOW_REAL_PROVIDER=true or ALLOW_REAL_PROVIDER=1 is required'), `Expected provider opt-in: ${result.stderr}`);
      assert(result.stderr.includes('No provider call was made'), `Expected no provider call: ${result.stderr}`);
    } finally {
      cleanup();
    }
  });

  test('ALLOW_REAL_PROVIDER=1 works', () => {
    const { taskId, tasksFilePath, cleanup } = createTempEnv();
    try {
      const result = runCli(['real-repo-run-ai', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_PROVIDER: '1',
        ALLOW_REAL_REPO_APPLY: 'true',
        ALLOW_REAL_REPO_COMMIT: 'true',
        ALLOW_REAL_REPO_PUSH: 'true',
        KIMI_API_KEY: 'fake',
        KIMI_BASE_URL: 'http://localhost:9999',
        KIMI_FAKE_RESPONSE: buildFakeKimiOutput([{ path: 'README.md', content: '# modified\n' }]),
      });
      assert.strictEqual(result.status, 0, `Expected success: ${result.stderr}`);
    } finally {
      cleanup();
    }
  });

  function assertInvalidAllowRealProvider(value: string): void {
    const { taskId, tasksFilePath, cleanup } = createTempEnv();
    try {
      const result = runCli(['real-repo-run-ai', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_PROVIDER: value,
        ALLOW_REAL_REPO_APPLY: 'true',
        ALLOW_REAL_REPO_COMMIT: 'true',
        ALLOW_REAL_REPO_PUSH: 'true',
      });
      assert.notStrictEqual(result.status, 0, `Expected refusal for ALLOW_REAL_PROVIDER=${value}`);
      assert(result.stderr.includes('ALLOW_REAL_PROVIDER=true or ALLOW_REAL_PROVIDER=1 is required'), `Expected opt-in message: ${result.stderr}`);
      assert(result.stderr.includes('No provider call was made'), `Expected no provider call: ${result.stderr}`);
    } finally {
      cleanup();
    }
  }

  test('ALLOW_REAL_PROVIDER=false refuses before provider call', () => {
    assertInvalidAllowRealProvider('false');
  });

  test('ALLOW_REAL_PROVIDER=yes refuses before provider call', () => {
    assertInvalidAllowRealProvider('yes');
  });

  test('ALLOW_REAL_PROVIDER=0 refuses before provider call', () => {
    assertInvalidAllowRealProvider('0');
  });

  test('missing ALLOW_REAL_REPO_APPLY refuses before provider call', () => {
    const { taskId, tasksFilePath, cleanup } = createTempEnv();
    try {
      const result = runCli(['real-repo-run-ai', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_PROVIDER: 'true',
        ALLOW_REAL_REPO_COMMIT: 'true',
        ALLOW_REAL_REPO_PUSH: 'true',
      });
      assert.notStrictEqual(result.status, 0);
      assert(result.stderr.includes('ALLOW_REAL_REPO_APPLY=true is required'), `Expected apply opt-in: ${result.stderr}`);
      assert(result.stderr.includes('No provider call was made'), `Expected no provider call: ${result.stderr}`);
    } finally {
      cleanup();
    }
  });

  test('missing ALLOW_REAL_REPO_COMMIT refuses before provider call', () => {
    const { taskId, tasksFilePath, cleanup } = createTempEnv();
    try {
      const result = runCli(['real-repo-run-ai', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_PROVIDER: 'true',
        ALLOW_REAL_REPO_APPLY: 'true',
        ALLOW_REAL_REPO_PUSH: 'true',
      });
      assert.notStrictEqual(result.status, 0);
      assert(result.stderr.includes('ALLOW_REAL_REPO_COMMIT=true is required'), `Expected commit opt-in: ${result.stderr}`);
      assert(result.stderr.includes('No provider call was made'), `Expected no provider call: ${result.stderr}`);
    } finally {
      cleanup();
    }
  });

  test('missing ALLOW_REAL_REPO_PUSH refuses before provider call', () => {
    const { taskId, tasksFilePath, cleanup } = createTempEnv();
    try {
      const result = runCli(['real-repo-run-ai', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_PROVIDER: 'true',
        ALLOW_REAL_REPO_APPLY: 'true',
        ALLOW_REAL_REPO_COMMIT: 'true',
      });
      assert.notStrictEqual(result.status, 0);
      assert(result.stderr.includes('ALLOW_REAL_REPO_PUSH=true is required'), `Expected push opt-in: ${result.stderr}`);
      assert(result.stderr.includes('No provider call was made'), `Expected no provider call: ${result.stderr}`);
    } finally {
      cleanup();
    }
  });

  test('dirty tree refuses before provider call', () => {
    const { taskId, tasksFilePath, repoPath, cleanup } = createTempEnv();
    try {
      writeFileSync(join(repoPath, 'README.md'), '# dirty\n', 'utf-8');
      const result = runCli(['real-repo-run-ai', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_PROVIDER: 'true',
        ALLOW_REAL_REPO_APPLY: 'true',
        ALLOW_REAL_REPO_COMMIT: 'true',
        ALLOW_REAL_REPO_PUSH: 'true',
        KIMI_API_KEY: 'fake',
        KIMI_BASE_URL: 'http://localhost:9999',
        KIMI_FAKE_RESPONSE: buildFakeKimiOutput([{ path: 'README.md', content: 'x' }]),
      });
      assert.notStrictEqual(result.status, 0);
      assert(result.stderr.includes('Safety check failed'), `Expected safety failure: ${result.stderr}`);
      assert(result.stderr.includes('No provider call was made'), `Expected no provider call: ${result.stderr}`);
    } finally {
      cleanup();
    }
  });

  test('current branch main refuses before provider call', () => {
    const { taskId, tasksFilePath, repoPath, cleanup } = createTempEnv();
    try {
      spawnSync('git', ['checkout', 'main'], {
        cwd: repoPath,
        encoding: 'utf-8',
        shell: false,
      });
      const result = runCli(['real-repo-run-ai', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_PROVIDER: 'true',
        ALLOW_REAL_REPO_APPLY: 'true',
        ALLOW_REAL_REPO_COMMIT: 'true',
        ALLOW_REAL_REPO_PUSH: 'true',
        KIMI_API_KEY: 'fake',
        KIMI_BASE_URL: 'http://localhost:9999',
        KIMI_FAKE_RESPONSE: buildFakeKimiOutput([{ path: 'README.md', content: 'x' }]),
      });
      assert.notStrictEqual(result.status, 0);
      assert(result.stderr.includes('Current branch is main'), `Expected main refusal: ${result.stderr}`);
      assert(result.stderr.includes('No provider call was made'), `Expected no provider call: ${result.stderr}`);
    } finally {
      cleanup();
    }
  });

  test('work_branch main refuses before provider call', () => {
    const { taskId, tasksFilePath, cleanup } = createTempEnv();
    try {
      const tasksContent = readFileSync(tasksFilePath, 'utf-8');
      writeFileSync(tasksFilePath, tasksContent.replace(/work_branch: "ai\/[^"]+"/, 'work_branch: "main"'), 'utf-8');
      const result = runCli(['real-repo-run-ai', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_PROVIDER: 'true',
        ALLOW_REAL_REPO_APPLY: 'true',
        ALLOW_REAL_REPO_COMMIT: 'true',
        ALLOW_REAL_REPO_PUSH: 'true',
        KIMI_API_KEY: 'fake',
        KIMI_BASE_URL: 'http://localhost:9999',
        KIMI_FAKE_RESPONSE: buildFakeKimiOutput([{ path: 'README.md', content: 'x' }]),
      });
      assert.notStrictEqual(result.status, 0);
      assert(result.stderr.includes('work_branch is main'), `Expected work_branch main refusal: ${result.stderr}`);
      assert(result.stderr.includes('No provider call was made'), `Expected no provider call: ${result.stderr}`);
    } finally {
      cleanup();
    }
  });

  test('branch mismatch refuses before provider call', () => {
    const { taskId, tasksFilePath, repoPath, cleanup } = createTempEnv();
    try {
      spawnSync('git', ['checkout', '-b', 'other-branch'], {
        cwd: repoPath,
        encoding: 'utf-8',
        shell: false,
      });
      const result = runCli(['real-repo-run-ai', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_PROVIDER: 'true',
        ALLOW_REAL_REPO_APPLY: 'true',
        ALLOW_REAL_REPO_COMMIT: 'true',
        ALLOW_REAL_REPO_PUSH: 'true',
        KIMI_API_KEY: 'fake',
        KIMI_BASE_URL: 'http://localhost:9999',
        KIMI_FAKE_RESPONSE: buildFakeKimiOutput([{ path: 'README.md', content: 'x' }]),
      });
      assert.notStrictEqual(result.status, 0);
      assert(result.stderr.includes('Safety check failed'), `Expected branch mismatch: ${result.stderr}`);
      assert(result.stderr.includes('No provider call was made'), `Expected no provider call: ${result.stderr}`);
    } finally {
      cleanup();
    }
  });

  test('provider call failure refuses safely', () => {
    const { taskId, tasksFilePath, cleanup } = createTempEnv();
    try {
      const result = runCli(['real-repo-run-ai', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_PROVIDER: 'true',
        ALLOW_REAL_REPO_APPLY: 'true',
        ALLOW_REAL_REPO_COMMIT: 'true',
        ALLOW_REAL_REPO_PUSH: 'true',
        KIMI_API_KEY: 'fake',
        KIMI_BASE_URL: 'ftp://invalid',
      });
      assert.notStrictEqual(result.status, 0);
      assert(result.stderr.includes('Provider call failed'), `Expected provider call failure: ${result.stderr}`);
      assert(result.stderr.includes('Manual inspection required'), `Expected manual inspection: ${result.stderr}`);
      assert(result.stderr.includes('No apply was performed'), `Expected no apply: ${result.stderr}`);
    } finally {
      cleanup();
    }
  });

  test('provider malformed output refuses safely', () => {
    const { taskId, tasksFilePath, cleanup } = createTempEnv();
    try {
      const result = runCli(['real-repo-run-ai', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_PROVIDER: 'true',
        ALLOW_REAL_REPO_APPLY: 'true',
        ALLOW_REAL_REPO_COMMIT: 'true',
        ALLOW_REAL_REPO_PUSH: 'true',
        KIMI_API_KEY: 'fake',
        KIMI_BASE_URL: 'http://localhost:9999',
        KIMI_FAKE_RESPONSE: 'not-json',
      });
      assert.notStrictEqual(result.status, 0);
      assert(result.stderr.includes('Provider output malformed'), `Expected malformed output: ${result.stderr}`);
      assert(result.stderr.includes('Manual inspection required'), `Expected manual inspection: ${result.stderr}`);
      assert(result.stderr.includes('No apply was performed'), `Expected no apply: ${result.stderr}`);
    } finally {
      cleanup();
    }
  });

  test('guardrails failure refuses safely', () => {
    const { taskId, tasksFilePath, cleanup } = createTempEnv();
    try {
      const result = runCli(['real-repo-run-ai', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_PROVIDER: 'true',
        ALLOW_REAL_REPO_APPLY: 'true',
        ALLOW_REAL_REPO_COMMIT: 'true',
        ALLOW_REAL_REPO_PUSH: 'true',
        KIMI_API_KEY: 'fake',
        KIMI_BASE_URL: 'http://localhost:9999',
        KIMI_FAKE_RESPONSE: buildFakeKimiOutput([{ path: '.env', content: 'secret' }]),
      });
      assert.notStrictEqual(result.status, 0);
      assert(result.stderr.includes('Guardrails failed'), `Expected guardrails failure: ${result.stderr}`);
      assert(result.stderr.includes('No apply was performed'), `Expected no apply: ${result.stderr}`);
    } finally {
      cleanup();
    }
  });

  test('line delta failure refuses safely', () => {
    const { taskId, tasksFilePath, cleanup } = createTempEnv();
    try {
      const bigContent = 'a\n'.repeat(200);
      const result = runCli(['real-repo-run-ai', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_PROVIDER: 'true',
        ALLOW_REAL_REPO_APPLY: 'true',
        ALLOW_REAL_REPO_COMMIT: 'true',
        ALLOW_REAL_REPO_PUSH: 'true',
        KIMI_API_KEY: 'fake',
        KIMI_BASE_URL: 'http://localhost:9999',
        KIMI_FAKE_RESPONSE: buildFakeKimiOutput([{ path: 'README.md', content: bigContent }]),
      });
      assert.notStrictEqual(result.status, 0);
      assert(result.stderr.includes('line delta') || result.stderr.includes('Guardrails'), `Expected line delta failure: ${result.stderr}`);
      assert(result.stderr.includes('No apply was performed'), `Expected no apply: ${result.stderr}`);
    } finally {
      cleanup();
    }
  });

  test('apply failure does not commit/push/state', () => {
    const { taskId, tasksFilePath, repoPath, originPath, runsDir, cleanup } = createTempEnv();
    try {
      writeFileSync(join(repoPath, 'blocked'), 'i am a file not a directory', 'utf-8');
      spawnSync('git', ['add', 'blocked'], { cwd: repoPath, encoding: 'utf-8', shell: false });
      spawnSync('git', ['commit', '-m', 'add blocked', '--no-gpg-sign'], { cwd: repoPath, encoding: 'utf-8', shell: false });
      const before = getBareRefs(originPath);
      const result = runCli(['real-repo-run-ai', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_PROVIDER: 'true',
        ALLOW_REAL_REPO_APPLY: 'true',
        ALLOW_REAL_REPO_COMMIT: 'true',
        ALLOW_REAL_REPO_PUSH: 'true',
        KIMI_API_KEY: 'fake',
        KIMI_BASE_URL: 'http://localhost:9999',
        KIMI_FAKE_RESPONSE: buildFakeKimiOutput([
          { path: 'README.md', content: '# modified\n' },
          { path: 'blocked/new.txt', content: 'should fail\n' },
        ]),
        RUNS_DIR: runsDir,
      });
      assert.notStrictEqual(result.status, 0);
      assert(result.stderr.includes('Sandbox preflight failed at step: apply'), `Expected apply failure: ${result.stderr}`);
      const after = getBareRefs(originPath);
      assert.deepStrictEqual(after, before, `Bare remote should not change on apply failure`);
      const state = loadStateFromPath(runsDir, taskId);
      assert.strictEqual(state, null, `State should not be written on apply failure`);
    } finally {
      cleanup();
    }
  });

  test('check failure rolls back and does not commit/push/state', () => {
    const { taskId, tasksFilePath, repoPath, originPath, runsDir, cleanup } = createTempEnv(['node', '-e', 'process.exit(1)']);
    try {
      const before = getBareRefs(originPath);
      const beforeContent = readFileSync(join(repoPath, 'README.md'), 'utf-8');
      const result = runCli(['real-repo-run-ai', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_PROVIDER: 'true',
        ALLOW_REAL_REPO_APPLY: 'true',
        ALLOW_REAL_REPO_COMMIT: 'true',
        ALLOW_REAL_REPO_PUSH: 'true',
        KIMI_API_KEY: 'fake',
        KIMI_BASE_URL: 'http://localhost:9999',
        KIMI_FAKE_RESPONSE: buildFakeKimiOutput([{ path: 'README.md', content: '# modified\n' }]),
        RUNS_DIR: runsDir,
      });
      assert.notStrictEqual(result.status, 0);
      assert(result.stderr.includes('Sandbox preflight failed'), `Expected sandbox preflight failure: ${result.stderr}`);
      const afterContent = readFileSync(join(repoPath, 'README.md'), 'utf-8');
      assert.strictEqual(afterContent, beforeContent, `Real repo should not be mutated when sandbox preflight checks fail`);
      const after = getBareRefs(originPath);
      assert.deepStrictEqual(after, before, `Bare remote should not change on check failure`);
      const state = loadStateFromPath(runsDir, taskId);
      assert.strictEqual(state, null, `State should not be written on check failure`);
    } finally {
      cleanup();
    }
  });

  test('successful run calls provider exactly once', () => {
    const { taskId, tasksFilePath, repoPath, cleanup } = createTempEnv();
    try {
      const result = runCli(['real-repo-run-ai', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_PROVIDER: 'true',
        ALLOW_REAL_REPO_APPLY: 'true',
        ALLOW_REAL_REPO_COMMIT: 'true',
        ALLOW_REAL_REPO_PUSH: 'true',
        KIMI_API_KEY: 'fake',
        KIMI_BASE_URL: 'http://localhost:9999',
        KIMI_FAKE_RESPONSE: buildFakeKimiOutput([{ path: 'README.md', content: '# provider-modified\n' }]),
      });
      assert.strictEqual(result.status, 0, `Expected success: ${result.stderr}`);
      const content = readFileSync(join(repoPath, 'README.md'), 'utf-8');
      assert.strictEqual(content, '# provider-modified\n', `Provider response should be applied`);
    } finally {
      cleanup();
    }
  });

  test('successful run applies files', () => {
    const { taskId, tasksFilePath, repoPath, cleanup } = createTempEnv();
    try {
      const result = runCli(['real-repo-run-ai', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_PROVIDER: 'true',
        ALLOW_REAL_REPO_APPLY: 'true',
        ALLOW_REAL_REPO_COMMIT: 'true',
        ALLOW_REAL_REPO_PUSH: 'true',
        KIMI_API_KEY: 'fake',
        KIMI_BASE_URL: 'http://localhost:9999',
        KIMI_FAKE_RESPONSE: buildFakeKimiOutput([{ path: 'README.md', content: '# modified\n' }]),
      });
      assert.strictEqual(result.status, 0, `Expected success: ${result.stderr}`);
      const content = readFileSync(join(repoPath, 'README.md'), 'utf-8');
      assert.strictEqual(content, '# modified\n', `File should be applied`);
    } finally {
      cleanup();
    }
  });

  test('successful run commits with exact message ai-orchestrator: apply <taskId>', () => {
    const { taskId, tasksFilePath, repoPath, cleanup } = createTempEnv();
    try {
      runCli(['real-repo-run-ai', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_PROVIDER: 'true',
        ALLOW_REAL_REPO_APPLY: 'true',
        ALLOW_REAL_REPO_COMMIT: 'true',
        ALLOW_REAL_REPO_PUSH: 'true',
        KIMI_API_KEY: 'fake',
        KIMI_BASE_URL: 'http://localhost:9999',
        KIMI_FAKE_RESPONSE: buildFakeKimiOutput([{ path: 'README.md', content: '# modified\n' }]),
      });
      const msgResult = spawnSync('git', ['log', '-1', '--pretty=%B'], {
        cwd: repoPath,
        encoding: 'utf-8',
        shell: false,
      });
      assert.strictEqual(msgResult.stdout.trim(), `ai-orchestrator: apply ${taskId}`);
    } finally {
      cleanup();
    }
  });

  test('successful run pushes current branch to local bare origin', () => {
    const { taskId, tasksFilePath, repoPath, originPath, cleanup } = createTempEnv();
    try {
      const branch = getCurrentBranch(repoPath);
      const result = runCli(['real-repo-run-ai', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_PROVIDER: 'true',
        ALLOW_REAL_REPO_APPLY: 'true',
        ALLOW_REAL_REPO_COMMIT: 'true',
        ALLOW_REAL_REPO_PUSH: 'true',
        KIMI_API_KEY: 'fake',
        KIMI_BASE_URL: 'http://localhost:9999',
        KIMI_FAKE_RESPONSE: buildFakeKimiOutput([{ path: 'README.md', content: '# modified\n' }]),
      });
      assert.strictEqual(result.status, 0, `Expected success: ${result.stderr}`);
      const refs = getBareRefs(originPath);
      const hasBranch = refs.some((r) => r.includes(`refs/heads/${branch}`));
      assert(hasBranch, `Bare remote should have refs/heads/${branch}: ${refs.join(', ')}`);
    } finally {
      cleanup();
    }
  });

  test('successful run writes pushed state', () => {
    const { taskId, tasksFilePath, runsDir, cleanup } = createTempEnv();
    try {
      runCli(['real-repo-run-ai', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_PROVIDER: 'true',
        ALLOW_REAL_REPO_APPLY: 'true',
        ALLOW_REAL_REPO_COMMIT: 'true',
        ALLOW_REAL_REPO_PUSH: 'true',
        KIMI_API_KEY: 'fake',
        KIMI_BASE_URL: 'http://localhost:9999',
        KIMI_FAKE_RESPONSE: buildFakeKimiOutput([{ path: 'README.md', content: '# modified\n' }]),
        RUNS_DIR: runsDir,
      });
      const state = loadStateFromPath(runsDir, taskId) as Record<string, unknown>;
      assert.strictEqual(state.status, 'pushed');
    } finally {
      cleanup();
    }
  });

  test('push failure rolls back local commit and restores repo', () => {
    const { taskId, tasksFilePath, repoPath, cleanup } = createTempEnv();
    try {
      spawnSync('git', ['remote', 'set-url', 'origin', '/nonexistent/remote'], {
        cwd: repoPath,
        encoding: 'utf-8',
        shell: false,
      });
      const beforeContent = readFileSync(join(repoPath, 'README.md'), 'utf-8');
      const beforeLogCount = getGitLogCount(repoPath);
      const result = runCli(['real-repo-run-ai', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_PROVIDER: 'true',
        ALLOW_REAL_REPO_APPLY: 'true',
        ALLOW_REAL_REPO_COMMIT: 'true',
        ALLOW_REAL_REPO_PUSH: 'true',
        KIMI_API_KEY: 'fake',
        KIMI_BASE_URL: 'http://localhost:9999',
        KIMI_FAKE_RESPONSE: buildFakeKimiOutput([{ path: 'README.md', content: '# modified\n' }]),
      });
      assert.notStrictEqual(result.status, 0, `Expected failure: ${result.stderr}`);
      assert(result.stderr.includes('Git push failed'), `Expected push failure: ${result.stderr}`);
      assert(result.stderr.includes('Rollback attempted'), `Expected rollback attempt: ${result.stderr}`);
      const afterContent = readFileSync(join(repoPath, 'README.md'), 'utf-8');
      const normalize = (s: string) => s.replace(/\r\n/g, '\n');
      assert.strictEqual(normalize(afterContent), normalize(beforeContent), 'README should be restored after rollback');
      const afterLogCount = getGitLogCount(repoPath);
      assert.strictEqual(afterLogCount, beforeLogCount, 'Local commit should be rolled back');
      assert.strictEqual(getGitPorcelain(repoPath), '', 'Working tree should be clean after rollback');
    } finally {
      cleanup();
    }
  });

  test('state does not include provider raw output', () => {
    const { taskId, tasksFilePath, runsDir, cleanup } = createTempEnv();
    try {
      runCli(['real-repo-run-ai', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_PROVIDER: 'true',
        ALLOW_REAL_REPO_APPLY: 'true',
        ALLOW_REAL_REPO_COMMIT: 'true',
        ALLOW_REAL_REPO_PUSH: 'true',
        KIMI_API_KEY: 'fake',
        KIMI_BASE_URL: 'http://localhost:9999',
        KIMI_FAKE_RESPONSE: buildFakeKimiOutput([{ path: 'README.md', content: '# modified\n' }], 'provider notes'),
        RUNS_DIR: runsDir,
      });
      const stateRaw = readFileSync(join(runsDir, taskId, 'state.json'), 'utf-8');
      assert(!stateRaw.includes('file_update'), `State should not contain provider response`);
      assert(!stateRaw.includes('provider notes'), `State should not contain provider notes`);
    } finally {
      cleanup();
    }
  });

  test('state does not include file contents', () => {
    const { taskId, tasksFilePath, runsDir, cleanup } = createTempEnv();
    try {
      runCli(['real-repo-run-ai', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_PROVIDER: 'true',
        ALLOW_REAL_REPO_APPLY: 'true',
        ALLOW_REAL_REPO_COMMIT: 'true',
        ALLOW_REAL_REPO_PUSH: 'true',
        KIMI_API_KEY: 'fake',
        KIMI_BASE_URL: 'http://localhost:9999',
        KIMI_FAKE_RESPONSE: buildFakeKimiOutput([{ path: 'README.md', content: '# secret content\n' }]),
        RUNS_DIR: runsDir,
      });
      const stateRaw = readFileSync(join(runsDir, taskId, 'state.json'), 'utf-8');
      assert(!stateRaw.includes('secret content'), `State should not contain file contents`);
    } finally {
      cleanup();
    }
  });

  test('state does not include fake API key', () => {
    const { taskId, tasksFilePath, runsDir, cleanup } = createTempEnv();
    try {
      runCli(['real-repo-run-ai', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_PROVIDER: 'true',
        ALLOW_REAL_REPO_APPLY: 'true',
        ALLOW_REAL_REPO_COMMIT: 'true',
        ALLOW_REAL_REPO_PUSH: 'true',
        KIMI_API_KEY: 'sk-fake12345',
        KIMI_BASE_URL: 'http://localhost:9999',
        KIMI_FAKE_RESPONSE: buildFakeKimiOutput([{ path: 'README.md', content: '# modified\n' }]),
        RUNS_DIR: runsDir,
      });
      const stateRaw = readFileSync(join(runsDir, taskId, 'state.json'), 'utf-8');
      assert(!stateRaw.includes('sk-fake'), `State should not contain fake API key`);
    } finally {
      cleanup();
    }
  });

  test('provider raw output is not printed', () => {
    const { taskId, tasksFilePath, cleanup } = createTempEnv();
    try {
      const result = runCli(['real-repo-run-ai', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_PROVIDER: 'true',
        ALLOW_REAL_REPO_APPLY: 'true',
        ALLOW_REAL_REPO_COMMIT: 'true',
        ALLOW_REAL_REPO_PUSH: 'true',
        KIMI_API_KEY: 'fake',
        KIMI_BASE_URL: 'http://localhost:9999',
        KIMI_FAKE_RESPONSE: buildFakeKimiOutput([{ path: 'README.md', content: '# modified\n' }], 'provider notes'),
      });
      assert.strictEqual(result.status, 0, `Expected success: ${result.stderr}`);
      const combined = result.stdout + result.stderr;
      assert(!combined.includes('file_update'), `Should not print provider raw output: ${combined}`);
      assert(!combined.includes('provider notes'), `Should not print provider notes: ${combined}`);
    } finally {
      cleanup();
    }
  });

  test('fake API key is not printed', () => {
    const { taskId, tasksFilePath, cleanup } = createTempEnv();
    try {
      const result = runCli(['real-repo-run-ai', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_PROVIDER: 'true',
        ALLOW_REAL_REPO_APPLY: 'true',
        ALLOW_REAL_REPO_COMMIT: 'true',
        ALLOW_REAL_REPO_PUSH: 'true',
        KIMI_API_KEY: 'sk-fake12345',
        KIMI_BASE_URL: 'http://localhost:9999',
        KIMI_FAKE_RESPONSE: buildFakeKimiOutput([{ path: 'README.md', content: '# modified\n' }]),
      });
      assert.strictEqual(result.status, 0, `Expected success: ${result.stderr}`);
      assert(!result.stderr.includes('sk-fake'), `Should not leak fake API key: ${result.stderr}`);
      assert(!result.stdout.includes('sk-fake'), `Should not leak fake API key in stdout: ${result.stdout}`);
    } finally {
      cleanup();
    }
  });

  test('no force push', () => {
    const { taskId, tasksFilePath, cleanup } = createTempEnv();
    try {
      const result = runCli(['real-repo-run-ai', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_PROVIDER: 'true',
        ALLOW_REAL_REPO_APPLY: 'true',
        ALLOW_REAL_REPO_COMMIT: 'true',
        ALLOW_REAL_REPO_PUSH: 'true',
        KIMI_API_KEY: 'fake',
        KIMI_BASE_URL: 'http://localhost:9999',
        KIMI_FAKE_RESPONSE: buildFakeKimiOutput([{ path: 'README.md', content: '# modified\n' }]),
      });
      assert.strictEqual(result.status, 0, `Expected success: ${result.stderr}`);
      assert(!result.stderr.includes('--force'), `Should not mention force: ${result.stderr}`);
    } finally {
      cleanup();
    }
  });

  test('no tags', () => {
    const { taskId, tasksFilePath, repoPath, originPath, cleanup } = createTempEnv();
    try {
      spawnSync('git', ['tag', 'v1.0.0'], {
        cwd: repoPath,
        encoding: 'utf-8',
        shell: false,
      });
      runCli(['real-repo-run-ai', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_PROVIDER: 'true',
        ALLOW_REAL_REPO_APPLY: 'true',
        ALLOW_REAL_REPO_COMMIT: 'true',
        ALLOW_REAL_REPO_PUSH: 'true',
        KIMI_API_KEY: 'fake',
        KIMI_BASE_URL: 'http://localhost:9999',
        KIMI_FAKE_RESPONSE: buildFakeKimiOutput([{ path: 'README.md', content: '# modified\n' }]),
      });
      const refs = getBareRefs(originPath);
      const hasTag = refs.some((r) => r.includes('refs/tags/'));
      assert(!hasTag, `Bare remote should NOT have tags: ${refs.join(', ')}`);
    } finally {
      cleanup();
    }
  });

  test('no all/mirror push', () => {
    const { taskId, tasksFilePath, cleanup } = createTempEnv();
    try {
      const result = runCli(['real-repo-run-ai', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_PROVIDER: 'true',
        ALLOW_REAL_REPO_APPLY: 'true',
        ALLOW_REAL_REPO_COMMIT: 'true',
        ALLOW_REAL_REPO_PUSH: 'true',
        KIMI_API_KEY: 'fake',
        KIMI_BASE_URL: 'http://localhost:9999',
        KIMI_FAKE_RESPONSE: buildFakeKimiOutput([{ path: 'README.md', content: '# modified\n' }]),
      });
      assert.strictEqual(result.status, 0, `Expected success: ${result.stderr}`);
      assert(!result.stderr.includes('--all'), `Should not mention --all: ${result.stderr}`);
      assert(!result.stderr.includes('--mirror'), `Should not mention --mirror: ${result.stderr}`);
    } finally {
      cleanup();
    }
  });

  test('no merge', () => {
    const { taskId, tasksFilePath, repoPath, cleanup } = createTempEnv();
    try {
      const before = getCurrentBranch(repoPath);
      const result = runCli(['real-repo-run-ai', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_PROVIDER: 'true',
        ALLOW_REAL_REPO_APPLY: 'true',
        ALLOW_REAL_REPO_COMMIT: 'true',
        ALLOW_REAL_REPO_PUSH: 'true',
        KIMI_API_KEY: 'fake',
        KIMI_BASE_URL: 'http://localhost:9999',
        KIMI_FAKE_RESPONSE: buildFakeKimiOutput([{ path: 'README.md', content: '# modified\n' }]),
      });
      assert.strictEqual(result.status, 0, `Expected success: ${result.stderr}`);
      const after = getCurrentBranch(repoPath);
      assert.strictEqual(after, before, `Branch should not change: ${before} -> ${after}`);
    } finally {
      cleanup();
    }
  });

  test('no checkout/switch', () => {
    const { taskId, tasksFilePath, repoPath, cleanup } = createTempEnv();
    try {
      const before = getCurrentBranch(repoPath);
      const result = runCli(['real-repo-run-ai', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_PROVIDER: 'true',
        ALLOW_REAL_REPO_APPLY: 'true',
        ALLOW_REAL_REPO_COMMIT: 'true',
        ALLOW_REAL_REPO_PUSH: 'true',
        KIMI_API_KEY: 'fake',
        KIMI_BASE_URL: 'http://localhost:9999',
        KIMI_FAKE_RESPONSE: buildFakeKimiOutput([{ path: 'README.md', content: '# modified\n' }]),
      });
      assert.strictEqual(result.status, 0, `Expected success: ${result.stderr}`);
      const after = getCurrentBranch(repoPath);
      assert.strictEqual(after, before, `Branch should not change: ${before} -> ${after}`);
    } finally {
      cleanup();
    }
  });

  test('no pull/fetch/rebase/reset', () => {
    const { taskId, tasksFilePath, repoPath, cleanup } = createTempEnv();
    try {
      const before = getGitLogCount(repoPath);
      const result = runCli(['real-repo-run-ai', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_PROVIDER: 'true',
        ALLOW_REAL_REPO_APPLY: 'true',
        ALLOW_REAL_REPO_COMMIT: 'true',
        ALLOW_REAL_REPO_PUSH: 'true',
        KIMI_API_KEY: 'fake',
        KIMI_BASE_URL: 'http://localhost:9999',
        KIMI_FAKE_RESPONSE: buildFakeKimiOutput([{ path: 'README.md', content: '# modified\n' }]),
      });
      assert.strictEqual(result.status, 0, `Expected success: ${result.stderr}`);
      const after = getGitLogCount(repoPath);
      assert.strictEqual(after, before + 1, `Local log should increase by exactly 1 commit: ${before} -> ${after}`);
    } finally {
      cleanup();
    }
  });

  test('no main touch', () => {
    const { taskId, tasksFilePath, originPath, cleanup } = createTempEnv();
    try {
      runCli(['real-repo-run-ai', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_PROVIDER: 'true',
        ALLOW_REAL_REPO_APPLY: 'true',
        ALLOW_REAL_REPO_COMMIT: 'true',
        ALLOW_REAL_REPO_PUSH: 'true',
        KIMI_API_KEY: 'fake',
        KIMI_BASE_URL: 'http://localhost:9999',
        KIMI_FAKE_RESPONSE: buildFakeKimiOutput([{ path: 'README.md', content: '# modified\n' }]),
      });
      const refs = getBareRefs(originPath);
      const hasMain = refs.some((r) => r.includes('refs/heads/main'));
      assert(!hasMain, `Bare remote should NOT have refs/heads/main: ${refs.join(', ')}`);
    } finally {
      cleanup();
    }
  });

  test('working tree clean after success', () => {
    const { taskId, tasksFilePath, repoPath, cleanup } = createTempEnv();
    try {
      const result = runCli(['real-repo-run-ai', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_PROVIDER: 'true',
        ALLOW_REAL_REPO_APPLY: 'true',
        ALLOW_REAL_REPO_COMMIT: 'true',
        ALLOW_REAL_REPO_PUSH: 'true',
        KIMI_API_KEY: 'fake',
        KIMI_BASE_URL: 'http://localhost:9999',
        KIMI_FAKE_RESPONSE: buildFakeKimiOutput([{ path: 'README.md', content: '# modified\n' }]),
      });
      assert.strictEqual(result.status, 0, `Expected success: ${result.stderr}`);
      const porcelain = getGitPorcelain(repoPath);
      assert.strictEqual(porcelain, '', `Working tree should be clean after success: ${porcelain}`);
    } finally {
      cleanup();
    }
  });

  test('branch unchanged after success', () => {
    const { taskId, tasksFilePath, repoPath, cleanup } = createTempEnv();
    try {
      const before = getCurrentBranch(repoPath);
      const result = runCli(['real-repo-run-ai', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_PROVIDER: 'true',
        ALLOW_REAL_REPO_APPLY: 'true',
        ALLOW_REAL_REPO_COMMIT: 'true',
        ALLOW_REAL_REPO_PUSH: 'true',
        KIMI_API_KEY: 'fake',
        KIMI_BASE_URL: 'http://localhost:9999',
        KIMI_FAKE_RESPONSE: buildFakeKimiOutput([{ path: 'README.md', content: '# modified\n' }]),
      });
      assert.strictEqual(result.status, 0, `Expected success: ${result.stderr}`);
      const after = getCurrentBranch(repoPath);
      assert.strictEqual(after, before, `Branch should not change: ${before} -> ${after}`);
    } finally {
      cleanup();
    }
  });

  test('sandbox preflight success allows real repo run-ai commit push and state', () => {
    const { taskId, tasksFilePath, repoPath, originPath, runsDir, cleanup } = createTempEnv();
    try {
      const before = getBareRefs(originPath);
      const result = runCli(['real-repo-run-ai', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_PROVIDER: 'true',
        ALLOW_REAL_REPO_APPLY: 'true',
        ALLOW_REAL_REPO_COMMIT: 'true',
        ALLOW_REAL_REPO_PUSH: 'true',
        KIMI_API_KEY: 'fake',
        KIMI_BASE_URL: 'http://localhost:9999',
        KIMI_FAKE_RESPONSE: buildFakeKimiOutput([
          { path: 'README.md', content: '# ai-sandbox-passed\n' },
        ]),
        RUNS_DIR: runsDir,
      });
      assert.strictEqual(result.status, 0, `Expected success: ${result.stderr}`);
      const content = readFileSync(join(repoPath, 'README.md'), 'utf-8');
      assert.strictEqual(content, '# ai-sandbox-passed\n', 'Real repo file should be modified after sandbox preflight passes');
      const after = getBareRefs(originPath);
      assert.notDeepStrictEqual(after, before, 'Should push to remote');
      const state = loadStateFromPath(runsDir, taskId);
      assert(state !== null, 'State should be written');
      assert.strictEqual((state as Record<string, unknown>).status, 'pushed');
    } finally {
      cleanup();
    }
  });

  test('existing real-repo-run behavior unchanged', () => {
    const { taskId, tasksFilePath, cleanup } = createTempEnv();
    try {
      const result = runCli(['real-repo-run', taskId], {
        TASKS_FILE: tasksFilePath,
      });
      assert.notStrictEqual(result.status, 0);
      assert(result.stderr.includes('ALLOW_REAL_REPO_APPLY=true is required'), `real-repo-run unchanged: ${result.stderr}`);
    } finally {
      cleanup();
    }
  });

  test('existing real-repo-apply behavior unchanged', () => {
    const { taskId, tasksFilePath, cleanup } = createTempEnv();
    try {
      const result = runCli(['real-repo-apply', taskId], {
        TASKS_FILE: tasksFilePath,
      });
      assert.notStrictEqual(result.status, 0);
      assert(result.stderr.includes('ALLOW_REAL_REPO_APPLY=true is required'), `real-repo-apply unchanged: ${result.stderr}`);
    } finally {
      cleanup();
    }
  });

  test('existing real-repo-commit behavior unchanged', () => {
    const { taskId, tasksFilePath, cleanup } = createTempEnv();
    try {
      const result = runCli(['real-repo-commit', taskId], {
        TASKS_FILE: tasksFilePath,
      });
      assert.notStrictEqual(result.status, 0);
      assert(result.stderr.includes('ALLOW_REAL_REPO_COMMIT=true is required'), `real-repo-commit unchanged: ${result.stderr}`);
    } finally {
      cleanup();
    }
  });

  test('existing real-repo-push behavior unchanged', () => {
    const { taskId, tasksFilePath, cleanup } = createTempEnv();
    try {
      const result = runCli(['real-repo-push', taskId], {
        TASKS_FILE: tasksFilePath,
      });
      assert.notStrictEqual(result.status, 0);
      assert(result.stderr.includes('ALLOW_REAL_REPO_PUSH=true is required'), `real-repo-push unchanged: ${result.stderr}`);
    } finally {
      cleanup();
    }
  });

  test('no stack trace in failure paths', () => {
    const { taskId, tasksFilePath, repoPath, cleanup } = createTempEnv();
    try {
      writeFileSync(join(repoPath, 'README.md'), '# dirty\n', 'utf-8');
      const result = runCli(['real-repo-run-ai', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_PROVIDER: 'true',
        ALLOW_REAL_REPO_APPLY: 'true',
        ALLOW_REAL_REPO_COMMIT: 'true',
        ALLOW_REAL_REPO_PUSH: 'true',
        KIMI_API_KEY: 'fake',
        KIMI_BASE_URL: 'http://localhost:9999',
        KIMI_FAKE_RESPONSE: buildFakeKimiOutput([{ path: 'README.md', content: '# modified\n' }]),
      });
      assert.notStrictEqual(result.status, 0);
      assert(!result.stderr.includes('at '), `Should not contain stack trace: ${result.stderr}`);
    } finally {
      cleanup();
    }
  });

  // --- Max attempts validation ---

  test('missing REAL_REPO_AI_MAX_ATTEMPTS defaults to 2', () => {
    const { taskId, tasksFilePath, repoPath, cleanup } = createTempEnv([], [{ command: 'node', args: ['check.cjs'] }]);
    try {
      setupCheckFile(repoPath);
      const result = runCli(['real-repo-run-ai', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_PROVIDER: 'true',
        ALLOW_REAL_REPO_APPLY: 'true',
        ALLOW_REAL_REPO_COMMIT: 'true',
        ALLOW_REAL_REPO_PUSH: 'true',
        KIMI_API_KEY: 'fake',
        KIMI_BASE_URL: 'http://localhost:9999',
        KIMI_FAKE_RESPONSES: JSON.stringify([
          buildFakeKimiOutput([{ path: 'README.md', content: '# fail\n' }]),
          buildFakeKimiOutput([{ path: 'README.md', content: '# pass\n' }]),
        ]),
      });
      assert.strictEqual(result.status, 0, `Expected success: ${result.stderr}`);
      assert(result.stderr.includes('Repair attempt succeeded'), `Expected repair success: ${result.stderr}`);
    } finally {
      cleanup();
    }
  });

  test('REAL_REPO_AI_MAX_ATTEMPTS=1 allows only one provider call', () => {
    const { taskId, tasksFilePath, repoPath, cleanup } = createTempEnv([], [{ command: 'node', args: ['check.cjs'] }]);
    try {
      setupCheckFile(repoPath);
      const result = runCli(['real-repo-run-ai', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_PROVIDER: 'true',
        ALLOW_REAL_REPO_APPLY: 'true',
        ALLOW_REAL_REPO_COMMIT: 'true',
        ALLOW_REAL_REPO_PUSH: 'true',
        REAL_REPO_AI_MAX_ATTEMPTS: '1',
        KIMI_API_KEY: 'fake',
        KIMI_BASE_URL: 'http://localhost:9999',
        KIMI_FAKE_RESPONSES: JSON.stringify([
          buildFakeKimiOutput([{ path: 'README.md', content: '# pass\n' }]),
        ]),
      });
      assert.strictEqual(result.status, 0, `Expected success: ${result.stderr}`);
      assert(!result.stderr.includes('Repair attempt'), `Should not repair with maxAttempts=1: ${result.stderr}`);
    } finally {
      cleanup();
    }
  });

  test('REAL_REPO_AI_MAX_ATTEMPTS=2 allows repair once', () => {
    const { taskId, tasksFilePath, repoPath, cleanup } = createTempEnv([], [{ command: 'node', args: ['check.cjs'] }]);
    try {
      setupCheckFile(repoPath);
      const result = runCli(['real-repo-run-ai', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_PROVIDER: 'true',
        ALLOW_REAL_REPO_APPLY: 'true',
        ALLOW_REAL_REPO_COMMIT: 'true',
        ALLOW_REAL_REPO_PUSH: 'true',
        REAL_REPO_AI_MAX_ATTEMPTS: '2',
        KIMI_API_KEY: 'fake',
        KIMI_BASE_URL: 'http://localhost:9999',
        KIMI_FAKE_RESPONSES: JSON.stringify([
          buildFakeKimiOutput([{ path: 'README.md', content: '# fail\n' }]),
          buildFakeKimiOutput([{ path: 'README.md', content: '# pass\n' }]),
        ]),
      });
      assert.strictEqual(result.status, 0, `Expected success: ${result.stderr}`);
    } finally {
      cleanup();
    }
  });

  test('REAL_REPO_AI_MAX_ATTEMPTS=3 allows two repairs', () => {
    const { taskId, tasksFilePath, repoPath, cleanup } = createTempEnv([], [{ command: 'node', args: ['check.cjs'] }]);
    try {
      setupCheckFile(repoPath);
      const result = runCli(['real-repo-run-ai', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_PROVIDER: 'true',
        ALLOW_REAL_REPO_APPLY: 'true',
        ALLOW_REAL_REPO_COMMIT: 'true',
        ALLOW_REAL_REPO_PUSH: 'true',
        REAL_REPO_AI_MAX_ATTEMPTS: '3',
        KIMI_API_KEY: 'fake',
        KIMI_BASE_URL: 'http://localhost:9999',
        KIMI_FAKE_RESPONSES: JSON.stringify([
          buildFakeKimiOutput([{ path: 'README.md', content: '# fail\n' }]),
          buildFakeKimiOutput([{ path: 'README.md', content: '# fail\n' }]),
          buildFakeKimiOutput([{ path: 'README.md', content: '# pass\n' }]),
        ]),
      });
      assert.strictEqual(result.status, 0, `Expected success: ${result.stderr}`);
    } finally {
      cleanup();
    }
  });

  test('REAL_REPO_AI_MAX_ATTEMPTS=0 refuses before provider call', () => {
    const { taskId, tasksFilePath, cleanup } = createTempEnv();
    try {
      const result = runCli(['real-repo-run-ai', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_PROVIDER: 'true',
        ALLOW_REAL_REPO_APPLY: 'true',
        ALLOW_REAL_REPO_COMMIT: 'true',
        ALLOW_REAL_REPO_PUSH: 'true',
        REAL_REPO_AI_MAX_ATTEMPTS: '0',
        KIMI_API_KEY: 'fake',
        KIMI_BASE_URL: 'http://localhost:9999',
      });
      assert.notStrictEqual(result.status, 0);
      assert(result.stderr.includes('Invalid REAL_REPO_AI_MAX_ATTEMPTS'), `Expected invalid message: ${result.stderr}`);
      assert(result.stderr.includes('No provider call was made'), `Expected no provider call: ${result.stderr}`);
    } finally {
      cleanup();
    }
  });

  test('REAL_REPO_AI_MAX_ATTEMPTS=4 refuses before provider call', () => {
    const { taskId, tasksFilePath, cleanup } = createTempEnv();
    try {
      const result = runCli(['real-repo-run-ai', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_PROVIDER: 'true',
        ALLOW_REAL_REPO_APPLY: 'true',
        ALLOW_REAL_REPO_COMMIT: 'true',
        ALLOW_REAL_REPO_PUSH: 'true',
        REAL_REPO_AI_MAX_ATTEMPTS: '4',
        KIMI_API_KEY: 'fake',
        KIMI_BASE_URL: 'http://localhost:9999',
      });
      assert.notStrictEqual(result.status, 0);
      assert(result.stderr.includes('Invalid REAL_REPO_AI_MAX_ATTEMPTS'), `Expected invalid message: ${result.stderr}`);
      assert(result.stderr.includes('No provider call was made'), `Expected no provider call: ${result.stderr}`);
    } finally {
      cleanup();
    }
  });

  test('non-numeric REAL_REPO_AI_MAX_ATTEMPTS refuses before provider call', () => {
    const { taskId, tasksFilePath, cleanup } = createTempEnv();
    try {
      const result = runCli(['real-repo-run-ai', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_PROVIDER: 'true',
        ALLOW_REAL_REPO_APPLY: 'true',
        ALLOW_REAL_REPO_COMMIT: 'true',
        ALLOW_REAL_REPO_PUSH: 'true',
        REAL_REPO_AI_MAX_ATTEMPTS: 'abc',
        KIMI_API_KEY: 'fake',
        KIMI_BASE_URL: 'http://localhost:9999',
      });
      assert.notStrictEqual(result.status, 0);
      assert(result.stderr.includes('Invalid REAL_REPO_AI_MAX_ATTEMPTS'), `Expected invalid message: ${result.stderr}`);
      assert(result.stderr.includes('No provider call was made'), `Expected no provider call: ${result.stderr}`);
    } finally {
      cleanup();
    }
  });

  test('invalid REAL_REPO_AI_MAX_ATTEMPTS does not apply/commit/push/state', () => {
    const { taskId, tasksFilePath, repoPath, originPath, runsDir, cleanup } = createTempEnv();
    try {
      const before = getBareRefs(originPath);
      const beforeLog = getGitLogCount(repoPath);
      const result = runCli(['real-repo-run-ai', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_PROVIDER: 'true',
        ALLOW_REAL_REPO_APPLY: 'true',
        ALLOW_REAL_REPO_COMMIT: 'true',
        ALLOW_REAL_REPO_PUSH: 'true',
        REAL_REPO_AI_MAX_ATTEMPTS: 'abc',
        KIMI_API_KEY: 'fake',
        KIMI_BASE_URL: 'http://localhost:9999',
        RUNS_DIR: runsDir,
      });
      assert.notStrictEqual(result.status, 0);
      assert(result.stderr.includes('Invalid REAL_REPO_AI_MAX_ATTEMPTS'), `Expected invalid message: ${result.stderr}`);
      const after = getBareRefs(originPath);
      assert.deepStrictEqual(after, before, `Remote should not change`);
      assert.strictEqual(getGitLogCount(repoPath), beforeLog, `No commit should be made`);
      assert.strictEqual(loadStateFromPath(runsDir, taskId), null, `No state should be written`);
    } finally {
      cleanup();
    }
  });

  // --- Check failure behavior ---

  test('check failure on attempt 1 rolls back', () => {
    const { taskId, tasksFilePath, repoPath, cleanup } = createTempEnv([], [{ command: 'node', args: ['check.cjs'] }]);
    try {
      setupCheckFile(repoPath);
      const beforeContent = readFileSync(join(repoPath, 'README.md'), 'utf-8');
      const result = runCli(['real-repo-run-ai', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_PROVIDER: 'true',
        ALLOW_REAL_REPO_APPLY: 'true',
        ALLOW_REAL_REPO_COMMIT: 'true',
        ALLOW_REAL_REPO_PUSH: 'true',
        REAL_REPO_AI_MAX_ATTEMPTS: '1',
        KIMI_API_KEY: 'fake',
        KIMI_BASE_URL: 'http://localhost:9999',
        KIMI_FAKE_RESPONSES: JSON.stringify([
          buildFakeKimiOutput([{ path: 'README.md', content: '# fail\n' }]),
        ]),
      });
      assert.notStrictEqual(result.status, 0);
      assert(result.stderr.includes('Sandbox preflight failed at step: checks'), `Expected sandbox check failure: ${result.stderr}`);
      const afterContent = readFileSync(join(repoPath, 'README.md'), 'utf-8');
      assert.strictEqual(afterContent, beforeContent, `File should be rolled back`);
    } finally {
      cleanup();
    }
  });

  test('check failure on attempt 1 does not commit', () => {
    const { taskId, tasksFilePath, repoPath, cleanup } = createTempEnv([], [{ command: 'node', args: ['check.cjs'] }]);
    try {
      setupCheckFile(repoPath);
      const beforeLog = getGitLogCount(repoPath);
      const result = runCli(['real-repo-run-ai', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_PROVIDER: 'true',
        ALLOW_REAL_REPO_APPLY: 'true',
        ALLOW_REAL_REPO_COMMIT: 'true',
        ALLOW_REAL_REPO_PUSH: 'true',
        REAL_REPO_AI_MAX_ATTEMPTS: '1',
        KIMI_API_KEY: 'fake',
        KIMI_BASE_URL: 'http://localhost:9999',
        KIMI_FAKE_RESPONSES: JSON.stringify([
          buildFakeKimiOutput([{ path: 'README.md', content: '# fail\n' }]),
        ]),
      });
      assert.notStrictEqual(result.status, 0);
      assert.strictEqual(getGitLogCount(repoPath), beforeLog, `No commit should be made`);
    } finally {
      cleanup();
    }
  });

  test('check failure on attempt 1 does not push', () => {
    const { taskId, tasksFilePath, originPath, repoPath, cleanup } = createTempEnv([], [{ command: 'node', args: ['check.cjs'] }]);
    try {
      setupCheckFile(repoPath);
      const before = getBareRefs(originPath);
      const result = runCli(['real-repo-run-ai', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_PROVIDER: 'true',
        ALLOW_REAL_REPO_APPLY: 'true',
        ALLOW_REAL_REPO_COMMIT: 'true',
        ALLOW_REAL_REPO_PUSH: 'true',
        REAL_REPO_AI_MAX_ATTEMPTS: '1',
        KIMI_API_KEY: 'fake',
        KIMI_BASE_URL: 'http://localhost:9999',
        KIMI_FAKE_RESPONSES: JSON.stringify([
          buildFakeKimiOutput([{ path: 'README.md', content: '# fail\n' }]),
        ]),
      });
      assert.notStrictEqual(result.status, 0);
      const after = getBareRefs(originPath);
      assert.deepStrictEqual(after, before, `Remote should not change`);
    } finally {
      cleanup();
    }
  });

  test('check failure on attempt 1 does not write state', () => {
    const { taskId, tasksFilePath, repoPath, runsDir, cleanup } = createTempEnv([], [{ command: 'node', args: ['check.cjs'] }]);
    try {
      setupCheckFile(repoPath);
      const result = runCli(['real-repo-run-ai', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_PROVIDER: 'true',
        ALLOW_REAL_REPO_APPLY: 'true',
        ALLOW_REAL_REPO_COMMIT: 'true',
        ALLOW_REAL_REPO_PUSH: 'true',
        REAL_REPO_AI_MAX_ATTEMPTS: '1',
        KIMI_API_KEY: 'fake',
        KIMI_BASE_URL: 'http://localhost:9999',
        KIMI_FAKE_RESPONSES: JSON.stringify([
          buildFakeKimiOutput([{ path: 'README.md', content: '# fail\n' }]),
        ]),
        RUNS_DIR: runsDir,
      });
      assert.notStrictEqual(result.status, 0);
      assert.strictEqual(loadStateFromPath(runsDir, taskId), null, `No state should be written`);
    } finally {
      cleanup();
    }
  });

  test('check failure triggers second provider call when attempts remain', () => {
    const { taskId, tasksFilePath, repoPath, cleanup } = createTempEnv([], [{ command: 'node', args: ['check.cjs'] }]);
    try {
      setupCheckFile(repoPath);
      const beforeContent = readFileSync(join(repoPath, 'README.md'), 'utf-8');
      const result = runCli(['real-repo-run-ai', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_PROVIDER: 'true',
        ALLOW_REAL_REPO_APPLY: 'true',
        ALLOW_REAL_REPO_COMMIT: 'true',
        ALLOW_REAL_REPO_PUSH: 'true',
        REAL_REPO_AI_MAX_ATTEMPTS: '2',
        KIMI_API_KEY: 'fake',
        KIMI_BASE_URL: 'http://localhost:9999',
        KIMI_FAKE_RESPONSES: JSON.stringify([
          buildFakeKimiOutput([{ path: 'README.md', content: '# fail\n' }]),
          buildFakeKimiOutput([{ path: 'README.md', content: '# pass\n' }]),
        ]),
      });
      assert.strictEqual(result.status, 0, `Expected success after second attempt: ${result.stderr}`);
      assert(result.stderr.includes('Repair attempt succeeded'), `Expected repair success: ${result.stderr}`);
      const content = readFileSync(join(repoPath, 'README.md'), 'utf-8');
      assert.strictEqual(content, '# pass\n', `Second provider response should be applied`);
    } finally {
      cleanup();
    }
  });

  test('repair provider output malformed refuses safely', () => {
    const { taskId, tasksFilePath, repoPath, cleanup } = createTempEnv([], [{ command: 'node', args: ['check.cjs'] }]);
    try {
      setupCheckFile(repoPath);
      const result = runCli(['real-repo-run-ai', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_PROVIDER: 'true',
        ALLOW_REAL_REPO_APPLY: 'true',
        ALLOW_REAL_REPO_COMMIT: 'true',
        ALLOW_REAL_REPO_PUSH: 'true',
        REAL_REPO_AI_MAX_ATTEMPTS: '2',
        KIMI_API_KEY: 'fake',
        KIMI_BASE_URL: 'http://localhost:9999',
        KIMI_FAKE_RESPONSES: JSON.stringify([
          buildFakeKimiOutput([{ path: 'README.md', content: '# fail\n' }]),
          'not-json',
        ]),
      });
      assert.notStrictEqual(result.status, 0);
      assert(result.stderr.includes('Provider repair output malformed'), `Expected malformed message: ${result.stderr}`);
    } finally {
      cleanup();
    }
  });

  test('repair provider call failed refuses safely', () => {
    const { taskId, tasksFilePath, repoPath, cleanup } = createTempEnv([], [{ command: 'node', args: ['check.cjs'] }]);
    try {
      setupCheckFile(repoPath);
      const result = runCli(['real-repo-run-ai', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_PROVIDER: 'true',
        ALLOW_REAL_REPO_APPLY: 'true',
        ALLOW_REAL_REPO_COMMIT: 'true',
        ALLOW_REAL_REPO_PUSH: 'true',
        REAL_REPO_AI_MAX_ATTEMPTS: '2',
        KIMI_API_KEY: 'fake',
        KIMI_BASE_URL: 'http://localhost:9999',
        KIMI_FAKE_RESPONSES: JSON.stringify([
          buildFakeKimiOutput([{ path: 'README.md', content: '# fail\n' }]),
          '__FETCH_ERROR__',
        ]),
      });
      assert.notStrictEqual(result.status, 0);
      assert(result.stderr.includes('Provider repair call failed'), `Expected repair call failed: ${result.stderr}`);
    } finally {
      cleanup();
    }
  });

  // --- Final failed attempt ---

  test('final failed attempt prints Checks failed after N attempts', () => {
    const { taskId, tasksFilePath, repoPath, cleanup } = createTempEnv([], [{ command: 'node', args: ['check.cjs'] }]);
    try {
      setupCheckFile(repoPath);
      const result = runCli(['real-repo-run-ai', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_PROVIDER: 'true',
        ALLOW_REAL_REPO_APPLY: 'true',
        ALLOW_REAL_REPO_COMMIT: 'true',
        ALLOW_REAL_REPO_PUSH: 'true',
        REAL_REPO_AI_MAX_ATTEMPTS: '1',
        KIMI_API_KEY: 'fake',
        KIMI_BASE_URL: 'http://localhost:9999',
        KIMI_FAKE_RESPONSES: JSON.stringify([
          buildFakeKimiOutput([{ path: 'README.md', content: '# fail\n' }]),
        ]),
      });
      assert.notStrictEqual(result.status, 0);
      assert(result.stderr.includes('Sandbox preflight failed at step: checks'), `Expected sandbox check failure: ${result.stderr}`);
    } finally {
      cleanup();
    }
  });

  test('final failed attempt leaves working tree clean', () => {
    const { taskId, tasksFilePath, repoPath, cleanup } = createTempEnv([], [{ command: 'node', args: ['check.cjs'] }]);
    try {
      setupCheckFile(repoPath);
      const result = runCli(['real-repo-run-ai', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_PROVIDER: 'true',
        ALLOW_REAL_REPO_APPLY: 'true',
        ALLOW_REAL_REPO_COMMIT: 'true',
        ALLOW_REAL_REPO_PUSH: 'true',
        REAL_REPO_AI_MAX_ATTEMPTS: '1',
        KIMI_API_KEY: 'fake',
        KIMI_BASE_URL: 'http://localhost:9999',
        KIMI_FAKE_RESPONSES: JSON.stringify([
          buildFakeKimiOutput([{ path: 'README.md', content: '# fail\n' }]),
        ]),
      });
      assert.notStrictEqual(result.status, 0);
      assert.strictEqual(getGitPorcelain(repoPath), '', `Working tree should be clean: ${getGitPorcelain(repoPath)}`);
    } finally {
      cleanup();
    }
  });

  test('final failed attempt leaves branch unchanged', () => {
    const { taskId, tasksFilePath, repoPath, cleanup } = createTempEnv([], [{ command: 'node', args: ['check.cjs'] }]);
    try {
      setupCheckFile(repoPath);
      const result = runCli(['real-repo-run-ai', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_PROVIDER: 'true',
        ALLOW_REAL_REPO_APPLY: 'true',
        ALLOW_REAL_REPO_COMMIT: 'true',
        ALLOW_REAL_REPO_PUSH: 'true',
        REAL_REPO_AI_MAX_ATTEMPTS: '1',
        KIMI_API_KEY: 'fake',
        KIMI_BASE_URL: 'http://localhost:9999',
        KIMI_FAKE_RESPONSES: JSON.stringify([
          buildFakeKimiOutput([{ path: 'README.md', content: '# fail\n' }]),
        ]),
      });
      assert.notStrictEqual(result.status, 0);
      assert.strictEqual(getCurrentBranch(repoPath), `ai/${taskId}`, `Branch should be unchanged`);
    } finally {
      cleanup();
    }
  });

  // --- Successful repair ---

  test('successful repair creates exactly one commit', () => {
    const { taskId, tasksFilePath, repoPath, cleanup } = createTempEnv([], [{ command: 'node', args: ['check.cjs'] }]);
    try {
      setupCheckFile(repoPath);
      const beforeLog = getGitLogCount(repoPath);
      const result = runCli(['real-repo-run-ai', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_PROVIDER: 'true',
        ALLOW_REAL_REPO_APPLY: 'true',
        ALLOW_REAL_REPO_COMMIT: 'true',
        ALLOW_REAL_REPO_PUSH: 'true',
        REAL_REPO_AI_MAX_ATTEMPTS: '2',
        KIMI_API_KEY: 'fake',
        KIMI_BASE_URL: 'http://localhost:9999',
        KIMI_FAKE_RESPONSES: JSON.stringify([
          buildFakeKimiOutput([{ path: 'README.md', content: '# fail\n' }]),
          buildFakeKimiOutput([{ path: 'README.md', content: '# pass\n' }]),
        ]),
      });
      assert.strictEqual(result.status, 0, `Expected success: ${result.stderr}`);
    } finally {
      cleanup();
    }
  });

  test('successful repair pushes exactly once', () => {
    const { taskId, tasksFilePath, repoPath, originPath, cleanup } = createTempEnv([], [{ command: 'node', args: ['check.cjs'] }]);
    try {
      setupCheckFile(repoPath);
      const before = getBareRefs(originPath);
      const result = runCli(['real-repo-run-ai', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_PROVIDER: 'true',
        ALLOW_REAL_REPO_APPLY: 'true',
        ALLOW_REAL_REPO_COMMIT: 'true',
        ALLOW_REAL_REPO_PUSH: 'true',
        REAL_REPO_AI_MAX_ATTEMPTS: '2',
        KIMI_API_KEY: 'fake',
        KIMI_BASE_URL: 'http://localhost:9999',
        KIMI_FAKE_RESPONSES: JSON.stringify([
          buildFakeKimiOutput([{ path: 'README.md', content: '# fail\n' }]),
          buildFakeKimiOutput([{ path: 'README.md', content: '# pass\n' }]),
        ]),
      });
      assert.strictEqual(result.status, 0, `Expected success: ${result.stderr}`);
    } finally {
      cleanup();
    }
  });

  test('successful repair writes pushed state', () => {
    const { taskId, tasksFilePath, repoPath, runsDir, cleanup } = createTempEnv([], [{ command: 'node', args: ['check.cjs'] }]);
    try {
      setupCheckFile(repoPath);
      const result = runCli(['real-repo-run-ai', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_PROVIDER: 'true',
        ALLOW_REAL_REPO_APPLY: 'true',
        ALLOW_REAL_REPO_COMMIT: 'true',
        ALLOW_REAL_REPO_PUSH: 'true',
        REAL_REPO_AI_MAX_ATTEMPTS: '2',
        KIMI_API_KEY: 'fake',
        KIMI_BASE_URL: 'http://localhost:9999',
        KIMI_FAKE_RESPONSES: JSON.stringify([
          buildFakeKimiOutput([{ path: 'README.md', content: '# fail\n' }]),
          buildFakeKimiOutput([{ path: 'README.md', content: '# pass\n' }]),
        ]),
        RUNS_DIR: runsDir,
      });
      assert.strictEqual(result.status, 0, `Expected success: ${result.stderr}`);
    } finally {
      cleanup();
    }
  });

  test('successful repair commit message is exactly ai-orchestrator: apply <taskId>', () => {
    const { taskId, tasksFilePath, repoPath, cleanup } = createTempEnv([], [{ command: 'node', args: ['check.cjs'] }]);
    try {
      setupCheckFile(repoPath);
      const result = runCli(['real-repo-run-ai', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_PROVIDER: 'true',
        ALLOW_REAL_REPO_APPLY: 'true',
        ALLOW_REAL_REPO_COMMIT: 'true',
        ALLOW_REAL_REPO_PUSH: 'true',
        REAL_REPO_AI_MAX_ATTEMPTS: '2',
        KIMI_API_KEY: 'fake',
        KIMI_BASE_URL: 'http://localhost:9999',
        KIMI_FAKE_RESPONSES: JSON.stringify([
          buildFakeKimiOutput([{ path: 'README.md', content: '# fail\n' }]),
          buildFakeKimiOutput([{ path: 'README.md', content: '# pass\n' }]),
        ]),
      });
      assert.strictEqual(result.status, 0, `Expected success: ${result.stderr}`);
    } finally {
      cleanup();
    }
  });

  test('successful repair state does not contain provider raw output', () => {
    const { taskId, tasksFilePath, repoPath, runsDir, cleanup } = createTempEnv([], [{ command: 'node', args: ['check.cjs'] }]);
    try {
      setupCheckFile(repoPath);
      const result = runCli(['real-repo-run-ai', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_PROVIDER: 'true',
        ALLOW_REAL_REPO_APPLY: 'true',
        ALLOW_REAL_REPO_COMMIT: 'true',
        ALLOW_REAL_REPO_PUSH: 'true',
        REAL_REPO_AI_MAX_ATTEMPTS: '2',
        KIMI_API_KEY: 'fake',
        KIMI_BASE_URL: 'http://localhost:9999',
        KIMI_FAKE_RESPONSES: JSON.stringify([
          buildFakeKimiOutput([{ path: 'README.md', content: '# fail\n' }]),
          buildFakeKimiOutput([{ path: 'README.md', content: '# pass\n' }]),
        ]),
        RUNS_DIR: runsDir,
      });
      assert.strictEqual(result.status, 0, `Expected success: ${result.stderr}`);
      const stateRaw = readFileSync(join(runsDir, taskId, 'state.json'), 'utf-8');
      assert(!stateRaw.includes('file_update'), `State should not contain provider raw output`);
    } finally {
      cleanup();
    }
  });

  test('successful repair state does not contain file contents', () => {
    const { taskId, tasksFilePath, repoPath, runsDir, cleanup } = createTempEnv([], [{ command: 'node', args: ['check.cjs'] }]);
    try {
      setupCheckFile(repoPath);
      runCli(['real-repo-run-ai', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_PROVIDER: 'true',
        ALLOW_REAL_REPO_APPLY: 'true',
        ALLOW_REAL_REPO_COMMIT: 'true',
        ALLOW_REAL_REPO_PUSH: 'true',
        REAL_REPO_AI_MAX_ATTEMPTS: '2',
        KIMI_API_KEY: 'fake',
        KIMI_BASE_URL: 'http://localhost:9999',
        KIMI_FAKE_RESPONSES: JSON.stringify([
          buildFakeKimiOutput([{ path: 'README.md', content: '# fail\n' }]),
          buildFakeKimiOutput([{ path: 'README.md', content: '# pass\n' }]),
        ]),
        RUNS_DIR: runsDir,
      });
      const stateRaw = readFileSync(join(runsDir, taskId, 'state.json'), 'utf-8');
      assert(!stateRaw.includes('file_update'), `State should not contain provider raw output`);
    } finally {
      cleanup();
    }
  });

  test('successful repair state does not contain fake API key', () => {
    const { taskId, tasksFilePath, repoPath, runsDir, cleanup } = createTempEnv([], [{ command: 'node', args: ['check.cjs'] }]);
    try {
      setupCheckFile(repoPath);
      runCli(['real-repo-run-ai', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_PROVIDER: 'true',
        ALLOW_REAL_REPO_APPLY: 'true',
        ALLOW_REAL_REPO_COMMIT: 'true',
        ALLOW_REAL_REPO_PUSH: 'true',
        REAL_REPO_AI_MAX_ATTEMPTS: '2',
        KIMI_API_KEY: 'sk-fake-repair-key',
        KIMI_BASE_URL: 'http://localhost:9999',
        KIMI_FAKE_RESPONSES: JSON.stringify([
          buildFakeKimiOutput([{ path: 'README.md', content: '# fail\n' }]),
          buildFakeKimiOutput([{ path: 'README.md', content: '# pass\n' }]),
        ]),
        RUNS_DIR: runsDir,
      });
      const stateRaw = readFileSync(join(runsDir, taskId, 'state.json'), 'utf-8');
      assert(!stateRaw.includes('sk-fake'), `State should not contain fake API key`);
    } finally {
      cleanup();
    }
  });

  test('successful repair preserves safety rules', () => {
    const { taskId, tasksFilePath, repoPath, cleanup } = createTempEnv([], [{ command: 'node', args: ['check.cjs'] }]);
    try {
      setupCheckFile(repoPath);
      const result = runCli(['real-repo-run-ai', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_PROVIDER: 'true',
        ALLOW_REAL_REPO_APPLY: 'true',
        ALLOW_REAL_REPO_COMMIT: 'true',
        ALLOW_REAL_REPO_PUSH: 'true',
        REAL_REPO_AI_MAX_ATTEMPTS: '2',
        KIMI_API_KEY: 'fake',
        KIMI_BASE_URL: 'http://localhost:9999',
        KIMI_FAKE_RESPONSES: JSON.stringify([
          buildFakeKimiOutput([{ path: 'README.md', content: '# fail\n' }]),
          buildFakeKimiOutput([{ path: 'README.md', content: '# pass\n' }]),
        ]),
      });
      assert.strictEqual(result.status, 0, `Expected success: ${result.stderr}`);
      assert(!result.stderr.includes('--force'), `Should not force push`);
      assert(!result.stderr.includes('No merge was performed'), `Should not merge`);
      assert(!result.stderr.includes('checkout'), `Should not checkout`);
      assert(!result.stderr.includes('main'), `Should not touch main`);
    } finally {
      cleanup();
    }
  });

  test('repair prompt does not leak fake API key in stderr', () => {
    const { taskId, tasksFilePath, repoPath, cleanup } = createTempEnv([], [{ command: 'node', args: ['check.cjs'] }]);
    try {
      setupCheckFile(repoPath);
      const result = runCli(['real-repo-run-ai', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_PROVIDER: 'true',
        ALLOW_REAL_REPO_APPLY: 'true',
        ALLOW_REAL_REPO_COMMIT: 'true',
        ALLOW_REAL_REPO_PUSH: 'true',
        REAL_REPO_AI_MAX_ATTEMPTS: '2',
        KIMI_API_KEY: 'sk-fake-repair-key',
        KIMI_BASE_URL: 'http://localhost:9999',
        KIMI_FAKE_RESPONSES: JSON.stringify([
          buildFakeKimiOutput([{ path: 'README.md', content: '# fail\n' }]),
          buildFakeKimiOutput([{ path: 'README.md', content: '# pass\n' }]),
        ]),
      });
      assert.strictEqual(result.status, 0, `Expected success: ${result.stderr}`);
      assert(!result.stderr.includes('sk-fake'), `Should not leak API key in repair: ${result.stderr}`);
    } finally {
      cleanup();
    }
  });

  test('repair prompt content is not printed to output', () => {
    const { taskId, tasksFilePath, repoPath, cleanup } = createTempEnv([], [{ command: 'node', args: ['check.cjs'] }]);
    try {
      setupCheckFile(repoPath);
      const result = runCli(['real-repo-run-ai', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_PROVIDER: 'true',
        ALLOW_REAL_REPO_APPLY: 'true',
        ALLOW_REAL_REPO_COMMIT: 'true',
        ALLOW_REAL_REPO_PUSH: 'true',
        REAL_REPO_AI_MAX_ATTEMPTS: '2',
        KIMI_API_KEY: 'fake',
        KIMI_BASE_URL: 'http://localhost:9999',
        KIMI_FAKE_RESPONSES: JSON.stringify([
          buildFakeKimiOutput([{ path: 'README.md', content: '# fail\n' }]),
          buildFakeKimiOutput([{ path: 'README.md', content: '# pass\n' }]),
        ]),
      });
      assert.strictEqual(result.status, 0, `Expected success: ${result.stderr}`);
      const combined = result.stdout + result.stderr;
      assert(!combined.includes('Failed check command:'), `Repair prompt should not be printed: ${combined}`);
      assert(!combined.includes('Previously proposed files:'), `Repair prompt should not be printed: ${combined}`);
    } finally {
      cleanup();
    }
  });

  test('corrupted local branch ref refuses before provider call', () => {
    const { taskId, tasksFilePath, repoPath, originPath, cleanup } = createTempEnv();
    try {
      corruptLocalBranchRef(repoPath, 'main');
      const beforeLog = getGitLogCount(repoPath);
      const beforeRefs = getBareRefs(originPath);
      const result = runCli(['real-repo-run-ai', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_PROVIDER: 'true',
        ALLOW_REAL_REPO_APPLY: 'true',
        ALLOW_REAL_REPO_COMMIT: 'true',
        ALLOW_REAL_REPO_PUSH: 'true',
      });
      assert.notStrictEqual(result.status, 0);
      assert(result.stderr.includes('Git repository health check failed'), `Expected health check failure: ${result.stderr}`);
      assert(result.stderr.includes('No provider call was made'), `Expected no provider call: ${result.stderr}`);
      assert.strictEqual(getGitLogCount(repoPath), beforeLog, `No commit should be made`);
      assert.deepStrictEqual(getBareRefs(originPath), beforeRefs, `Remote should not change`);
    } finally {
      cleanup();
    }
  });

  test('corrupted remote origin/main ref refuses before provider call', () => {
    const { taskId, tasksFilePath, repoPath, originPath, cleanup } = createTempEnv();
    try {
      corruptRemoteBaseRef(repoPath, 'main');
      const beforeLog = getGitLogCount(repoPath);
      const beforeRefs = getBareRefs(originPath);
      const result = runCli(['real-repo-run-ai', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_PROVIDER: 'true',
        ALLOW_REAL_REPO_APPLY: 'true',
        ALLOW_REAL_REPO_COMMIT: 'true',
        ALLOW_REAL_REPO_PUSH: 'true',
      });
      assert.notStrictEqual(result.status, 0);
      assert(result.stderr.includes('Git repository health check failed'), `Expected health check failure: ${result.stderr}`);
      assert(result.stderr.includes('No provider call was made'), `Expected no provider call: ${result.stderr}`);
      assert.strictEqual(getGitLogCount(repoPath), beforeLog, `No commit should be made`);
      assert.deepStrictEqual(getBareRefs(originPath), beforeRefs, `Remote should not change`);
    } finally {
      cleanup();
    }
  });

  test('invalid HEAD refuses before provider call', () => {
    const { taskId, tasksFilePath, repoPath, originPath, cleanup } = createTempEnv();
    try {
      invalidateHead(repoPath);
      const beforeLog = getGitLogCount(repoPath);
      const beforeRefs = getBareRefs(originPath);
      const result = runCli(['real-repo-run-ai', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_PROVIDER: 'true',
        ALLOW_REAL_REPO_APPLY: 'true',
        ALLOW_REAL_REPO_COMMIT: 'true',
        ALLOW_REAL_REPO_PUSH: 'true',
      });
      assert.notStrictEqual(result.status, 0);
      assert(result.stderr.includes('Git repository health check failed'), `Expected health check failure: ${result.stderr}`);
      assert(result.stderr.includes('No provider call was made'), `Expected no provider call: ${result.stderr}`);
      assert.strictEqual(getGitLogCount(repoPath), beforeLog, `No commit should be made`);
      assert.deepStrictEqual(getBareRefs(originPath), beforeRefs, `Remote should not change`);
    } finally {
      cleanup();
    }
  });

  test('sandbox checks failure triggers repair provider call before real repo mutation', () => {
    const { taskId, tasksFilePath, repoPath, cleanup } = createTempEnv([], [{ command: 'node', args: ['check.cjs'] }]);
    try {
      setupCheckFile(repoPath);
      const beforeContent = readFileSync(join(repoPath, 'README.md'), 'utf-8');
      const result = runCli(['real-repo-run-ai', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_PROVIDER: 'true',
        ALLOW_REAL_REPO_APPLY: 'true',
        ALLOW_REAL_REPO_COMMIT: 'true',
        ALLOW_REAL_REPO_PUSH: 'true',
        REAL_REPO_AI_MAX_ATTEMPTS: '2',
        KIMI_API_KEY: 'fake',
        KIMI_BASE_URL: 'http://localhost:9999',
        KIMI_FAKE_RESPONSES: JSON.stringify([
          buildFakeKimiOutput([{ path: 'README.md', content: '# fail\n' }]),
          buildFakeKimiOutput([{ path: 'README.md', content: '# pass\n' }]),
        ]),
      });
      assert.strictEqual(result.status, 0, `Expected success: ${result.stderr}`);
      assert(result.stderr.includes('Sandbox checks failed on attempt 1, requesting repair...'), `Should trigger repair: ${result.stderr}`);
      assert(result.stderr.includes('Repair attempt 2/2 (sandbox preflight)'), `Should show sandbox preflight repair: ${result.stderr}`);
      const content = readFileSync(join(repoPath, 'README.md'), 'utf-8');
      assert.strictEqual(content, '# pass\n', 'Repaired output should be applied to real repo');
      assert.notStrictEqual(content, beforeContent, 'Real repo should be mutated after successful repair');
    } finally {
      cleanup();
    }
  });

  test('repaired output that passes sandbox preflight then applies to real repo', () => {
    const { taskId, tasksFilePath, repoPath, cleanup } = createTempEnv([], [{ command: 'node', args: ['check.cjs'] }]);
    try {
      setupCheckFile(repoPath);
      const result = runCli(['real-repo-run-ai', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_PROVIDER: 'true',
        ALLOW_REAL_REPO_APPLY: 'true',
        ALLOW_REAL_REPO_COMMIT: 'true',
        ALLOW_REAL_REPO_PUSH: 'true',
        REAL_REPO_AI_MAX_ATTEMPTS: '2',
        KIMI_API_KEY: 'fake',
        KIMI_BASE_URL: 'http://localhost:9999',
        KIMI_FAKE_RESPONSES: JSON.stringify([
          buildFakeKimiOutput([{ path: 'README.md', content: '# fail\n' }]),
          buildFakeKimiOutput([{ path: 'README.md', content: '# repaired\n' }]),
        ]),
      });
      assert.strictEqual(result.status, 0, `Expected success: ${result.stderr}`);
      const content = readFileSync(join(repoPath, 'README.md'), 'utf-8');
      assert.strictEqual(content, '# repaired\n', 'Real repo file should be modified after repaired sandbox preflight passes');
    } finally {
      cleanup();
    }
  });

  test('repaired output that passes sandbox preflight commits/pushes/state as before', () => {
    const { taskId, tasksFilePath, repoPath, originPath, runsDir, cleanup } = createTempEnv([], [{ command: 'node', args: ['check.cjs'] }]);
    try {
      setupCheckFile(repoPath);
      const before = getBareRefs(originPath);
      const result = runCli(['real-repo-run-ai', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_PROVIDER: 'true',
        ALLOW_REAL_REPO_APPLY: 'true',
        ALLOW_REAL_REPO_COMMIT: 'true',
        ALLOW_REAL_REPO_PUSH: 'true',
        REAL_REPO_AI_MAX_ATTEMPTS: '2',
        KIMI_API_KEY: 'fake',
        KIMI_BASE_URL: 'http://localhost:9999',
        KIMI_FAKE_RESPONSES: JSON.stringify([
          buildFakeKimiOutput([{ path: 'README.md', content: '# fail\n' }]),
          buildFakeKimiOutput([{ path: 'README.md', content: '# pass\n' }]),
        ]),
        RUNS_DIR: runsDir,
      });
      assert.strictEqual(result.status, 0, `Expected success: ${result.stderr}`);
      const after = getBareRefs(originPath);
      assert.notDeepStrictEqual(after, before, 'Should push to remote after repair');
      const state = loadStateFromPath(runsDir, taskId);
      assert(state !== null, 'State should be written after repair');
      assert.strictEqual((state as Record<string, unknown>).status, 'pushed');
    } finally {
      cleanup();
    }
  });

  test('parse failure does not repair and exits non-zero', () => {
    const { taskId, tasksFilePath, cleanup } = createTempEnv();
    try {
      const result = runCli(['real-repo-run-ai', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_PROVIDER: 'true',
        ALLOW_REAL_REPO_APPLY: 'true',
        ALLOW_REAL_REPO_COMMIT: 'true',
        ALLOW_REAL_REPO_PUSH: 'true',
        KIMI_API_KEY: 'fake',
        KIMI_BASE_URL: 'http://localhost:9999',
        KIMI_FAKE_RESPONSE: 'not-valid-json',
      });
      assert.notStrictEqual(result.status, 0);
      assert(!result.stderr.includes('requesting repair'), `Parse failure should not trigger repair: ${result.stderr}`);
    } finally {
      cleanup();
    }
  });

  test('guardrails failure does not repair and exits non-zero', () => {
    const { taskId, tasksFilePath, cleanup } = createTempEnv();
    try {
      const result = runCli(['real-repo-run-ai', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_PROVIDER: 'true',
        ALLOW_REAL_REPO_APPLY: 'true',
        ALLOW_REAL_REPO_COMMIT: 'true',
        ALLOW_REAL_REPO_PUSH: 'true',
        KIMI_API_KEY: 'fake',
        KIMI_BASE_URL: 'http://localhost:9999',
        KIMI_FAKE_RESPONSE: buildFakeKimiOutput([{ path: '.env', content: 'SECRET=1\n' }]),
      });
      assert.notStrictEqual(result.status, 0);
      assert(!result.stderr.includes('requesting repair'), `Guardrails failure should not trigger repair: ${result.stderr}`);
    } finally {
      cleanup();
    }
  });

  test('apply failure does not repair and exits non-zero', () => {
    const { taskId, tasksFilePath, repoPath, cleanup } = createTempEnv();
    try {
      writeFileSync(join(repoPath, 'blocked'), 'i am a file not a directory', 'utf-8');
      spawnSync('git', ['add', 'blocked'], { cwd: repoPath, encoding: 'utf-8', shell: false });
      spawnSync('git', ['commit', '-m', 'add blocked', '--no-gpg-sign'], { cwd: repoPath, encoding: 'utf-8', shell: false });
      const result = runCli(['real-repo-run-ai', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_PROVIDER: 'true',
        ALLOW_REAL_REPO_APPLY: 'true',
        ALLOW_REAL_REPO_COMMIT: 'true',
        ALLOW_REAL_REPO_PUSH: 'true',
        KIMI_API_KEY: 'fake',
        KIMI_BASE_URL: 'http://localhost:9999',
        KIMI_FAKE_RESPONSE: buildFakeKimiOutput([{ path: 'blocked/new.txt', content: 'should fail\n' }]),
      });
      assert.notStrictEqual(result.status, 0);
      assert(result.stderr.includes('apply'), `Should mention apply failure: ${result.stderr}`);
      assert(!result.stderr.includes('requesting repair'), `Apply failure should not trigger repair: ${result.stderr}`);
    } finally {
      cleanup();
    }
  });

  test('maxAttempts reached does not repair and exits non-zero', () => {
    const { taskId, tasksFilePath, repoPath, cleanup } = createTempEnv([], [{ command: 'node', args: ['check.cjs'] }]);
    try {
      setupCheckFile(repoPath);
      const result = runCli(['real-repo-run-ai', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_PROVIDER: 'true',
        ALLOW_REAL_REPO_APPLY: 'true',
        ALLOW_REAL_REPO_COMMIT: 'true',
        ALLOW_REAL_REPO_PUSH: 'true',
        REAL_REPO_AI_MAX_ATTEMPTS: '1',
        KIMI_API_KEY: 'fake',
        KIMI_BASE_URL: 'http://localhost:9999',
        KIMI_FAKE_RESPONSES: JSON.stringify([
          buildFakeKimiOutput([{ path: 'README.md', content: '# fail\n' }]),
        ]),
      });
      assert.notStrictEqual(result.status, 0);
      assert(!result.stderr.includes('requesting repair'), `MaxAttempts reached should not trigger repair: ${result.stderr}`);
      assert(result.stderr.includes('Attempt 1 of 1 reached'), `Should mention max attempts reached: ${result.stderr}`);
    } finally {
      cleanup();
    }
  });

  test('failed sandbox checks before repair do not mutate real repo', () => {
    const { taskId, tasksFilePath, repoPath, cleanup } = createTempEnv([], [{ command: 'node', args: ['check.cjs'] }]);
    try {
      setupCheckFile(repoPath);
      const beforeContent = readFileSync(join(repoPath, 'README.md'), 'utf-8');
      const result = runCli(['real-repo-run-ai', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_PROVIDER: 'true',
        ALLOW_REAL_REPO_APPLY: 'true',
        ALLOW_REAL_REPO_COMMIT: 'true',
        ALLOW_REAL_REPO_PUSH: 'true',
        REAL_REPO_AI_MAX_ATTEMPTS: '1',
        KIMI_API_KEY: 'fake',
        KIMI_BASE_URL: 'http://localhost:9999',
        KIMI_FAKE_RESPONSES: JSON.stringify([
          buildFakeKimiOutput([{ path: 'README.md', content: '# fail\n' }]),
        ]),
      });
      assert.notStrictEqual(result.status, 0);
      const afterContent = readFileSync(join(repoPath, 'README.md'), 'utf-8');
      assert.strictEqual(afterContent, beforeContent, `Real repo should not be mutated when sandbox checks fail and maxAttempts reached`);
    } finally {
      cleanup();
    }
  });

  test('failed sandbox checks before repair do not commit', () => {
    const { taskId, tasksFilePath, repoPath, cleanup } = createTempEnv([], [{ command: 'node', args: ['check.cjs'] }]);
    try {
      setupCheckFile(repoPath);
      const beforeLog = getGitLogCount(repoPath);
      const result = runCli(['real-repo-run-ai', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_PROVIDER: 'true',
        ALLOW_REAL_REPO_APPLY: 'true',
        ALLOW_REAL_REPO_COMMIT: 'true',
        ALLOW_REAL_REPO_PUSH: 'true',
        REAL_REPO_AI_MAX_ATTEMPTS: '1',
        KIMI_API_KEY: 'fake',
        KIMI_BASE_URL: 'http://localhost:9999',
        KIMI_FAKE_RESPONSES: JSON.stringify([
          buildFakeKimiOutput([{ path: 'README.md', content: '# fail\n' }]),
        ]),
      });
      assert.notStrictEqual(result.status, 0);
      assert.strictEqual(getGitLogCount(repoPath), beforeLog, `No commit should be made when sandbox checks fail and maxAttempts reached`);
    } finally {
      cleanup();
    }
  });

  test('failed sandbox checks before repair do not push', () => {
    const { taskId, tasksFilePath, repoPath, originPath, cleanup } = createTempEnv([], [{ command: 'node', args: ['check.cjs'] }]);
    try {
      setupCheckFile(repoPath);
      const before = getBareRefs(originPath);
      const result = runCli(['real-repo-run-ai', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_PROVIDER: 'true',
        ALLOW_REAL_REPO_APPLY: 'true',
        ALLOW_REAL_REPO_COMMIT: 'true',
        ALLOW_REAL_REPO_PUSH: 'true',
        REAL_REPO_AI_MAX_ATTEMPTS: '1',
        KIMI_API_KEY: 'fake',
        KIMI_BASE_URL: 'http://localhost:9999',
        KIMI_FAKE_RESPONSES: JSON.stringify([
          buildFakeKimiOutput([{ path: 'README.md', content: '# fail\n' }]),
        ]),
      });
      assert.notStrictEqual(result.status, 0);
      const after = getBareRefs(originPath);
      assert.deepStrictEqual(after, before, `No push should occur when sandbox checks fail and maxAttempts reached`);
    } finally {
      cleanup();
    }
  });

  test('retry-on-sandbox-checks is now only via buildSandboxPreflightRepairDecision', () => {
    const { taskId, tasksFilePath, repoPath, cleanup } = createTempEnv([], [{ command: 'node', args: ['check.cjs'] }]);
    try {
      setupCheckFile(repoPath);
      const result = runCli(['real-repo-run-ai', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_PROVIDER: 'true',
        ALLOW_REAL_REPO_APPLY: 'true',
        ALLOW_REAL_REPO_COMMIT: 'true',
        ALLOW_REAL_REPO_PUSH: 'true',
        REAL_REPO_AI_MAX_ATTEMPTS: '2',
        KIMI_API_KEY: 'fake',
        KIMI_BASE_URL: 'http://localhost:9999',
        KIMI_FAKE_RESPONSES: JSON.stringify([
          buildFakeKimiOutput([{ path: 'README.md', content: '# fail\n' }]),
          buildFakeKimiOutput([{ path: 'README.md', content: '# pass\n' }]),
        ]),
      });
      assert.strictEqual(result.status, 0, `Expected success: ${result.stderr}`);
      assert(result.stderr.includes('requesting repair'), `Should use helper-based repair: ${result.stderr}`);
      assert(!result.stderr.includes('Checks failed on attempt 1, retrying...'), `Should NOT use old ad-hoc retry message: ${result.stderr}`);
    } finally {
      cleanup();
    }
  });

  test('maxAttempts reached sandbox checks failure does not leak sk-fake in stderr', () => {
    const { taskId, tasksFilePath, repoPath, cleanup } = createTempEnv([], [{ command: 'node', args: ['-e', "console.error('sk-fake-test-key'); process.exit(1)"] }]);
    try {
      const result = runCli(['real-repo-run-ai', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_PROVIDER: 'true',
        ALLOW_REAL_REPO_APPLY: 'true',
        ALLOW_REAL_REPO_COMMIT: 'true',
        ALLOW_REAL_REPO_PUSH: 'true',
        REAL_REPO_AI_MAX_ATTEMPTS: '1',
        KIMI_API_KEY: 'fake',
        KIMI_BASE_URL: 'http://localhost:9999',
        KIMI_FAKE_RESPONSE: buildFakeKimiOutput([{ path: 'README.md', content: '# pass\n' }]),
      });
      assert.notStrictEqual(result.status, 0);
      assert(!result.stderr.includes('sk-fake'), `Should not leak sk-fake in stderr: ${result.stderr}`);
      assert(result.stderr.includes('[REDACTED]'), `Should contain redaction marker: ${result.stderr}`);
    } finally {
      cleanup();
    }
  });

  test('maxAttempts reached sandbox checks failure redacts Bearer fake-token in stderr', () => {
    const { taskId, tasksFilePath, repoPath, cleanup } = createTempEnv([], [{ command: 'node', args: ['-e', "console.error('Bearer fake-token'); process.exit(1)"] }]);
    try {
      const result = runCli(['real-repo-run-ai', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_PROVIDER: 'true',
        ALLOW_REAL_REPO_APPLY: 'true',
        ALLOW_REAL_REPO_COMMIT: 'true',
        ALLOW_REAL_REPO_PUSH: 'true',
        REAL_REPO_AI_MAX_ATTEMPTS: '1',
        KIMI_API_KEY: 'fake',
        KIMI_BASE_URL: 'http://localhost:9999',
        KIMI_FAKE_RESPONSE: buildFakeKimiOutput([{ path: 'README.md', content: '# pass\n' }]),
      });
      assert.notStrictEqual(result.status, 0);
      assert(!result.stderr.includes('Bearer fake-token'), `Should not leak Bearer token in stderr: ${result.stderr}`);
      assert(result.stderr.includes('[REDACTED]'), `Should contain redaction marker: ${result.stderr}`);
    } finally {
      cleanup();
    }
  });

  test('maxAttempts reached sandbox checks failure redacts api_key and token in stderr', () => {
    const { taskId, tasksFilePath, repoPath, cleanup } = createTempEnv([], [{ command: 'node', args: ['-e', "console.error('api_key=fake-key token=fake-token'); process.exit(1)"] }]);
    try {
      const result = runCli(['real-repo-run-ai', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_PROVIDER: 'true',
        ALLOW_REAL_REPO_APPLY: 'true',
        ALLOW_REAL_REPO_COMMIT: 'true',
        ALLOW_REAL_REPO_PUSH: 'true',
        REAL_REPO_AI_MAX_ATTEMPTS: '1',
        KIMI_API_KEY: 'fake',
        KIMI_BASE_URL: 'http://localhost:9999',
        KIMI_FAKE_RESPONSE: buildFakeKimiOutput([{ path: 'README.md', content: '# pass\n' }]),
      });
      assert.notStrictEqual(result.status, 0);
      assert(!result.stderr.includes('fake-key'), `Should not leak api_key value in stderr: ${result.stderr}`);
      assert(!result.stderr.includes('fake-token'), `Should not leak token value in stderr: ${result.stderr}`);
      assert(result.stderr.includes('[REDACTED]'), `Should contain redaction marker: ${result.stderr}`);
    } finally {
      cleanup();
    }
  });

  test('redacted stderr still includes useful sandbox failure message', () => {
    const { taskId, tasksFilePath, repoPath, cleanup } = createTempEnv([], [{ command: 'node', args: ['-e', "console.error('sk-fake-test-key'); process.exit(1)"] }]);
    try {
      const result = runCli(['real-repo-run-ai', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_PROVIDER: 'true',
        ALLOW_REAL_REPO_APPLY: 'true',
        ALLOW_REAL_REPO_COMMIT: 'true',
        ALLOW_REAL_REPO_PUSH: 'true',
        REAL_REPO_AI_MAX_ATTEMPTS: '1',
        KIMI_API_KEY: 'fake',
        KIMI_BASE_URL: 'http://localhost:9999',
        KIMI_FAKE_RESPONSE: buildFakeKimiOutput([{ path: 'README.md', content: '# pass\n' }]),
      });
      assert.notStrictEqual(result.status, 0);
      assert(result.stderr.includes('Sandbox preflight failed'), `Should include failure message: ${result.stderr}`);
      assert(result.stderr.includes('checks'), `Should include failed step: ${result.stderr}`);
    } finally {
      cleanup();
    }
  });

  test('successful repair behavior from Stage 7.4.2 still passes', () => {
    const { taskId, tasksFilePath, repoPath, cleanup } = createTempEnv([], [{ command: 'node', args: ['check.cjs'] }]);
    try {
      setupCheckFile(repoPath);
      const result = runCli(['real-repo-run-ai', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_PROVIDER: 'true',
        ALLOW_REAL_REPO_APPLY: 'true',
        ALLOW_REAL_REPO_COMMIT: 'true',
        ALLOW_REAL_REPO_PUSH: 'true',
        REAL_REPO_AI_MAX_ATTEMPTS: '2',
        KIMI_API_KEY: 'fake',
        KIMI_BASE_URL: 'http://localhost:9999',
        KIMI_FAKE_RESPONSES: JSON.stringify([
          buildFakeKimiOutput([{ path: 'README.md', content: '# fail\n' }]),
          buildFakeKimiOutput([{ path: 'README.md', content: '# pass\n' }]),
        ]),
      });
      assert.strictEqual(result.status, 0, `Expected success: ${result.stderr}`);
      const content = readFileSync(join(repoPath, 'README.md'), 'utf-8');
      assert.strictEqual(content, '# pass\n', 'Repair should still work after 7.4.2A');
    } finally {
      cleanup();
    }
  });

  test('parse guardrails apply failures still do not repair', () => {
    const { taskId, tasksFilePath, cleanup } = createTempEnv();
    try {
      const result = runCli(['real-repo-run-ai', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_PROVIDER: 'true',
        ALLOW_REAL_REPO_APPLY: 'true',
        ALLOW_REAL_REPO_COMMIT: 'true',
        ALLOW_REAL_REPO_PUSH: 'true',
        KIMI_API_KEY: 'fake',
        KIMI_BASE_URL: 'http://localhost:9999',
        KIMI_FAKE_RESPONSE: buildFakeKimiOutput([{ path: '.env', content: 'SECRET=1\n' }]),
      });
      assert.notStrictEqual(result.status, 0);
      assert(!result.stderr.includes('requesting repair'), `Guardrails failure should not trigger repair`);
    } finally {
      cleanup();
    }
  });

  test('sandbox-safe repaired flow end-to-end from bad output to pushed state', () => {
    const { taskId, tasksFilePath, repoPath, originPath, runsDir, cleanup } = createTempEnv([], [{ command: 'node', args: ['check.cjs'] }]);
    try {
      setupCheckFile(repoPath);
      const before = getBareRefs(originPath);
      const beforeContent = readFileSync(join(repoPath, 'README.md'), 'utf-8');
      const beforeLogCount = getGitLogCount(repoPath);
      const result = runCli(['real-repo-run-ai', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_PROVIDER: 'true',
        ALLOW_REAL_REPO_APPLY: 'true',
        ALLOW_REAL_REPO_COMMIT: 'true',
        ALLOW_REAL_REPO_PUSH: 'true',
        REAL_REPO_AI_MAX_ATTEMPTS: '2',
        KIMI_API_KEY: 'fake',
        KIMI_BASE_URL: 'http://localhost:9999',
        KIMI_FAKE_RESPONSES: JSON.stringify([
          buildFakeKimiOutput([{ path: 'README.md', content: '# fail\n' }]),
          buildFakeKimiOutput([{ path: 'README.md', content: '# pass\n' }]),
        ]),
        RUNS_DIR: runsDir,
      });
      assert.strictEqual(result.status, 0, `Expected success: ${result.stderr}`);
      // First attempt failed sandbox checks
      assert(result.stderr.includes('Sandbox checks failed on attempt 1'), `Should show first attempt failure: ${result.stderr}`);
      // Repair was requested
      assert(result.stderr.includes('requesting repair'), `Should show repair request: ${result.stderr}`);
      // Real repo mutated only after repaired output passes sandbox
      const content = readFileSync(join(repoPath, 'README.md'), 'utf-8');
      assert.strictEqual(content, '# pass\n', 'Real repo should have repaired content');
      assert.notStrictEqual(content, beforeContent, 'Real repo should be mutated after successful repair');
      // Exactly one commit created by the flow
      assert.strictEqual(getGitLogCount(repoPath), beforeLogCount + 1, `Should create exactly one commit`);
      // Push happened
      const after = getBareRefs(originPath);
      assert.notDeepStrictEqual(after, before, 'Should push to remote after successful repair');
      // State written as pushed
      const state = loadStateFromPath(runsDir, taskId);
      assert(state !== null, 'State should be written');
      assert.strictEqual((state as Record<string, unknown>).status, 'pushed');
    } finally {
      cleanup();
    }
  });

  test('sandbox check logs with multiple secrets are redacted in stderr', () => {
    const { taskId, tasksFilePath, repoPath, cleanup } = createTempEnv([], [{ command: 'node', args: ['check-secret.cjs'] }]);
    try {
      setupCheckFileWithSecrets(repoPath);
      const result = runCli(['real-repo-run-ai', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_PROVIDER: 'true',
        ALLOW_REAL_REPO_APPLY: 'true',
        ALLOW_REAL_REPO_COMMIT: 'true',
        ALLOW_REAL_REPO_PUSH: 'true',
        REAL_REPO_AI_MAX_ATTEMPTS: '1',
        KIMI_API_KEY: 'fake',
        KIMI_BASE_URL: 'http://localhost:9999',
        KIMI_FAKE_RESPONSES: JSON.stringify([
          buildFakeKimiOutput([{ path: 'README.md', content: '# fail\n' }]),
        ]),
      });
      assert.notStrictEqual(result.status, 0, `Expected failure: ${result.stderr}`);
      assert(!result.stderr.includes('sk-fake-e2e-secret'), `Should not leak sk-fake secret in stderr: ${result.stderr}`);
      assert(!result.stderr.includes('Bearer fake-e2e-token'), `Should not leak Bearer token in stderr: ${result.stderr}`);
      assert(!result.stderr.includes('fake-e2e-key'), `Should not leak api_key value in stderr: ${result.stderr}`);
      assert(result.stderr.includes('[REDACTED]'), `Should contain redaction marker: ${result.stderr}`);
      assert(result.stderr.includes('Sandbox preflight failed'), `Should include failure message: ${result.stderr}`);
      assert(result.stderr.includes('checks'), `Should include failed step: ${result.stderr}`);
    } finally {
      cleanup();
    }
  });

  test('maxAttempts reached when repair also fails sandbox checks', () => {
    const { taskId, tasksFilePath, repoPath, originPath, runsDir, cleanup } = createTempEnv([], [{ command: 'node', args: ['check.cjs'] }]);
    try {
      setupCheckFile(repoPath);
      const before = getBareRefs(originPath);
      const beforeContent = readFileSync(join(repoPath, 'README.md'), 'utf-8');
      const beforeLogCount = getGitLogCount(repoPath);
      const result = runCli(['real-repo-run-ai', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_PROVIDER: 'true',
        ALLOW_REAL_REPO_APPLY: 'true',
        ALLOW_REAL_REPO_COMMIT: 'true',
        ALLOW_REAL_REPO_PUSH: 'true',
        REAL_REPO_AI_MAX_ATTEMPTS: '2',
        KIMI_API_KEY: 'fake',
        KIMI_BASE_URL: 'http://localhost:9999',
        KIMI_FAKE_RESPONSES: JSON.stringify([
          buildFakeKimiOutput([{ path: 'README.md', content: '# fail\n' }]),
          buildFakeKimiOutput([{ path: 'README.md', content: '# alsofail\n' }]),
        ]),
        RUNS_DIR: runsDir,
      });
      assert.notStrictEqual(result.status, 0, `Expected failure: ${result.stderr}`);
      // First attempt failed
      assert(result.stderr.includes('Sandbox checks failed on attempt 1'), `Should show first attempt failure: ${result.stderr}`);
      // Repair was attempted
      assert(result.stderr.includes('requesting repair'), `Should show repair attempt: ${result.stderr}`);
      // Repair also failed (alsofail contains 'fail')
      assert(result.stderr.includes('Sandbox checks failed on attempt 2') || result.stderr.includes('Attempt 2 of 2 reached'), `Should show second attempt failure or max reached: ${result.stderr}`);
      // No real repo mutation
      const afterContent = readFileSync(join(repoPath, 'README.md'), 'utf-8');
      assert.strictEqual(afterContent, beforeContent, `Real repo should not be mutated when repair also fails`);
      // No commit
      assert.strictEqual(getGitLogCount(repoPath), beforeLogCount, `No commit should be made`);
      // No push
      const after = getBareRefs(originPath);
      assert.deepStrictEqual(after, before, `Should not push when repair also fails`);
      // No state
      const state = loadStateFromPath(runsDir, taskId);
      assert.strictEqual(state, null, `State should not be written`);
    } finally {
      cleanup();
    }
  });

  test('real reviewer accept path runs when ALLOW_REAL_PROVIDER is set', () => {
    const { taskId, tasksFilePath, repoPath, originPath, runsDir, cleanup } = createTempEnv();
    try {
      const before = getBareRefs(originPath);
      const result = runCli(['real-repo-run-ai', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_PROVIDER: 'true',
        ALLOW_REAL_REPO_APPLY: 'true',
        ALLOW_REAL_REPO_COMMIT: 'true',
        ALLOW_REAL_REPO_PUSH: 'true',
        KIMI_API_KEY: 'fake',
        KIMI_BASE_URL: 'http://localhost:9999',
        KIMI_FAKE_RESPONSE: buildFakeKimiOutput([{ path: 'README.md', content: '# modified\n' }]),
        KIMI_FAKE_REVIEWER_RESPONSE: JSON.stringify({
          decision: 'accepted',
          confidence: 'high',
          blocking_issues: [],
          non_blocking_issues: [],
          review_summary: 'Real reviewer acceptance.',
          fix_task: null,
          next_action: 'advance_to_next_task',
        }),
        RUNS_DIR: runsDir,
      });
      assert.strictEqual(result.status, 0, `Expected success: ${result.stderr}`);
      assert(result.stderr.includes('Reviewer gate accepted'), `Should show reviewer gate accepted: ${result.stderr}`);
      const after = getBareRefs(originPath);
      assert.notDeepStrictEqual(after, before, 'Should push to remote');
      const state = loadStateFromPath(runsDir, taskId);
      assert(state !== null);
      assert.strictEqual((state as Record<string, unknown>).status, 'pushed');
      const reviewerGate = (state as Record<string, unknown>).reviewer_gate as Record<string, unknown> | undefined;
      assert(reviewerGate !== undefined, `Should have reviewer_gate`);
      assert.strictEqual(reviewerGate.status, 'accepted');
      assert.strictEqual(reviewerGate.nextAction, 'continue');
      assert(Array.isArray(reviewerGate.blockingIssues) && reviewerGate.blockingIssues.length === 0);
      assert(Array.isArray(reviewerGate.nonBlockingIssues) && reviewerGate.nonBlockingIssues.length === 0);
      assert((state as Record<string, unknown>).reviewer_block_review_result !== undefined, `Should have reviewer_block_review_result`);
      assert.strictEqual((state as Record<string, unknown>).pending_reviewer_fix_task, undefined, `Should not have pending_reviewer_fix_task`);
      assert.strictEqual((state as Record<string, unknown>).pending_reviewer_fix_task_state, undefined, `Should not have pending_reviewer_fix_task_state`);
      assert.strictEqual((state as Record<string, unknown>).pending_reviewer_fix_task_execution_plan, undefined, `Should not have pending_reviewer_fix_task_execution_plan`);
      assert.strictEqual((state as Record<string, unknown>).pending_reviewer_fix_task_execution_request, undefined, `Should not have pending_reviewer_fix_task_execution_request`);
      assert.strictEqual((state as Record<string, unknown>).pending_reviewer_fix_task_execution_request_state, undefined, `Should not have pending_reviewer_fix_task_execution_request_state`);
      assert.strictEqual((state as Record<string, unknown>).reviewer_fix_task_run_plan, undefined, `Should not have reviewer_fix_task_run_plan`);
      assert.strictEqual((state as Record<string, unknown>).reviewer_fix_task_run_plan_state, undefined, `Should not have reviewer_fix_task_run_plan_state`);
      assert.strictEqual((state as Record<string, unknown>).reviewer_fix_task_controlled_run, undefined, `Should not have reviewer_fix_task_controlled_run`);
    } finally {
      cleanup();
    }
  });

  test('real reviewer reject persists reviewer_gate and pending fix task with redacted secrets', () => {
    const { taskId, tasksFilePath, repoPath, originPath, runsDir, cleanup } = createTempEnv();
    try {
      const before = getBareRefs(originPath);
      const result = runCli(['real-repo-run-ai', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_PROVIDER: 'true',
        ALLOW_REAL_REPO_APPLY: 'true',
        ALLOW_REAL_REPO_COMMIT: 'true',
        ALLOW_REAL_REPO_PUSH: 'true',
        REAL_REPO_REVIEWER_NO_DEFAULT: '1',
        KIMI_API_KEY: 'fake',
        KIMI_BASE_URL: 'http://localhost:9999',
        KIMI_FAKE_RESPONSE: buildFakeKimiOutput([{ path: 'README.md', content: '# modified\n' }]),
        KIMI_FAKE_REVIEWER_RESPONSE: JSON.stringify({
          decision: 'rejected',
          confidence: 'high',
          blocking_issues: ['sk-fake-real-reviewer-secret'],
          non_blocking_issues: ['pk-fake-real-reviewer-public'],
          review_summary: 'Needs fix',
          fix_task: 'use Bearer fake-real-reviewer-token',
          next_action: 'send_fix_to_coder',
        }),
        RUNS_DIR: runsDir,
      });
      assert.notStrictEqual(result.status, 0, `Expected failure: ${result.stderr}`);
      assert(result.stderr.includes('Reviewer gate fix_required'), `Should show fix_required: ${result.stderr}`);
      assert(!result.stderr.includes('sk-fake-real-reviewer-secret'), `Should not leak sk secret in stderr: ${result.stderr}`);
      assert(!result.stderr.includes('Bearer fake-real-reviewer-token'), `Should not leak Bearer token in stderr: ${result.stderr}`);
      const after = getBareRefs(originPath);
      assert.notDeepStrictEqual(after, before, 'Push should still have happened');
      const state = loadStateFromPath(runsDir, taskId);
      assert(state !== null);
      assert.strictEqual((state as Record<string, unknown>).status, 'pushed');
      const rg = (state as Record<string, unknown>).reviewer_gate as Record<string, unknown>;
      assert(rg !== undefined, `Should persist reviewer_gate`);
      assert.strictEqual(rg.status, 'fix_required');
      assert.strictEqual(rg.source, 'reviewer');
      assert.strictEqual(rg.nextAction, 'fix');
      const stateRaw = JSON.stringify(state);
      assert(!stateRaw.includes('sk-fake-real-reviewer-secret'), `Should not leak sk secret in persisted state`);
      assert(!stateRaw.includes('Bearer fake-real-reviewer-token'), `Should not leak Bearer token in persisted state`);
      assert(!stateRaw.includes('pk-fake-real-reviewer-public'), `Should not leak pk secret in persisted state`);
      const rbr = (state as Record<string, unknown>).reviewer_block_review_result as Record<string, unknown>;
      assert(rbr !== undefined, `Should persist reviewer_block_review_result`);
      assert.strictEqual(rbr.blockId, `single-task-review:${taskId}`);
      const resolutionPlan = rbr.resolutionPlan as Record<string, unknown>;
      assert.strictEqual(resolutionPlan.action, 'append_fix_task');
      const pending = (state as Record<string, unknown>).pending_reviewer_fix_task as Record<string, unknown>;
      assert(pending !== undefined, `Should persist pending_reviewer_fix_task on fix_required`);
      assert.strictEqual(pending.status, 'pending');
    } finally {
      cleanup();
    }
  });

  test('real reviewer block_for_human persists reviewer_gate with no pending fix task', () => {
    const { taskId, tasksFilePath, repoPath, originPath, runsDir, cleanup } = createTempEnv();
    try {
      const before = getBareRefs(originPath);
      const result = runCli(['real-repo-run-ai', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_PROVIDER: 'true',
        ALLOW_REAL_REPO_APPLY: 'true',
        ALLOW_REAL_REPO_COMMIT: 'true',
        ALLOW_REAL_REPO_PUSH: 'true',
        REAL_REPO_REVIEWER_NO_DEFAULT: '1',
        KIMI_API_KEY: 'fake',
        KIMI_BASE_URL: 'http://localhost:9999',
        KIMI_FAKE_RESPONSE: buildFakeKimiOutput([{ path: 'README.md', content: '# modified\n' }]),
        KIMI_FAKE_REVIEWER_RESPONSE: JSON.stringify({
          decision: 'rejected',
          confidence: 'high',
          blocking_issues: ['sk-fake-block-for-human-secret'],
          non_blocking_issues: [],
          review_summary: 'Blocked for human review',
          fix_task: null,
          next_action: 'block_for_human',
        }),
        RUNS_DIR: runsDir,
      });
      assert.notStrictEqual(result.status, 0, `Expected failure: ${result.stderr}`);
      assert(result.stderr.includes('Reviewer gate blocked'), `Should show blocked: ${result.stderr}`);
      assert(!result.stderr.includes('sk-fake-block-for-human-secret'), `Should not leak sk secret in stderr: ${result.stderr}`);
      const after = getBareRefs(originPath);
      assert.notDeepStrictEqual(after, before, 'Push should still have happened');
      const state = loadStateFromPath(runsDir, taskId);
      assert(state !== null);
      assert.strictEqual((state as Record<string, unknown>).status, 'pushed');
      const rg = (state as Record<string, unknown>).reviewer_gate as Record<string, unknown>;
      assert(rg !== undefined, `Should persist reviewer_gate`);
      assert.strictEqual(rg.status, 'blocked');
      assert.strictEqual(rg.source, 'reviewer');
      assert.strictEqual(rg.nextAction, 'block');
      const stateRaw = JSON.stringify(state);
      assert(!stateRaw.includes('sk-fake-block-for-human-secret'), `Should not leak sk secret in persisted state`);
      const rbr = (state as Record<string, unknown>).reviewer_block_review_result as Record<string, unknown>;
      assert(rbr !== undefined, `Should persist reviewer_block_review_result`);
      assert.strictEqual((state as Record<string, unknown>).pending_reviewer_fix_task, undefined, `Should not persist pending_reviewer_fix_task on block_for_human`);
    } finally {
      cleanup();
    }
  });

  test('real reviewer invalid JSON response exits non-zero with provider block', () => {
    const { taskId, tasksFilePath, repoPath, originPath, runsDir, cleanup } = createTempEnv();
    try {
      const before = getBareRefs(originPath);
      const result = runCli(['real-repo-run-ai', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_PROVIDER: 'true',
        ALLOW_REAL_REPO_APPLY: 'true',
        ALLOW_REAL_REPO_COMMIT: 'true',
        ALLOW_REAL_REPO_PUSH: 'true',
        REAL_REPO_REVIEWER_NO_DEFAULT: '1',
        KIMI_API_KEY: 'fake',
        KIMI_BASE_URL: 'http://localhost:9999',
        KIMI_FAKE_RESPONSE: buildFakeKimiOutput([{ path: 'README.md', content: '# modified\n' }]),
        KIMI_FAKE_REVIEWER_RESPONSE: 'not-valid-json',
        RUNS_DIR: runsDir,
      });
      assert.notStrictEqual(result.status, 0, `Expected failure: ${result.stderr}`);
      assert(result.stderr.includes('Reviewer gate blocked') || result.stderr.includes('Reviewer gate error'), `Should show blocked/error: ${result.stderr}`);
      const state = loadStateFromPath(runsDir, taskId);
      assert(state !== null);
      const rg = (state as Record<string, unknown>).reviewer_gate as Record<string, unknown>;
      assert(rg !== undefined, `Should persist reviewer_gate`);
      assert.strictEqual(rg.status, 'blocked');
      assert.strictEqual(rg.source, 'provider');
      const rbr = (state as Record<string, unknown>).reviewer_block_review_result as Record<string, unknown>;
      assert(rbr !== undefined, `Should persist reviewer_block_review_result`);
    } finally {
      cleanup();
    }
  });

  test('real reviewer invalid schema response exits non-zero with provider block', () => {
    const { taskId, tasksFilePath, repoPath, originPath, runsDir, cleanup } = createTempEnv();
    try {
      const before = getBareRefs(originPath);
      const result = runCli(['real-repo-run-ai', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_PROVIDER: 'true',
        ALLOW_REAL_REPO_APPLY: 'true',
        ALLOW_REAL_REPO_COMMIT: 'true',
        ALLOW_REAL_REPO_PUSH: 'true',
        REAL_REPO_REVIEWER_NO_DEFAULT: '1',
        KIMI_API_KEY: 'fake',
        KIMI_BASE_URL: 'http://localhost:9999',
        KIMI_FAKE_RESPONSE: buildFakeKimiOutput([{ path: 'README.md', content: '# modified\n' }]),
        KIMI_FAKE_REVIEWER_RESPONSE: JSON.stringify({
          decision: 'accepted',
          confidence: 'high',
          blocking_issues: ['should be empty for accepted'],
          non_blocking_issues: [],
          review_summary: 'Invalid accepted',
          fix_task: null,
          next_action: 'advance_to_next_task',
        }),
        RUNS_DIR: runsDir,
      });
      assert.notStrictEqual(result.status, 0, `Expected failure: ${result.stderr}`);
      assert(result.stderr.includes('Reviewer gate blocked') || result.stderr.includes('Reviewer gate error'), `Should show blocked/error: ${result.stderr}`);
      const state = loadStateFromPath(runsDir, taskId);
      assert(state !== null);
      const rg = (state as Record<string, unknown>).reviewer_gate as Record<string, unknown>;
      assert(rg !== undefined, `Should persist reviewer_gate`);
      assert.strictEqual(rg.status, 'blocked');
      assert.strictEqual(rg.source, 'provider');
    } finally {
      cleanup();
    }
  });

  test('real reviewer missing KIMI_API_KEY fails before provider call', () => {
    const { taskId, tasksFilePath, repoPath, originPath, runsDir, cleanup } = createTempEnv();
    try {
      const before = getBareRefs(originPath);
      const result = runCli(['real-repo-run-ai', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_PROVIDER: 'true',
        ALLOW_REAL_REPO_APPLY: 'true',
        ALLOW_REAL_REPO_COMMIT: 'true',
        ALLOW_REAL_REPO_PUSH: 'true',
        REAL_REPO_REVIEWER_NO_DEFAULT: '1',
        KIMI_BASE_URL: 'http://localhost:9999',
        KIMI_API_KEY: '',
        KIMI_FAKE_RESPONSE: buildFakeKimiOutput([{ path: 'README.md', content: '# modified\n' }]),
        KIMI_FAKE_REVIEWER_RESPONSE: JSON.stringify({
          decision: 'accepted',
          confidence: 'high',
          blocking_issues: [],
          non_blocking_issues: [],
          review_summary: 'Should not be reached',
          fix_task: null,
          next_action: 'advance_to_next_task',
        }),
        RUNS_DIR: runsDir,
      });
      assert.notStrictEqual(result.status, 0, `Expected failure: ${result.stderr}`);
      assert(result.stderr.includes('KIMI_API_KEY env var is required'), `Should require API key: ${result.stderr}`);
      assert(!result.stderr.includes('Reviewer gate'), `Should not reach reviewer gate: ${result.stderr}`);
      const after = getBareRefs(originPath);
      assert.deepStrictEqual(after, before, 'Should not push without API key');
    } finally {
      cleanup();
    }
  });

  test('real reviewer missing KIMI_BASE_URL fails before provider call', () => {
    const { taskId, tasksFilePath, repoPath, originPath, runsDir, cleanup } = createTempEnv();
    try {
      const before = getBareRefs(originPath);
      const result = runCli(['real-repo-run-ai', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_PROVIDER: 'true',
        ALLOW_REAL_REPO_APPLY: 'true',
        ALLOW_REAL_REPO_COMMIT: 'true',
        ALLOW_REAL_REPO_PUSH: 'true',
        REAL_REPO_REVIEWER_NO_DEFAULT: '1',
        KIMI_API_KEY: 'fake',
        KIMI_BASE_URL: '',
        KIMI_FAKE_RESPONSE: buildFakeKimiOutput([{ path: 'README.md', content: '# modified\n' }]),
        KIMI_FAKE_REVIEWER_RESPONSE: JSON.stringify({
          decision: 'accepted',
          confidence: 'high',
          blocking_issues: [],
          non_blocking_issues: [],
          review_summary: 'Should not be reached',
          fix_task: null,
          next_action: 'advance_to_next_task',
        }),
        RUNS_DIR: runsDir,
      });
      assert.notStrictEqual(result.status, 0, `Expected failure: ${result.stderr}`);
      assert(result.stderr.includes('KIMI_BASE_URL env var is required'), `Should require base URL: ${result.stderr}`);
      assert(!result.stderr.includes('Reviewer gate'), `Should not reach reviewer gate: ${result.stderr}`);
      const after = getBareRefs(originPath);
      assert.deepStrictEqual(after, before, 'Should not push without base URL');
    } finally {
      cleanup();
    }
  });

  test('real reviewer input capture includes repo path task goal commit sha branch check summary state status', () => {
    const { taskId, tasksFilePath, repoPath, originPath, runsDir, cleanup } = createTempEnv();
    const captureFile = join(runsDir, 'real-reviewer-input-capture.json');
    try {
      const result = runCli(['real-repo-run-ai', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_PROVIDER: 'true',
        ALLOW_REAL_REPO_APPLY: 'true',
        ALLOW_REAL_REPO_COMMIT: 'true',
        ALLOW_REAL_REPO_PUSH: 'true',
        REAL_REPO_REVIEWER_NO_DEFAULT: '1',
        KIMI_API_KEY: 'fake',
        KIMI_BASE_URL: 'http://localhost:9999',
        KIMI_FAKE_RESPONSE: buildFakeKimiOutput([{ path: 'README.md', content: '# modified\n' }]),
        KIMI_FAKE_REVIEWER_RESPONSE: JSON.stringify({
          decision: 'accepted',
          confidence: 'high',
          blocking_issues: [],
          non_blocking_issues: [],
          review_summary: 'Real reviewer acceptance.',
          fix_task: null,
          next_action: 'advance_to_next_task',
        }),
        REAL_REPO_REVIEWER_CAPTURE_INPUT_FILE: captureFile,
        RUNS_DIR: runsDir,
      });
      assert.strictEqual(result.status, 0, `Expected success: ${result.stderr}`);
      assert(existsSync(captureFile), `Capture file should exist`);
      const captured = JSON.parse(readFileSync(captureFile, 'utf-8'));
      assert.strictEqual(captured.repoPath, repoPath.replace(/\\/g, '/'), `Should include repo path`);
      assert.strictEqual(captured.taskId, taskId, `Should include task id`);
      assert.strictEqual(captured.taskGoal, 'Test goal', `Should include task goal`);
      assert.strictEqual(captured.branchName, `ai/${taskId}`, `Should include branch name`);
      assert(typeof captured.commitSha === 'string' && captured.commitSha.length === 40, `Should include full commit SHA`);
      assert(typeof captured.checkSummary === 'object' && captured.checkSummary !== null, `Should include check summary`);
      assert.strictEqual((captured.checkSummary as Record<string, unknown>).test, 'pass', `Check summary should reflect passing tests`);
      assert.strictEqual(captured.stateStatus, 'pushed', `Should include state status`);
      assert(typeof captured.safety === 'object' && captured.safety !== null, `Should include safety flags`);
      assert.strictEqual(captured.safety.commitShaIsFullLength, true);
      assert.strictEqual(captured.safety.branchIsNotMain, true);
      assert.strictEqual(captured.safety.hasChangedFiles, true);
    } finally {
      cleanup();
    }
  });

  test('fake reviewer accept exits 0 after commit push state and persists reviewer_gate', () => {
    const { taskId, tasksFilePath, repoPath, originPath, runsDir, cleanup } = createTempEnv();
    try {
      const before = getBareRefs(originPath);
      const result = runCli(['real-repo-run-ai', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_PROVIDER: 'true',
        ALLOW_REAL_REPO_APPLY: 'true',
        ALLOW_REAL_REPO_COMMIT: 'true',
        ALLOW_REAL_REPO_PUSH: 'true',
        KIMI_API_KEY: 'fake',
        KIMI_BASE_URL: 'http://localhost:9999',
        KIMI_FAKE_RESPONSE: buildFakeKimiOutput([{ path: 'README.md', content: '# modified\n' }]),
        REAL_REPO_REVIEWER_FAKE_RESPONSE: JSON.stringify({
          decision: 'accept',
          confidence: 'high',
          blockingIssues: [],
          nonBlockingIssues: [],
          reviewSummary: 'Looks good',
          nextAction: 'continue',
        }),
        RUNS_DIR: runsDir,
      });
      assert.strictEqual(result.status, 0, `Expected success: ${result.stderr}`);
      assert(result.stderr.includes('Reviewer gate accepted'), `Should show reviewer gate accepted: ${result.stderr}`);
      const after = getBareRefs(originPath);
      assert.notDeepStrictEqual(after, before, 'Should push to remote');
      const state = loadStateFromPath(runsDir, taskId);
      assert(state !== null);
      assert.strictEqual((state as Record<string, unknown>).status, 'pushed');
      const rg = (state as Record<string, unknown>).reviewer_gate as Record<string, unknown>;
      assert(rg !== undefined, `Should persist reviewer_gate`);
      assert.strictEqual(rg.status, 'accepted');
      assert.strictEqual(rg.source, 'reviewer');
      assert.strictEqual(rg.nextAction, 'continue');
      assert.strictEqual(rg.reviewSummary, 'Looks good');
      const rbr = (state as Record<string, unknown>).reviewer_block_review_result as Record<string, unknown>;
      assert(rbr !== undefined, `Should persist reviewer_block_review_result`);
      assert.strictEqual(rbr.blockId, `single-task-review:${taskId}`);
      const resolutionPlan = rbr.resolutionPlan as Record<string, unknown>;
      assert.strictEqual(resolutionPlan.action, 'continue_block');
      const taskDecisions = rbr.blockDecision ? (rbr.blockDecision as Record<string, unknown>).taskDecisions as unknown[] : [];
      assert.strictEqual(taskDecisions.length, 1);
      const decision0 = taskDecisions[0] as Record<string, unknown>;
      assert.strictEqual((decision0.outcome as Record<string, unknown>).status, 'accepted');
      assert.strictEqual((state as Record<string, unknown>).pending_reviewer_fix_task, undefined, `Should not persist pending_reviewer_fix_task on accept`);
      assert.strictEqual((state as Record<string, unknown>).pending_reviewer_fix_task_state, undefined, `Should not persist pending_reviewer_fix_task_state on accept`);
      assert.strictEqual((state as Record<string, unknown>).pending_reviewer_fix_task_execution_plan, undefined, `Should not persist pending_reviewer_fix_task_execution_plan on accept`);
      assert.strictEqual((state as Record<string, unknown>).pending_reviewer_fix_task_execution_request, undefined, `Should not persist pending_reviewer_fix_task_execution_request on accept`);
      assert.strictEqual((state as Record<string, unknown>).pending_reviewer_fix_task_execution_request_state, undefined, `Should not persist pending_reviewer_fix_task_execution_request_state on accept`);
      assert.strictEqual((state as Record<string, unknown>).reviewer_fix_task_run_plan, undefined, `Should not persist reviewer_fix_task_run_plan on accept`);
      assert.strictEqual((state as Record<string, unknown>).reviewer_fix_task_run_plan_state, undefined, `Should not persist reviewer_fix_task_run_plan_state on accept`);
      assert.strictEqual((state as Record<string, unknown>).reviewer_fix_task_controlled_run, undefined, `Should not persist reviewer_fix_task_controlled_run on accept`);
    } finally {
      cleanup();
    }
  });

  test('fake reviewer reject persists reviewer_gate with redacted secrets', () => {
    const { taskId, tasksFilePath, repoPath, originPath, runsDir, cleanup } = createTempEnv();
    try {
      const before = getBareRefs(originPath);
      const beforeLogCount = getGitLogCount(repoPath);
      const result = runCli(['real-repo-run-ai', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_PROVIDER: 'true',
        ALLOW_REAL_REPO_APPLY: 'true',
        ALLOW_REAL_REPO_COMMIT: 'true',
        ALLOW_REAL_REPO_PUSH: 'true',
        KIMI_API_KEY: 'fake',
        KIMI_BASE_URL: 'http://localhost:9999',
        KIMI_FAKE_RESPONSE: buildFakeKimiOutput([{ path: 'README.md', content: '# modified\n' }]),
        REAL_REPO_REVIEWER_FAKE_RESPONSE: JSON.stringify({
          decision: 'reject',
          confidence: 'high',
          blockingIssues: ['sk-fake-reviewer-secret'],
          nonBlockingIssues: ['pk-fake-reviewer-public'],
          reviewSummary: 'Needs fix',
          nextAction: 'fix',
          fixTask: 'use Bearer fake-reviewer-token',
        }),
        REAL_REPO_ENABLE_REVIEWER_FIX_LOOP: '0',
        REAL_REPO_REVIEWER_FIX_TASK_FAKE_EXECUTOR_RESPONSE: JSON.stringify({
          status: 'completed',
          reason: 'Fake fix completed',
          commitSha: 'fake-commit-sha-123',
          changedFiles: ['src/fake-fix.ts'],
          runState: { raw: 'sk-fake-run-state-secret' },
        }),
        RUNS_DIR: runsDir,
      });
      assert.notStrictEqual(result.status, 0, `Expected failure: ${result.stderr}`);
      assert(result.stderr.includes('Reviewer gate fix_required'), `Should show fix_required: ${result.stderr}`);
      assert(result.stderr.includes('Blocking issues:'), `Should show blocking issues label: ${result.stderr}`);
      assert(result.stderr.includes('Fix task:'), `Should show fix task label: ${result.stderr}`);
      assert(!result.stderr.includes('sk-fake-reviewer-secret'), `Should not leak sk secret in stderr: ${result.stderr}`);
      assert(!result.stderr.includes('Bearer fake-reviewer-token'), `Should not leak Bearer token in stderr: ${result.stderr}`);
      const after = getBareRefs(originPath);
      assert.notDeepStrictEqual(after, before, 'Initial push should still have happened');
      assert.strictEqual(getGitLogCount(repoPath), beforeLogCount + 1, 'Should create exactly one commit');
      const state = loadStateFromPath(runsDir, taskId);
      assert(state !== null);
      assert.strictEqual((state as Record<string, unknown>).status, 'pushed');
      const rg = (state as Record<string, unknown>).reviewer_gate as Record<string, unknown>;
      assert(rg !== undefined, `Should persist reviewer_gate`);
      assert.strictEqual(rg.status, 'fix_required');
      assert.strictEqual(rg.source, 'reviewer');
      assert.strictEqual(rg.nextAction, 'fix');
      const rgBlocking = rg.blockingIssues as string[];
      const rgNonBlocking = rg.nonBlockingIssues as string[];
      assert(Array.isArray(rgBlocking));
      assert(Array.isArray(rgNonBlocking));
      const stateRaw = JSON.stringify(state);
      assert(!stateRaw.includes('sk-fake-reviewer-secret'), `Should not leak sk secret in persisted state`);
      assert(!stateRaw.includes('Bearer fake-reviewer-token'), `Should not leak Bearer token in persisted state`);
      assert(!stateRaw.includes('pk-fake-reviewer-public'), `Should not leak pk secret in persisted state`);
      const rbr = (state as Record<string, unknown>).reviewer_block_review_result as Record<string, unknown>;
      assert(rbr !== undefined, `Should persist reviewer_block_review_result`);
      assert.strictEqual(rbr.blockId, `single-task-review:${taskId}`);
      const resolutionPlan = rbr.resolutionPlan as Record<string, unknown>;
      assert.strictEqual(resolutionPlan.action, 'append_fix_task');
      const fixTaskPlan = rbr.fixTaskPlan as Record<string, unknown>;
      assert.strictEqual(fixTaskPlan.action, 'create_fix_task');
      const fixTask = fixTaskPlan.fixTask as Record<string, unknown>;
      assert.strictEqual(fixTask.taskId, `fix-${taskId}-reviewer-1`);
      assert.strictEqual(fixTask.source, 'reviewer_gate');
      assert.strictEqual(fixTask.parentTaskId, taskId);
      assert.strictEqual(getGitLogCount(repoPath), beforeLogCount + 1, 'Should not execute fix task (no extra commit)');
      const rbrRaw = JSON.stringify(rbr);
      assert(!rbrRaw.includes('sk-fake-reviewer-secret'), `reviewer_block_review_result should not leak sk secret`);
      assert(!rbrRaw.includes('Bearer fake-reviewer-token'), `reviewer_block_review_result should not leak Bearer token`);
      const pending = (state as Record<string, unknown>).pending_reviewer_fix_task as Record<string, unknown>;
      assert(pending !== undefined, `Should persist pending_reviewer_fix_task on fix_required`);
      assert.strictEqual(pending.status, 'pending');
      assert.strictEqual(pending.source, 'reviewer_gate');
      assert.strictEqual(pending.createdFromResolutionAction, 'append_fix_task');
      assert.strictEqual(pending.parentTaskId, taskId);
      assert.strictEqual(pending.attempt, 1);
      const pendingTask = pending.task as Record<string, unknown>;
      assert.strictEqual(pendingTask.taskId, `fix-${taskId}-reviewer-1`);
      assert.strictEqual(pendingTask.parentTaskId, taskId);
      assert.strictEqual(pendingTask.attempt, 1);
      assert.strictEqual(pendingTask.source, 'reviewer_gate');
      const pendingRaw = JSON.stringify(pending);
      assert(!pendingRaw.includes('sk-fake-reviewer-secret'), `pending_reviewer_fix_task should not leak sk secret`);
      assert(!pendingRaw.includes('Bearer fake-reviewer-token'), `pending_reviewer_fix_task should not leak Bearer token`);
      assert(!pendingRaw.includes('pk-fake-reviewer-public'), `pending_reviewer_fix_task should not leak pk secret`);
      const pendingState = (state as Record<string, unknown>).pending_reviewer_fix_task_state as Record<string, unknown>;
      assert(pendingState !== undefined, `Should persist pending_reviewer_fix_task_state on fix_required`);
      assert.strictEqual(pendingState.status, 'ready');
      assert.strictEqual(pendingState.reason, 'Pending reviewer fix task is valid and ready.');
      assert.deepStrictEqual(pendingState.blockingIssues, []);
      const pendingStateTask = (pendingState.pendingFixTask as Record<string, unknown>).task as Record<string, unknown>;
      assert.strictEqual((pendingState.pendingFixTask as Record<string, unknown>).parentTaskId, taskId);
      assert.strictEqual((pendingState.pendingFixTask as Record<string, unknown>).attempt, 1);
      assert.strictEqual(pendingStateTask.taskId, `fix-${taskId}-reviewer-1`);
      assert.strictEqual(pendingStateTask.goal, pending.task.goal);
      const pendingStateRaw = JSON.stringify(pendingState);
      assert(!pendingStateRaw.includes('sk-fake-reviewer-secret'), `pending_reviewer_fix_task_state should not leak sk secret`);
      assert(!pendingStateRaw.includes('Bearer fake-reviewer-token'), `pending_reviewer_fix_task_state should not leak Bearer token`);
      assert(!pendingStateRaw.includes('pk-fake-reviewer-public'), `pending_reviewer_fix_task_state should not leak pk secret`);
      const execPlan = (state as Record<string, unknown>).pending_reviewer_fix_task_execution_plan as Record<string, unknown>;
      assert(execPlan !== undefined, `Should persist pending_reviewer_fix_task_execution_plan on fix_required`);
      assert.strictEqual(execPlan.action, 'ready_to_execute');
      assert.strictEqual(execPlan.parentTaskId, taskId);
      assert.strictEqual(execPlan.attempt, 1);
      const execPlanTask = execPlan.fixTask as Record<string, unknown>;
      assert.strictEqual(execPlanTask.taskId, `fix-${taskId}-reviewer-1`);
      assert.strictEqual(execPlanTask.goal, pending.task.goal);
      assert.deepStrictEqual(execPlanTask.blockingIssues, pending.task.blockingIssues);
      const execPlanRaw = JSON.stringify(execPlan);
      assert(!execPlanRaw.includes('sk-fake-reviewer-secret'), `pending_reviewer_fix_task_execution_plan should not leak sk secret`);
      assert(!execPlanRaw.includes('Bearer fake-reviewer-token'), `pending_reviewer_fix_task_execution_plan should not leak Bearer token`);
      assert(!execPlanRaw.includes('pk-fake-reviewer-public'), `pending_reviewer_fix_task_execution_plan should not leak pk secret`);
      const execRequest = (state as Record<string, unknown>).pending_reviewer_fix_task_execution_request as Record<string, unknown>;
      assert(execRequest !== undefined, `Should persist pending_reviewer_fix_task_execution_request on fix_required`);
      assert.strictEqual(execRequest.action, 'create_execution_request');
      const requestPayload = execRequest.executionRequest as Record<string, unknown>;
      assert.strictEqual(requestPayload.kind, 'reviewer_fix_task');
      assert.strictEqual(requestPayload.status, 'pending');
      assert.strictEqual(requestPayload.source, 'reviewer_gate');
      assert.strictEqual(requestPayload.taskId, `fix-${taskId}-reviewer-1`);
      assert.strictEqual(requestPayload.parentTaskId, taskId);
      assert.strictEqual(requestPayload.attempt, 1);
      assert.strictEqual(requestPayload.title, pending.task.title);
      assert.strictEqual(requestPayload.goal, pending.task.goal);
      assert.deepStrictEqual(requestPayload.blockingIssues, pending.task.blockingIssues);
      const execRequestRaw = JSON.stringify(execRequest);
      assert(!execRequestRaw.includes('sk-fake-reviewer-secret'), `pending_reviewer_fix_task_execution_request should not leak sk secret`);
      assert(!execRequestRaw.includes('Bearer fake-reviewer-token'), `pending_reviewer_fix_task_execution_request should not leak Bearer token`);
      assert(!execRequestRaw.includes('pk-fake-reviewer-public'), `pending_reviewer_fix_task_execution_request should not leak pk secret`);
      const execRequestState = (state as Record<string, unknown>).pending_reviewer_fix_task_execution_request_state as Record<string, unknown>;
      assert(execRequestState !== undefined, `Should persist pending_reviewer_fix_task_execution_request_state on fix_required`);
      assert.strictEqual(execRequestState.status, 'ready');
      const execRequestStateResult = execRequestState.executionRequestResult as Record<string, unknown>;
      assert.strictEqual(execRequestStateResult.action, 'create_execution_request');
      const execRequestStatePayload = execRequestState.executionRequest as Record<string, unknown>;
      assert.strictEqual(execRequestStatePayload.taskId, `fix-${taskId}-reviewer-1`);
      assert.strictEqual(execRequestStatePayload.parentTaskId, taskId);
      assert.strictEqual(execRequestStatePayload.attempt, 1);
      assert.strictEqual(execRequestStatePayload.title, pending.task.title);
      assert.strictEqual(execRequestStatePayload.goal, pending.task.goal);
      assert.deepStrictEqual(execRequestStatePayload.blockingIssues, pending.task.blockingIssues);
      const execRequestStateTask = execRequestStatePayload.task as Record<string, unknown>;
      assert.strictEqual(execRequestStateTask.taskId, `fix-${taskId}-reviewer-1`);
      assert.strictEqual(execRequestStateTask.parentTaskId, taskId);
      assert.strictEqual(execRequestStateTask.attempt, 1);
      assert.strictEqual(execRequestStateTask.title, pending.task.title);
      assert.strictEqual(execRequestStateTask.goal, pending.task.goal);
      assert.strictEqual(execRequestStateTask.source, 'reviewer_gate');
      assert.deepStrictEqual(execRequestStateTask.blockingIssues, pending.task.blockingIssues);
      const execRequestStateRaw = JSON.stringify(execRequestState);
      assert(!execRequestStateRaw.includes('sk-fake-reviewer-secret'), `pending_reviewer_fix_task_execution_request_state should not leak sk secret`);
      assert(!execRequestStateRaw.includes('Bearer fake-reviewer-token'), `pending_reviewer_fix_task_execution_request_state should not leak Bearer token`);
      assert(!execRequestStateRaw.includes('pk-fake-reviewer-public'), `pending_reviewer_fix_task_execution_request_state should not leak pk secret`);
      const runPlan = (state as Record<string, unknown>).reviewer_fix_task_run_plan as Record<string, unknown>;
      assert(runPlan !== undefined, `Should persist reviewer_fix_task_run_plan on fix_required`);
      assert.strictEqual(runPlan.action, 'run_fix_task');
      const runPlanExecRequest = runPlan.executionRequest as Record<string, unknown>;
      assert.strictEqual(runPlanExecRequest.kind, 'reviewer_fix_task');
      assert.strictEqual(runPlanExecRequest.status, 'pending');
      assert.strictEqual(runPlanExecRequest.source, 'reviewer_gate');
      assert.strictEqual(runPlan.taskId, `fix-${taskId}-reviewer-1`);
      assert.strictEqual(runPlan.parentTaskId, taskId);
      assert.strictEqual(runPlan.attempt, 1);
      assert.strictEqual(runPlan.title, pending.task.title);
      assert.strictEqual(runPlan.goal, pending.task.goal);
      assert.deepStrictEqual(runPlan.blockingIssues, pending.task.blockingIssues);
      const runPlanFixTask = runPlan.fixTask as Record<string, unknown>;
      assert.strictEqual(runPlanFixTask.taskId, `fix-${taskId}-reviewer-1`);
      assert.strictEqual(runPlanFixTask.title, pending.task.title);
      assert.strictEqual(runPlanFixTask.goal, pending.task.goal);
      const runPlanRaw = JSON.stringify(runPlan);
      assert(!runPlanRaw.includes('sk-fake-reviewer-secret'), `reviewer_fix_task_run_plan should not leak sk secret`);
      assert(!runPlanRaw.includes('Bearer fake-reviewer-token'), `reviewer_fix_task_run_plan should not leak Bearer token`);
      assert(!runPlanRaw.includes('pk-fake-reviewer-public'), `reviewer_fix_task_run_plan should not leak pk secret`);
      const runPlanState = (state as Record<string, unknown>).reviewer_fix_task_run_plan_state as Record<string, unknown>;
      assert(runPlanState !== undefined, `Should persist reviewer_fix_task_run_plan_state on fix_required`);
      assert.strictEqual(runPlanState.status, 'ready');
      const runPlanStateRunPlan = runPlanState.runPlan as Record<string, unknown>;
      assert.strictEqual(runPlanStateRunPlan.action, 'run_fix_task');
      assert.strictEqual(runPlanStateRunPlan.taskId, `fix-${taskId}-reviewer-1`);
      assert.strictEqual(runPlanStateRunPlan.parentTaskId, taskId);
      assert.strictEqual(runPlanStateRunPlan.attempt, 1);
      assert.strictEqual(runPlanStateRunPlan.title, pending.task.title);
      assert.strictEqual(runPlanStateRunPlan.goal, pending.task.goal);
      assert.deepStrictEqual(runPlanStateRunPlan.blockingIssues, pending.task.blockingIssues);
      const runPlanStateExecRequest = runPlanState.executionRequest as Record<string, unknown>;
      assert.strictEqual(runPlanStateExecRequest.kind, 'reviewer_fix_task');
      assert.strictEqual(runPlanStateExecRequest.status, 'pending');
      assert.strictEqual(runPlanStateExecRequest.source, 'reviewer_gate');
      const runPlanStateFixTask = runPlanState.fixTask as Record<string, unknown>;
      assert.strictEqual(runPlanStateFixTask.taskId, `fix-${taskId}-reviewer-1`);
      assert.strictEqual(runPlanStateFixTask.title, pending.task.title);
      assert.strictEqual(runPlanStateFixTask.goal, pending.task.goal);
      const runPlanStateRaw = JSON.stringify(runPlanState);
      assert(!runPlanStateRaw.includes('sk-fake-reviewer-secret'), `reviewer_fix_task_run_plan_state should not leak sk secret`);
      assert(!runPlanStateRaw.includes('Bearer fake-reviewer-token'), `reviewer_fix_task_run_plan_state should not leak Bearer token`);
      assert(!runPlanStateRaw.includes('pk-fake-reviewer-public'), `reviewer_fix_task_run_plan_state should not leak pk secret`);
      const controlledRun = (state as Record<string, unknown>).reviewer_fix_task_controlled_run as Record<string, unknown>;
      assert(controlledRun !== undefined, `Should persist reviewer_fix_task_controlled_run on fix_required with fake executor`);
      assert.strictEqual(controlledRun.runnerResultStatus, 'executed');
      assert.strictEqual(controlledRun.runnerResultNextAction, 'review_fix_result');
      const persistedState = controlledRun.persistedState as Record<string, unknown>;
      assert.strictEqual(persistedState.status, 'executed');
      assert.strictEqual(persistedState.nextAction, 'review_fix_result');
      assert.strictEqual(persistedState.taskId, `fix-${taskId}-reviewer-1`);
      assert.strictEqual(persistedState.parentTaskId, taskId);
      assert.strictEqual(persistedState.attempt, 1);
      assert.strictEqual((persistedState.executionRequest as Record<string, unknown>).taskId, `fix-${taskId}-reviewer-1`);
      assert.strictEqual((persistedState.fixTask as Record<string, unknown>).taskId, `fix-${taskId}-reviewer-1`);
      const persistedExecutorResult = persistedState.executorResult as Record<string, unknown>;
      assert.strictEqual(persistedExecutorResult.status, 'completed');
      assert.strictEqual(persistedExecutorResult.commitSha, 'fake-commit-sha-123');
      assert.deepStrictEqual(persistedExecutorResult.changedFiles, ['src/fake-fix.ts']);
      assert.strictEqual(persistedExecutorResult.hasRunState, true);
      const controlledRunRaw = JSON.stringify(controlledRun);
      assert(!controlledRunRaw.includes('sk-fake-run-state-secret'), `reviewer_fix_task_controlled_run should not leak fake runState secret`);
      assert(!controlledRunRaw.includes('runState'), `reviewer_fix_task_controlled_run should not include raw runState`);
    } finally {
      cleanup();
    }
  });

  test('with REAL_REPO_ENABLE_REVIEWER_FIX_LOOP=0 fix_required does not execute fix task', () => {
    const { taskId, tasksFilePath, repoPath, originPath, runsDir, cleanup } = createTempEnv();
    try {
      const beforeLogCount = getGitLogCount(repoPath);
      const result = runCli(['real-repo-run-ai', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_PROVIDER: 'true',
        ALLOW_REAL_REPO_APPLY: 'true',
        ALLOW_REAL_REPO_COMMIT: 'true',
        ALLOW_REAL_REPO_PUSH: 'true',
        KIMI_API_KEY: 'fake',
        KIMI_BASE_URL: 'http://localhost:9999',
        KIMI_FAKE_RESPONSE: buildFakeKimiOutput([{ path: 'README.md', content: '# modified\n' }]),
        REAL_REPO_ENABLE_REVIEWER_FIX_LOOP: '0',
        REAL_REPO_REVIEWER_FAKE_RESPONSE: JSON.stringify({
          decision: 'reject',
          confidence: 'high',
          blockingIssues: ['sk-fake-reviewer-secret'],
          nonBlockingIssues: ['pk-fake-reviewer-public'],
          reviewSummary: 'Needs fix',
          nextAction: 'fix',
          fixTask: 'use Bearer fake-reviewer-token',
        }),
        RUNS_DIR: runsDir,
      });
      assert.notStrictEqual(result.status, 0, `Expected failure: ${result.stderr}`);
      assert.strictEqual(getGitLogCount(repoPath), beforeLogCount + 1, 'Should create exactly one commit');
      const state = loadStateFromPath(runsDir, taskId);
      assert(state !== null);
      assert.strictEqual((state as Record<string, unknown>).reviewer_fix_task_controlled_run, undefined, `Should not persist reviewer_fix_task_controlled_run without fake executor env`);
    } finally {
      cleanup();
    }
  });

  test('fix_required with fake blocked executor persists blocked controlled run', () => {
    const { taskId, tasksFilePath, repoPath, originPath, runsDir, cleanup } = createTempEnv();
    try {
      const beforeLogCount = getGitLogCount(repoPath);
      const result = runCli(['real-repo-run-ai', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_PROVIDER: 'true',
        ALLOW_REAL_REPO_APPLY: 'true',
        ALLOW_REAL_REPO_COMMIT: 'true',
        ALLOW_REAL_REPO_PUSH: 'true',
        KIMI_API_KEY: 'fake',
        KIMI_BASE_URL: 'http://localhost:9999',
        KIMI_FAKE_RESPONSE: buildFakeKimiOutput([{ path: 'README.md', content: '# modified\n' }]),
        REAL_REPO_ENABLE_REVIEWER_FIX_LOOP: '0',
        REAL_REPO_REVIEWER_FAKE_RESPONSE: JSON.stringify({
          decision: 'reject',
          confidence: 'high',
          blockingIssues: ['sk-fake-reviewer-secret'],
          nonBlockingIssues: ['pk-fake-reviewer-public'],
          reviewSummary: 'Needs fix',
          nextAction: 'fix',
          fixTask: 'use Bearer fake-reviewer-token',
        }),
        REAL_REPO_REVIEWER_FIX_TASK_FAKE_EXECUTOR_RESPONSE: JSON.stringify({
          status: 'blocked',
          reason: 'Blocked due to sk-fake-blocked-secret',
          blockingIssues: ['Still broken with api_key=leaked'],
        }),
        RUNS_DIR: runsDir,
      });
      assert.notStrictEqual(result.status, 0, `Expected failure: ${result.stderr}`);
      assert.strictEqual(getGitLogCount(repoPath), beforeLogCount + 1, 'Should create exactly one commit');
      const state = loadStateFromPath(runsDir, taskId);
      assert(state !== null);
      const controlledRun = (state as Record<string, unknown>).reviewer_fix_task_controlled_run as Record<string, unknown>;
      assert(controlledRun !== undefined, `Should persist reviewer_fix_task_controlled_run on fix_required with blocked fake executor`);
      assert.strictEqual(controlledRun.runnerResultStatus, 'blocked');
      assert.strictEqual(controlledRun.runnerResultNextAction, 'block');
      const persistedState = controlledRun.persistedState as Record<string, unknown>;
      assert.strictEqual(persistedState.status, 'blocked');
      assert.strictEqual(persistedState.nextAction, 'block');
      const controlledRunRaw = JSON.stringify(controlledRun);
      assert(!controlledRunRaw.includes('sk-fake-blocked-secret'), `reviewer_fix_task_controlled_run should not leak blocked executor reason secret`);
      assert(!controlledRunRaw.includes('leaked'), `reviewer_fix_task_controlled_run should not leak blocked executor blocking issue secret`);
      assert(persistedState.reason.includes('[REDACTED]'));
      const persistedExecutorResult = persistedState.executorResult as Record<string, unknown>;
      assert.deepStrictEqual(persistedExecutorResult.blockingIssues, ['Still broken with api_key=[REDACTED]']);
    } finally {
      cleanup();
    }
  });

  test('fix_required with invalid fake executor JSON does not leak raw secret', () => {
    const { taskId, tasksFilePath, repoPath, originPath, runsDir, cleanup } = createTempEnv();
    try {
      const beforeLogCount = getGitLogCount(repoPath);
      const result = runCli(['real-repo-run-ai', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_PROVIDER: 'true',
        ALLOW_REAL_REPO_APPLY: 'true',
        ALLOW_REAL_REPO_COMMIT: 'true',
        ALLOW_REAL_REPO_PUSH: 'true',
        KIMI_API_KEY: 'fake',
        KIMI_BASE_URL: 'http://localhost:9999',
        KIMI_FAKE_RESPONSE: buildFakeKimiOutput([{ path: 'README.md', content: '# modified\n' }]),
        REAL_REPO_REVIEWER_FAKE_RESPONSE: JSON.stringify({
          decision: 'reject',
          confidence: 'high',
          blockingIssues: ['sk-fake-reviewer-secret'],
          nonBlockingIssues: ['pk-fake-reviewer-public'],
          reviewSummary: 'Needs fix',
          nextAction: 'fix',
          fixTask: 'use Bearer fake-reviewer-token',
        }),
        REAL_REPO_REVIEWER_FIX_TASK_FAKE_EXECUTOR_RESPONSE: 'not-json sk-fake-invalid-secret',
        RUNS_DIR: runsDir,
      });
      assert.notStrictEqual(result.status, 0, `Expected failure: ${result.stderr}`);
      assert.strictEqual(getGitLogCount(repoPath), beforeLogCount + 1, 'Should create exactly one commit');
      const state = loadStateFromPath(runsDir, taskId);
      assert(state !== null);
      const controlledRun = (state as Record<string, unknown>).reviewer_fix_task_controlled_run as Record<string, unknown>;
      assert(controlledRun !== undefined, `Should persist reviewer_fix_task_controlled_run on invalid fake executor JSON`);
      assert.strictEqual(controlledRun.runnerResultStatus, 'blocked');
      assert.strictEqual(controlledRun.runnerResultNextAction, 'block');
      const controlledRunRaw = JSON.stringify(controlledRun);
      assert(!controlledRunRaw.includes('sk-fake-invalid-secret'), `reviewer_fix_task_controlled_run should not leak raw invalid JSON secret`);
      assert(!controlledRunRaw.includes('not-json'), `reviewer_fix_task_controlled_run should not include raw invalid JSON`);
      const resultStderr = result.stderr;
      assert(!resultStderr.includes('sk-fake-invalid-secret'), `stderr should not leak raw invalid JSON secret`);
    } finally {
      cleanup();
    }
  });

  test('fix_required with unsupported fake executor status does not leak raw status', () => {
    const { taskId, tasksFilePath, repoPath, originPath, runsDir, cleanup } = createTempEnv();
    try {
      const beforeLogCount = getGitLogCount(repoPath);
      const result = runCli(['real-repo-run-ai', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_PROVIDER: 'true',
        ALLOW_REAL_REPO_APPLY: 'true',
        ALLOW_REAL_REPO_COMMIT: 'true',
        ALLOW_REAL_REPO_PUSH: 'true',
        KIMI_API_KEY: 'fake',
        KIMI_BASE_URL: 'http://localhost:9999',
        KIMI_FAKE_RESPONSE: buildFakeKimiOutput([{ path: 'README.md', content: '# modified\n' }]),
        REAL_REPO_ENABLE_REVIEWER_FIX_LOOP: '0',
        REAL_REPO_REVIEWER_FAKE_RESPONSE: JSON.stringify({
          decision: 'reject',
          confidence: 'high',
          blockingIssues: ['sk-fake-reviewer-secret'],
          nonBlockingIssues: ['pk-fake-reviewer-public'],
          reviewSummary: 'Needs fix',
          nextAction: 'fix',
          fixTask: 'use Bearer fake-reviewer-token',
        }),
        REAL_REPO_REVIEWER_FIX_TASK_FAKE_EXECUTOR_RESPONSE: JSON.stringify({
          status: 'unexpected-status-value sk-fake-unsupported-secret',
          reason: 'Should not matter',
        }),
        RUNS_DIR: runsDir,
      });
      assert.notStrictEqual(result.status, 0, `Expected failure: ${result.stderr}`);
      assert.strictEqual(getGitLogCount(repoPath), beforeLogCount + 1, 'Should create exactly one commit');
      const state = loadStateFromPath(runsDir, taskId);
      assert(state !== null);
      const controlledRun = (state as Record<string, unknown>).reviewer_fix_task_controlled_run as Record<string, unknown>;
      assert(controlledRun !== undefined, `Should persist reviewer_fix_task_controlled_run on unsupported fake executor status`);
      assert.strictEqual(controlledRun.runnerResultStatus, 'blocked');
      assert.strictEqual(controlledRun.runnerResultNextAction, 'block');
      const controlledRunRaw = JSON.stringify(controlledRun);
      assert(!controlledRunRaw.includes('unexpected-status-value'), `reviewer_fix_task_controlled_run should not leak raw unsupported status`);
      assert(!controlledRunRaw.includes('sk-fake-unsupported-secret'), `reviewer_fix_task_controlled_run should not leak secret from unsupported status`);
      assert(!result.stderr.includes('unexpected-status-value'), `stderr should not leak raw unsupported status`);
      assert(!result.stderr.includes('sk-fake-unsupported-secret'), `stderr should not leak secret from unsupported status`);
      const persistedState = controlledRun.persistedState as Record<string, unknown>;
      assert.strictEqual(persistedState.status, 'blocked');
      assert(persistedState.reason.includes('Unsupported fake executor status'));
    } finally {
      cleanup();
    }
  });

  test('fake reviewer block_for_human persists reviewer_gate with redacted secrets', () => {
    const { taskId, tasksFilePath, repoPath, originPath, runsDir, cleanup } = createTempEnv();
    try {
      const before = getBareRefs(originPath);
      const beforeLogCount = getGitLogCount(repoPath);
      const result = runCli(['real-repo-run-ai', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_PROVIDER: 'true',
        ALLOW_REAL_REPO_APPLY: 'true',
        ALLOW_REAL_REPO_COMMIT: 'true',
        ALLOW_REAL_REPO_PUSH: 'true',
        KIMI_API_KEY: 'fake',
        KIMI_BASE_URL: 'http://localhost:9999',
        KIMI_FAKE_RESPONSE: buildFakeKimiOutput([{ path: 'README.md', content: '# modified\n' }]),
        REAL_REPO_REVIEWER_FAKE_RESPONSE: JSON.stringify({
          decision: 'block_for_human',
          confidence: 'high',
          blockingIssues: ['api_key=fake-reviewer-key'],
          nonBlockingIssues: [],
          reviewSummary: 'Blocked because token=fake-reviewer-token',
          nextAction: 'block',
        }),
        RUNS_DIR: runsDir,
      });
      assert.notStrictEqual(result.status, 0, `Expected failure: ${result.stderr}`);
      assert(result.stderr.includes('Reviewer gate blocked'), `Should show blocked: ${result.stderr}`);
      assert(result.stderr.includes('Blocking issues:'), `Should show blocking issues label: ${result.stderr}`);
      assert(!result.stderr.includes('api_key=fake-reviewer-key'), `Should not leak api_key in stderr: ${result.stderr}`);
      const after = getBareRefs(originPath);
      assert.notDeepStrictEqual(after, before, 'Initial push should still have happened');
      assert.strictEqual(getGitLogCount(repoPath), beforeLogCount + 1, 'Should create exactly one commit');
      const state = loadStateFromPath(runsDir, taskId);
      assert(state !== null);
      const rg = (state as Record<string, unknown>).reviewer_gate as Record<string, unknown>;
      assert(rg !== undefined, `Should persist reviewer_gate`);
      assert.strictEqual(rg.status, 'blocked');
      assert.strictEqual(rg.source, 'reviewer');
      assert.strictEqual(rg.nextAction, 'block');
      const stateRaw = JSON.stringify(state);
      assert(!stateRaw.includes('api_key=fake-reviewer-key'), `Should not leak api_key in persisted state`);
      assert(!stateRaw.includes('token=fake-reviewer-token'), `Should not leak token in persisted state`);
      const rbr = (state as Record<string, unknown>).reviewer_block_review_result as Record<string, unknown>;
      assert(rbr !== undefined, `Should persist reviewer_block_review_result`);
      assert.strictEqual(rbr.blockId, `single-task-review:${taskId}`);
      const resolutionPlan = rbr.resolutionPlan as Record<string, unknown>;
      assert.strictEqual(resolutionPlan.action, 'block_for_human');
      const fixTaskPlan = rbr.fixTaskPlan as Record<string, unknown>;
      assert.strictEqual(fixTaskPlan.action, 'block_for_human');
      const rbrRaw = JSON.stringify(rbr);
      assert(!rbrRaw.includes('api_key=fake-reviewer-key'), `reviewer_block_review_result should not leak api_key`);
      assert(!rbrRaw.includes('token=fake-reviewer-token'), `reviewer_block_review_result should not leak token`);
      assert.strictEqual((state as Record<string, unknown>).pending_reviewer_fix_task, undefined, `Should not persist pending_reviewer_fix_task on block_for_human`);
      assert.strictEqual((state as Record<string, unknown>).pending_reviewer_fix_task_state, undefined, `Should not persist pending_reviewer_fix_task_state on block_for_human`);
      assert.strictEqual((state as Record<string, unknown>).pending_reviewer_fix_task_execution_plan, undefined, `Should not persist pending_reviewer_fix_task_execution_plan on block_for_human`);
      assert.strictEqual((state as Record<string, unknown>).pending_reviewer_fix_task_execution_request, undefined, `Should not persist pending_reviewer_fix_task_execution_request on block_for_human`);
      assert.strictEqual((state as Record<string, unknown>).pending_reviewer_fix_task_execution_request_state, undefined, `Should not persist pending_reviewer_fix_task_execution_request_state on block_for_human`);
      assert.strictEqual((state as Record<string, unknown>).reviewer_fix_task_run_plan, undefined, `Should not persist reviewer_fix_task_run_plan on block_for_human`);
      assert.strictEqual((state as Record<string, unknown>).reviewer_fix_task_run_plan_state, undefined, `Should not persist reviewer_fix_task_run_plan_state on block_for_human`);
      assert.strictEqual((state as Record<string, unknown>).reviewer_fix_task_controlled_run, undefined, `Should not persist reviewer_fix_task_controlled_run on block_for_human`);
    } finally {
      cleanup();
    }
  });

  test('invalid fake reviewer output exits non-zero with parser block and persists reviewer_gate', () => {
    const { taskId, tasksFilePath, repoPath, originPath, runsDir, cleanup } = createTempEnv();
    try {
      const before = getBareRefs(originPath);
      const result = runCli(['real-repo-run-ai', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_PROVIDER: 'true',
        ALLOW_REAL_REPO_APPLY: 'true',
        ALLOW_REAL_REPO_COMMIT: 'true',
        ALLOW_REAL_REPO_PUSH: 'true',
        KIMI_API_KEY: 'fake',
        KIMI_BASE_URL: 'http://localhost:9999',
        KIMI_FAKE_RESPONSE: buildFakeKimiOutput([{ path: 'README.md', content: '# modified\n' }]),
        REAL_REPO_REVIEWER_FAKE_RESPONSE: 'not valid json',
        RUNS_DIR: runsDir,
      });
      assert.notStrictEqual(result.status, 0, `Expected failure: ${result.stderr}`);
      assert(result.stderr.includes('Reviewer gate blocked'), `Should show blocked: ${result.stderr}`);
      const after = getBareRefs(originPath);
      assert.notDeepStrictEqual(after, before, 'Initial push should still have happened');
      const state = loadStateFromPath(runsDir, taskId);
      assert(state !== null);
      const rg = (state as Record<string, unknown>).reviewer_gate as Record<string, unknown>;
      assert(rg !== undefined, `Should persist reviewer_gate`);
      assert.strictEqual(rg.status, 'blocked');
      assert.strictEqual(rg.source, 'parser');
      assert.strictEqual(rg.nextAction, 'block');
      assert(Array.isArray(rg.blockingIssues));
      assert((rg.blockingIssues as string[]).length > 0, `Parser blocking issues should not be empty`);
      const rbr = (state as Record<string, unknown>).reviewer_block_review_result as Record<string, unknown>;
      assert(rbr !== undefined, `Should persist reviewer_block_review_result`);
      assert.strictEqual(rbr.blockId, `single-task-review:${taskId}`);
      const resolutionPlan = rbr.resolutionPlan as Record<string, unknown>;
      assert.strictEqual(resolutionPlan.action, 'block_for_human');
      const fixTaskPlan = rbr.fixTaskPlan as Record<string, unknown>;
      assert.strictEqual(fixTaskPlan.action, 'block_for_human');
      assert.strictEqual((state as Record<string, unknown>).pending_reviewer_fix_task, undefined, `Should not persist pending_reviewer_fix_task on parser failure`);
      assert.strictEqual((state as Record<string, unknown>).pending_reviewer_fix_task_state, undefined, `Should not persist pending_reviewer_fix_task_state on parser failure`);
      assert.strictEqual((state as Record<string, unknown>).pending_reviewer_fix_task_execution_plan, undefined, `Should not persist pending_reviewer_fix_task_execution_plan on parser failure`);
      assert.strictEqual((state as Record<string, unknown>).pending_reviewer_fix_task_execution_request, undefined, `Should not persist pending_reviewer_fix_task_execution_request on parser failure`);
      assert.strictEqual((state as Record<string, unknown>).pending_reviewer_fix_task_execution_request_state, undefined, `Should not persist pending_reviewer_fix_task_execution_request_state on parser failure`);
      assert.strictEqual((state as Record<string, unknown>).reviewer_fix_task_run_plan, undefined, `Should not persist reviewer_fix_task_run_plan on parser failure`);
      assert.strictEqual((state as Record<string, unknown>).reviewer_fix_task_run_plan_state, undefined, `Should not persist reviewer_fix_task_run_plan_state on parser failure`);
      assert.strictEqual((state as Record<string, unknown>).reviewer_fix_task_controlled_run, undefined, `Should not persist reviewer_fix_task_controlled_run on parser failure`);
    } finally {
      cleanup();
    }
  });

  test('reviewer provider error persists reviewer_gate and reviewer_block_review_result as block_for_human', () => {
    const { taskId, tasksFilePath, repoPath, originPath, runsDir, cleanup } = createTempEnv();
    try {
      const before = getBareRefs(originPath);
      const result = runCli(['real-repo-run-ai', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_PROVIDER: 'true',
        ALLOW_REAL_REPO_APPLY: 'true',
        ALLOW_REAL_REPO_COMMIT: 'true',
        ALLOW_REAL_REPO_PUSH: 'true',
        KIMI_API_KEY: 'fake',
        KIMI_BASE_URL: 'http://localhost:9999',
        KIMI_FAKE_RESPONSE: buildFakeKimiOutput([{ path: 'README.md', content: '# modified\n' }]),
        REAL_REPO_REVIEWER_FAKE_RESPONSE: JSON.stringify({
          decision: 'accept',
          confidence: 'high',
          blockingIssues: [],
          nonBlockingIssues: [],
          reviewSummary: 'Would accept',
          nextAction: 'continue',
        }),
        REAL_REPO_REVIEWER_FORCE_PROVIDER_ERROR: 'true',
        RUNS_DIR: runsDir,
      });
      assert.notStrictEqual(result.status, 0, `Expected failure: ${result.stderr}`);
      const after = getBareRefs(originPath);
      assert.notDeepStrictEqual(after, before, 'Initial push should still have happened');
      const state = loadStateFromPath(runsDir, taskId);
      assert(state !== null);
      const rg = (state as Record<string, unknown>).reviewer_gate as Record<string, unknown>;
      assert(rg !== undefined, `Should persist reviewer_gate`);
      assert.strictEqual(rg.status, 'blocked');
      assert.strictEqual(rg.source, 'provider');
      const rbr = (state as Record<string, unknown>).reviewer_block_review_result as Record<string, unknown>;
      assert(rbr !== undefined, `Should persist reviewer_block_review_result`);
      assert.strictEqual(rbr.blockId, `single-task-review:${taskId}`);
      const resolutionPlan = rbr.resolutionPlan as Record<string, unknown>;
      assert.strictEqual(resolutionPlan.action, 'block_for_human');
      const fixTaskPlan = rbr.fixTaskPlan as Record<string, unknown>;
      assert.strictEqual(fixTaskPlan.action, 'block_for_human');
      assert.strictEqual((state as Record<string, unknown>).pending_reviewer_fix_task, undefined, `Should not persist pending_reviewer_fix_task on provider error`);
      assert.strictEqual((state as Record<string, unknown>).pending_reviewer_fix_task_state, undefined, `Should not persist pending_reviewer_fix_task_state on provider error`);
      assert.strictEqual((state as Record<string, unknown>).pending_reviewer_fix_task_execution_plan, undefined, `Should not persist pending_reviewer_fix_task_execution_plan on provider error`);
      assert.strictEqual((state as Record<string, unknown>).pending_reviewer_fix_task_execution_request, undefined, `Should not persist pending_reviewer_fix_task_execution_request on provider error`);
      assert.strictEqual((state as Record<string, unknown>).pending_reviewer_fix_task_execution_request_state, undefined, `Should not persist pending_reviewer_fix_task_execution_request_state on provider error`);
      assert.strictEqual((state as Record<string, unknown>).reviewer_fix_task_run_plan, undefined, `Should not persist reviewer_fix_task_run_plan on provider error`);
      assert.strictEqual((state as Record<string, unknown>).reviewer_fix_task_run_plan_state, undefined, `Should not persist reviewer_fix_task_run_plan_state on provider error`);
      assert.strictEqual((state as Record<string, unknown>).reviewer_fix_task_controlled_run, undefined, `Should not persist reviewer_fix_task_controlled_run on provider error`);
    } finally {
      cleanup();
    }
  });

  test('reviewer gate is not run if apply fails before reviewer stage', () => {
    const { taskId, tasksFilePath, repoPath, originPath, runsDir, cleanup } = createTempEnv();
    try {
      writeFileSync(join(repoPath, 'blocked'), 'i am a file not a directory', 'utf-8');
      spawnSync('git', ['add', 'blocked'], { cwd: repoPath, encoding: 'utf-8', shell: false });
      spawnSync('git', ['commit', '-m', 'add blocked', '--no-gpg-sign'], { cwd: repoPath, encoding: 'utf-8', shell: false });
      const before = getBareRefs(originPath);
      const result = runCli(['real-repo-run-ai', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_PROVIDER: 'true',
        ALLOW_REAL_REPO_APPLY: 'true',
        ALLOW_REAL_REPO_COMMIT: 'true',
        ALLOW_REAL_REPO_PUSH: 'true',
        KIMI_API_KEY: 'fake',
        KIMI_BASE_URL: 'http://localhost:9999',
        KIMI_FAKE_RESPONSE: buildFakeKimiOutput([
          { path: 'README.md', content: '# modified\n' },
          { path: 'blocked/new.txt', content: 'should fail\n' },
        ]),
        REAL_REPO_REVIEWER_FAKE_RESPONSE: JSON.stringify({
          decision: 'accept',
          confidence: 'high',
          blockingIssues: [],
          nonBlockingIssues: [],
          reviewSummary: 'Looks good',
          nextAction: 'continue',
        }),
        RUNS_DIR: runsDir,
      });
      assert.notStrictEqual(result.status, 0);
      assert(!result.stderr.includes('Reviewer gate'), `Should not run reviewer gate when apply fails: ${result.stderr}`);
      const after = getBareRefs(originPath);
      assert.deepStrictEqual(after, before, 'Should not push when apply fails');
      const state = loadStateFromPath(runsDir, taskId);
      assert.strictEqual(state, null, `State should not be written when apply fails`);
    } finally {
      cleanup();
    }
  });

  test('raw fake reviewer output is not printed or persisted', () => {
    const { taskId, tasksFilePath, repoPath, runsDir, cleanup } = createTempEnv();
    try {
      const rawResponse = JSON.stringify({
        decision: 'accept',
        confidence: 'high',
        blockingIssues: [],
        nonBlockingIssues: [],
        reviewSummary: 'Looks good',
        nextAction: 'continue',
      });
      const result = runCli(['real-repo-run-ai', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_PROVIDER: 'true',
        ALLOW_REAL_REPO_APPLY: 'true',
        ALLOW_REAL_REPO_COMMIT: 'true',
        ALLOW_REAL_REPO_PUSH: 'true',
        KIMI_API_KEY: 'fake',
        KIMI_BASE_URL: 'http://localhost:9999',
        KIMI_FAKE_RESPONSE: buildFakeKimiOutput([{ path: 'README.md', content: '# modified\n' }]),
        REAL_REPO_REVIEWER_FAKE_RESPONSE: rawResponse,
        RUNS_DIR: runsDir,
      });
      assert.strictEqual(result.status, 0, `Expected success: ${result.stderr}`);
      assert(!result.stdout.includes(rawResponse), `Should not print raw reviewer output in stdout`);
      assert(!result.stderr.includes(rawResponse), `Should not print raw reviewer output in stderr`);
      const state = loadStateFromPath(runsDir, taskId);
      assert(state !== null);
      const stateRaw = JSON.stringify(state);
      assert(!stateRaw.includes(rawResponse), `Should not persist raw reviewer output in state`);
      const rbr = (state as Record<string, unknown>).reviewer_block_review_result as Record<string, unknown>;
      assert(rbr !== undefined, `Should persist reviewer_block_review_result`);
      const rbrRaw = JSON.stringify(rbr);
      assert(!rbrRaw.includes(rawResponse), `Should not persist raw reviewer output in reviewer_block_review_result`);
    } finally {
      cleanup();
    }
  });

  test('fake secrets in reviewer provider failure path do not leak in stderr or state', () => {
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
        KIMI_FAKE_RESPONSE: buildFakeKimiOutput([{ path: 'README.md', content: '# modified\n' }]),
        REAL_REPO_REVIEWER_FAKE_RESPONSE: 'not valid json with sk-fake-key',
        RUNS_DIR: runsDir,
      });
      assert.notStrictEqual(result.status, 0);
      assert(!result.stderr.includes('sk-fake-key'), `Should not leak secret in stderr: ${result.stderr}`);
      assert(result.stderr.includes('[REDACTED]') || result.stderr.includes('Reviewer gate blocked'), `Should redact or block: ${result.stderr}`);
      const state = loadStateFromPath(runsDir, taskId);
      assert(state !== null);
      const stateRaw = JSON.stringify(state);
      assert(!stateRaw.includes('sk-fake-key'), `Should not leak secret in persisted state: ${stateRaw}`);
      const rbr = (state as Record<string, unknown>).reviewer_block_review_result as Record<string, unknown>;
      assert(rbr !== undefined, `Should persist reviewer_block_review_result`);
      const rbrRaw = JSON.stringify(rbr);
      assert(!rbrRaw.includes('sk-fake-key'), `Should not leak secret in reviewer_block_review_result: ${rbrRaw}`);
    } finally {
      cleanup();
    }
  });

  test('fake reviewer receives reviewer input with task goal commit sha changed files diff stat check summary safety flags', () => {
    const { taskId, tasksFilePath, repoPath, originPath, runsDir, cleanup } = createTempEnv();
    const captureFile = join(runsDir, 'reviewer-input-capture.json');
    try {
      const before = getBareRefs(originPath);
      const result = runCli(['real-repo-run-ai', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_PROVIDER: 'true',
        ALLOW_REAL_REPO_APPLY: 'true',
        ALLOW_REAL_REPO_COMMIT: 'true',
        ALLOW_REAL_REPO_PUSH: 'true',
        KIMI_API_KEY: 'fake',
        KIMI_BASE_URL: 'http://localhost:9999',
        KIMI_FAKE_RESPONSE: buildFakeKimiOutput([{ path: 'README.md', content: '# modified\n' }]),
        REAL_REPO_REVIEWER_FAKE_RESPONSE: JSON.stringify({
          decision: 'accept',
          confidence: 'high',
          blockingIssues: [],
          nonBlockingIssues: [],
          reviewSummary: 'Looks good',
          nextAction: 'continue',
        }),
        REAL_REPO_REVIEWER_CAPTURE_INPUT_FILE: captureFile,
        RUNS_DIR: runsDir,
      });
      assert.strictEqual(result.status, 0, `Expected success: ${result.stderr}`);
      assert(existsSync(captureFile), `Capture file should exist: ${captureFile}`);
      const captured = JSON.parse(readFileSync(captureFile, 'utf-8'));
      assert.strictEqual(captured.taskGoal, 'Test goal', `Should include task goal`);
      assert(typeof captured.commitSha === 'string' && captured.commitSha.length === 40, `Should include full commit SHA: ${captured.commitSha}`);
      assert(Array.isArray(captured.changedFiles) && captured.changedFiles.includes('README.md'), `Should include changed files: ${JSON.stringify(captured.changedFiles)}`);
      assert(typeof captured.diffStat === 'string' && captured.diffStat.length > 0, `Should include diff stat: ${captured.diffStat}`);
      assert(typeof captured.checkSummary === 'object' && captured.checkSummary !== null, `Should include check summary`);
      assert(typeof captured.safety === 'object' && captured.safety !== null, `Should include safety flags`);
      assert.strictEqual(captured.safety.commitShaIsFullLength, true, `Safety should show full SHA`);
      assert.strictEqual(captured.safety.branchIsNotMain, true, `Safety should show branch not main`);
      assert.strictEqual(captured.safety.hasChangedFiles, true, `Safety should show has changed files`);
      const after = getBareRefs(originPath);
      assert.notDeepStrictEqual(after, before, 'Should push to remote');
    } finally {
      cleanup();
    }
  });

  test('captured reviewer input does not include raw reviewer output', () => {
    const { taskId, tasksFilePath, repoPath, runsDir, cleanup } = createTempEnv();
    const captureFile = join(runsDir, 'reviewer-input-capture.json');
    try {
      const rawResponse = JSON.stringify({
        decision: 'accept',
        confidence: 'high',
        blockingIssues: [],
        nonBlockingIssues: [],
        reviewSummary: 'Looks good',
        nextAction: 'continue',
      });
      runCli(['real-repo-run-ai', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_PROVIDER: 'true',
        ALLOW_REAL_REPO_APPLY: 'true',
        ALLOW_REAL_REPO_COMMIT: 'true',
        ALLOW_REAL_REPO_PUSH: 'true',
        KIMI_API_KEY: 'fake',
        KIMI_BASE_URL: 'http://localhost:9999',
        KIMI_FAKE_RESPONSE: buildFakeKimiOutput([{ path: 'README.md', content: '# modified\n' }]),
        REAL_REPO_REVIEWER_FAKE_RESPONSE: rawResponse,
        REAL_REPO_REVIEWER_CAPTURE_INPUT_FILE: captureFile,
        RUNS_DIR: runsDir,
      });
      assert(existsSync(captureFile), `Capture file should exist`);
      const capturedRaw = readFileSync(captureFile, 'utf-8');
      assert(!capturedRaw.includes(rawResponse), `Captured input should not contain raw reviewer output`);
    } finally {
      cleanup();
    }
  });

  function getHeadSha(repoPath: string): string {
    const result = spawnSync('git', ['rev-parse', 'HEAD'], {
      cwd: repoPath,
      encoding: 'utf-8',
      shell: false,
    });
    return result.stdout.trim();
  }

  test('with REAL_REPO_ENABLE_REVIEWER_FIX_LOOP=0 fix_required does not execute fix task', () => {
    const { taskId, tasksFilePath, repoPath, originPath, runsDir, cleanup } = createTempEnv();
    try {
      const beforeLogCount = getGitLogCount(repoPath);
      const result = runCli(['real-repo-run-ai', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_PROVIDER: 'true',
        ALLOW_REAL_REPO_APPLY: 'true',
        ALLOW_REAL_REPO_COMMIT: 'true',
        ALLOW_REAL_REPO_PUSH: 'true',
        KIMI_API_KEY: 'fake',
        KIMI_BASE_URL: 'http://localhost:9999',
        KIMI_FAKE_RESPONSE: buildFakeKimiOutput([{ path: 'README.md', content: '# modified\n' }]),
        REAL_REPO_REVIEWER_FAKE_RESPONSE: JSON.stringify({
          decision: 'reject',
          confidence: 'high',
          blockingIssues: ['missing fix'],
          nonBlockingIssues: [],
          reviewSummary: 'Needs fix',
          nextAction: 'fix',
          fixTask: 'add fix.txt',
        }),
        REAL_REPO_ENABLE_REVIEWER_FIX_LOOP: '0',
        RUNS_DIR: runsDir,
      });
      assert.notStrictEqual(result.status, 0, `Expected failure: ${result.stderr}`);
      assert.strictEqual(getGitLogCount(repoPath), beforeLogCount + 1, 'Should create exactly one commit');
      const state = loadStateFromPath(runsDir, taskId);
      assert(state !== null);
      assert.strictEqual((state as Record<string, unknown>).reviewer_fix_task_controlled_run, undefined, 'Should not run fix task without env flag');
      assert.strictEqual((state as Record<string, unknown>).reviewer_fix_task_second_review, undefined, 'Should not have second review without env flag');
    } finally {
      cleanup();
    }
  });

  test('with REAL_REPO_ENABLE_REVIEWER_FIX_LOOP=1 fix_required executes fix task and second reviewer accepts', () => {
    const { taskId, tasksFilePath, repoPath, originPath, runsDir, cleanup } = createTempEnv();
    try {
      const beforeLogCount = getGitLogCount(repoPath);
      const result = runCli(['real-repo-run-ai', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_PROVIDER: 'true',
        ALLOW_REAL_REPO_APPLY: 'true',
        ALLOW_REAL_REPO_COMMIT: 'true',
        ALLOW_REAL_REPO_PUSH: 'true',
        KIMI_API_KEY: 'fake',
        KIMI_BASE_URL: 'http://localhost:9999',
        KIMI_FAKE_RESPONSE: buildFakeKimiOutput([{ path: 'README.md', content: '# modified\n' }]),
        REAL_REPO_REVIEWER_FAKE_RESPONSE: JSON.stringify({
          decision: 'reject',
          confidence: 'high',
          blockingIssues: ['missing fix'],
          nonBlockingIssues: [],
          reviewSummary: 'Needs fix',
          nextAction: 'fix',
          fixTask: 'add fix.txt',
        }),
        REAL_REPO_REVIEWER_FIX_TASK_KIMI_FAKE_RESPONSE: buildFakeKimiOutput([
          { path: 'fix.txt', content: 'fix applied\n' },
        ]),
        REAL_REPO_REVIEWER_SECOND_FAKE_RESPONSE: JSON.stringify({
          decision: 'accept',
          confidence: 'high',
          blockingIssues: [],
          nonBlockingIssues: [],
          reviewSummary: 'Fix looks good',
          nextAction: 'continue',
        }),
        REAL_REPO_ENABLE_REVIEWER_FIX_LOOP: '1',
        RUNS_DIR: runsDir,
      });
      assert.strictEqual(result.status, 0, `Expected success: ${result.stderr}`);
      assert(result.stderr.includes('Reviewer fix-loop completed'), `Should report fix-loop completion: ${result.stderr}`);
      assert.strictEqual(getGitLogCount(repoPath), beforeLogCount + 2, 'Should create original and fix commits');

      const state = loadStateFromPath(runsDir, taskId) as Record<string, unknown>;
      assert(state !== null);
      assert.strictEqual(state.status, 'pushed');

      const controlledRun = state.reviewer_fix_task_controlled_run as Record<string, unknown>;
      assert(controlledRun !== undefined, 'Should persist controlled run');
      assert.strictEqual(controlledRun.runnerResultStatus, 'executed');
      assert.strictEqual(controlledRun.runnerResultNextAction, 'review_fix_result');

      const postRunPlan = state.reviewer_fix_task_post_run_review_plan as Record<string, unknown>;
      assert(postRunPlan !== undefined, 'Should persist post-run review plan');
      assert.strictEqual(postRunPlan.action, 'review_fix_result');
      const fixTaskId = `fix-${taskId}-reviewer-1`;
      assert.strictEqual(postRunPlan.taskId, fixTaskId);
      assert.strictEqual(postRunPlan.parentTaskId, taskId);
      assert.strictEqual(postRunPlan.attempt, 1);
      const fixCommitSha = postRunPlan.commitSha as string;
      assert(typeof fixCommitSha === 'string' && fixCommitSha.length === 40, `Fix commit SHA should be 40 chars: ${fixCommitSha}`);

      const originalCommitSha = state.commit_sha as string;
      assert.notStrictEqual(fixCommitSha, originalCommitSha, 'Fix commit should differ from original commit');

      const changedFiles = postRunPlan.changedFiles as string[];
      assert(Array.isArray(changedFiles) && changedFiles.includes('fix.txt'), `Should include fix changed files: ${JSON.stringify(changedFiles)}`);

      const secondReview = state.reviewer_fix_task_second_review as Record<string, unknown>;
      assert(secondReview !== undefined, 'Should persist second review');
      assert.strictEqual(secondReview.fixTaskId, fixTaskId);
      assert.strictEqual(secondReview.parentTaskId, taskId);
      assert.strictEqual(secondReview.attempt, 1);
      assert.strictEqual(secondReview.fixCommitSha, fixCommitSha);
      assert.strictEqual(secondReview.finalStatus, 'accepted');
      assert.strictEqual(secondReview.nextAction, 'continue');

      const secondGate = secondReview.reviewerGate as Record<string, unknown>;
      assert(secondGate !== undefined);
      assert.strictEqual(secondGate.status, 'accepted');
      assert.strictEqual(secondGate.nextAction, 'continue');

      const rbr = secondReview.reviewerBlockReviewResult as Record<string, unknown>;
      assert(rbr !== undefined, 'Should persist reviewerBlockReviewResult from second gate');
      const blockDecision = rbr.blockDecision as Record<string, unknown>;
      const actionPlan = blockDecision.actionPlan as Record<string, unknown>;
      assert.strictEqual(actionPlan.action, 'continue', 'Second review actionPlan should be continue');
      const resolutionPlan = rbr.resolutionPlan as Record<string, unknown>;
      assert.strictEqual(resolutionPlan.action, 'continue_block', 'Second review resolutionPlan should be continue_block');

      const stateRaw = JSON.stringify(state);
      assert(!stateRaw.includes('fix applied'), 'State should not contain fix file content');
      assert(!stateRaw.includes('sk-fake'), 'State should not leak secrets');
    } finally {
      cleanup();
    }
  });

  test('with REAL_REPO_ENABLE_REVIEWER_FIX_LOOP=1 fix_required invalid fix JSON exits non-zero and explains invalid response', () => {
    const { taskId, tasksFilePath, repoPath, originPath, runsDir, cleanup } = createTempEnv();
    try {
      const beforeLogCount = getGitLogCount(repoPath);
      const result = runCli(['real-repo-run-ai', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_PROVIDER: 'true',
        ALLOW_REAL_REPO_APPLY: 'true',
        ALLOW_REAL_REPO_COMMIT: 'true',
        ALLOW_REAL_REPO_PUSH: 'true',
        KIMI_API_KEY: 'fake',
        KIMI_BASE_URL: 'http://localhost:9999',
        KIMI_FAKE_RESPONSE: buildFakeKimiOutput([{ path: 'README.md', content: '# modified\n' }]),
        REAL_REPO_REVIEWER_FAKE_RESPONSE: JSON.stringify({
          decision: 'reject',
          confidence: 'high',
          blockingIssues: ['missing fix'],
          nonBlockingIssues: [],
          reviewSummary: 'Needs fix',
          nextAction: 'fix',
          fixTask: 'add fix.txt',
        }),
        REAL_REPO_REVIEWER_FIX_TASK_KIMI_FAKE_RESPONSE: 'not-json sk-fake-fix-invalid',
        REAL_REPO_ENABLE_REVIEWER_FIX_LOOP: '1',
        RUNS_DIR: runsDir,
      });
      assert.notStrictEqual(result.status, 0, `Expected failure: ${result.stderr}`);
      assert(result.stderr.includes('fix execution blocked or failed') || result.stderr.includes('Invalid Kimi JSON'), `Should explain invalid fix response: ${result.stderr}`);
      assert.strictEqual(getGitLogCount(repoPath), beforeLogCount + 1, 'Should create only original commit');

      const state = loadStateFromPath(runsDir, taskId) as Record<string, unknown>;
      assert(state !== null);
      const controlledRun = state.reviewer_fix_task_controlled_run as Record<string, unknown>;
      assert(controlledRun !== undefined, 'Should persist controlled run');
      assert.strictEqual(controlledRun.runnerResultStatus, 'blocked');

      const controlledRunRaw = JSON.stringify(controlledRun);
      assert(!controlledRunRaw.includes('sk-fake-fix-invalid'), 'Should not leak invalid JSON secret in controlled run');
      assert(!result.stderr.includes('sk-fake-fix-invalid'), 'Should not leak invalid JSON secret in stderr');
      assert(!result.stdout.includes('sk-fake-fix-invalid'), 'Should not leak invalid JSON secret in stdout');
    } finally {
      cleanup();
    }
  });

  test('with REAL_REPO_ENABLE_REVIEWER_FIX_LOOP=1 fix_required fix checks fail exits non-zero and persists check failure', () => {
    const { taskId, tasksFilePath, repoPath, originPath, runsDir, cleanup } = createTempEnv(['node', 'check-fix.cjs']);
    try {
      setupFixFailingCheck(repoPath);
      const beforeLogCount = getGitLogCount(repoPath);
      const result = runCli(['real-repo-run-ai', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_PROVIDER: 'true',
        ALLOW_REAL_REPO_APPLY: 'true',
        ALLOW_REAL_REPO_COMMIT: 'true',
        ALLOW_REAL_REPO_PUSH: 'true',
        KIMI_API_KEY: 'fake',
        KIMI_BASE_URL: 'http://localhost:9999',
        KIMI_FAKE_RESPONSE: buildFakeKimiOutput([{ path: 'README.md', content: '# modified\n' }]),
        REAL_REPO_REVIEWER_FAKE_RESPONSE: JSON.stringify({
          decision: 'reject',
          confidence: 'high',
          blockingIssues: ['missing fix'],
          nonBlockingIssues: [],
          reviewSummary: 'Needs fix',
          nextAction: 'fix',
          fixTask: 'add fix.txt',
        }),
        REAL_REPO_REVIEWER_FIX_TASK_KIMI_FAKE_RESPONSE: buildFakeKimiOutput([
          { path: 'fix.txt', content: 'fix applied\n' },
        ]),
        REAL_REPO_ENABLE_REVIEWER_FIX_LOOP: '1',
        RUNS_DIR: runsDir,
      });
      assert.notStrictEqual(result.status, 0, `Expected failure: ${result.stderr}`);
      assert.strictEqual(getGitLogCount(repoPath), beforeLogCount + 1, 'Should create only original commit');
      assert(result.stderr.includes('fix execution blocked or failed') || result.stderr.includes('Checks failed'), `Should report check failure: ${result.stderr}`);

      const state = loadStateFromPath(runsDir, taskId) as Record<string, unknown>;
      assert(state !== null);
      const controlledRun = state.reviewer_fix_task_controlled_run as Record<string, unknown>;
      assert(controlledRun !== undefined, 'Should persist controlled run');
      assert.strictEqual(controlledRun.runnerResultStatus, 'blocked');
      const persistedState = controlledRun.persistedState as Record<string, unknown>;
      assert(typeof persistedState.reason === 'string' && persistedState.reason.length > 0, 'Should persist blocked reason');
    } finally {
      cleanup();
    }
  });


  test('with REAL_REPO_ENABLE_REVIEWER_FIX_LOOP=1 and max_fix_attempts=1 second reviewer reject does not recursively fix', () => {
    const { taskId, tasksFilePath, repoPath, originPath, runsDir, cleanup } = createTempEnv();
    try {
      const beforeLogCount = getGitLogCount(repoPath);
      const result = runCli(['real-repo-run-ai', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_PROVIDER: 'true',
        ALLOW_REAL_REPO_APPLY: 'true',
        ALLOW_REAL_REPO_COMMIT: 'true',
        ALLOW_REAL_REPO_PUSH: 'true',
        KIMI_API_KEY: 'fake',
        KIMI_BASE_URL: 'http://localhost:9999',
        KIMI_FAKE_RESPONSE: buildFakeKimiOutput([{ path: 'README.md', content: '# modified\n' }]),
        REAL_REPO_REVIEWER_FAKE_RESPONSE: JSON.stringify({
          decision: 'reject',
          confidence: 'high',
          blockingIssues: ['missing fix'],
          nonBlockingIssues: [],
          reviewSummary: 'Needs fix',
          nextAction: 'fix',
          fixTask: 'add fix.txt',
        }),
        REAL_REPO_REVIEWER_FIX_TASK_KIMI_FAKE_RESPONSE: buildFakeKimiOutput([
          { path: 'fix.txt', content: 'fix applied\n' },
        ]),
        REAL_REPO_REVIEWER_SECOND_FAKE_RESPONSE: JSON.stringify({
          decision: 'reject',
          confidence: 'high',
          blockingIssues: ['still missing more'],
          nonBlockingIssues: [],
          reviewSummary: 'Still needs fix',
          nextAction: 'fix',
          fixTask: 'add more tests',
        }),
        REAL_REPO_ENABLE_REVIEWER_FIX_LOOP: '1',
        REAL_REPO_REVIEWER_MAX_FIX_ATTEMPTS: '1',
        RUNS_DIR: runsDir,
      });
      assert.notStrictEqual(result.status, 0, `Expected failure: ${result.stderr}`);
      writeFileSync('d:/AI orchestrator/tmp/debug2.json', JSON.stringify({ stderr: result.stderr }, null, 2), 'utf-8');
      assert(result.stderr.includes('max fix attempts reached'), `Should report max attempts reached: ${result.stderr}`);
      assert.strictEqual(getGitLogCount(repoPath), beforeLogCount + 2, 'Should create original and one fix commit only');

      const state = loadStateFromPath(runsDir, taskId) as Record<string, unknown>;
      const secondReview = state.reviewer_fix_task_second_review as Record<string, unknown>;
      assert(secondReview !== undefined);
      assert.strictEqual(secondReview.finalStatus, 'fix_required');
      assert.strictEqual(secondReview.nextAction, 'manual_followup');
      const secondGate = secondReview.reviewerGate as Record<string, unknown>;
      assert.strictEqual(secondGate.status, 'fix_required');

      const rbr = secondReview.reviewerBlockReviewResult as Record<string, unknown>;
      assert(rbr !== undefined, 'Should persist reviewerBlockReviewResult from second gate');
      const resolutionPlan = rbr.resolutionPlan as Record<string, unknown>;
      assert.strictEqual(resolutionPlan.action, 'block_for_human', 'Second reject resolutionPlan should be block_for_human due to max attempts');
    } finally {
      cleanup();
    }
  });

  test('with REAL_REPO_ENABLE_REVIEWER_FIX_LOOP=1 second reviewer block_for_human stops fix loop', () => {
    const { taskId, tasksFilePath, repoPath, originPath, runsDir, cleanup } = createTempEnv();
    try {
      const beforeLogCount = getGitLogCount(repoPath);
      const result = runCli(['real-repo-run-ai', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_PROVIDER: 'true',
        ALLOW_REAL_REPO_APPLY: 'true',
        ALLOW_REAL_REPO_COMMIT: 'true',
        ALLOW_REAL_REPO_PUSH: 'true',
        KIMI_API_KEY: 'fake',
        KIMI_BASE_URL: 'http://localhost:9999',
        KIMI_FAKE_RESPONSE: buildFakeKimiOutput([{ path: 'README.md', content: '# modified\n' }]),
        REAL_REPO_REVIEWER_FAKE_RESPONSE: JSON.stringify({
          decision: 'reject',
          confidence: 'high',
          blockingIssues: ['missing fix'],
          nonBlockingIssues: [],
          reviewSummary: 'Needs fix',
          nextAction: 'fix',
          fixTask: 'add fix.txt',
        }),
        REAL_REPO_REVIEWER_FIX_TASK_KIMI_FAKE_RESPONSE: buildFakeKimiOutput([
          { path: 'fix.txt', content: 'fix applied\n' },
        ]),
        REAL_REPO_REVIEWER_SECOND_FAKE_RESPONSE: JSON.stringify({
          decision: 'block_for_human',
          confidence: 'high',
          blockingIssues: ['human review required'],
          nonBlockingIssues: [],
          reviewSummary: 'Block',
          nextAction: 'block',
        }),
        REAL_REPO_ENABLE_REVIEWER_FIX_LOOP: '1',
        RUNS_DIR: runsDir,
      });
      assert.notStrictEqual(result.status, 0, `Expected failure: ${result.stderr}`);
      assert.strictEqual(getGitLogCount(repoPath), beforeLogCount + 2, 'Should create original and one fix commit only');

      const state = loadStateFromPath(runsDir, taskId) as Record<string, unknown>;
      const secondReview = state.reviewer_fix_task_second_review as Record<string, unknown>;
      assert(secondReview !== undefined);
      assert.strictEqual(secondReview.finalStatus, 'blocked');
      assert.strictEqual(secondReview.nextAction, 'block');
      const secondGate = secondReview.reviewerGate as Record<string, unknown>;
      assert.strictEqual(secondGate.status, 'blocked');

      const rbr = secondReview.reviewerBlockReviewResult as Record<string, unknown>;
      assert(rbr !== undefined, 'Should persist reviewerBlockReviewResult from second gate');
      const blockDecision = rbr.blockDecision as Record<string, unknown>;
      const actionPlan = blockDecision.actionPlan as Record<string, unknown>;
      assert.strictEqual(actionPlan.action, 'block_for_human', 'Second block actionPlan should be block_for_human');
      const resolutionPlan = rbr.resolutionPlan as Record<string, unknown>;
      assert.strictEqual(resolutionPlan.action, 'block_for_human', 'Second block resolutionPlan should be block_for_human');
    } finally {
      cleanup();
    }
  });

  test('with REAL_REPO_ENABLE_REVIEWER_FIX_LOOP=1 fix execution guardrails failure blocks safely', () => {
    const { taskId, tasksFilePath, repoPath, originPath, runsDir, cleanup } = createTempEnv();
    try {
      const beforeLogCount = getGitLogCount(repoPath);
      const result = runCli(['real-repo-run-ai', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_PROVIDER: 'true',
        ALLOW_REAL_REPO_APPLY: 'true',
        ALLOW_REAL_REPO_COMMIT: 'true',
        ALLOW_REAL_REPO_PUSH: 'true',
        KIMI_API_KEY: 'fake',
        KIMI_BASE_URL: 'http://localhost:9999',
        KIMI_FAKE_RESPONSE: buildFakeKimiOutput([{ path: 'README.md', content: '# modified\n' }]),
        REAL_REPO_REVIEWER_FAKE_RESPONSE: JSON.stringify({
          decision: 'reject',
          confidence: 'high',
          blockingIssues: ['missing fix'],
          nonBlockingIssues: [],
          reviewSummary: 'Needs fix',
          nextAction: 'fix',
          fixTask: 'add fix.txt',
        }),
        REAL_REPO_REVIEWER_FIX_TASK_KIMI_FAKE_RESPONSE: buildFakeKimiOutput([
          { path: '.env', content: 'SECRET=sk-fake-env-secret\n' },
        ]),
        REAL_REPO_ENABLE_REVIEWER_FIX_LOOP: '1',
        RUNS_DIR: runsDir,
      });
      assert.notStrictEqual(result.status, 0, `Expected failure: ${result.stderr}`);
      assert.strictEqual(getGitLogCount(repoPath), beforeLogCount + 1, 'Should not create fix commit on guardrails failure');

      const state = loadStateFromPath(runsDir, taskId) as Record<string, unknown>;
      const controlledRun = state.reviewer_fix_task_controlled_run as Record<string, unknown>;
      assert(controlledRun !== undefined);
      assert.strictEqual(controlledRun.runnerResultStatus, 'blocked');
      assert.strictEqual((state as Record<string, unknown>).reviewer_fix_task_second_review, undefined, 'Should not run second review when fix execution blocked');

      const combinedOutput = result.stdout + result.stderr;
      assert(!combinedOutput.includes('sk-fake-env-secret'), 'Should not leak env secret in output');
      const stateRaw = JSON.stringify(state);
      assert(!stateRaw.includes('sk-fake-env-secret'), 'Should not leak env secret in state');
    } finally {
      cleanup();
    }
  });

  test('with REAL_REPO_ENABLE_REVIEWER_FIX_LOOP=1 reviewer accept does not execute fix task', () => {
    const { taskId, tasksFilePath, repoPath, originPath, runsDir, cleanup } = createTempEnv();
    try {
      const beforeLogCount = getGitLogCount(repoPath);
      const result = runCli(['real-repo-run-ai', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_PROVIDER: 'true',
        ALLOW_REAL_REPO_APPLY: 'true',
        ALLOW_REAL_REPO_COMMIT: 'true',
        ALLOW_REAL_REPO_PUSH: 'true',
        KIMI_API_KEY: 'fake',
        KIMI_BASE_URL: 'http://localhost:9999',
        KIMI_FAKE_RESPONSE: buildFakeKimiOutput([{ path: 'README.md', content: '# modified\n' }]),
        REAL_REPO_REVIEWER_FAKE_RESPONSE: JSON.stringify({
          decision: 'accept',
          confidence: 'high',
          blockingIssues: [],
          nonBlockingIssues: [],
          reviewSummary: 'Looks good',
          nextAction: 'continue',
        }),
        REAL_REPO_ENABLE_REVIEWER_FIX_LOOP: '1',
        RUNS_DIR: runsDir,
      });
      assert.strictEqual(result.status, 0, `Expected success: ${result.stderr}`);
      assert.strictEqual(getGitLogCount(repoPath), beforeLogCount + 1, 'Should create only original commit');
      const state = loadStateFromPath(runsDir, taskId) as Record<string, unknown>;
      assert.strictEqual((state as Record<string, unknown>).reviewer_fix_task_controlled_run, undefined);
      assert.strictEqual((state as Record<string, unknown>).reviewer_fix_task_second_review, undefined);
    } finally {
      cleanup();
    }
  });

  test('with REAL_REPO_ENABLE_REVIEWER_FIX_LOOP=1 reviewer block_for_human does not execute fix task', () => {
    const { taskId, tasksFilePath, repoPath, originPath, runsDir, cleanup } = createTempEnv();
    try {
      const beforeLogCount = getGitLogCount(repoPath);
      const result = runCli(['real-repo-run-ai', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_PROVIDER: 'true',
        ALLOW_REAL_REPO_APPLY: 'true',
        ALLOW_REAL_REPO_COMMIT: 'true',
        ALLOW_REAL_REPO_PUSH: 'true',
        KIMI_API_KEY: 'fake',
        KIMI_BASE_URL: 'http://localhost:9999',
        KIMI_FAKE_RESPONSE: buildFakeKimiOutput([{ path: 'README.md', content: '# modified\n' }]),
        REAL_REPO_REVIEWER_FAKE_RESPONSE: JSON.stringify({
          decision: 'block_for_human',
          confidence: 'high',
          blockingIssues: ['human needed'],
          nonBlockingIssues: [],
          reviewSummary: 'Block',
          nextAction: 'block',
        }),
        REAL_REPO_ENABLE_REVIEWER_FIX_LOOP: '1',
        RUNS_DIR: runsDir,
      });
      assert.notStrictEqual(result.status, 0, `Expected failure: ${result.stderr}`);
      assert.strictEqual(getGitLogCount(repoPath), beforeLogCount + 1, 'Should create only original commit');
      const state = loadStateFromPath(runsDir, taskId) as Record<string, unknown>;
      assert.strictEqual((state as Record<string, unknown>).reviewer_fix_task_controlled_run, undefined);
      assert.strictEqual((state as Record<string, unknown>).reviewer_fix_task_second_review, undefined);
    } finally {
      cleanup();
    }
  });

  test('with REAL_REPO_ENABLE_REVIEWER_FIX_LOOP=1 reviewer parser failure does not execute fix task', () => {
    const { taskId, tasksFilePath, repoPath, originPath, runsDir, cleanup } = createTempEnv();
    try {
      const beforeLogCount = getGitLogCount(repoPath);
      const result = runCli(['real-repo-run-ai', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_PROVIDER: 'true',
        ALLOW_REAL_REPO_APPLY: 'true',
        ALLOW_REAL_REPO_COMMIT: 'true',
        ALLOW_REAL_REPO_PUSH: 'true',
        KIMI_API_KEY: 'fake',
        KIMI_BASE_URL: 'http://localhost:9999',
        KIMI_FAKE_RESPONSE: buildFakeKimiOutput([{ path: 'README.md', content: '# modified\n' }]),
        REAL_REPO_REVIEWER_FAKE_RESPONSE: 'not valid json with sk-fake-key',
        REAL_REPO_ENABLE_REVIEWER_FIX_LOOP: '1',
        RUNS_DIR: runsDir,
      });
      assert.notStrictEqual(result.status, 0, `Expected failure: ${result.stderr}`);
      assert.strictEqual(getGitLogCount(repoPath), beforeLogCount + 1, 'Should create only original commit');
      const state = loadStateFromPath(runsDir, taskId) as Record<string, unknown>;
      assert.strictEqual((state as Record<string, unknown>).reviewer_fix_task_controlled_run, undefined);
      assert.strictEqual((state as Record<string, unknown>).reviewer_fix_task_second_review, undefined);
    } finally {
      cleanup();
    }
  });

  test('with REAL_REPO_ENABLE_REVIEWER_FIX_LOOP=1 reviewer provider error does not execute fix task', () => {
    const { taskId, tasksFilePath, repoPath, originPath, runsDir, cleanup } = createTempEnv();
    try {
      const beforeLogCount = getGitLogCount(repoPath);
      const result = runCli(['real-repo-run-ai', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_PROVIDER: 'true',
        ALLOW_REAL_REPO_APPLY: 'true',
        ALLOW_REAL_REPO_COMMIT: 'true',
        ALLOW_REAL_REPO_PUSH: 'true',
        KIMI_API_KEY: 'fake',
        KIMI_BASE_URL: 'http://localhost:9999',
        KIMI_FAKE_RESPONSE: buildFakeKimiOutput([{ path: 'README.md', content: '# modified\n' }]),
        REAL_REPO_REVIEWER_FAKE_RESPONSE: JSON.stringify({
          decision: 'accept',
          confidence: 'high',
          blockingIssues: [],
          nonBlockingIssues: [],
          reviewSummary: 'Looks good',
          nextAction: 'continue',
        }),
        REAL_REPO_REVIEWER_FORCE_PROVIDER_ERROR: 'true',
        REAL_REPO_ENABLE_REVIEWER_FIX_LOOP: '1',
        RUNS_DIR: runsDir,
      });
      assert.notStrictEqual(result.status, 0, `Expected failure: ${result.stderr}`);
      assert.strictEqual(getGitLogCount(repoPath), beforeLogCount + 1, 'Should create only original commit');
      const state = loadStateFromPath(runsDir, taskId) as Record<string, unknown>;
      assert.strictEqual((state as Record<string, unknown>).reviewer_fix_task_controlled_run, undefined);
      assert.strictEqual((state as Record<string, unknown>).reviewer_fix_task_second_review, undefined);
    } finally {
      cleanup();
    }
  });

  test('fix-loop state redacts secrets in reviewer and executor output', () => {
    const { taskId, tasksFilePath, repoPath, originPath, runsDir, cleanup } = createTempEnv();
    try {
      runCli(['real-repo-run-ai', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_PROVIDER: 'true',
        ALLOW_REAL_REPO_APPLY: 'true',
        ALLOW_REAL_REPO_COMMIT: 'true',
        ALLOW_REAL_REPO_PUSH: 'true',
        KIMI_API_KEY: 'fake',
        KIMI_BASE_URL: 'http://localhost:9999',
        KIMI_FAKE_RESPONSE: buildFakeKimiOutput([{ path: 'README.md', content: '# modified\n' }]),
        REAL_REPO_REVIEWER_FAKE_RESPONSE: JSON.stringify({
          decision: 'reject',
          confidence: 'high',
          blockingIssues: ['sk-fake-reviewer-secret'],
          nonBlockingIssues: [],
          reviewSummary: 'Needs fix with Bearer fake-reviewer-token',
          nextAction: 'fix',
          fixTask: 'use api_key=fake-key',
        }),
        REAL_REPO_REVIEWER_FIX_TASK_KIMI_FAKE_RESPONSE: buildFakeKimiOutput(
          [{ path: 'fix.txt', content: 'fix applied\n' }],
          'used sk-fake-fix-secret'
        ),
        REAL_REPO_REVIEWER_SECOND_FAKE_RESPONSE: JSON.stringify({
          decision: 'accept',
          confidence: 'high',
          blockingIssues: [],
          nonBlockingIssues: [],
          reviewSummary: 'Looks good',
          nextAction: 'continue',
        }),
        REAL_REPO_ENABLE_REVIEWER_FIX_LOOP: '1',
        RUNS_DIR: runsDir,
      });
      const stateRaw = readFileSync(join(runsDir, taskId, 'state.json'), 'utf-8');
      assert(!stateRaw.includes('sk-fake-reviewer-secret'), 'Should not leak sk secret');
      assert(!stateRaw.includes('Bearer fake-reviewer-token'), 'Should not leak Bearer token');
      assert(!stateRaw.includes('api_key=fake-key'), 'Should not leak api_key');
      assert(!stateRaw.includes('sk-fake-fix-secret'), 'Should not leak fix provider secret');
    } finally {
      cleanup();
    }
  });

  function buildKimiReviewerResponse(decision: 'accepted' | 'rejected' | 'block_for_human', nextAction: string, opts: { blocking?: string[]; summary?: string; fixTask?: string | null } = {}): string {
    const blocking = opts.blocking ?? [];
    return JSON.stringify({
      decision,
      confidence: 'high',
      blocking_issues: blocking,
      non_blocking_issues: [],
      review_summary: opts.summary ?? 'review',
      fix_task: opts.fixTask === undefined ? null : opts.fixTask,
      next_action: nextAction,
    });
  }

  test('fix executor accepts ALLOW_REAL_PROVIDER=1 and fake second reviewer accepts', () => {
    const { taskId, tasksFilePath, repoPath, originPath, runsDir, cleanup } = createTempEnv();
    try {
      const beforeLogCount = getGitLogCount(repoPath);
      const result = runCli(['real-repo-run-ai', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_PROVIDER: '1',
        ALLOW_REAL_REPO_APPLY: 'true',
        ALLOW_REAL_REPO_COMMIT: 'true',
        ALLOW_REAL_REPO_PUSH: 'true',
        KIMI_API_KEY: 'fake',
        KIMI_BASE_URL: 'http://localhost:9999',
        KIMI_FAKE_RESPONSE: buildFakeKimiOutput([{ path: 'README.md', content: '# modified\n' }]),
        REAL_REPO_REVIEWER_FAKE_RESPONSE: JSON.stringify({
          decision: 'reject',
          confidence: 'high',
          blockingIssues: ['missing fix'],
          nonBlockingIssues: [],
          reviewSummary: 'Needs fix',
          nextAction: 'fix',
          fixTask: 'add fix.txt',
        }),
        REAL_REPO_REVIEWER_FIX_TASK_KIMI_FAKE_RESPONSE: buildFakeKimiOutput([{ path: 'fix.txt', content: 'fix applied\n' }]),
        REAL_REPO_REVIEWER_SECOND_FAKE_RESPONSE: JSON.stringify({
          decision: 'accept',
          confidence: 'high',
          blockingIssues: [],
          nonBlockingIssues: [],
          reviewSummary: 'Fix looks good',
          nextAction: 'continue',
        }),
        REAL_REPO_ENABLE_REVIEWER_FIX_LOOP: '1',
        RUNS_DIR: runsDir,
      });
      assert.strictEqual(result.status, 0, `Expected success: ${result.stderr}`);
      assert.strictEqual(getGitLogCount(repoPath), beforeLogCount + 2, 'Should create original and fix commits');
      const state = loadStateFromPath(runsDir, taskId) as Record<string, unknown>;
      const secondReview = state.reviewer_fix_task_second_review as Record<string, unknown>;
      assert(secondReview !== undefined);
      assert.strictEqual(secondReview.finalStatus, 'accepted');
      const secondGate = secondReview.reviewerGate as Record<string, unknown>;
      assert.strictEqual(secondGate.status, 'accepted');
    } finally {
      cleanup();
    }
  });

  test('real second reviewer accept path with mocked Kimi transport exits 0', () => {
    const { taskId, tasksFilePath, repoPath, originPath, runsDir, cleanup } = createTempEnv();
    try {
      const beforeLogCount = getGitLogCount(repoPath);
      const result = runCli(['real-repo-run-ai', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_PROVIDER: 'true',
        ALLOW_REAL_REPO_APPLY: 'true',
        ALLOW_REAL_REPO_COMMIT: 'true',
        ALLOW_REAL_REPO_PUSH: 'true',
        REAL_REPO_REVIEWER_NO_DEFAULT: '1',
        KIMI_API_KEY: 'fake',
        KIMI_BASE_URL: 'http://localhost:9999',
        KIMI_FAKE_RESPONSE: buildFakeKimiOutput([{ path: 'README.md', content: '# modified\n' }]),
        KIMI_FAKE_REVIEWER_RESPONSE: buildKimiReviewerResponse('rejected', 'send_fix_to_coder', {
          blocking: ['missing fix'],
          summary: 'Needs fix',
          fixTask: 'add fix.txt',
        }),
        REAL_REPO_REVIEWER_FIX_TASK_KIMI_FAKE_RESPONSE: buildFakeKimiOutput([{ path: 'fix.txt', content: 'fix applied\n' }]),
        REAL_REPO_REVIEWER_SECOND_KIMI_FAKE_RESPONSE: buildKimiReviewerResponse('accepted', 'advance_to_next_task', {
          summary: 'Fix accepted',
        }),
        REAL_REPO_ENABLE_REVIEWER_FIX_LOOP: '1',
        RUNS_DIR: runsDir,
      });
      assert.strictEqual(result.status, 0, `Expected success: ${result.stderr}`);
      assert(result.stderr.includes('Reviewer fix-loop completed'), `Should report fix-loop completion: ${result.stderr}`);
      assert.strictEqual(getGitLogCount(repoPath), beforeLogCount + 2, 'Should create original and fix commits');

      const state = loadStateFromPath(runsDir, taskId) as Record<string, unknown>;
      const secondReview = state.reviewer_fix_task_second_review as Record<string, unknown>;
      assert(secondReview !== undefined, 'Should persist second review');
      assert.strictEqual(secondReview.attempt, 1);
      const fixCommitSha = secondReview.fixCommitSha as string;
      assert(typeof fixCommitSha === 'string' && fixCommitSha.length === 40, `Fix commit SHA should be 40 chars`);
      assert.notStrictEqual(fixCommitSha, state.commit_sha, 'Fix commit should differ from original commit');
      assert.strictEqual(secondReview.finalStatus, 'accepted');
      assert.strictEqual(secondReview.nextAction, 'continue');

      const secondGate = secondReview.reviewerGate as Record<string, unknown>;
      assert.strictEqual(secondGate.status, 'accepted');
      assert.strictEqual(secondGate.source, 'reviewer');
      assert.strictEqual(secondGate.nextAction, 'continue');

      const rbr = secondReview.reviewerBlockReviewResult as Record<string, unknown>;
      const actionPlan = (rbr.blockDecision as Record<string, unknown>).actionPlan as Record<string, unknown>;
      assert.strictEqual(actionPlan.action, 'continue', 'Second review actionPlan should be continue');
    } finally {
      cleanup();
    }
  });

  test('real second reviewer reject path continues to next fix attempt and stops at max', () => {
    const { taskId, tasksFilePath, repoPath, originPath, runsDir, cleanup } = createTempEnv();
    try {
      const beforeLogCount = getGitLogCount(repoPath);
      const result = runCli(['real-repo-run-ai', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_PROVIDER: 'true',
        ALLOW_REAL_REPO_APPLY: 'true',
        ALLOW_REAL_REPO_COMMIT: 'true',
        ALLOW_REAL_REPO_PUSH: 'true',
        REAL_REPO_REVIEWER_NO_DEFAULT: '1',
        KIMI_API_KEY: 'fake',
        KIMI_BASE_URL: 'http://localhost:9999',
        KIMI_FAKE_RESPONSE: buildFakeKimiOutput([{ path: 'README.md', content: '# modified\n' }]),
        KIMI_FAKE_REVIEWER_RESPONSE: buildKimiReviewerResponse('rejected', 'send_fix_to_coder', {
          blocking: ['missing fix'],
          summary: 'Needs fix',
          fixTask: 'add fix.txt',
        }),
        REAL_REPO_REVIEWER_FIX_TASK_KIMI_FAKE_RESPONSES: JSON.stringify([
          buildFakeKimiOutput([{ path: 'fix.txt', content: 'fix attempt 1\n' }]),
          buildFakeKimiOutput([{ path: 'fix.txt', content: 'fix attempt 2\n' }]),
        ]),
        REAL_REPO_REVIEWER_SECOND_KIMI_FAKE_RESPONSE: buildKimiReviewerResponse('rejected', 'send_fix_to_coder', {
          blocking: ['still missing'],
          summary: 'Still needs fix',
          fixTask: 'add more',
        }),
        REAL_REPO_ENABLE_REVIEWER_FIX_LOOP: '1',
        REAL_REPO_REVIEWER_MAX_FIX_ATTEMPTS: '2',
        RUNS_DIR: runsDir,
      });
      assert.notStrictEqual(result.status, 0, `Expected failure: ${result.stderr}`);
      assert(result.stderr.includes('max fix attempts reached'), `Should report max attempts reached: ${result.stderr}`);
      assert.strictEqual(getGitLogCount(repoPath), beforeLogCount + 3, 'Should create original + two fix commits');

      const state = loadStateFromPath(runsDir, taskId) as Record<string, unknown>;
      const secondReview = state.reviewer_fix_task_second_review as Record<string, unknown>;
      assert(secondReview !== undefined);
      assert.strictEqual(secondReview.attempt, 2);
      assert.strictEqual(secondReview.finalStatus, 'fix_required');
      assert.strictEqual(secondReview.nextAction, 'manual_followup');

      const secondGate = secondReview.reviewerGate as Record<string, unknown>;
      assert.strictEqual(secondGate.status, 'fix_required');
      assert.strictEqual(secondGate.source, 'reviewer');

      const rbr = secondReview.reviewerBlockReviewResult as Record<string, unknown>;
      const resolutionPlan = rbr.resolutionPlan as Record<string, unknown>;
      assert.strictEqual(resolutionPlan.action, 'block_for_human', 'Max attempts should resolve to block_for_human');
    } finally {
      cleanup();
    }
  });

  test('real second reviewer block_for_human stops fix loop without another fix attempt', () => {
    const { taskId, tasksFilePath, repoPath, originPath, runsDir, cleanup } = createTempEnv();
    try {
      const beforeLogCount = getGitLogCount(repoPath);
      const result = runCli(['real-repo-run-ai', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_PROVIDER: 'true',
        ALLOW_REAL_REPO_APPLY: 'true',
        ALLOW_REAL_REPO_COMMIT: 'true',
        ALLOW_REAL_REPO_PUSH: 'true',
        REAL_REPO_REVIEWER_NO_DEFAULT: '1',
        KIMI_API_KEY: 'fake',
        KIMI_BASE_URL: 'http://localhost:9999',
        KIMI_FAKE_RESPONSE: buildFakeKimiOutput([{ path: 'README.md', content: '# modified\n' }]),
        KIMI_FAKE_REVIEWER_RESPONSE: buildKimiReviewerResponse('rejected', 'send_fix_to_coder', {
          blocking: ['missing fix'],
          summary: 'Needs fix',
          fixTask: 'add fix.txt',
        }),
        REAL_REPO_REVIEWER_FIX_TASK_KIMI_FAKE_RESPONSE: buildFakeKimiOutput([{ path: 'fix.txt', content: 'fix applied\n' }]),
        REAL_REPO_REVIEWER_SECOND_KIMI_FAKE_RESPONSE: buildKimiReviewerResponse('rejected', 'block_for_human', {
          blocking: ['human review required'],
          summary: 'Blocked',
        }),
        REAL_REPO_ENABLE_REVIEWER_FIX_LOOP: '1',
        RUNS_DIR: runsDir,
      });
      assert.notStrictEqual(result.status, 0, `Expected failure: ${result.stderr}`);
      assert.strictEqual(getGitLogCount(repoPath), beforeLogCount + 2, 'Should create original + one fix commit');

      const state = loadStateFromPath(runsDir, taskId) as Record<string, unknown>;
      const secondReview = state.reviewer_fix_task_second_review as Record<string, unknown>;
      assert(secondReview !== undefined);
      assert.strictEqual(secondReview.finalStatus, 'blocked');
      assert.strictEqual(secondReview.nextAction, 'block');

      const secondGate = secondReview.reviewerGate as Record<string, unknown>;
      assert.strictEqual(secondGate.status, 'blocked');
      assert.strictEqual(secondGate.nextAction, 'block');

      const rbr = secondReview.reviewerBlockReviewResult as Record<string, unknown>;
      const resolutionPlan = rbr.resolutionPlan as Record<string, unknown>;
      assert.strictEqual(resolutionPlan.action, 'block_for_human');
    } finally {
      cleanup();
    }
  });

  test('real second reviewer invalid JSON exits non-zero with provider block', () => {
    const { taskId, tasksFilePath, repoPath, originPath, runsDir, cleanup } = createTempEnv();
    try {
      const beforeLogCount = getGitLogCount(repoPath);
      const result = runCli(['real-repo-run-ai', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_PROVIDER: 'true',
        ALLOW_REAL_REPO_APPLY: 'true',
        ALLOW_REAL_REPO_COMMIT: 'true',
        ALLOW_REAL_REPO_PUSH: 'true',
        REAL_REPO_REVIEWER_NO_DEFAULT: '1',
        KIMI_API_KEY: 'fake',
        KIMI_BASE_URL: 'http://localhost:9999',
        KIMI_FAKE_RESPONSE: buildFakeKimiOutput([{ path: 'README.md', content: '# modified\n' }]),
        KIMI_FAKE_REVIEWER_RESPONSE: buildKimiReviewerResponse('rejected', 'send_fix_to_coder', {
          blocking: ['missing fix'],
          summary: 'Needs fix',
          fixTask: 'add fix.txt',
        }),
        REAL_REPO_REVIEWER_FIX_TASK_KIMI_FAKE_RESPONSE: buildFakeKimiOutput([{ path: 'fix.txt', content: 'fix applied\n' }]),
        REAL_REPO_REVIEWER_SECOND_KIMI_FAKE_RESPONSE: 'not-json sk-fake-second-invalid',
        REAL_REPO_ENABLE_REVIEWER_FIX_LOOP: '1',
        RUNS_DIR: runsDir,
      });
      assert.notStrictEqual(result.status, 0, `Expected failure: ${result.stderr}`);
      assert.strictEqual(getGitLogCount(repoPath), beforeLogCount + 2, 'Should create original + fix commit');

      const state = loadStateFromPath(runsDir, taskId) as Record<string, unknown>;
      const secondReview = state.reviewer_fix_task_second_review as Record<string, unknown>;
      assert(secondReview !== undefined);
      assert.strictEqual(secondReview.finalStatus, 'blocked');

      const secondGate = secondReview.reviewerGate as Record<string, unknown>;
      assert.strictEqual(secondGate.status, 'blocked');
      assert.strictEqual(secondGate.source, 'provider');

      const combined = result.stdout + result.stderr;
      assert(!combined.includes('sk-fake-second-invalid'), 'Should not leak invalid JSON secret in output');
      const stateRaw = JSON.stringify(state);
      assert(!stateRaw.includes('sk-fake-second-invalid'), 'Should not leak invalid JSON secret in state');
    } finally {
      cleanup();
    }
  });

  test('real second reviewer invalid schema exits non-zero with provider block', () => {
    const { taskId, tasksFilePath, repoPath, originPath, runsDir, cleanup } = createTempEnv();
    try {
      const beforeLogCount = getGitLogCount(repoPath);
      const result = runCli(['real-repo-run-ai', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_PROVIDER: 'true',
        ALLOW_REAL_REPO_APPLY: 'true',
        ALLOW_REAL_REPO_COMMIT: 'true',
        ALLOW_REAL_REPO_PUSH: 'true',
        REAL_REPO_REVIEWER_NO_DEFAULT: '1',
        KIMI_API_KEY: 'fake',
        KIMI_BASE_URL: 'http://localhost:9999',
        KIMI_FAKE_RESPONSE: buildFakeKimiOutput([{ path: 'README.md', content: '# modified\n' }]),
        KIMI_FAKE_REVIEWER_RESPONSE: buildKimiReviewerResponse('rejected', 'send_fix_to_coder', {
          blocking: ['missing fix'],
          summary: 'Needs fix',
          fixTask: 'add fix.txt',
        }),
        REAL_REPO_REVIEWER_FIX_TASK_KIMI_FAKE_RESPONSE: buildFakeKimiOutput([{ path: 'fix.txt', content: 'fix applied\n' }]),
        REAL_REPO_REVIEWER_SECOND_KIMI_FAKE_RESPONSE: JSON.stringify({
          decision: 'accepted',
          confidence: 'high',
          blocking_issues: ['should be empty for accepted'],
          non_blocking_issues: [],
          review_summary: 'Invalid accepted',
          fix_task: null,
          next_action: 'advance_to_next_task',
        }),
        REAL_REPO_ENABLE_REVIEWER_FIX_LOOP: '1',
        RUNS_DIR: runsDir,
      });
      assert.notStrictEqual(result.status, 0, `Expected failure: ${result.stderr}`);
      assert.strictEqual(getGitLogCount(repoPath), beforeLogCount + 2, 'Should create original + fix commit');

      const state = loadStateFromPath(runsDir, taskId) as Record<string, unknown>;
      const secondReview = state.reviewer_fix_task_second_review as Record<string, unknown>;
      assert(secondReview !== undefined);
      assert.strictEqual(secondReview.finalStatus, 'blocked');

      const secondGate = secondReview.reviewerGate as Record<string, unknown>;
      assert.strictEqual(secondGate.status, 'blocked');
      assert.strictEqual(secondGate.source, 'provider');
    } finally {
      cleanup();
    }
  });

  test('real second reviewer provider error exits non-zero with provider block and no token leak', () => {
    const { taskId, tasksFilePath, repoPath, originPath, runsDir, cleanup } = createTempEnv();
    try {
      const beforeLogCount = getGitLogCount(repoPath);
      const result = runCli(['real-repo-run-ai', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_PROVIDER: 'true',
        ALLOW_REAL_REPO_APPLY: 'true',
        ALLOW_REAL_REPO_COMMIT: 'true',
        ALLOW_REAL_REPO_PUSH: 'true',
        REAL_REPO_REVIEWER_NO_DEFAULT: '1',
        KIMI_API_KEY: 'fake',
        KIMI_BASE_URL: 'http://localhost:9999',
        KIMI_FAKE_RESPONSE: buildFakeKimiOutput([{ path: 'README.md', content: '# modified\n' }]),
        KIMI_FAKE_REVIEWER_RESPONSE: buildKimiReviewerResponse('rejected', 'send_fix_to_coder', {
          blocking: ['missing fix'],
          summary: 'Needs fix',
          fixTask: 'add fix.txt',
        }),
        REAL_REPO_REVIEWER_FIX_TASK_KIMI_FAKE_RESPONSE: buildFakeKimiOutput([{ path: 'fix.txt', content: 'fix applied\n' }]),
        REAL_REPO_REVIEWER_SECOND_KIMI_FAKE_RESPONSE: buildKimiReviewerResponse('accepted', 'advance_to_next_task'),
        REAL_REPO_REVIEWER_SECOND_FORCE_PROVIDER_ERROR: 'true',
        REAL_REPO_ENABLE_REVIEWER_FIX_LOOP: '1',
        RUNS_DIR: runsDir,
      });
      assert.notStrictEqual(result.status, 0, `Expected failure: ${result.stderr}`);
      assert.strictEqual(getGitLogCount(repoPath), beforeLogCount + 2, 'Should create original + fix commit');

      const state = loadStateFromPath(runsDir, taskId) as Record<string, unknown>;
      const secondReview = state.reviewer_fix_task_second_review as Record<string, unknown>;
      assert(secondReview !== undefined);
      assert.strictEqual(secondReview.finalStatus, 'blocked');

      const secondGate = secondReview.reviewerGate as Record<string, unknown>;
      assert.strictEqual(secondGate.status, 'blocked');
      assert.strictEqual(secondGate.source, 'provider');
      assert((secondGate.blockingIssues as string[]).some((i) => i.includes('Forced second reviewer provider error')));
    } finally {
      cleanup();
    }
  });

  test('real second reviewer input capture includes fix commit fields', () => {
    const { taskId, tasksFilePath, repoPath, originPath, runsDir, cleanup } = createTempEnv();
    const captureFile = join(runsDir, 'second-reviewer-input-capture.json');
    try {
      const result = runCli(['real-repo-run-ai', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_PROVIDER: 'true',
        ALLOW_REAL_REPO_APPLY: 'true',
        ALLOW_REAL_REPO_COMMIT: 'true',
        ALLOW_REAL_REPO_PUSH: 'true',
        REAL_REPO_REVIEWER_NO_DEFAULT: '1',
        KIMI_API_KEY: 'fake',
        KIMI_BASE_URL: 'http://localhost:9999',
        KIMI_FAKE_RESPONSE: buildFakeKimiOutput([{ path: 'README.md', content: '# modified\n' }]),
        KIMI_FAKE_REVIEWER_RESPONSE: buildKimiReviewerResponse('rejected', 'send_fix_to_coder', {
          blocking: ['missing fix'],
          summary: 'Needs fix',
          fixTask: 'add fix.txt',
        }),
        REAL_REPO_REVIEWER_FIX_TASK_KIMI_FAKE_RESPONSE: buildFakeKimiOutput([{ path: 'fix.txt', content: 'fix applied\n' }]),
        REAL_REPO_REVIEWER_SECOND_KIMI_FAKE_RESPONSE: buildKimiReviewerResponse('accepted', 'advance_to_next_task'),
        REAL_REPO_REVIEWER_CAPTURE_INPUT_FILE: captureFile,
        REAL_REPO_ENABLE_REVIEWER_FIX_LOOP: '1',
        RUNS_DIR: runsDir,
      });
      assert.strictEqual(result.status, 0, `Expected success: ${result.stderr}`);
      assert(existsSync(captureFile), 'Second reviewer capture file should exist');
      const captured = JSON.parse(readFileSync(captureFile, 'utf-8'));
      assert.strictEqual(captured.repoPath, repoPath.replace(/\\/g, '/'), 'Should include repo path');
      assert.strictEqual(captured.taskId, `fix-${taskId}-reviewer-1`, 'Should include fix task id');
      assert.strictEqual(captured.taskGoal, 'add fix.txt', 'Should include fix task goal');
      assert.strictEqual(captured.branchName, `ai/${taskId}`, 'Should include branch name');
      assert(typeof captured.commitSha === 'string' && captured.commitSha.length === 40, 'Should include full fix commit SHA');
      assert(Array.isArray(captured.changedFiles) && captured.changedFiles.includes('fix.txt'), 'Should include changed files');
      assert(typeof captured.checkSummary === 'object' && captured.checkSummary !== null, 'Should include check summary');
      assert.strictEqual(captured.stateStatus, 'fix_review', 'Should include fix_review state status');
      assert(typeof captured.safety === 'object' && captured.safety !== null, 'Should include safety flags');
      assert.strictEqual(captured.safety.commitShaIsFullLength, true);
      assert.strictEqual(captured.safety.branchIsNotMain, true);
      assert.strictEqual(captured.safety.hasChangedFiles, true);
    } finally {
      cleanup();
    }
  });

  function getRepoLockPath(repoPath: string, workBranch: string, runsDir: string): string {
    return getRepoRunLockPath(repoPath, workBranch, runsDir);
  }

  function writeRepoLock(lockPath: string, metadata: Record<string, unknown>): void {
    const dir = dirname(lockPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(lockPath, JSON.stringify(metadata, null, 2), 'utf-8');
  }

  function baseRepoEnv(runsDir: string): Record<string, string> {
    return {
      ALLOW_REAL_PROVIDER: 'true',
      ALLOW_REAL_REPO_APPLY: 'true',
      ALLOW_REAL_REPO_COMMIT: 'true',
      ALLOW_REAL_REPO_PUSH: 'true',
      KIMI_API_KEY: 'fake',
      KIMI_BASE_URL: 'http://localhost:9999',
      RUNS_DIR: runsDir,
    };
  }

  test('repo run creates and releases lock on success', () => {
    const { taskId, tasksFilePath, repoPath, runsDir, cleanup } = createTempEnv();
    try {
      const lockPath = getRepoLockPath(repoPath, `ai/${taskId}`, runsDir);
      const result = runCli(['real-repo-run-ai', taskId], {
        TASKS_FILE: tasksFilePath,
        ...baseRepoEnv(runsDir),
        KIMI_FAKE_RESPONSE: buildFakeKimiOutput([{ path: 'README.md', content: '# modified\n' }]),
      });
      assert.strictEqual(result.status, 0, `Expected success: ${result.stderr}`);
      assert(!existsSync(lockPath), 'Repo lock should be released after success');
    } finally {
      cleanup();
    }
  });

  test('repo run releases lock after failure', () => {
    const { taskId, tasksFilePath, repoPath, runsDir, cleanup } = createTempEnv();
    try {
      const lockPath = getRepoLockPath(repoPath, `ai/${taskId}`, runsDir);
      const result = runCli(['real-repo-run-ai', taskId], {
        TASKS_FILE: tasksFilePath,
        ...baseRepoEnv(runsDir),
        KIMI_FAKE_RESPONSE: buildFakeKimiOutput([{ path: '.env', content: 'SECRET=1\n' }]),
      });
      assert.notStrictEqual(result.status, 0, `Expected failure: ${result.stderr}`);
      assert(result.stderr.includes('Guardrails failed'), `Expected guardrails failure: ${result.stderr}`);
      assert(!existsSync(lockPath), 'Repo lock should be released after failure');
    } finally {
      cleanup();
    }
  });

  test('repo run refuses if lock exists before provider call', () => {
    const { taskId, tasksFilePath, repoPath, runsDir, cleanup } = createTempEnv();
    try {
      const beforeLog = getGitLogCount(repoPath);
      const lockPath = getRepoLockPath(repoPath, `ai/${taskId}`, runsDir);
      writeRepoLock(lockPath, {
        pid: 99999,
        command: 'real-repo-run-ai',
        repoPath: repoPath.replace(/\\/g, '/'),
        workBranch: `ai/${taskId}`,
        createdAt: new Date().toISOString(),
      });
      const result = runCli(['real-repo-run-ai', taskId], {
        TASKS_FILE: tasksFilePath,
        ...baseRepoEnv(runsDir),
        KIMI_FAKE_RESPONSE: buildFakeKimiOutput([{ path: 'README.md', content: '# modified\n' }]),
      });
      assert.notStrictEqual(result.status, 0, `Expected lock refusal: ${result.stderr}`);
      assert.strictEqual(getGitLogCount(repoPath), beforeLog, 'No commit should be created');

      const output = result.stdout + result.stderr;
      assert(output.includes('Another run appears to be active'), `Expected lock conflict message: ${output}`);
      assert(output.includes('No provider call was made'), `Expected no provider call message: ${output}`);
    } finally {
      cleanup();
    }
  });

  test('repo lock is scoped by repo path and work branch', () => {
    const env1 = createTempEnv();
    try {
      const lockPath1 = getRepoLockPath(env1.repoPath, `ai/${env1.taskId}`, env1.runsDir);
      writeRepoLock(lockPath1, {
        pid: 99999,
        command: 'real-repo-run-ai',
        repoPath: env1.repoPath.replace(/\\/g, '/'),
        workBranch: `ai/${env1.taskId}`,
        createdAt: new Date().toISOString(),
      });
      const result1 = runCli(['real-repo-run-ai', env1.taskId], {
        TASKS_FILE: env1.tasksFilePath,
        ...baseRepoEnv(env1.runsDir),
        KIMI_FAKE_RESPONSE: buildFakeKimiOutput([{ path: 'README.md', content: '# modified\n' }]),
      });
      assert.notStrictEqual(result1.status, 0, `Expected same-repo same-branch conflict: ${result1.stderr}`);
      assert(result1.stderr.includes('Another run appears to be active'), `Expected lock conflict: ${result1.stderr}`);
    } finally {
      env1.cleanup();
    }

    const env2 = createTempEnv();
    try {
      const lockPath2 = getRepoLockPath(env2.repoPath, 'ai/other-branch', env2.runsDir);
      writeRepoLock(lockPath2, {
        pid: 99999,
        command: 'real-repo-run-ai',
        repoPath: env2.repoPath.replace(/\\/g, '/'),
        workBranch: 'ai/other-branch',
        createdAt: new Date().toISOString(),
      });
      const result2 = runCli(['real-repo-run-ai', env2.taskId], {
        TASKS_FILE: env2.tasksFilePath,
        ...baseRepoEnv(env2.runsDir),
        KIMI_FAKE_RESPONSE: buildFakeKimiOutput([{ path: 'README.md', content: '# modified\n' }]),
      });
      assert.strictEqual(result2.status, 0, `Expected success for different branch: ${result2.stderr}`);
    } finally {
      env2.cleanup();
    }

    const env3 = createTempEnv();
    try {
      const foreignRepoPath = '/tmp/foreign-repo-for-lock-test';
      const lockPath3 = getRepoLockPath(foreignRepoPath, `ai/${env3.taskId}`, env3.runsDir);
      writeRepoLock(lockPath3, {
        pid: 99999,
        command: 'real-repo-run-ai',
        repoPath: foreignRepoPath,
        workBranch: `ai/${env3.taskId}`,
        createdAt: new Date().toISOString(),
      });
      const result3 = runCli(['real-repo-run-ai', env3.taskId], {
        TASKS_FILE: env3.tasksFilePath,
        ...baseRepoEnv(env3.runsDir),
        KIMI_FAKE_RESPONSE: buildFakeKimiOutput([{ path: 'README.md', content: '# modified\n' }]),
      });
      assert.strictEqual(result3.status, 0, `Expected success for different repo: ${result3.stderr}`);
    } finally {
      env3.cleanup();
    }
  });

  test('task state save leaves no temp files', () => {
    const { taskId, tasksFilePath, runsDir, cleanup } = createTempEnv();
    try {
      const result = runCli(['real-repo-run-ai', taskId], {
        TASKS_FILE: tasksFilePath,
        ...baseRepoEnv(runsDir),
        KIMI_FAKE_RESPONSE: buildFakeKimiOutput([{ path: 'README.md', content: '# modified\n' }]),
      });
      assert.strictEqual(result.status, 0, `Expected success: ${result.stderr}`);
      const runDir = join(runsDir, taskId);
      const tmpFiles = readdirSync(runDir).filter((name) => name.includes('.tmp.'));
      assert.strictEqual(tmpFiles.length, 0, `Expected no temp files, found: ${tmpFiles.join(', ')}`);
    } finally {
      cleanup();
    }
  });

  // --- Post-push rollback policy (Stage 17.4A) ---

  test('post-push reviewer block preserves original commit and records skipped rollback', () => {
    const { taskId, tasksFilePath, repoPath, originPath, runsDir, cleanup } = createTempEnv();
    try {
      const beforeLogCount = getGitLogCount(repoPath);
      const beforeRemote = getBareRefs(originPath);
      const result = runCli(['real-repo-run-ai', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_PROVIDER: 'true',
        ALLOW_REAL_REPO_APPLY: 'true',
        ALLOW_REAL_REPO_COMMIT: 'true',
        ALLOW_REAL_REPO_PUSH: 'true',
        KIMI_API_KEY: 'fake',
        KIMI_BASE_URL: 'http://localhost:9999',
        KIMI_FAKE_RESPONSE: buildFakeKimiOutput([{ path: 'README.md', content: '# modified\n' }]),
        REAL_REPO_REVIEWER_FAKE_RESPONSE: JSON.stringify({
          decision: 'block_for_human',
          confidence: 'high',
          blockingIssues: ['human review required'],
          nonBlockingIssues: [],
          reviewSummary: 'Block',
          nextAction: 'block',
        }),
        RUNS_DIR: runsDir,
      });
      assert.notStrictEqual(result.status, 0, `Expected failure: ${result.stderr}`);
      assert.strictEqual(getGitLogCount(repoPath), beforeLogCount + 1, 'Should preserve original commit');
      const afterRemote = getBareRefs(originPath);
      assert.notDeepStrictEqual(afterRemote, beforeRemote, 'Original commit should be pushed');
      const state = loadStateFromPath(runsDir, taskId) as Record<string, unknown>;
      assert(state !== null);
      const rollback = state.rollback as Record<string, unknown>;
      assert(rollback !== undefined, 'Should record rollback metadata');
      assert.strictEqual(rollback.status, 'skipped');
      assert.strictEqual(rollback.attempted, false);
      assert.strictEqual(rollback.policy, 'post_push_preserve_for_human');
      assert(typeof rollback.reason === 'string' && rollback.reason.includes('already pushed'), `Expected pushed reason: ${rollback.reason}`);
      assert.strictEqual(state.commit_sha, getHeadSha(repoPath), 'State commit should match preserved HEAD');
    } finally {
      cleanup();
    }
  });

  test('post-push reviewer reject with fix loop disabled preserves original commit and skipped rollback', () => {
    const { taskId, tasksFilePath, repoPath, originPath, runsDir, cleanup } = createTempEnv();
    try {
      const beforeLogCount = getGitLogCount(repoPath);
      const beforeRemote = getBareRefs(originPath);
      const result = runCli(['real-repo-run-ai', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_PROVIDER: 'true',
        ALLOW_REAL_REPO_APPLY: 'true',
        ALLOW_REAL_REPO_COMMIT: 'true',
        ALLOW_REAL_REPO_PUSH: 'true',
        KIMI_API_KEY: 'fake',
        KIMI_BASE_URL: 'http://localhost:9999',
        KIMI_FAKE_RESPONSE: buildFakeKimiOutput([{ path: 'README.md', content: '# modified\n' }]),
        REAL_REPO_REVIEWER_FAKE_RESPONSE: JSON.stringify({
          decision: 'reject',
          confidence: 'high',
          blockingIssues: ['needs fix'],
          nonBlockingIssues: [],
          reviewSummary: 'Needs fix',
          nextAction: 'fix',
          fixTask: 'add fix.txt',
        }),
        REAL_REPO_ENABLE_REVIEWER_FIX_LOOP: '0',
        RUNS_DIR: runsDir,
      });
      assert.notStrictEqual(result.status, 0, `Expected failure: ${result.stderr}`);
      assert.strictEqual(getGitLogCount(repoPath), beforeLogCount + 1, 'Should preserve original commit');
      const afterRemote = getBareRefs(originPath);
      assert.notDeepStrictEqual(afterRemote, beforeRemote, 'Original commit should be pushed');
      const state = loadStateFromPath(runsDir, taskId) as Record<string, unknown>;
      assert(state !== null);
      const rollback = state.rollback as Record<string, unknown>;
      assert(rollback !== undefined, 'Should record rollback metadata');
      assert.strictEqual(rollback.status, 'skipped');
      assert.strictEqual(rollback.attempted, false);
      assert.strictEqual(rollback.policy, 'post_push_preserve_for_human');
      assert(typeof rollback.reason === 'string' && rollback.reason.includes('fix execution is not configured'), `Expected fix-loop disabled reason: ${rollback.reason}`);
      assert.strictEqual(state.commit_sha, getHeadSha(repoPath));
    } finally {
      cleanup();
    }
  });

  test('failed fix execution after original push preserves original commit and rolls back failed fix', () => {
    const { taskId, tasksFilePath, repoPath, originPath, runsDir, cleanup } = createTempEnv(['node', 'check-fix.cjs']);
    try {
      setupFixFailingCheck(repoPath);
      const beforeLogCount = getGitLogCount(repoPath);
      const beforeRemote = getBareRefs(originPath);
      const result = runCli(['real-repo-run-ai', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_PROVIDER: 'true',
        ALLOW_REAL_REPO_APPLY: 'true',
        ALLOW_REAL_REPO_COMMIT: 'true',
        ALLOW_REAL_REPO_PUSH: 'true',
        KIMI_API_KEY: 'fake',
        KIMI_BASE_URL: 'http://localhost:9999',
        KIMI_FAKE_RESPONSE: buildFakeKimiOutput([{ path: 'README.md', content: '# modified\n' }]),
        REAL_REPO_REVIEWER_FAKE_RESPONSE: JSON.stringify({
          decision: 'reject',
          confidence: 'high',
          blockingIssues: ['missing fix'],
          nonBlockingIssues: [],
          reviewSummary: 'Needs fix',
          nextAction: 'fix',
          fixTask: 'add fix.txt',
        }),
        REAL_REPO_REVIEWER_FIX_TASK_KIMI_FAKE_RESPONSE: buildFakeKimiOutput([{ path: 'fix.txt', content: 'fix applied\n' }]),
        REAL_REPO_ENABLE_REVIEWER_FIX_LOOP: '1',
        RUNS_DIR: runsDir,
      });
      assert.notStrictEqual(result.status, 0, `Expected failure: ${result.stderr}`);
      assert.strictEqual(getGitLogCount(repoPath), beforeLogCount + 1, 'Should preserve only original commit locally');
      const afterRemote = getBareRefs(originPath);
      assert.notDeepStrictEqual(afterRemote, beforeRemote, 'Original commit should be pushed');
      assert(!existsSync(join(repoPath, 'fix.txt')), 'Failed fix file should be rolled back');
      const state = loadStateFromPath(runsDir, taskId) as Record<string, unknown>;
      assert(state !== null);
      const rollback = state.rollback as Record<string, unknown>;
      assert(rollback !== undefined, 'Should record rollback metadata');
      assert.strictEqual(rollback.status, 'skipped');
      assert.strictEqual(rollback.attempted, false);
      assert.strictEqual(rollback.policy, 'post_push_preserve_for_human');
      assert(typeof rollback.reason === 'string' && rollback.reason.includes('fix attempt rolled back locally'), `Expected fix rollback reason: ${rollback.reason}`);
      assert.strictEqual(state.commit_sha, getHeadSha(repoPath));
      const controlledRun = state.reviewer_fix_task_controlled_run as Record<string, unknown>;
      assert(controlledRun !== undefined);
      assert.strictEqual(controlledRun.runnerResultStatus, 'blocked');
    } finally {
      cleanup();
    }
  });

  test('second reviewer block after pushed fix preserves both commits', () => {
    const { taskId, tasksFilePath, repoPath, originPath, runsDir, cleanup } = createTempEnv();
    try {
      const beforeLogCount = getGitLogCount(repoPath);
      const beforeRemote = getBareRefs(originPath);
      const result = runCli(['real-repo-run-ai', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_PROVIDER: 'true',
        ALLOW_REAL_REPO_APPLY: 'true',
        ALLOW_REAL_REPO_COMMIT: 'true',
        ALLOW_REAL_REPO_PUSH: 'true',
        KIMI_API_KEY: 'fake',
        KIMI_BASE_URL: 'http://localhost:9999',
        KIMI_FAKE_RESPONSE: buildFakeKimiOutput([{ path: 'README.md', content: '# modified\n' }]),
        REAL_REPO_REVIEWER_FAKE_RESPONSE: JSON.stringify({
          decision: 'reject',
          confidence: 'high',
          blockingIssues: ['missing fix'],
          nonBlockingIssues: [],
          reviewSummary: 'Needs fix',
          nextAction: 'fix',
          fixTask: 'add fix.txt',
        }),
        REAL_REPO_REVIEWER_FIX_TASK_KIMI_FAKE_RESPONSE: buildFakeKimiOutput([{ path: 'fix.txt', content: 'fix applied\n' }]),
        REAL_REPO_REVIEWER_SECOND_FAKE_RESPONSE: JSON.stringify({
          decision: 'block_for_human',
          confidence: 'high',
          blockingIssues: ['human review required'],
          nonBlockingIssues: [],
          reviewSummary: 'Block fix',
          nextAction: 'block',
        }),
        REAL_REPO_ENABLE_REVIEWER_FIX_LOOP: '1',
        RUNS_DIR: runsDir,
      });
      assert.notStrictEqual(result.status, 0, `Expected failure: ${result.stderr}`);
      assert.strictEqual(getGitLogCount(repoPath), beforeLogCount + 2, 'Should preserve original and fix commits');
      const afterRemote = getBareRefs(originPath);
      assert.notDeepStrictEqual(afterRemote, beforeRemote, 'Commits should be pushed');
      const state = loadStateFromPath(runsDir, taskId) as Record<string, unknown>;
      assert(state !== null);
      const rollback = state.rollback as Record<string, unknown>;
      assert(rollback !== undefined, 'Should record rollback metadata');
      assert.strictEqual(rollback.status, 'skipped');
      assert.strictEqual(rollback.attempted, false);
      assert.strictEqual(rollback.policy, 'post_push_preserve_for_human');
      assert(typeof rollback.reason === 'string' && rollback.reason.includes('pushed commits preserved'), `Expected pushed commits preserved reason: ${rollback.reason}`);
      const secondReview = state.reviewer_fix_task_second_review as Record<string, unknown>;
      assert(secondReview !== undefined);
      const fixCommitSha = secondReview.fixCommitSha as string;
      assert(typeof fixCommitSha === 'string' && fixCommitSha.length === 40);
      assert.notStrictEqual(fixCommitSha, state.commit_sha, 'Fix commit should differ from original');
      assert.strictEqual(fixCommitSha, getHeadSha(repoPath), 'Fix commit should be local HEAD');
    } finally {
      cleanup();
    }
  });

  test('pre-push push failure performs rollback tagged with pre_push_failure policy', () => {
    const { taskId, tasksFilePath, repoPath, cleanup } = createTempEnv();
    try {
      spawnSync('git', ['remote', 'set-url', 'origin', '/nonexistent/remote'], {
        cwd: repoPath,
        encoding: 'utf-8',
        shell: false,
      });
      const beforeContent = readFileSync(join(repoPath, 'README.md'), 'utf-8');
      const beforeLogCount = getGitLogCount(repoPath);
      const result = runCli(['real-repo-run-ai', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_PROVIDER: 'true',
        ALLOW_REAL_REPO_APPLY: 'true',
        ALLOW_REAL_REPO_COMMIT: 'true',
        ALLOW_REAL_REPO_PUSH: 'true',
        KIMI_API_KEY: 'fake',
        KIMI_BASE_URL: 'http://localhost:9999',
        KIMI_FAKE_RESPONSE: buildFakeKimiOutput([{ path: 'README.md', content: '# modified\n' }]),
      });
      assert.notStrictEqual(result.status, 0, `Expected failure: ${result.stderr}`);
      assert(result.stderr.includes('Git push failed'), `Expected push failure: ${result.stderr}`);
      assert(result.stderr.includes('Rollback attempted'), `Expected rollback attempted: ${result.stderr}`);
      assert(result.stderr.includes('policy=pre_push_failure'), `Expected pre_push_failure policy: ${result.stderr}`);
      assert.strictEqual(getGitLogCount(repoPath), beforeLogCount, 'Local commit should be rolled back');
      assert.strictEqual(getGitPorcelain(repoPath), '', 'Working tree should be clean');
      const afterContent = readFileSync(join(repoPath, 'README.md'), 'utf-8');
      assert.strictEqual(
        afterContent.replace(/\r\n/g, '\n'),
        beforeContent.replace(/\r\n/g, '\n'),
        'README should be restored'
      );
    } finally {
      cleanup();
    }
  });

  test('post-push rollback metadata does not leak reviewer secrets', () => {
    const { taskId, tasksFilePath, repoPath, originPath, runsDir, cleanup } = createTempEnv();
    try {
      const result = runCli(['real-repo-run-ai', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_PROVIDER: 'true',
        ALLOW_REAL_REPO_APPLY: 'true',
        ALLOW_REAL_REPO_COMMIT: 'true',
        ALLOW_REAL_REPO_PUSH: 'true',
        KIMI_API_KEY: 'fake',
        KIMI_BASE_URL: 'http://localhost:9999',
        KIMI_FAKE_RESPONSE: buildFakeKimiOutput([{ path: 'README.md', content: '# modified\n' }]),
        REAL_REPO_REVIEWER_FAKE_RESPONSE: JSON.stringify({
          decision: 'block_for_human',
          confidence: 'high',
          blockingIssues: ['api_key=secret-roll-policy-key'],
          nonBlockingIssues: [],
          reviewSummary: 'Block with token=secret-roll-policy-token',
          nextAction: 'block',
        }),
        RUNS_DIR: runsDir,
      });
      assert.notStrictEqual(result.status, 0, `Expected failure: ${result.stderr}`);
      const state = loadStateFromPath(runsDir, taskId) as Record<string, unknown>;
      assert(state !== null);
      const stateRaw = JSON.stringify(state);
      assert(!stateRaw.includes('secret-roll-policy-key'), 'Should not leak api_key in state');
      assert(!stateRaw.includes('secret-roll-policy-token'), 'Should not leak token in state');
      const combined = result.stdout + result.stderr;
      assert(!combined.includes('secret-roll-policy-key'), 'Should not leak api_key in output');
      assert(!combined.includes('secret-roll-policy-token'), 'Should not leak token in output');
      const rollback = state.rollback as Record<string, unknown>;
      assert(rollback !== undefined);
      assert.strictEqual(rollback.policy, 'post_push_preserve_for_human');
    } finally {
      cleanup();
    }
  });
});
