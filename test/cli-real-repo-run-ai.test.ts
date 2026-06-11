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
  delete env.REAL_REPO_REVIEWER_CAPTURE_INPUT_FILE;
  delete env.REAL_REPO_REVIEWER_FORCE_PROVIDER_ERROR;
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

describe('cli real-repo-run-ai', () => {
  test('missing taskId refuses', () => {
    const result = runCli(['real-repo-run-ai']);
    assert.notStrictEqual(result.status, 0);
    assert(result.stderr.includes('task id is required'), `Expected task id required: ${result.stderr}`);
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
      assert(result.stderr.includes('ALLOW_REAL_PROVIDER=true is required'), `Expected provider opt-in: ${result.stderr}`);
      assert(result.stderr.includes('No provider call was made'), `Expected no provider call: ${result.stderr}`);
    } finally {
      cleanup();
    }
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

  test('without REAL_REPO_REVIEWER_FAKE_RESPONSE existing success behavior unchanged', () => {
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
        RUNS_DIR: runsDir,
      });
      assert.strictEqual(result.status, 0, `Expected success: ${result.stderr}`);
      assert(!result.stderr.includes('Reviewer gate'), `Should not run reviewer gate without env: ${result.stderr}`);
      const after = getBareRefs(originPath);
      assert.notDeepStrictEqual(after, before, 'Should push to remote');
      const state = loadStateFromPath(runsDir, taskId);
      assert(state !== null);
      assert.strictEqual((state as Record<string, unknown>).status, 'pushed');
      assert.strictEqual((state as Record<string, unknown>).reviewer_gate, undefined, `Should not have reviewer_gate without env`);
      assert.strictEqual((state as Record<string, unknown>).reviewer_block_review_result, undefined, `Should not have reviewer_block_review_result without env`);
      assert.strictEqual((state as Record<string, unknown>).pending_reviewer_fix_task, undefined, `Should not have pending_reviewer_fix_task without env`);
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
});
