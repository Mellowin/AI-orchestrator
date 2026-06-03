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

describe('cli real-repo-commit', () => {
  test('command exists and refuses safely', () => {
    const { taskId, tasksFilePath, cleanup } = createTempEnv();
    try {
      const result = runCli(['real-repo-commit', taskId], {
        TASKS_FILE: tasksFilePath,
      });
      assert.notStrictEqual(result.status, 0, `Expected non-zero exit: ${result.stderr}`);
    } finally {
      cleanup();
    }
  });

  test('missing taskId exits non-zero', () => {
    const result = runCli(['real-repo-commit']);
    assert.notStrictEqual(result.status, 0);
  });

  test('missing taskId prints No commit was made', () => {
    const result = runCli(['real-repo-commit']);
    assert(result.stderr.includes('No commit was made'), `Expected "No commit was made": ${result.stderr}`);
  });

  test('without ALLOW_REAL_REPO_COMMIT refuses with opt-in message', () => {
    const { taskId, tasksFilePath, cleanup } = createTempEnv();
    try {
      const result = runCli(['real-repo-commit', taskId], {
        TASKS_FILE: tasksFilePath,
      });
      assert.notStrictEqual(result.status, 0);
      assert(result.stderr.includes('ALLOW_REAL_REPO_COMMIT=true is required'), `Expected opt-in message: ${result.stderr}`);
    } finally {
      cleanup();
    }
  });

  test('without ALLOW_REAL_REPO_COMMIT does not require ALLOW_REAL_REPO_APPLY', () => {
    const { taskId, tasksFilePath, cleanup } = createTempEnv();
    try {
      const result = runCli(['real-repo-commit', taskId], {
        TASKS_FILE: tasksFilePath,
      });
      assert.notStrictEqual(result.status, 0);
      assert(!result.stderr.includes('ALLOW_REAL_REPO_APPLY'), `Should not require ALLOW_REAL_REPO_APPLY: ${result.stderr}`);
    } finally {
      cleanup();
    }
  });

  test('without ALLOW_REAL_REPO_COMMIT does not require REAL_REPO_PROVIDER_RESPONSE', () => {
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

  test('with ALLOW_REAL_REPO_COMMIT=true still refuses because implementation is disabled', () => {
    const { taskId, tasksFilePath, cleanup } = createTempEnv();
    try {
      const result = runCli(['real-repo-commit', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_REPO_COMMIT: 'true',
      });
      assert.notStrictEqual(result.status, 0);
      assert(result.stderr.includes('real-repo-commit is not implemented yet'), `Expected not-implemented message: ${result.stderr}`);
    } finally {
      cleanup();
    }
  });

  test('with ALLOW_REAL_REPO_COMMIT=true prints Stage 4.3 commit behavior remains disabled', () => {
    const { taskId, tasksFilePath, cleanup } = createTempEnv();
    try {
      const result = runCli(['real-repo-commit', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_REPO_COMMIT: 'true',
      });
      assert.notStrictEqual(result.status, 0);
      assert(result.stderr.includes('Stage 4.3 commit behavior remains disabled'), `Expected Stage 4.3 disabled: ${result.stderr}`);
    } finally {
      cleanup();
    }
  });

  test('with ALLOW_REAL_REPO_COMMIT=true prints Human review required before commit', () => {
    const { taskId, tasksFilePath, cleanup } = createTempEnv();
    try {
      const result = runCli(['real-repo-commit', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_REPO_COMMIT: 'true',
      });
      assert.notStrictEqual(result.status, 0);
      assert(result.stderr.includes('Human review required before commit'), `Expected human review message: ${result.stderr}`);
    } finally {
      cleanup();
    }
  });

  test('does not modify repo files', () => {
    const { taskId, tasksFilePath, repoPath, cleanup } = createTempEnv();
    try {
      const before = readFileSync(join(repoPath, 'README.md'), 'utf-8');
      runCli(['real-repo-commit', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_REPO_COMMIT: 'true',
      });
      const after = readFileSync(join(repoPath, 'README.md'), 'utf-8');
      assert.strictEqual(after, before);
    } finally {
      cleanup();
    }
  });

  test('does not create new files', () => {
    const { taskId, tasksFilePath, repoPath, cleanup } = createTempEnv();
    try {
      const before = readdirSync(repoPath);
      runCli(['real-repo-commit', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_REPO_COMMIT: 'true',
      });
      const after = readdirSync(repoPath);
      assert.deepStrictEqual(after, before);
    } finally {
      cleanup();
    }
  });

  test('does not write state.json', () => {
    const { taskId, tasksFilePath, repoPath, cleanup } = createTempEnv();
    try {
      runCli(['real-repo-commit', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_REPO_COMMIT: 'true',
      });
      const statePath = join(repoPath, 'runs', taskId, 'state.json');
      assert(!existsSync(statePath), `state.json should not exist: ${statePath}`);
    } finally {
      cleanup();
    }
  });

  test('does not commit', () => {
    const { taskId, tasksFilePath, repoPath, cleanup } = createTempEnv();
    try {
      const logBefore = spawnSync('git', ['log', '--oneline'], {
        cwd: repoPath,
        encoding: 'utf-8',
        shell: false,
      }).stdout.trim().split('\n').length;
      runCli(['real-repo-commit', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_REPO_COMMIT: 'true',
      });
      const logAfter = spawnSync('git', ['log', '--oneline'], {
        cwd: repoPath,
        encoding: 'utf-8',
        shell: false,
      }).stdout.trim().split('\n').length;
      assert.strictEqual(logAfter, logBefore, `Commit count should not change`);
    } finally {
      cleanup();
    }
  });

  test('does not stage files with git add', () => {
    const { taskId, tasksFilePath, repoPath, cleanup } = createTempEnv();
    try {
      const statusBefore = spawnSync('git', ['status', '--short'], {
        cwd: repoPath,
        encoding: 'utf-8',
        shell: false,
      }).stdout.trim();
      runCli(['real-repo-commit', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_REPO_COMMIT: 'true',
      });
      const statusAfter = spawnSync('git', ['status', '--short'], {
        cwd: repoPath,
        encoding: 'utf-8',
        shell: false,
      }).stdout.trim();
      assert.strictEqual(statusAfter, statusBefore, `Git status should not change`);
    } finally {
      cleanup();
    }
  });

  test('does not push', () => {
    const { taskId, tasksFilePath, cleanup } = createTempEnv();
    try {
      const result = runCli(['real-repo-commit', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_REPO_COMMIT: 'true',
      });
      assert.notStrictEqual(result.status, 0);
      assert(result.stderr.includes('No push was performed'), `Expected no push message: ${result.stderr}`);
    } finally {
      cleanup();
    }
  });

  test('does not merge', () => {
    const { taskId, tasksFilePath, cleanup } = createTempEnv();
    try {
      const result = runCli(['real-repo-commit', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_REPO_COMMIT: 'true',
      });
      assert.notStrictEqual(result.status, 0);
      assert(result.stderr.includes('No merge was performed'), `Expected no merge message: ${result.stderr}`);
    } finally {
      cleanup();
    }
  });

  test('does not checkout or switch branch', () => {
    const { taskId, tasksFilePath, repoPath, cleanup } = createTempEnv();
    try {
      const branchBefore = spawnSync('git', ['branch', '--show-current'], {
        cwd: repoPath,
        encoding: 'utf-8',
        shell: false,
      }).stdout.trim();
      runCli(['real-repo-commit', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_REPO_COMMIT: 'true',
      });
      const branchAfter = spawnSync('git', ['branch', '--show-current'], {
        cwd: repoPath,
        encoding: 'utf-8',
        shell: false,
      }).stdout.trim();
      assert.strictEqual(branchAfter, branchBefore, `Branch should not change: ${branchBefore} -> ${branchAfter}`);
    } finally {
      cleanup();
    }
  });

  test('does not touch main', () => {
    const { taskId, tasksFilePath, repoPath, cleanup } = createTempEnv();
    try {
      runCli(['real-repo-commit', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_REPO_COMMIT: 'true',
      });
      const mainLog = spawnSync('git', ['log', 'main', '--oneline'], {
        cwd: repoPath,
        encoding: 'utf-8',
        shell: false,
      }).stdout.trim();
      assert.strictEqual(mainLog.split('\n').length, 1, `main should have exactly 1 commit`);
    } finally {
      cleanup();
    }
  });

  test('does not require API keys', () => {
    const { taskId, tasksFilePath, cleanup } = createTempEnv();
    try {
      const result = runCli(['real-repo-commit', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_REPO_COMMIT: 'true',
      });
      assert.notStrictEqual(result.status, 0);
      assert(!result.stderr.includes('KIMI_API_KEY'), `Should not require KIMI_API_KEY: ${result.stderr}`);
      assert(!result.stderr.includes('OPENAI_API_KEY'), `Should not require OPENAI_API_KEY: ${result.stderr}`);
    } finally {
      cleanup();
    }
  });

  test('does not call provider/network', () => {
    const { taskId, tasksFilePath, cleanup } = createTempEnv();
    try {
      const result = runCli(['real-repo-commit', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_REPO_COMMIT: 'true',
      });
      assert.notStrictEqual(result.status, 0);
      assert(!result.stderr.includes('Provider'), `Should not mention provider: ${result.stderr}`);
      assert(!result.stderr.includes('network'), `Should not mention network: ${result.stderr}`);
    } finally {
      cleanup();
    }
  });

  test('output contains no stack trace', () => {
    const { taskId, tasksFilePath, cleanup } = createTempEnv();
    try {
      const result = runCli(['real-repo-commit', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_REPO_COMMIT: 'true',
      });
      assert.notStrictEqual(result.status, 0);
      assert(!result.stderr.includes('at '), `Should not contain stack trace: ${result.stderr}`);
    } finally {
      cleanup();
    }
  });

  test('fake API key value is not printed', () => {
    const { taskId, tasksFilePath, cleanup } = createTempEnv();
    try {
      const result = runCli(['real-repo-commit', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_REPO_COMMIT: 'true',
      });
      assert.notStrictEqual(result.status, 0);
      assert(!result.stderr.includes('sk-fake'), `Should not leak fake API key: ${result.stderr}`);
      assert(!result.stdout.includes('sk-fake'), `Should not leak fake API key in stdout: ${result.stdout}`);
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
