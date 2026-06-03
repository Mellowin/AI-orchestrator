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
  delete env.OPENAI_API_KEY;
  delete env.MOCK_AI;
  delete env.ALLOW_REAL_PROVIDER_RUN;
  delete env.ALLOW_SANDBOX_APPLY_PREVIEW;
  delete env.ALLOW_REAL_REPO_APPLY;
  delete env.ALLOW_REAL_REPO_COMMIT;
  delete env.ALLOW_REAL_REPO_PUSH;
  delete env.SANDBOX_PROVIDER_RESPONSE;
  delete env.SANDBOX_ROOT;
  delete env.REAL_REPO_PROVIDER_RESPONSE;
  delete env.RUNS_DIR;
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

function createTempEnv(checks: string[] = []): {
  taskId: string;
  tasksFilePath: string;
  repoPath: string;
  originPath: string;
  runsDir: string;
  cleanup: () => void;
} {
  const id = `${Date.now()}-${counter++}`;
  const taskId = `run-${id}`;
  const tmpBase = join(process.cwd(), 'tmp');
  if (!existsSync(tmpBase)) {
    mkdirSync(tmpBase);
  }
  const tmpDir = mkdtempSync(join(tmpBase, `run-${id}-`));
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

  const checkLines = checks.length > 0
    ? checks.map((c) => `    - command: "${c.split(' ')[0]}"\n      args: [${c.split(' ').slice(1).map((a) => `"${a}"`).join(', ')}]`).join('\n')
    : '    - command: "node"\n      args: ["-e", "process.exit(0)"]';

  const tasksFilePath = join(tmpDir, 'tasks.yaml');
  writeFileSync(
    tasksFilePath,
    `tasks:
  - id: ${taskId}
    title: "Run test"
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

describe('cli real-repo-run', () => {
  test('missing taskId refuses', () => {
    const result = runCli(['real-repo-run']);
    assert.notStrictEqual(result.status, 0);
    assert(result.stderr.includes('task id is required'), `Expected task id required: ${result.stderr}`);
  });

  test('missing ALLOW_REAL_REPO_APPLY refuses', () => {
    const { taskId, tasksFilePath, cleanup } = createTempEnv();
    try {
      const result = runCli(['real-repo-run', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_REPO_COMMIT: 'true',
        ALLOW_REAL_REPO_PUSH: 'true',
      });
      assert.notStrictEqual(result.status, 0);
      assert(result.stderr.includes('ALLOW_REAL_REPO_APPLY=true is required'), `Expected apply opt-in: ${result.stderr}`);
    } finally {
      cleanup();
    }
  });

  test('missing ALLOW_REAL_REPO_COMMIT refuses', () => {
    const { taskId, tasksFilePath, cleanup } = createTempEnv();
    try {
      const result = runCli(['real-repo-run', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_REPO_APPLY: 'true',
        ALLOW_REAL_REPO_PUSH: 'true',
      });
      assert.notStrictEqual(result.status, 0);
      assert(result.stderr.includes('ALLOW_REAL_REPO_COMMIT=true is required'), `Expected commit opt-in: ${result.stderr}`);
    } finally {
      cleanup();
    }
  });

  test('missing ALLOW_REAL_REPO_PUSH refuses', () => {
    const { taskId, tasksFilePath, cleanup } = createTempEnv();
    try {
      const result = runCli(['real-repo-run', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_REPO_APPLY: 'true',
        ALLOW_REAL_REPO_COMMIT: 'true',
      });
      assert.notStrictEqual(result.status, 0);
      assert(result.stderr.includes('ALLOW_REAL_REPO_PUSH=true is required'), `Expected push opt-in: ${result.stderr}`);
    } finally {
      cleanup();
    }
  });

  test('missing provider response refuses', () => {
    const { taskId, tasksFilePath, cleanup } = createTempEnv();
    try {
      const result = runCli(['real-repo-run', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_REPO_APPLY: 'true',
        ALLOW_REAL_REPO_COMMIT: 'true',
        ALLOW_REAL_REPO_PUSH: 'true',
      });
      assert.notStrictEqual(result.status, 0);
      assert(result.stderr.includes('REAL_REPO_PROVIDER_RESPONSE'), `Expected provider response message: ${result.stderr}`);
    } finally {
      cleanup();
    }
  });

  test('malformed provider response refuses', () => {
    const { taskId, tasksFilePath, cleanup } = createTempEnv();
    try {
      const result = runCli(['real-repo-run', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_REPO_APPLY: 'true',
        ALLOW_REAL_REPO_COMMIT: 'true',
        ALLOW_REAL_REPO_PUSH: 'true',
        REAL_REPO_PROVIDER_RESPONSE: 'not-json',
      });
      assert.notStrictEqual(result.status, 0);
    } finally {
      cleanup();
    }
  });

  test('guardrails failure refuses', () => {
    const { taskId, tasksFilePath, cleanup } = createTempEnv();
    try {
      const result = runCli(['real-repo-run', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_REPO_APPLY: 'true',
        ALLOW_REAL_REPO_COMMIT: 'true',
        ALLOW_REAL_REPO_PUSH: 'true',
        REAL_REPO_PROVIDER_RESPONSE: buildFakeKimiOutput([{ path: '.env', content: 'secret' }]),
      });
      assert.notStrictEqual(result.status, 0);
      assert(result.stderr.includes('Guardrails failed'), `Expected guardrails failure: ${result.stderr}`);
    } finally {
      cleanup();
    }
  });

  test('line delta failure refuses', () => {
    const { taskId, tasksFilePath, cleanup } = createTempEnv();
    try {
      const bigContent = 'a\n'.repeat(200);
      const result = runCli(['real-repo-run', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_REPO_APPLY: 'true',
        ALLOW_REAL_REPO_COMMIT: 'true',
        ALLOW_REAL_REPO_PUSH: 'true',
        REAL_REPO_PROVIDER_RESPONSE: buildFakeKimiOutput([{ path: 'README.md', content: bigContent }]),
      });
      assert.notStrictEqual(result.status, 0);
      assert(result.stderr.includes('line delta') || result.stderr.includes('Guardrails'), `Expected line delta failure: ${result.stderr}`);
    } finally {
      cleanup();
    }
  });

  test('line delta failure uses real-repo-run prefix', () => {
    const { taskId, tasksFilePath, cleanup } = createTempEnv();
    try {
      const bigContent = 'a\n'.repeat(200);
      const result = runCli(['real-repo-run', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_REPO_APPLY: 'true',
        ALLOW_REAL_REPO_COMMIT: 'true',
        ALLOW_REAL_REPO_PUSH: 'true',
        REAL_REPO_PROVIDER_RESPONSE: buildFakeKimiOutput([{ path: 'README.md', content: bigContent }]),
      });
      assert.notStrictEqual(result.status, 0);
      assert(result.stderr.includes('[real-repo-run] Guardrails failed'), `Expected [real-repo-run] prefix: ${result.stderr}`);
      assert(!result.stderr.includes('[real-repo-run-ai]'), `Should NOT contain [real-repo-run-ai] prefix: ${result.stderr}`);
    } finally {
      cleanup();
    }
  });

  test('current branch main refuses', () => {
    const { taskId, tasksFilePath, repoPath, cleanup } = createTempEnv();
    try {
      spawnSync('git', ['checkout', 'main'], {
        cwd: repoPath,
        encoding: 'utf-8',
        shell: false,
      });
      const result = runCli(['real-repo-run', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_REPO_APPLY: 'true',
        ALLOW_REAL_REPO_COMMIT: 'true',
        ALLOW_REAL_REPO_PUSH: 'true',
        REAL_REPO_PROVIDER_RESPONSE: buildFakeKimiOutput([{ path: 'README.md', content: 'x' }]),
      });
      assert.notStrictEqual(result.status, 0);
      assert(result.stderr.includes('Current branch is main'), `Expected main refusal: ${result.stderr}`);
    } finally {
      cleanup();
    }
  });

  test('work_branch main refuses', () => {
    const { taskId, tasksFilePath, cleanup } = createTempEnv();
    try {
      const tasksContent = readFileSync(tasksFilePath, 'utf-8');
      writeFileSync(tasksFilePath, tasksContent.replace(/work_branch: "ai\/[^"]+"/, 'work_branch: "main"'), 'utf-8');
      const result = runCli(['real-repo-run', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_REPO_APPLY: 'true',
        ALLOW_REAL_REPO_COMMIT: 'true',
        ALLOW_REAL_REPO_PUSH: 'true',
        REAL_REPO_PROVIDER_RESPONSE: buildFakeKimiOutput([{ path: 'README.md', content: 'x' }]),
      });
      assert.notStrictEqual(result.status, 0);
      assert(result.stderr.includes('work_branch is main'), `Expected work_branch main refusal: ${result.stderr}`);
    } finally {
      cleanup();
    }
  });

  test('branch mismatch refuses', () => {
    const { taskId, tasksFilePath, repoPath, cleanup } = createTempEnv();
    try {
      spawnSync('git', ['checkout', '-b', 'other-branch'], {
        cwd: repoPath,
        encoding: 'utf-8',
        shell: false,
      });
      const result = runCli(['real-repo-run', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_REPO_APPLY: 'true',
        ALLOW_REAL_REPO_COMMIT: 'true',
        ALLOW_REAL_REPO_PUSH: 'true',
        REAL_REPO_PROVIDER_RESPONSE: buildFakeKimiOutput([{ path: 'README.md', content: 'x' }]),
      });
      assert.notStrictEqual(result.status, 0);
      assert(result.stderr.includes('Safety check failed'), `Expected branch mismatch: ${result.stderr}`);
    } finally {
      cleanup();
    }
  });

  test('dirty tree before apply refuses', () => {
    const { taskId, tasksFilePath, repoPath, cleanup } = createTempEnv();
    try {
      writeFileSync(join(repoPath, 'README.md'), '# dirty\n', 'utf-8');
      const result = runCli(['real-repo-run', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_REPO_APPLY: 'true',
        ALLOW_REAL_REPO_COMMIT: 'true',
        ALLOW_REAL_REPO_PUSH: 'true',
        REAL_REPO_PROVIDER_RESPONSE: buildFakeKimiOutput([{ path: 'README.md', content: 'x' }]),
      });
      assert.notStrictEqual(result.status, 0);
      assert(result.stderr.includes('Safety check failed'), `Expected safety failure: ${result.stderr}`);
    } finally {
      cleanup();
    }
  });

  test('apply failure does not commit/push/state', () => {
    const { taskId, tasksFilePath, repoPath, originPath, runsDir, cleanup } = createTempEnv();
    try {
      // Create a file named 'blocked' and try to write inside it to cause apply failure
      writeFileSync(join(repoPath, 'blocked'), 'i am a file not a directory', 'utf-8');
      spawnSync('git', ['add', 'blocked'], { cwd: repoPath, encoding: 'utf-8', shell: false });
      spawnSync('git', ['commit', '-m', 'add blocked', '--no-gpg-sign'], { cwd: repoPath, encoding: 'utf-8', shell: false });
      const before = getBareRefs(originPath);
      const result = runCli(['real-repo-run', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_REPO_APPLY: 'true',
        ALLOW_REAL_REPO_COMMIT: 'true',
        ALLOW_REAL_REPO_PUSH: 'true',
        REAL_REPO_PROVIDER_RESPONSE: buildFakeKimiOutput([
          { path: 'README.md', content: '# modified\n' },
          { path: 'blocked/new.txt', content: 'should fail\n' },
        ]),
        RUNS_DIR: runsDir,
      });
      assert.notStrictEqual(result.status, 0);
      assert(result.stderr.includes('Apply failed'), `Expected apply failure: ${result.stderr}`);
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
      const result = runCli(['real-repo-run', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_REPO_APPLY: 'true',
        ALLOW_REAL_REPO_COMMIT: 'true',
        ALLOW_REAL_REPO_PUSH: 'true',
        REAL_REPO_PROVIDER_RESPONSE: buildFakeKimiOutput([{ path: 'README.md', content: '# modified\n' }]),
        RUNS_DIR: runsDir,
      });
      assert.notStrictEqual(result.status, 0);
      assert(result.stderr.includes('Checks failed'), `Expected check failure: ${result.stderr}`);
      const afterContent = readFileSync(join(repoPath, 'README.md'), 'utf-8');
      assert.strictEqual(afterContent, beforeContent, `File should be rolled back after check failure`);
      const after = getBareRefs(originPath);
      assert.deepStrictEqual(after, before, `Bare remote should not change on check failure`);
      const state = loadStateFromPath(runsDir, taskId);
      assert.strictEqual(state, null, `State should not be written on check failure`);
    } finally {
      cleanup();
    }
  });

  test('successful run applies files', () => {
    const { taskId, tasksFilePath, repoPath, cleanup } = createTempEnv();
    try {
      const result = runCli(['real-repo-run', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_REPO_APPLY: 'true',
        ALLOW_REAL_REPO_COMMIT: 'true',
        ALLOW_REAL_REPO_PUSH: 'true',
        REAL_REPO_PROVIDER_RESPONSE: buildFakeKimiOutput([{ path: 'README.md', content: '# modified\n' }]),
      });
      assert.strictEqual(result.status, 0, `Expected success: ${result.stderr}`);
      const content = readFileSync(join(repoPath, 'README.md'), 'utf-8');
      assert.strictEqual(content, '# modified\n', `File should be applied`);
    } finally {
      cleanup();
    }
  });

  test('successful run creates commit', () => {
    const { taskId, tasksFilePath, repoPath, cleanup } = createTempEnv();
    try {
      const before = getGitLogCount(repoPath);
      const result = runCli(['real-repo-run', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_REPO_APPLY: 'true',
        ALLOW_REAL_REPO_COMMIT: 'true',
        ALLOW_REAL_REPO_PUSH: 'true',
        REAL_REPO_PROVIDER_RESPONSE: buildFakeKimiOutput([{ path: 'README.md', content: '# modified\n' }]),
      });
      assert.strictEqual(result.status, 0, `Expected success: ${result.stderr}`);
      const after = getGitLogCount(repoPath);
      assert.strictEqual(after, before + 1, `Commit count should increase by 1: ${before} -> ${after}`);
    } finally {
      cleanup();
    }
  });

  test('successful run commit message is exactly ai-orchestrator: apply <taskId>', () => {
    const { taskId, tasksFilePath, repoPath, cleanup } = createTempEnv();
    try {
      runCli(['real-repo-run', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_REPO_APPLY: 'true',
        ALLOW_REAL_REPO_COMMIT: 'true',
        ALLOW_REAL_REPO_PUSH: 'true',
        REAL_REPO_PROVIDER_RESPONSE: buildFakeKimiOutput([{ path: 'README.md', content: '# modified\n' }]),
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
      const result = runCli(['real-repo-run', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_REPO_APPLY: 'true',
        ALLOW_REAL_REPO_COMMIT: 'true',
        ALLOW_REAL_REPO_PUSH: 'true',
        REAL_REPO_PROVIDER_RESPONSE: buildFakeKimiOutput([{ path: 'README.md', content: '# modified\n' }]),
      });
      assert.strictEqual(result.status, 0, `Expected success: ${result.stderr}`);
      const refs = getBareRefs(originPath);
      const hasBranch = refs.some((r) => r.includes(`refs/heads/${branch}`));
      assert(hasBranch, `Bare remote should have refs/heads/${branch}: ${refs.join(', ')}`);
    } finally {
      cleanup();
    }
  });

  test('successful run writes state status pushed', () => {
    const { taskId, tasksFilePath, runsDir, cleanup } = createTempEnv();
    try {
      runCli(['real-repo-run', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_REPO_APPLY: 'true',
        ALLOW_REAL_REPO_COMMIT: 'true',
        ALLOW_REAL_REPO_PUSH: 'true',
        REAL_REPO_PROVIDER_RESPONSE: buildFakeKimiOutput([{ path: 'README.md', content: '# modified\n' }]),
        RUNS_DIR: runsDir,
      });
      const state = loadStateFromPath(runsDir, taskId) as Record<string, unknown>;
      assert.strictEqual(state.status, 'pushed');
    } finally {
      cleanup();
    }
  });

  test('state contains pushed_remote origin', () => {
    const { taskId, tasksFilePath, runsDir, cleanup } = createTempEnv();
    try {
      runCli(['real-repo-run', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_REPO_APPLY: 'true',
        ALLOW_REAL_REPO_COMMIT: 'true',
        ALLOW_REAL_REPO_PUSH: 'true',
        REAL_REPO_PROVIDER_RESPONSE: buildFakeKimiOutput([{ path: 'README.md', content: '# modified\n' }]),
        RUNS_DIR: runsDir,
      });
      const state = loadStateFromPath(runsDir, taskId) as Record<string, unknown>;
      assert.strictEqual(state.pushed_remote, 'origin');
    } finally {
      cleanup();
    }
  });

  test('state contains pushed_ref currentBranch', () => {
    const { taskId, tasksFilePath, repoPath, runsDir, cleanup } = createTempEnv();
    try {
      const branch = getCurrentBranch(repoPath);
      runCli(['real-repo-run', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_REPO_APPLY: 'true',
        ALLOW_REAL_REPO_COMMIT: 'true',
        ALLOW_REAL_REPO_PUSH: 'true',
        REAL_REPO_PROVIDER_RESPONSE: buildFakeKimiOutput([{ path: 'README.md', content: '# modified\n' }]),
        RUNS_DIR: runsDir,
      });
      const state = loadStateFromPath(runsDir, taskId) as Record<string, unknown>;
      assert.strictEqual(state.pushed_ref, branch);
    } finally {
      cleanup();
    }
  });

  test('state contains commit_sha HEAD', () => {
    const { taskId, tasksFilePath, repoPath, runsDir, cleanup } = createTempEnv();
    try {
      runCli(['real-repo-run', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_REPO_APPLY: 'true',
        ALLOW_REAL_REPO_COMMIT: 'true',
        ALLOW_REAL_REPO_PUSH: 'true',
        REAL_REPO_PROVIDER_RESPONSE: buildFakeKimiOutput([{ path: 'README.md', content: '# modified\n' }]),
        RUNS_DIR: runsDir,
      });
      const headSha = spawnSync('git', ['rev-parse', '--verify', 'HEAD'], {
        cwd: repoPath,
        encoding: 'utf-8',
        shell: false,
      }).stdout.trim();
      const state = loadStateFromPath(runsDir, taskId) as Record<string, unknown>;
      assert.strictEqual(state.commit_sha, headSha);
    } finally {
      cleanup();
    }
  });

  test('state does not contain provider response content', () => {
    const { taskId, tasksFilePath, runsDir, cleanup } = createTempEnv();
    try {
      runCli(['real-repo-run', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_REPO_APPLY: 'true',
        ALLOW_REAL_REPO_COMMIT: 'true',
        ALLOW_REAL_REPO_PUSH: 'true',
        REAL_REPO_PROVIDER_RESPONSE: buildFakeKimiOutput([{ path: 'README.md', content: '# modified\n' }], 'provider notes'),
        RUNS_DIR: runsDir,
      });
      const stateRaw = readFileSync(join(runsDir, taskId, 'state.json'), 'utf-8');
      assert(!stateRaw.includes('file_update'), `State should not contain provider response`);
      assert(!stateRaw.includes('provider notes'), `State should not contain provider notes`);
    } finally {
      cleanup();
    }
  });

  test('state does not contain file contents', () => {
    const { taskId, tasksFilePath, runsDir, cleanup } = createTempEnv();
    try {
      runCli(['real-repo-run', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_REPO_APPLY: 'true',
        ALLOW_REAL_REPO_COMMIT: 'true',
        ALLOW_REAL_REPO_PUSH: 'true',
        REAL_REPO_PROVIDER_RESPONSE: buildFakeKimiOutput([{ path: 'README.md', content: '# secret content\n' }]),
        RUNS_DIR: runsDir,
      });
      const stateRaw = readFileSync(join(runsDir, taskId, 'state.json'), 'utf-8');
      assert(!stateRaw.includes('secret content'), `State should not contain file contents`);
    } finally {
      cleanup();
    }
  });

  test('state does not contain fake API key', () => {
    const { taskId, tasksFilePath, runsDir, cleanup } = createTempEnv();
    try {
      runCli(['real-repo-run', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_REPO_APPLY: 'true',
        ALLOW_REAL_REPO_COMMIT: 'true',
        ALLOW_REAL_REPO_PUSH: 'true',
        REAL_REPO_PROVIDER_RESPONSE: buildFakeKimiOutput([{ path: 'README.md', content: '# modified\n' }]),
        RUNS_DIR: runsDir,
        KIMI_API_KEY: 'sk-fake12345',
      });
      const stateRaw = readFileSync(join(runsDir, taskId, 'state.json'), 'utf-8');
      assert(!stateRaw.includes('sk-fake'), `State should not contain fake API key`);
    } finally {
      cleanup();
    }
  });

  test('no force push', () => {
    const { taskId, tasksFilePath, cleanup } = createTempEnv();
    try {
      const result = runCli(['real-repo-run', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_REPO_APPLY: 'true',
        ALLOW_REAL_REPO_COMMIT: 'true',
        ALLOW_REAL_REPO_PUSH: 'true',
        REAL_REPO_PROVIDER_RESPONSE: buildFakeKimiOutput([{ path: 'README.md', content: '# modified\n' }]),
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
      runCli(['real-repo-run', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_REPO_APPLY: 'true',
        ALLOW_REAL_REPO_COMMIT: 'true',
        ALLOW_REAL_REPO_PUSH: 'true',
        REAL_REPO_PROVIDER_RESPONSE: buildFakeKimiOutput([{ path: 'README.md', content: '# modified\n' }]),
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
      const result = runCli(['real-repo-run', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_REPO_APPLY: 'true',
        ALLOW_REAL_REPO_COMMIT: 'true',
        ALLOW_REAL_REPO_PUSH: 'true',
        REAL_REPO_PROVIDER_RESPONSE: buildFakeKimiOutput([{ path: 'README.md', content: '# modified\n' }]),
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
      const result = runCli(['real-repo-run', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_REPO_APPLY: 'true',
        ALLOW_REAL_REPO_COMMIT: 'true',
        ALLOW_REAL_REPO_PUSH: 'true',
        REAL_REPO_PROVIDER_RESPONSE: buildFakeKimiOutput([{ path: 'README.md', content: '# modified\n' }]),
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
      const result = runCli(['real-repo-run', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_REPO_APPLY: 'true',
        ALLOW_REAL_REPO_COMMIT: 'true',
        ALLOW_REAL_REPO_PUSH: 'true',
        REAL_REPO_PROVIDER_RESPONSE: buildFakeKimiOutput([{ path: 'README.md', content: '# modified\n' }]),
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
      const result = runCli(['real-repo-run', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_REPO_APPLY: 'true',
        ALLOW_REAL_REPO_COMMIT: 'true',
        ALLOW_REAL_REPO_PUSH: 'true',
        REAL_REPO_PROVIDER_RESPONSE: buildFakeKimiOutput([{ path: 'README.md', content: '# modified\n' }]),
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
      runCli(['real-repo-run', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_REPO_APPLY: 'true',
        ALLOW_REAL_REPO_COMMIT: 'true',
        ALLOW_REAL_REPO_PUSH: 'true',
        REAL_REPO_PROVIDER_RESPONSE: buildFakeKimiOutput([{ path: 'README.md', content: '# modified\n' }]),
      });
      const refs = getBareRefs(originPath);
      const hasMain = refs.some((r) => r.includes('refs/heads/main'));
      assert(!hasMain, `Bare remote should NOT have refs/heads/main: ${refs.join(', ')}`);
    } finally {
      cleanup();
    }
  });

  test('no provider/API key required', () => {
    const { taskId, tasksFilePath, cleanup } = createTempEnv();
    try {
      const result = runCli(['real-repo-run', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_REPO_APPLY: 'true',
        ALLOW_REAL_REPO_COMMIT: 'true',
        ALLOW_REAL_REPO_PUSH: 'true',
        REAL_REPO_PROVIDER_RESPONSE: buildFakeKimiOutput([{ path: 'README.md', content: '# modified\n' }]),
      });
      assert.strictEqual(result.status, 0, `Expected success: ${result.stderr}`);
      assert(!result.stderr.includes('KIMI_API_KEY'), `Should not require KIMI_API_KEY: ${result.stderr}`);
      assert(!result.stderr.includes('Provider'), `Should not mention provider: ${result.stderr}`);
    } finally {
      cleanup();
    }
  });

  test('fake API key not printed', () => {
    const { taskId, tasksFilePath, cleanup } = createTempEnv();
    try {
      const result = runCli(['real-repo-run', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_REPO_APPLY: 'true',
        ALLOW_REAL_REPO_COMMIT: 'true',
        ALLOW_REAL_REPO_PUSH: 'true',
        REAL_REPO_PROVIDER_RESPONSE: buildFakeKimiOutput([{ path: 'README.md', content: '# modified\n' }]),
        KIMI_API_KEY: 'sk-fake12345',
      });
      assert.strictEqual(result.status, 0, `Expected success: ${result.stderr}`);
      assert(!result.stderr.includes('sk-fake'), `Should not leak fake API key: ${result.stderr}`);
      assert(!result.stdout.includes('sk-fake'), `Should not leak fake API key in stdout: ${result.stdout}`);
    } finally {
      cleanup();
    }
  });

  test('no stack trace', () => {
    const { taskId, tasksFilePath, repoPath, cleanup } = createTempEnv();
    try {
      writeFileSync(join(repoPath, 'README.md'), '# dirty\n', 'utf-8');
      const result = runCli(['real-repo-run', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_REPO_APPLY: 'true',
        ALLOW_REAL_REPO_COMMIT: 'true',
        ALLOW_REAL_REPO_PUSH: 'true',
        REAL_REPO_PROVIDER_RESPONSE: buildFakeKimiOutput([{ path: 'README.md', content: '# modified\n' }]),
      });
      assert.notStrictEqual(result.status, 0);
      assert(!result.stderr.includes('at '), `Should not contain stack trace: ${result.stderr}`);
    } finally {
      cleanup();
    }
  });

  test('branch before/after unchanged', () => {
    const { taskId, tasksFilePath, repoPath, cleanup } = createTempEnv();
    try {
      const before = getCurrentBranch(repoPath);
      const result = runCli(['real-repo-run', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_REPO_APPLY: 'true',
        ALLOW_REAL_REPO_COMMIT: 'true',
        ALLOW_REAL_REPO_PUSH: 'true',
        REAL_REPO_PROVIDER_RESPONSE: buildFakeKimiOutput([{ path: 'README.md', content: '# modified\n' }]),
      });
      assert.strictEqual(result.status, 0, `Expected success: ${result.stderr}`);
      const after = getCurrentBranch(repoPath);
      assert.strictEqual(after, before, `Branch should not change: ${before} -> ${after}`);
    } finally {
      cleanup();
    }
  });

  test('working tree clean after success', () => {
    const { taskId, tasksFilePath, repoPath, cleanup } = createTempEnv();
    try {
      const result = runCli(['real-repo-run', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_REPO_APPLY: 'true',
        ALLOW_REAL_REPO_COMMIT: 'true',
        ALLOW_REAL_REPO_PUSH: 'true',
        REAL_REPO_PROVIDER_RESPONSE: buildFakeKimiOutput([{ path: 'README.md', content: '# modified\n' }]),
      });
      assert.strictEqual(result.status, 0, `Expected success: ${result.stderr}`);
      const porcelain = getGitPorcelain(repoPath);
      assert.strictEqual(porcelain, '', `Working tree should be clean after success: ${porcelain}`);
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
});
