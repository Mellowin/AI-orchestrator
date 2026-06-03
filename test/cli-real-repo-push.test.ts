import { describe, test } from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
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
  const taskId = `push-${id}`;
  const tmpBase = join(process.cwd(), 'tmp');
  if (!existsSync(tmpBase)) {
    mkdirSync(tmpBase);
  }
  const tmpDir = mkdtempSync(join(tmpBase, `push-${id}-`));
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
    title: "Push test"
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

function getCurrentBranch(repoPath: string): string {
  const result = spawnSync('git', ['branch', '--show-current'], {
    cwd: repoPath,
    encoding: 'utf-8',
    shell: false,
  });
  return result.stdout.trim();
}

describe('cli real-repo-push', () => {
  test('command exists and refuses safely', () => {
    const result = runCli(['real-repo-push']);
    assert.notStrictEqual(result.status, 0);
    assert(result.stderr.includes('No push was performed'), `Expected no push message: ${result.stderr}`);
  });

  test('missing taskId exits non-zero', () => {
    const result = runCli(['real-repo-push']);
    assert.notStrictEqual(result.status, 0);
    assert(result.stderr.includes('task id is required'), `Expected task id required: ${result.stderr}`);
  });

  test('missing taskId prints No push was performed', () => {
    const result = runCli(['real-repo-push']);
    assert.notStrictEqual(result.status, 0);
    assert(result.stderr.includes('No push was performed'), `Expected no push: ${result.stderr}`);
  });

  test('without ALLOW_REAL_REPO_PUSH, refuses with opt-in message', () => {
    const { taskId, tasksFilePath, cleanup } = createTempEnv();
    try {
      const result = runCli(['real-repo-push', taskId], {
        TASKS_FILE: tasksFilePath,
      });
      assert.notStrictEqual(result.status, 0);
      assert(result.stderr.includes('ALLOW_REAL_REPO_PUSH=true is required'), `Expected opt-in message: ${result.stderr}`);
    } finally {
      cleanup();
    }
  });

  test('without ALLOW_REAL_REPO_PUSH, does not require ALLOW_REAL_REPO_APPLY', () => {
    const { taskId, tasksFilePath, cleanup } = createTempEnv();
    try {
      const result = runCli(['real-repo-push', taskId], {
        TASKS_FILE: tasksFilePath,
      });
      assert.notStrictEqual(result.status, 0);
      assert(!result.stderr.includes('ALLOW_REAL_REPO_APPLY'), `Should not require ALLOW_REAL_REPO_APPLY: ${result.stderr}`);
    } finally {
      cleanup();
    }
  });

  test('without ALLOW_REAL_REPO_PUSH, does not require ALLOW_REAL_REPO_COMMIT', () => {
    const { taskId, tasksFilePath, cleanup } = createTempEnv();
    try {
      const result = runCli(['real-repo-push', taskId], {
        TASKS_FILE: tasksFilePath,
      });
      assert.notStrictEqual(result.status, 0);
      assert(!result.stderr.includes('ALLOW_REAL_REPO_COMMIT'), `Should not require ALLOW_REAL_REPO_COMMIT: ${result.stderr}`);
    } finally {
      cleanup();
    }
  });

  test('without ALLOW_REAL_REPO_PUSH, does not require REAL_REPO_PROVIDER_RESPONSE', () => {
    const { taskId, tasksFilePath, cleanup } = createTempEnv();
    try {
      const result = runCli(['real-repo-push', taskId], {
        TASKS_FILE: tasksFilePath,
      });
      assert.notStrictEqual(result.status, 0);
      assert(!result.stderr.includes('REAL_REPO_PROVIDER_RESPONSE'), `Should not require REAL_REPO_PROVIDER_RESPONSE: ${result.stderr}`);
    } finally {
      cleanup();
    }
  });

  test('with ALLOW_REAL_REPO_PUSH=true, still refuses because implementation disabled', () => {
    const { taskId, tasksFilePath, cleanup } = createTempEnv();
    try {
      const result = runCli(['real-repo-push', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_REPO_PUSH: 'true',
      });
      assert.notStrictEqual(result.status, 0);
      assert(result.stderr.includes('real-repo-push is not implemented yet'), `Expected not implemented: ${result.stderr}`);
    } finally {
      cleanup();
    }
  });

  test('with opt-in, prints Stage 4.4 push behavior remains disabled', () => {
    const { taskId, tasksFilePath, cleanup } = createTempEnv();
    try {
      const result = runCli(['real-repo-push', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_REPO_PUSH: 'true',
      });
      assert.notStrictEqual(result.status, 0);
      assert(result.stderr.includes('Stage 4.4 push behavior remains disabled'), `Expected stage 4.4 disabled: ${result.stderr}`);
    } finally {
      cleanup();
    }
  });

  test('with opt-in, prints Human review required before push', () => {
    const { taskId, tasksFilePath, cleanup } = createTempEnv();
    try {
      const result = runCli(['real-repo-push', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_REPO_PUSH: 'true',
      });
      assert.notStrictEqual(result.status, 0);
      assert(result.stderr.includes('Human review required before push'), `Expected human review: ${result.stderr}`);
    } finally {
      cleanup();
    }
  });

  test('does not call git push', () => {
    const { taskId, tasksFilePath, repoPath, cleanup } = createTempEnv();
    try {
      const before = spawnSync('git', ['log', '--oneline'], {
        cwd: repoPath,
        encoding: 'utf-8',
        shell: false,
      }).stdout.trim().split('\n').filter((l) => l.length > 0).length;
      runCli(['real-repo-push', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_REPO_PUSH: 'true',
      });
      const after = spawnSync('git', ['log', '--oneline'], {
        cwd: repoPath,
        encoding: 'utf-8',
        shell: false,
      }).stdout.trim().split('\n').filter((l) => l.length > 0).length;
      assert.strictEqual(after, before, `Log count should not change`);
    } finally {
      cleanup();
    }
  });

  test('does not call git merge', () => {
    const { taskId, tasksFilePath, repoPath, cleanup } = createTempEnv();
    try {
      const before = getCurrentBranch(repoPath);
      runCli(['real-repo-push', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_REPO_PUSH: 'true',
      });
      const after = getCurrentBranch(repoPath);
      assert.strictEqual(after, before, `Branch should not change`);
    } finally {
      cleanup();
    }
  });

  test('does not call git checkout or switch', () => {
    const { taskId, tasksFilePath, repoPath, cleanup } = createTempEnv();
    try {
      const before = getCurrentBranch(repoPath);
      runCli(['real-repo-push', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_REPO_PUSH: 'true',
      });
      const after = getCurrentBranch(repoPath);
      assert.strictEqual(after, before, `Branch should not change: ${before} -> ${after}`);
    } finally {
      cleanup();
    }
  });

  test('does not call git pull/fetch/rebase/reset', () => {
    const { taskId, tasksFilePath, repoPath, cleanup } = createTempEnv();
    try {
      const before = spawnSync('git', ['log', '--oneline'], {
        cwd: repoPath,
        encoding: 'utf-8',
        shell: false,
      }).stdout.trim().split('\n').filter((l) => l.length > 0).length;
      runCli(['real-repo-push', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_REPO_PUSH: 'true',
      });
      const after = spawnSync('git', ['log', '--oneline'], {
        cwd: repoPath,
        encoding: 'utf-8',
        shell: false,
      }).stdout.trim().split('\n').filter((l) => l.length > 0).length;
      assert.strictEqual(after, before, `Log count should not change`);
    } finally {
      cleanup();
    }
  });

  test('branch before/after remains the same', () => {
    const { taskId, tasksFilePath, repoPath, cleanup } = createTempEnv();
    try {
      const before = getCurrentBranch(repoPath);
      runCli(['real-repo-push', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_REPO_PUSH: 'true',
      });
      const after = getCurrentBranch(repoPath);
      assert.strictEqual(after, before, `Branch should not change: ${before} -> ${after}`);
    } finally {
      cleanup();
    }
  });

  test('no state.json write', () => {
    const { taskId, tasksFilePath, repoPath, cleanup } = createTempEnv();
    try {
      runCli(['real-repo-push', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_REPO_PUSH: 'true',
      });
      const statePath = join(repoPath, 'runs', taskId, 'state.json');
      assert(!existsSync(statePath), `state.json should not exist: ${statePath}`);
    } finally {
      cleanup();
    }
  });

  test('no provider/network/API key requirement', () => {
    const { taskId, tasksFilePath, cleanup } = createTempEnv();
    try {
      const result = runCli(['real-repo-push', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_REPO_PUSH: 'true',
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

  test('no stack trace', () => {
    const { taskId, tasksFilePath, cleanup } = createTempEnv();
    try {
      const result = runCli(['real-repo-push', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_REPO_PUSH: 'true',
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
      const result = runCli(['real-repo-push', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_REPO_PUSH: 'true',
        KIMI_API_KEY: 'sk-fake12345',
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

  test('existing real-repo-commit behavior is not changed', () => {
    const { taskId, tasksFilePath, cleanup } = createTempEnv();
    try {
      const result = runCli(['real-repo-commit', taskId], {
        TASKS_FILE: tasksFilePath,
      });
      assert.notStrictEqual(result.status, 0);
      assert(result.stderr.includes('ALLOW_REAL_REPO_COMMIT=true is required'), `real-repo-commit refusal unchanged: ${result.stderr}`);
    } finally {
      cleanup();
    }
  });
});
