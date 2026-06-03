import { describe, test } from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
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
  delete env.SANDBOX_PROVIDER_RESPONSE;
  delete env.SANDBOX_ROOT;
  delete env.REAL_REPO_PROVIDER_RESPONSE;
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

function createTempEnv(): {
  taskId: string;
  tasksFilePath: string;
  repoPath: string;
  cleanup: () => void;
} {
  const id = `${Date.now()}-${counter++}`;
  const taskId = `commit-${id}`;
  const tmpBase = join(process.cwd(), 'tmp');
  if (!existsSync(tmpBase)) {
    mkdirSync(tmpBase);
  }
  const tmpDir = mkdtempSync(join(tmpBase, `commit-${id}-`));
  const repoPath = join(tmpDir, 'repo');
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

  const tasksFilePath = join(tmpDir, 'tasks.yaml');
  writeFileSync(
    tasksFilePath,
    `tasks:
  - id: ${taskId}
    title: "Commit test"
    repo_path: "${repoPath.replace(/\\/g, '/')}"
    base_branch: "main"
    work_branch: "ai/${taskId}"
    goal: "Test goal"
    context_files: []
    checks: []
    guardrails:
      deny_modify: []
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

function getCurrentBranch(repoPath: string): string {
  const result = spawnSync('git', ['branch', '--show-current'], {
    cwd: repoPath,
    encoding: 'utf-8',
    shell: false,
  });
  return result.stdout.trim();
}

function getGitPorcelain(repoPath: string): string {
  const result = spawnSync('git', ['status', '--porcelain', '--untracked-files=all'], {
    cwd: repoPath,
    encoding: 'utf-8',
    shell: false,
  });
  return result.stdout.trim();
}

describe('cli real-repo-commit', () => {
  test('missing taskId exits non-zero and prints No commit was made', () => {
    const result = runCli(['real-repo-commit']);
    assert.notStrictEqual(result.status, 0);
    assert(result.stderr.includes('No commit was made'), `Expected "No commit was made": ${result.stderr}`);
  });

  test('missing ALLOW_REAL_REPO_COMMIT refuses before requiring ALLOW_REAL_REPO_APPLY', () => {
    const { taskId, tasksFilePath, cleanup } = createTempEnv();
    try {
      const result = runCli(['real-repo-commit', taskId], {
        TASKS_FILE: tasksFilePath,
      });
      assert.notStrictEqual(result.status, 0);
      assert(result.stderr.includes('ALLOW_REAL_REPO_COMMIT=true is required'), `Expected opt-in message: ${result.stderr}`);
      assert(!result.stderr.includes('ALLOW_REAL_REPO_APPLY'), `Should not require ALLOW_REAL_REPO_APPLY: ${result.stderr}`);
    } finally {
      cleanup();
    }
  });

  test('missing ALLOW_REAL_REPO_COMMIT refuses before requiring REAL_REPO_PROVIDER_RESPONSE', () => {
    const { taskId, tasksFilePath, cleanup } = createTempEnv();
    try {
      const result = runCli(['real-repo-commit', taskId], {
        TASKS_FILE: tasksFilePath,
      });
      assert.notStrictEqual(result.status, 0);
      assert(!result.stderr.includes('REAL_REPO_PROVIDER_RESPONSE'), `Should not require REAL_REPO_PROVIDER_RESPONSE: ${result.stderr}`);
    } finally {
      cleanup();
    }
  });

  test('with ALLOW_REAL_REPO_COMMIT=true, missing ALLOW_REAL_REPO_APPLY refuses', () => {
    const { taskId, tasksFilePath, cleanup } = createTempEnv();
    try {
      const result = runCli(['real-repo-commit', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_REPO_COMMIT: 'true',
      });
      assert.notStrictEqual(result.status, 0);
      assert(result.stderr.includes('ALLOW_REAL_REPO_APPLY=true is required'), `Expected ALLOW_REAL_REPO_APPLY message: ${result.stderr}`);
    } finally {
      cleanup();
    }
  });

  test('with both opt-ins, missing REAL_REPO_PROVIDER_RESPONSE refuses', () => {
    const { taskId, tasksFilePath, cleanup } = createTempEnv();
    try {
      const result = runCli(['real-repo-commit', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_REPO_COMMIT: 'true',
        ALLOW_REAL_REPO_APPLY: 'true',
      });
      assert.notStrictEqual(result.status, 0);
      assert(result.stderr.includes('REAL_REPO_PROVIDER_RESPONSE'), `Expected provider response message: ${result.stderr}`);
    } finally {
      cleanup();
    }
  });

  test('with both opt-ins, empty REAL_REPO_PROVIDER_RESPONSE refuses', () => {
    const { taskId, tasksFilePath, cleanup } = createTempEnv();
    try {
      const result = runCli(['real-repo-commit', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_REPO_COMMIT: 'true',
        ALLOW_REAL_REPO_APPLY: 'true',
        REAL_REPO_PROVIDER_RESPONSE: '   ',
      });
      assert.notStrictEqual(result.status, 0);
      assert(result.stderr.includes('REAL_REPO_PROVIDER_RESPONSE'), `Expected provider response message: ${result.stderr}`);
    } finally {
      cleanup();
    }
  });

  test('with both opt-ins, malformed provider response refuses', () => {
    const { taskId, tasksFilePath, cleanup } = createTempEnv();
    try {
      const result = runCli(['real-repo-commit', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_REPO_COMMIT: 'true',
        ALLOW_REAL_REPO_APPLY: 'true',
        REAL_REPO_PROVIDER_RESPONSE: 'not-json',
      });
      assert.notStrictEqual(result.status, 0);
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
      const result = runCli(['real-repo-commit', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_REPO_COMMIT: 'true',
        ALLOW_REAL_REPO_APPLY: 'true',
        REAL_REPO_PROVIDER_RESPONSE: buildFakeKimiOutput([{ path: 'README.md', content: 'x' }]),
      });
      assert.notStrictEqual(result.status, 0);
      assert(result.stderr.includes('Current branch is main'), `Expected main branch refusal: ${result.stderr}`);
    } finally {
      cleanup();
    }
  });

  test('task.work_branch main refuses', () => {
    const { taskId, tasksFilePath, repoPath, cleanup } = createTempEnv();
    try {
      // Rewrite tasks.yaml with work_branch: main
      const tasksContent = readFileSync(tasksFilePath, 'utf-8');
      writeFileSync(tasksFilePath, tasksContent.replace(/work_branch: "ai\/[^"]+"/, 'work_branch: "main"'), 'utf-8');
      const result = runCli(['real-repo-commit', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_REPO_COMMIT: 'true',
        ALLOW_REAL_REPO_APPLY: 'true',
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
      const result = runCli(['real-repo-commit', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_REPO_COMMIT: 'true',
        ALLOW_REAL_REPO_APPLY: 'true',
        REAL_REPO_PROVIDER_RESPONSE: buildFakeKimiOutput([{ path: 'README.md', content: 'x' }]),
      });
      assert.notStrictEqual(result.status, 0);
      assert(result.stderr.includes('Branch mismatch'), `Expected branch mismatch refusal: ${result.stderr}`);
    } finally {
      cleanup();
    }
  });

  test('no working tree changes refuses', () => {
    const { taskId, tasksFilePath, cleanup } = createTempEnv();
    try {
      const result = runCli(['real-repo-commit', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_REPO_COMMIT: 'true',
        ALLOW_REAL_REPO_APPLY: 'true',
        REAL_REPO_PROVIDER_RESPONSE: buildFakeKimiOutput([{ path: 'README.md', content: 'x' }]),
      });
      assert.notStrictEqual(result.status, 0);
      assert(result.stderr.includes('No working tree changes match the approved apply manifest'), `Expected no changes refusal: ${result.stderr}`);
    } finally {
      cleanup();
    }
  });

  test('unrelated modified tracked file refuses', () => {
    const { taskId, tasksFilePath, repoPath, cleanup } = createTempEnv();
    try {
      writeFileSync(join(repoPath, 'README.md'), '# modified\n', 'utf-8');
      writeFileSync(join(repoPath, 'NEW.md'), 'new\n', 'utf-8');
      const result = runCli(['real-repo-commit', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_REPO_COMMIT: 'true',
        ALLOW_REAL_REPO_APPLY: 'true',
        REAL_REPO_PROVIDER_RESPONSE: buildFakeKimiOutput([{ path: 'NEW.md', content: 'new' }]),
      });
      assert.notStrictEqual(result.status, 0);
      assert(result.stderr.includes('Unrelated changes detected'), `Expected unrelated refusal: ${result.stderr}`);
      assert(result.stderr.includes('README.md'), `Expected README.md in unrelated: ${result.stderr}`);
    } finally {
      cleanup();
    }
  });

  test('unrelated untracked file refuses', () => {
    const { taskId, tasksFilePath, repoPath, cleanup } = createTempEnv();
    try {
      writeFileSync(join(repoPath, 'NEW.md'), 'new\n', 'utf-8');
      writeFileSync(join(repoPath, 'UNRELATED.md'), 'unrelated\n', 'utf-8');
      const result = runCli(['real-repo-commit', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_REPO_COMMIT: 'true',
        ALLOW_REAL_REPO_APPLY: 'true',
        REAL_REPO_PROVIDER_RESPONSE: buildFakeKimiOutput([{ path: 'NEW.md', content: 'new' }]),
      });
      assert.notStrictEqual(result.status, 0);
      assert(result.stderr.includes('Unrelated changes detected'), `Expected unrelated refusal: ${result.stderr}`);
      assert(result.stderr.includes('UNRELATED.md'), `Expected UNRELATED.md in unrelated: ${result.stderr}`);
    } finally {
      cleanup();
    }
  });

  test('unrelated staged file refuses', () => {
    const { taskId, tasksFilePath, repoPath, cleanup } = createTempEnv();
    try {
      writeFileSync(join(repoPath, 'NEW.md'), 'new\n', 'utf-8');
      writeFileSync(join(repoPath, 'UNRELATED.md'), 'unrelated\n', 'utf-8');
      spawnSync('git', ['add', 'UNRELATED.md'], {
        cwd: repoPath,
        encoding: 'utf-8',
        shell: false,
      });
      const result = runCli(['real-repo-commit', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_REPO_COMMIT: 'true',
        ALLOW_REAL_REPO_APPLY: 'true',
        REAL_REPO_PROVIDER_RESPONSE: buildFakeKimiOutput([{ path: 'NEW.md', content: 'new' }]),
      });
      assert.notStrictEqual(result.status, 0);
      assert(result.stderr.includes('Unrelated changes detected'), `Expected unrelated refusal: ${result.stderr}`);
      assert(result.stderr.includes('UNRELATED.md'), `Expected UNRELATED.md in unrelated: ${result.stderr}`);
    } finally {
      cleanup();
    }
  });

  test('approved modified tracked file passes pre-commit validation, then refuses before commit', () => {
    const { taskId, tasksFilePath, repoPath, cleanup } = createTempEnv();
    try {
      writeFileSync(join(repoPath, 'README.md'), '# modified\n', 'utf-8');
      const result = runCli(['real-repo-commit', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_REPO_COMMIT: 'true',
        ALLOW_REAL_REPO_APPLY: 'true',
        REAL_REPO_PROVIDER_RESPONSE: buildFakeKimiOutput([{ path: 'README.md', content: 'modified' }]),
      });
      assert.notStrictEqual(result.status, 0);
      assert(result.stderr.includes('pre-commit validation passed, but git commit is not implemented yet'), `Expected pre-commit pass: ${result.stderr}`);
    } finally {
      cleanup();
    }
  });

  test('approved new/untracked file passes pre-commit validation, then refuses before commit', () => {
    const { taskId, tasksFilePath, repoPath, cleanup } = createTempEnv();
    try {
      writeFileSync(join(repoPath, 'NEW.md'), 'new\n', 'utf-8');
      const result = runCli(['real-repo-commit', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_REPO_COMMIT: 'true',
        ALLOW_REAL_REPO_APPLY: 'true',
        REAL_REPO_PROVIDER_RESPONSE: buildFakeKimiOutput([{ path: 'NEW.md', content: 'new' }]),
      });
      assert.notStrictEqual(result.status, 0);
      assert(result.stderr.includes('pre-commit validation passed, but git commit is not implemented yet'), `Expected pre-commit pass: ${result.stderr}`);
    } finally {
      cleanup();
    }
  });

  test('approved staged file passes pre-commit validation, then refuses before commit', () => {
    const { taskId, tasksFilePath, repoPath, cleanup } = createTempEnv();
    try {
      writeFileSync(join(repoPath, 'NEW.md'), 'new\n', 'utf-8');
      spawnSync('git', ['add', 'NEW.md'], {
        cwd: repoPath,
        encoding: 'utf-8',
        shell: false,
      });
      const result = runCli(['real-repo-commit', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_REPO_COMMIT: 'true',
        ALLOW_REAL_REPO_APPLY: 'true',
        REAL_REPO_PROVIDER_RESPONSE: buildFakeKimiOutput([{ path: 'NEW.md', content: 'new' }]),
      });
      assert.notStrictEqual(result.status, 0);
      assert(result.stderr.includes('pre-commit validation passed, but git commit is not implemented yet'), `Expected pre-commit pass: ${result.stderr}`);
    } finally {
      cleanup();
    }
  });

  test('successful pre-commit validation prints commit message preview', () => {
    const { taskId, tasksFilePath, repoPath, cleanup } = createTempEnv();
    try {
      writeFileSync(join(repoPath, 'README.md'), '# modified\n', 'utf-8');
      const result = runCli(['real-repo-commit', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_REPO_COMMIT: 'true',
        ALLOW_REAL_REPO_APPLY: 'true',
        REAL_REPO_PROVIDER_RESPONSE: buildFakeKimiOutput([{ path: 'README.md', content: 'modified' }]),
      });
      assert.notStrictEqual(result.status, 0);
      assert(result.stderr.includes('Commit message: ai-orchestrator: apply'), `Expected commit message preview: ${result.stderr}`);
      assert(result.stderr.includes(taskId), `Expected taskId in commit message: ${result.stderr}`);
    } finally {
      cleanup();
    }
  });

  test('commit message preview does not include provider response content', () => {
    const { taskId, tasksFilePath, repoPath, cleanup } = createTempEnv();
    try {
      writeFileSync(join(repoPath, 'README.md'), '# modified\n', 'utf-8');
      const result = runCli(['real-repo-commit', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_REPO_COMMIT: 'true',
        ALLOW_REAL_REPO_APPLY: 'true',
        REAL_REPO_PROVIDER_RESPONSE: buildFakeKimiOutput([{ path: 'README.md', content: 'modified' }]),
      });
      assert.notStrictEqual(result.status, 0);
      assert(!result.stderr.includes('file_update'), `Should not include provider response content: ${result.stderr}`);
    } finally {
      cleanup();
    }
  });

  test('commit message preview does not include file content', () => {
    const { taskId, tasksFilePath, repoPath, cleanup } = createTempEnv();
    try {
      writeFileSync(join(repoPath, 'README.md'), '# modified secret content\n', 'utf-8');
      const result = runCli(['real-repo-commit', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_REPO_COMMIT: 'true',
        ALLOW_REAL_REPO_APPLY: 'true',
        REAL_REPO_PROVIDER_RESPONSE: buildFakeKimiOutput([{ path: 'README.md', content: 'modified secret content' }]),
      });
      assert.notStrictEqual(result.status, 0);
      assert(!result.stderr.includes('secret content'), `Should not include file content: ${result.stderr}`);
    } finally {
      cleanup();
    }
  });

  test('fake API key value is not printed', () => {
    const { taskId, tasksFilePath, repoPath, cleanup } = createTempEnv();
    try {
      writeFileSync(join(repoPath, 'README.md'), '# modified\n', 'utf-8');
      const result = runCli(['real-repo-commit', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_REPO_COMMIT: 'true',
        ALLOW_REAL_REPO_APPLY: 'true',
        REAL_REPO_PROVIDER_RESPONSE: buildFakeKimiOutput([{ path: 'README.md', content: 'modified' }]),
        KIMI_API_KEY: 'sk-fake12345',
      });
      assert.notStrictEqual(result.status, 0);
      assert(!result.stderr.includes('sk-fake'), `Should not leak fake API key: ${result.stderr}`);
      assert(!result.stdout.includes('sk-fake'), `Should not leak fake API key in stdout: ${result.stdout}`);
    } finally {
      cleanup();
    }
  });

  test('no stack trace in all failure paths', () => {
    const { taskId, tasksFilePath, repoPath, cleanup } = createTempEnv();
    try {
      writeFileSync(join(repoPath, 'README.md'), '# modified\n', 'utf-8');
      const result = runCli(['real-repo-commit', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_REPO_COMMIT: 'true',
        ALLOW_REAL_REPO_APPLY: 'true',
        REAL_REPO_PROVIDER_RESPONSE: buildFakeKimiOutput([{ path: 'README.md', content: 'modified' }]),
      });
      assert.notStrictEqual(result.status, 0);
      assert(!result.stderr.includes('at '), `Should not contain stack trace: ${result.stderr}`);
    } finally {
      cleanup();
    }
  });

  test('no git commit is created in any path', () => {
    const { taskId, tasksFilePath, repoPath, cleanup } = createTempEnv();
    try {
      writeFileSync(join(repoPath, 'README.md'), '# modified\n', 'utf-8');
      const before = getGitLogCount(repoPath);
      runCli(['real-repo-commit', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_REPO_COMMIT: 'true',
        ALLOW_REAL_REPO_APPLY: 'true',
        REAL_REPO_PROVIDER_RESPONSE: buildFakeKimiOutput([{ path: 'README.md', content: 'modified' }]),
      });
      const after = getGitLogCount(repoPath);
      assert.strictEqual(after, before, `Commit count should not change`);
    } finally {
      cleanup();
    }
  });

  test('no git add / staging mutation is performed by the command', () => {
    const { taskId, tasksFilePath, repoPath, cleanup } = createTempEnv();
    try {
      writeFileSync(join(repoPath, 'README.md'), '# modified\n', 'utf-8');
      const before = getGitPorcelain(repoPath);
      runCli(['real-repo-commit', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_REPO_COMMIT: 'true',
        ALLOW_REAL_REPO_APPLY: 'true',
        REAL_REPO_PROVIDER_RESPONSE: buildFakeKimiOutput([{ path: 'README.md', content: 'modified' }]),
      });
      const after = getGitPorcelain(repoPath);
      assert.strictEqual(after, before, `Git porcelain should not change`);
    } finally {
      cleanup();
    }
  });

  test('no push', () => {
    const { taskId, tasksFilePath, repoPath, cleanup } = createTempEnv();
    try {
      writeFileSync(join(repoPath, 'README.md'), '# modified\n', 'utf-8');
      const result = runCli(['real-repo-commit', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_REPO_COMMIT: 'true',
        ALLOW_REAL_REPO_APPLY: 'true',
        REAL_REPO_PROVIDER_RESPONSE: buildFakeKimiOutput([{ path: 'README.md', content: 'modified' }]),
      });
      assert.notStrictEqual(result.status, 0);
      assert(result.stderr.includes('No push was performed'), `Expected no push message: ${result.stderr}`);
    } finally {
      cleanup();
    }
  });

  test('no merge', () => {
    const { taskId, tasksFilePath, repoPath, cleanup } = createTempEnv();
    try {
      writeFileSync(join(repoPath, 'README.md'), '# modified\n', 'utf-8');
      const result = runCli(['real-repo-commit', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_REPO_COMMIT: 'true',
        ALLOW_REAL_REPO_APPLY: 'true',
        REAL_REPO_PROVIDER_RESPONSE: buildFakeKimiOutput([{ path: 'README.md', content: 'modified' }]),
      });
      assert.notStrictEqual(result.status, 0);
      assert(result.stderr.includes('No merge was performed'), `Expected no merge message: ${result.stderr}`);
    } finally {
      cleanup();
    }
  });

  test('no checkout or switch branch', () => {
    const { taskId, tasksFilePath, repoPath, cleanup } = createTempEnv();
    try {
      writeFileSync(join(repoPath, 'README.md'), '# modified\n', 'utf-8');
      const before = getCurrentBranch(repoPath);
      runCli(['real-repo-commit', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_REPO_COMMIT: 'true',
        ALLOW_REAL_REPO_APPLY: 'true',
        REAL_REPO_PROVIDER_RESPONSE: buildFakeKimiOutput([{ path: 'README.md', content: 'modified' }]),
      });
      const after = getCurrentBranch(repoPath);
      assert.strictEqual(after, before, `Branch should not change: ${before} -> ${after}`);
    } finally {
      cleanup();
    }
  });

  test('no main touch', () => {
    const { taskId, tasksFilePath, repoPath, cleanup } = createTempEnv();
    try {
      writeFileSync(join(repoPath, 'README.md'), '# modified\n', 'utf-8');
      const before = getGitLogCount(repoPath);
      runCli(['real-repo-commit', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_REPO_COMMIT: 'true',
        ALLOW_REAL_REPO_APPLY: 'true',
        REAL_REPO_PROVIDER_RESPONSE: buildFakeKimiOutput([{ path: 'README.md', content: 'modified' }]),
      });
      // Switch to main to check its log
      spawnSync('git', ['stash', '--include-untracked'], {
        cwd: repoPath,
        encoding: 'utf-8',
        shell: false,
      });
      spawnSync('git', ['checkout', 'main'], {
        cwd: repoPath,
        encoding: 'utf-8',
        shell: false,
      });
      const mainLog = spawnSync('git', ['log', '--oneline'], {
        cwd: repoPath,
        encoding: 'utf-8',
        shell: false,
      }).stdout.trim().split('\n').filter((l) => l.length > 0).length;
      assert.strictEqual(mainLog, 1, `main should have exactly 1 commit`);
    } finally {
      cleanup();
    }
  });

  test('no state.json write', () => {
    const { taskId, tasksFilePath, repoPath, cleanup } = createTempEnv();
    try {
      writeFileSync(join(repoPath, 'README.md'), '# modified\n', 'utf-8');
      runCli(['real-repo-commit', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_REPO_COMMIT: 'true',
        ALLOW_REAL_REPO_APPLY: 'true',
        REAL_REPO_PROVIDER_RESPONSE: buildFakeKimiOutput([{ path: 'README.md', content: 'modified' }]),
      });
      const statePath = join(repoPath, 'runs', taskId, 'state.json');
      assert(!existsSync(statePath), `state.json should not exist: ${statePath}`);
    } finally {
      cleanup();
    }
  });

  test('no provider/network/API keys required', () => {
    const { taskId, tasksFilePath, repoPath, cleanup } = createTempEnv();
    try {
      writeFileSync(join(repoPath, 'README.md'), '# modified\n', 'utf-8');
      const result = runCli(['real-repo-commit', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_REPO_COMMIT: 'true',
        ALLOW_REAL_REPO_APPLY: 'true',
        REAL_REPO_PROVIDER_RESPONSE: buildFakeKimiOutput([{ path: 'README.md', content: 'modified' }]),
      });
      assert.notStrictEqual(result.status, 0);
      assert(!result.stderr.includes('KIMI_API_KEY'), `Should not require KIMI_API_KEY: ${result.stderr}`);
      assert(!result.stderr.includes('OPENAI_API_KEY'), `Should not require OPENAI_API_KEY: ${result.stderr}`);
      assert(!result.stderr.includes('Provider'), `Should not mention provider: ${result.stderr}`);
      assert(!result.stderr.includes('network'), `Should not mention network: ${result.stderr}`);
    } finally {
      cleanup();
    }
  });

  test('existing real-repo-apply behavior is not changed', () => {
    const { taskId, tasksFilePath, cleanup } = createTempEnv();
    try {
      const result = runCli(['real-repo-apply', taskId], {
        TASKS_FILE: tasksFilePath,
      });
      assert.notStrictEqual(result.status, 0);
      assert(result.stderr.includes('ALLOW_REAL_REPO_APPLY=true is required'), `real-repo-apply refusal unchanged: ${result.stderr}`);
    } finally {
      cleanup();
    }
  });
});
