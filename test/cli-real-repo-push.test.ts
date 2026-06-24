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
  originPath: string;
  runsDir: string;
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

  // Create bare remote and add as origin
  spawnSync('git', ['init', '--bare', originPath], {
    encoding: 'utf-8',
    shell: false,
  });
  spawnSync('git', ['remote', 'add', 'origin', originPath], {
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

function loadStateFromPath(runsDir: string, taskId: string): unknown {
  const statePath = join(runsDir, taskId, 'state.json');
  if (!existsSync(statePath)) {
    return null;
  }
  return JSON.parse(readFileSync(statePath, 'utf-8'));
}

function getGitPorcelain(repoPath: string): string {
  const result = spawnSync('git', ['status', '--porcelain', '--untracked-files=all'], {
    cwd: repoPath,
    encoding: 'utf-8',
    shell: false,
  });
  return result.stdout.trim();
}

describe('cli real-repo-push', () => {
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

  test('missing ALLOW_REAL_REPO_PUSH refuses', () => {
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

  test('missing ALLOW_REAL_REPO_PUSH does not require apply/commit/provider env', () => {
    const { taskId, tasksFilePath, cleanup } = createTempEnv();
    try {
      const result = runCli(['real-repo-push', taskId], {
        TASKS_FILE: tasksFilePath,
      });
      assert.notStrictEqual(result.status, 0);
      assert(!result.stderr.includes('ALLOW_REAL_REPO_APPLY'), `Should not require ALLOW_REAL_REPO_APPLY: ${result.stderr}`);
      assert(!result.stderr.includes('ALLOW_REAL_REPO_COMMIT'), `Should not require ALLOW_REAL_REPO_COMMIT: ${result.stderr}`);
      assert(!result.stderr.includes('REAL_REPO_PROVIDER_RESPONSE'), `Should not require REAL_REPO_PROVIDER_RESPONSE: ${result.stderr}`);
    } finally {
      cleanup();
    }
  });

  test('with opt-in, missing task refuses safely', () => {
    const { tasksFilePath, cleanup } = createTempEnv();
    try {
      const result = runCli(['real-repo-push', 'nonexistent-task'], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_REPO_PUSH: 'true',
      });
      assert.notStrictEqual(result.status, 0);
      assert(result.stderr.includes('Error:'), `Expected safe error: ${result.stderr}`);
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
      const result = runCli(['real-repo-push', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_REPO_PUSH: 'true',
      });
      assert.notStrictEqual(result.status, 0);
      assert(result.stderr.includes('Current branch is main'), `Expected main branch refusal: ${result.stderr}`);
    } finally {
      cleanup();
    }
  });

  test('task.work_branch main refuses', () => {
    const { taskId, tasksFilePath, cleanup } = createTempEnv();
    try {
      const tasksContent = readFileSync(tasksFilePath, 'utf-8');
      writeFileSync(tasksFilePath, tasksContent.replace(/work_branch: "ai\/[^"]+"/, 'work_branch: "main"'), 'utf-8');
      const result = runCli(['real-repo-push', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_REPO_PUSH: 'true',
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
      const result = runCli(['real-repo-push', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_REPO_PUSH: 'true',
      });
      assert.notStrictEqual(result.status, 0);
      assert(result.stderr.includes('Branch mismatch'), `Expected branch mismatch refusal: ${result.stderr}`);
    } finally {
      cleanup();
    }
  });

  test('dirty tracked working tree refuses', () => {
    const { taskId, tasksFilePath, repoPath, originPath, cleanup } = createTempEnv();
    try {
      writeFileSync(join(repoPath, 'README.md'), '# dirty\n', 'utf-8');
      const before = getBareRefs(originPath);
      const result = runCli(['real-repo-push', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_REPO_PUSH: 'true',
      });
      assert.notStrictEqual(result.status, 0);
      assert(result.stderr.includes('Working tree is not clean'), `Expected dirty tree refusal: ${result.stderr}`);
      const after = getBareRefs(originPath);
      assert.deepStrictEqual(after, before, `Bare remote should not change on dirty tree refusal`);
    } finally {
      cleanup();
    }
  });

  test('untracked file refuses', () => {
    const { taskId, tasksFilePath, repoPath, originPath, cleanup } = createTempEnv();
    try {
      writeFileSync(join(repoPath, 'UNTRACKED.md'), 'untracked\n', 'utf-8');
      const before = getBareRefs(originPath);
      const result = runCli(['real-repo-push', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_REPO_PUSH: 'true',
      });
      assert.notStrictEqual(result.status, 0);
      assert(result.stderr.includes('Working tree is not clean'), `Expected untracked refusal: ${result.stderr}`);
      const after = getBareRefs(originPath);
      assert.deepStrictEqual(after, before, `Bare remote should not change on untracked refusal`);
    } finally {
      cleanup();
    }
  });

  test('staged file refuses', () => {
    const { taskId, tasksFilePath, repoPath, originPath, cleanup } = createTempEnv();
    try {
      writeFileSync(join(repoPath, 'STAGED.md'), 'staged\n', 'utf-8');
      spawnSync('git', ['add', 'STAGED.md'], {
        cwd: repoPath,
        encoding: 'utf-8',
        shell: false,
      });
      const before = getBareRefs(originPath);
      const result = runCli(['real-repo-push', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_REPO_PUSH: 'true',
      });
      assert.notStrictEqual(result.status, 0);
      assert(result.stderr.includes('Working tree is not clean'), `Expected staged refusal: ${result.stderr}`);
      const after = getBareRefs(originPath);
      assert.deepStrictEqual(after, before, `Bare remote should not change on staged refusal`);
    } finally {
      cleanup();
    }
  });

  test('missing local HEAD commit refuses', () => {
    const { taskId, tasksFilePath, repoPath, originPath, cleanup } = createTempEnv();
    try {
      // Switch to main, delete work branch, create orphan work branch with no commits
      spawnSync('git', ['checkout', 'main'], {
        cwd: repoPath,
        encoding: 'utf-8',
        shell: false,
      });
      spawnSync('git', ['branch', '-D', `ai/${taskId}`], {
        cwd: repoPath,
        encoding: 'utf-8',
        shell: false,
      });
      spawnSync('git', ['checkout', '--orphan', `ai/${taskId}`], {
        cwd: repoPath,
        encoding: 'utf-8',
        shell: false,
      });
      // Remove tracked files from index and working tree for clean status
      spawnSync('git', ['rm', '-rf', '.'], {
        cwd: repoPath,
        encoding: 'utf-8',
        shell: false,
      });
      const before = getBareRefs(originPath);
      const result = runCli(['real-repo-push', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_REPO_PUSH: 'true',
      });
      assert.notStrictEqual(result.status, 0);
      assert(
        result.stderr.includes('No local HEAD commit exists') || result.stderr.includes('ambiguous argument \'HEAD\''),
        `Expected missing HEAD refusal: ${result.stderr}`
      );
      const after = getBareRefs(originPath);
      assert.deepStrictEqual(after, before, `Bare remote should not change on missing HEAD refusal`);
    } finally {
      cleanup();
    }
  });

  test('missing origin remote refuses', () => {
    const { taskId, tasksFilePath, repoPath, originPath, cleanup } = createTempEnv();
    try {
      spawnSync('git', ['remote', 'remove', 'origin'], {
        cwd: repoPath,
        encoding: 'utf-8',
        shell: false,
      });
      const before = getBareRefs(originPath);
      const result = runCli(['real-repo-push', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_REPO_PUSH: 'true',
      });
      assert.notStrictEqual(result.status, 0);
      assert(result.stderr.includes('Remote origin does not exist'), `Expected missing origin refusal: ${result.stderr}`);
      const after = getBareRefs(originPath);
      assert.deepStrictEqual(after, before, `Bare remote should not change on missing origin refusal`);
    } finally {
      cleanup();
    }
  });

  test('origin remote exists and clean branch passes validation', () => {
    const { taskId, tasksFilePath, cleanup } = createTempEnv();
    try {
      const result = runCli(['real-repo-push', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_REPO_PUSH: 'true',
      });
      assert.strictEqual(result.status, 0, `Expected success: ${result.stderr}`);
    } finally {
      cleanup();
    }
  });

  test('actual push updates local bare remote branch', () => {
    const { taskId, tasksFilePath, repoPath, originPath, cleanup } = createTempEnv();
    try {
      const before = getBareRefs(originPath);
      assert.strictEqual(before.length, 0, `Bare remote should have no refs before push`);

      const result = runCli(['real-repo-push', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_REPO_PUSH: 'true',
      });
      assert.strictEqual(result.status, 0, `Expected success: ${result.stderr}`);

      const after = getBareRefs(originPath);
      assert(after.length > 0, `Bare remote should have refs after push: ${after.join(', ')}`);
    } finally {
      cleanup();
    }
  });

  test('pushed branch name equals current work branch', () => {
    const { taskId, tasksFilePath, repoPath, originPath, cleanup } = createTempEnv();
    try {
      const branch = getCurrentBranch(repoPath);
      const result = runCli(['real-repo-push', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_REPO_PUSH: 'true',
      });
      assert.strictEqual(result.status, 0, `Expected success: ${result.stderr}`);

      const after = getBareRefs(originPath);
      const hasBranch = after.some((ref) => ref.includes(`refs/heads/${branch}`));
      assert(hasBranch, `Bare remote should have refs/heads/${branch}: ${after.join(', ')}`);
    } finally {
      cleanup();
    }
  });

  test('command output contains Push completed', () => {
    const { taskId, tasksFilePath, cleanup } = createTempEnv();
    try {
      const result = runCli(['real-repo-push', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_REPO_PUSH: 'true',
      });
      assert.strictEqual(result.status, 0, `Expected success: ${result.stderr}`);
      assert(result.stderr.includes('Push completed'), `Expected Push completed: ${result.stderr}`);
    } finally {
      cleanup();
    }
  });

  test('command output contains Push target: origin <currentBranch>', () => {
    const { taskId, tasksFilePath, repoPath, cleanup } = createTempEnv();
    try {
      const branch = getCurrentBranch(repoPath);
      const result = runCli(['real-repo-push', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_REPO_PUSH: 'true',
      });
      assert.strictEqual(result.status, 0, `Expected success: ${result.stderr}`);
      assert(result.stderr.includes(`Push target: origin ${branch}`), `Expected push target: ${result.stderr}`);
    } finally {
      cleanup();
    }
  });

  test('command does not push main', () => {
    const { taskId, tasksFilePath, repoPath, originPath, cleanup } = createTempEnv();
    try {
      const result = runCli(['real-repo-push', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_REPO_PUSH: 'true',
      });
      assert.strictEqual(result.status, 0, `Expected success: ${result.stderr}`);
      const after = getBareRefs(originPath);
      const hasMain = after.some((ref) => ref.includes('refs/heads/main'));
      assert(!hasMain, `Bare remote should NOT have refs/heads/main: ${after.join(', ')}`);
    } finally {
      cleanup();
    }
  });

  test('command does not push tags', () => {
    const { taskId, tasksFilePath, repoPath, originPath, cleanup } = createTempEnv();
    try {
      spawnSync('git', ['tag', 'v1.0.0'], {
        cwd: repoPath,
        encoding: 'utf-8',
        shell: false,
      });
      const result = runCli(['real-repo-push', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_REPO_PUSH: 'true',
      });
      assert.strictEqual(result.status, 0, `Expected success: ${result.stderr}`);
      const after = getBareRefs(originPath);
      const hasTag = after.some((ref) => ref.includes('refs/tags/'));
      assert(!hasTag, `Bare remote should NOT have tags: ${after.join(', ')}`);
    } finally {
      cleanup();
    }
  });

  test('command does not use force', () => {
    const { taskId, tasksFilePath, cleanup } = createTempEnv();
    try {
      const result = runCli(['real-repo-push', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_REPO_PUSH: 'true',
      });
      assert.strictEqual(result.status, 0, `Expected success: ${result.stderr}`);
      assert(!result.stderr.includes('--force'), `Should not mention force: ${result.stderr}`);
      assert(!result.stderr.includes('force'), `Should not mention force: ${result.stderr}`);
    } finally {
      cleanup();
    }
  });

  test('command does not use --all', () => {
    const { taskId, tasksFilePath, cleanup } = createTempEnv();
    try {
      const result = runCli(['real-repo-push', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_REPO_PUSH: 'true',
      });
      assert.strictEqual(result.status, 0, `Expected success: ${result.stderr}`);
      assert(!result.stderr.includes('--all'), `Should not mention --all: ${result.stderr}`);
    } finally {
      cleanup();
    }
  });

  test('command does not use --mirror', () => {
    const { taskId, tasksFilePath, cleanup } = createTempEnv();
    try {
      const result = runCli(['real-repo-push', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_REPO_PUSH: 'true',
      });
      assert.strictEqual(result.status, 0, `Expected success: ${result.stderr}`);
      assert(!result.stderr.includes('--mirror'), `Should not mention --mirror: ${result.stderr}`);
    } finally {
      cleanup();
    }
  });

  test('command does not merge', () => {
    const { taskId, tasksFilePath, repoPath, cleanup } = createTempEnv();
    try {
      const before = getCurrentBranch(repoPath);
      const result = runCli(['real-repo-push', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_REPO_PUSH: 'true',
      });
      assert.strictEqual(result.status, 0, `Expected success: ${result.stderr}`);
      const after = getCurrentBranch(repoPath);
      assert.strictEqual(after, before, `Branch should not change: ${before} -> ${after}`);
    } finally {
      cleanup();
    }
  });

  test('command does not checkout or switch branch', () => {
    const { taskId, tasksFilePath, repoPath, cleanup } = createTempEnv();
    try {
      const before = getCurrentBranch(repoPath);
      const result = runCli(['real-repo-push', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_REPO_PUSH: 'true',
      });
      assert.strictEqual(result.status, 0, `Expected success: ${result.stderr}`);
      const after = getCurrentBranch(repoPath);
      assert.strictEqual(after, before, `Branch should not change: ${before} -> ${after}`);
    } finally {
      cleanup();
    }
  });

  test('command does not pull/fetch/rebase/reset', () => {
    const { taskId, tasksFilePath, repoPath, cleanup } = createTempEnv();
    try {
      const before = spawnSync('git', ['log', '--oneline'], {
        cwd: repoPath,
        encoding: 'utf-8',
        shell: false,
      }).stdout.trim().split('\n').filter((l) => l.length > 0).length;
      const result = runCli(['real-repo-push', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_REPO_PUSH: 'true',
      });
      assert.strictEqual(result.status, 0, `Expected success: ${result.stderr}`);
      const after = spawnSync('git', ['log', '--oneline'], {
        cwd: repoPath,
        encoding: 'utf-8',
        shell: false,
      }).stdout.trim().split('\n').filter((l) => l.length > 0).length;
      assert.strictEqual(after, before, `Local log count should not change: ${before} -> ${after}`);
    } finally {
      cleanup();
    }
  });

  test('branch before/after remains unchanged', () => {
    const { taskId, tasksFilePath, repoPath, cleanup } = createTempEnv();
    try {
      const before = getCurrentBranch(repoPath);
      const result = runCli(['real-repo-push', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_REPO_PUSH: 'true',
      });
      assert.strictEqual(result.status, 0, `Expected success: ${result.stderr}`);
      const after = getCurrentBranch(repoPath);
      assert.strictEqual(after, before, `Branch should not change: ${before} -> ${after}`);
    } finally {
      cleanup();
    }
  });

  test('working tree before/after remains clean', () => {
    const { taskId, tasksFilePath, repoPath, cleanup } = createTempEnv();
    try {
      const before = getGitPorcelain(repoPath);
      assert.strictEqual(before, '', `Working tree should be clean before push: ${before}`);
      const result = runCli(['real-repo-push', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_REPO_PUSH: 'true',
      });
      assert.strictEqual(result.status, 0, `Expected success: ${result.stderr}`);
      const after = getGitPorcelain(repoPath);
      assert.strictEqual(after, '', `Working tree should be clean after push: ${after}`);
    } finally {
      cleanup();
    }
  });

  test('successful push writes state', () => {
    const { taskId, tasksFilePath, runsDir, cleanup } = createTempEnv();
    try {
      const result = runCli(['real-repo-push', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_REPO_PUSH: 'true',
        RUNS_DIR: runsDir,
      });
      assert.strictEqual(result.status, 0, `Expected success: ${result.stderr}`);
      const state = loadStateFromPath(runsDir, taskId);
      assert.notStrictEqual(state, null, `State should be written`);
    } finally {
      cleanup();
    }
  });

  test('state status is pushed', () => {
    const { taskId, tasksFilePath, runsDir, cleanup } = createTempEnv();
    try {
      runCli(['real-repo-push', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_REPO_PUSH: 'true',
        RUNS_DIR: runsDir,
      });
      const state = loadStateFromPath(runsDir, taskId) as Record<string, unknown>;
      assert.strictEqual(state.status, 'pushed');
    } finally {
      cleanup();
    }
  });

  test('state contains taskId', () => {
    const { taskId, tasksFilePath, runsDir, cleanup } = createTempEnv();
    try {
      runCli(['real-repo-push', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_REPO_PUSH: 'true',
        RUNS_DIR: runsDir,
      });
      const state = loadStateFromPath(runsDir, taskId) as Record<string, unknown>;
      assert.strictEqual(state.task_id, taskId);
    } finally {
      cleanup();
    }
  });

  test('state contains current branch', () => {
    const { taskId, tasksFilePath, repoPath, runsDir, cleanup } = createTempEnv();
    try {
      const branch = getCurrentBranch(repoPath);
      runCli(['real-repo-push', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_REPO_PUSH: 'true',
        RUNS_DIR: runsDir,
      });
      const state = loadStateFromPath(runsDir, taskId) as Record<string, unknown>;
      assert.strictEqual(state.branch, branch);
    } finally {
      cleanup();
    }
  });

  test('state contains pushed remote origin', () => {
    const { taskId, tasksFilePath, runsDir, cleanup } = createTempEnv();
    try {
      runCli(['real-repo-push', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_REPO_PUSH: 'true',
        RUNS_DIR: runsDir,
      });
      const state = loadStateFromPath(runsDir, taskId) as Record<string, unknown>;
      assert.strictEqual(state.pushed_remote, 'origin');
    } finally {
      cleanup();
    }
  });

  test('state contains pushed ref/currentBranch', () => {
    const { taskId, tasksFilePath, repoPath, runsDir, cleanup } = createTempEnv();
    try {
      const branch = getCurrentBranch(repoPath);
      runCli(['real-repo-push', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_REPO_PUSH: 'true',
        RUNS_DIR: runsDir,
      });
      const state = loadStateFromPath(runsDir, taskId) as Record<string, unknown>;
      assert.strictEqual(state.pushed_ref, branch);
    } finally {
      cleanup();
    }
  });

  test('state contains HEAD commit SHA', () => {
    const { taskId, tasksFilePath, repoPath, runsDir, cleanup } = createTempEnv();
    try {
      const headSha = spawnSync('git', ['rev-parse', '--verify', 'HEAD'], {
        cwd: repoPath,
        encoding: 'utf-8',
        shell: false,
      }).stdout.trim();
      runCli(['real-repo-push', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_REPO_PUSH: 'true',
        RUNS_DIR: runsDir,
      });
      const state = loadStateFromPath(runsDir, taskId) as Record<string, unknown>;
      assert.strictEqual(state.commit_sha, headSha);
    } finally {
      cleanup();
    }
  });

  test('state contains updated_at timestamp', () => {
    const { taskId, tasksFilePath, runsDir, cleanup } = createTempEnv();
    try {
      const before = Date.now();
      runCli(['real-repo-push', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_REPO_PUSH: 'true',
        RUNS_DIR: runsDir,
      });
      const after = Date.now();
      const state = loadStateFromPath(runsDir, taskId) as Record<string, unknown>;
      const updatedAt = new Date(String(state.updated_at)).getTime();
      assert(updatedAt >= before && updatedAt <= after, `updated_at should be recent: ${state.updated_at}`);
    } finally {
      cleanup();
    }
  });

  test('state contains safety note', () => {
    const { taskId, tasksFilePath, runsDir, cleanup } = createTempEnv();
    try {
      runCli(['real-repo-push', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_REPO_PUSH: 'true',
        RUNS_DIR: runsDir,
      });
      const state = loadStateFromPath(runsDir, taskId) as Record<string, unknown>;
      assert.strictEqual(
        state.safety_note,
        'Push completed; merge not performed; human review required before merge'
      );
    } finally {
      cleanup();
    }
  });

  test('state does NOT contain provider response content', () => {
    const { taskId, tasksFilePath, runsDir, cleanup } = createTempEnv();
    try {
      runCli(['real-repo-push', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_REPO_PUSH: 'true',
        RUNS_DIR: runsDir,
      });
      const stateRaw = readFileSync(join(runsDir, taskId, 'state.json'), 'utf-8');
      assert(!stateRaw.includes('file_update'), `State should not contain provider response content`);
    } finally {
      cleanup();
    }
  });

  test('state does NOT contain file contents', () => {
    const { taskId, tasksFilePath, runsDir, cleanup } = createTempEnv();
    try {
      runCli(['real-repo-push', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_REPO_PUSH: 'true',
        RUNS_DIR: runsDir,
      });
      const stateRaw = readFileSync(join(runsDir, taskId, 'state.json'), 'utf-8');
      assert(!stateRaw.includes('# hello'), `State should not contain file contents`);
    } finally {
      cleanup();
    }
  });

  test('state does NOT contain fake API key', () => {
    const { taskId, tasksFilePath, runsDir, cleanup } = createTempEnv();
    try {
      runCli(['real-repo-push', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_REPO_PUSH: 'true',
        RUNS_DIR: runsDir,
        KIMI_API_KEY: 'sk-fake12345',
      });
      const stateRaw = readFileSync(join(runsDir, taskId, 'state.json'), 'utf-8');
      assert(!stateRaw.includes('sk-fake'), `State should not contain fake API key`);
    } finally {
      cleanup();
    }
  });

  test('state does NOT contain remote URL with credentials', () => {
    const { taskId, tasksFilePath, runsDir, cleanup } = createTempEnv();
    try {
      runCli(['real-repo-push', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_REPO_PUSH: 'true',
        RUNS_DIR: runsDir,
      });
      const state = loadStateFromPath(runsDir, taskId) as Record<string, unknown>;
      assert(!('remote_url' in state), `State should not contain remote_url field`);
      assert(!('origin_url' in state), `State should not contain origin_url field`);
    } finally {
      cleanup();
    }
  });

  test('validation failure does not write state', () => {
    const { taskId, tasksFilePath, repoPath, runsDir, cleanup } = createTempEnv();
    try {
      writeFileSync(join(repoPath, 'README.md'), '# dirty\n', 'utf-8');
      runCli(['real-repo-push', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_REPO_PUSH: 'true',
        RUNS_DIR: runsDir,
      });
      const state = loadStateFromPath(runsDir, taskId);
      assert.strictEqual(state, null, `State should not be written on validation failure`);
    } finally {
      cleanup();
    }
  });

  test('dirty tree refusal does not write state', () => {
    const { taskId, tasksFilePath, repoPath, runsDir, cleanup } = createTempEnv();
    try {
      writeFileSync(join(repoPath, 'README.md'), '# dirty\n', 'utf-8');
      runCli(['real-repo-push', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_REPO_PUSH: 'true',
        RUNS_DIR: runsDir,
      });
      const state = loadStateFromPath(runsDir, taskId);
      assert.strictEqual(state, null, `State should not be written on dirty tree refusal`);
    } finally {
      cleanup();
    }
  });

  test('missing remote refusal does not write state', () => {
    const { taskId, tasksFilePath, repoPath, runsDir, cleanup } = createTempEnv();
    try {
      spawnSync('git', ['remote', 'remove', 'origin'], {
        cwd: repoPath,
        encoding: 'utf-8',
        shell: false,
      });
      runCli(['real-repo-push', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_REPO_PUSH: 'true',
        RUNS_DIR: runsDir,
      });
      const state = loadStateFromPath(runsDir, taskId);
      assert.strictEqual(state, null, `State should not be written on missing remote refusal`);
    } finally {
      cleanup();
    }
  });

  test('push failure does not write state', () => {
    const { taskId, tasksFilePath, repoPath, runsDir, cleanup } = createTempEnv();
    try {
      spawnSync('git', ['remote', 'set-url', 'origin', '/nonexistent/remote.git'], {
        cwd: repoPath,
        encoding: 'utf-8',
        shell: false,
      });
      runCli(['real-repo-push', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_REPO_PUSH: 'true',
        RUNS_DIR: runsDir,
      });
      const state = loadStateFromPath(runsDir, taskId);
      assert.strictEqual(state, null, `State should not be written on push failure`);
    } finally {
      cleanup();
    }
  });

  test('state write failure after push is reported safely', () => {
    const { taskId, tasksFilePath, runsDir, cleanup } = createTempEnv();
    try {
      // Make runsDir a file so mkdirSync fails
      rmSync(runsDir, { recursive: true, force: true });
      writeFileSync(runsDir, 'not-a-dir', 'utf-8');
      const result = runCli(['real-repo-push', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_REPO_PUSH: 'true',
        RUNS_DIR: runsDir,
      });
      assert.notStrictEqual(result.status, 0);
      assert(result.stderr.includes('Push completed'), `Expected Push completed: ${result.stderr}`);
      assert(result.stderr.includes('State write failed'), `Expected State write failed: ${result.stderr}`);
      assert(result.stderr.includes('Manual inspection required'), `Expected manual inspection: ${result.stderr}`);
    } finally {
      cleanup();
    }
  });

  test('state write failure does not retry push', () => {
    const { taskId, tasksFilePath, originPath, runsDir, cleanup } = createTempEnv();
    try {
      rmSync(runsDir, { recursive: true, force: true });
      writeFileSync(runsDir, 'not-a-dir', 'utf-8');
      runCli(['real-repo-push', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_REPO_PUSH: 'true',
        RUNS_DIR: runsDir,
      });
      const after = getBareRefs(originPath);
      // Push succeeded once; verify branch exists and no duplicate refs from retry
      assert(after.length === 1, `Bare remote should have exactly 1 ref after single push: ${after.join(', ')}`);
    } finally {
      cleanup();
    }
  });

  test('state write failure does not merge', () => {
    const { taskId, tasksFilePath, repoPath, runsDir, cleanup } = createTempEnv();
    try {
      const before = getCurrentBranch(repoPath);
      rmSync(runsDir, { recursive: true, force: true });
      writeFileSync(runsDir, 'not-a-dir', 'utf-8');
      runCli(['real-repo-push', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_REPO_PUSH: 'true',
        RUNS_DIR: runsDir,
      });
      const after = getCurrentBranch(repoPath);
      assert.strictEqual(after, before, `Branch should not change on state write failure`);
    } finally {
      cleanup();
    }
  });

  test('state write failure does not checkout/switch', () => {
    const { taskId, tasksFilePath, repoPath, runsDir, cleanup } = createTempEnv();
    try {
      const before = getCurrentBranch(repoPath);
      rmSync(runsDir, { recursive: true, force: true });
      writeFileSync(runsDir, 'not-a-dir', 'utf-8');
      runCli(['real-repo-push', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_REPO_PUSH: 'true',
        RUNS_DIR: runsDir,
      });
      const after = getCurrentBranch(repoPath);
      assert.strictEqual(after, before, `Branch should not change on state write failure: ${before} -> ${after}`);
    } finally {
      cleanup();
    }
  });

  test('successful push still does not merge', () => {
    const { taskId, tasksFilePath, repoPath, runsDir, cleanup } = createTempEnv();
    try {
      const before = getCurrentBranch(repoPath);
      runCli(['real-repo-push', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_REPO_PUSH: 'true',
        RUNS_DIR: runsDir,
      });
      const after = getCurrentBranch(repoPath);
      assert.strictEqual(after, before, `Branch should not change: ${before} -> ${after}`);
    } finally {
      cleanup();
    }
  });

  test('successful push still does not checkout/switch', () => {
    const { taskId, tasksFilePath, repoPath, runsDir, cleanup } = createTempEnv();
    try {
      const before = getCurrentBranch(repoPath);
      runCli(['real-repo-push', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_REPO_PUSH: 'true',
        RUNS_DIR: runsDir,
      });
      const after = getCurrentBranch(repoPath);
      assert.strictEqual(after, before, `Branch should not change: ${before} -> ${after}`);
    } finally {
      cleanup();
    }
  });

  test('successful push still does not touch main', () => {
    const { taskId, tasksFilePath, repoPath, originPath, runsDir, cleanup } = createTempEnv();
    try {
      runCli(['real-repo-push', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_REPO_PUSH: 'true',
        RUNS_DIR: runsDir,
      });
      const after = getBareRefs(originPath);
      const hasMain = after.some((ref) => ref.includes('refs/heads/main'));
      assert(!hasMain, `Bare remote should NOT have refs/heads/main: ${after.join(', ')}`);
    } finally {
      cleanup();
    }
  });

  test('successful push still does not call provider', () => {
    const { taskId, tasksFilePath, runsDir, cleanup } = createTempEnv();
    try {
      const result = runCli(['real-repo-push', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_REPO_PUSH: 'true',
        RUNS_DIR: runsDir,
      });
      assert.strictEqual(result.status, 0, `Expected success: ${result.stderr}`);
      assert(!result.stderr.includes('Provider'), `Should not mention provider: ${result.stderr}`);
      assert(!result.stderr.includes('network'), `Should not mention network: ${result.stderr}`);
    } finally {
      cleanup();
    }
  });

  test('successful push still does not require API keys', () => {
    const { taskId, tasksFilePath, runsDir, cleanup } = createTempEnv();
    try {
      const result = runCli(['real-repo-push', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_REPO_PUSH: 'true',
        RUNS_DIR: runsDir,
      });
      assert.strictEqual(result.status, 0, `Expected success: ${result.stderr}`);
      assert(!result.stderr.includes('KIMI_API_KEY'), `Should not require KIMI_API_KEY: ${result.stderr}`);
      assert(!result.stderr.includes('OPENAI_API_KEY'), `Should not require OPENAI_API_KEY: ${result.stderr}`);
    } finally {
      cleanup();
    }
  });

  test('no provider/API keys required', () => {
    const { taskId, tasksFilePath, runsDir, cleanup } = createTempEnv();
    try {
      const result = runCli(['real-repo-push', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_REPO_PUSH: 'true',
        RUNS_DIR: runsDir,
      });
      assert.strictEqual(result.status, 0, `Expected success: ${result.stderr}`);
      assert(!result.stderr.includes('KIMI_API_KEY'), `Should not require KIMI_API_KEY: ${result.stderr}`);
      assert(!result.stderr.includes('OPENAI_API_KEY'), `Should not require OPENAI_API_KEY: ${result.stderr}`);
      assert(!result.stderr.includes('Provider'), `Should not mention provider: ${result.stderr}`);
      assert(!result.stderr.includes('network'), `Should not mention network: ${result.stderr}`);
    } finally {
      cleanup();
    }
  });

  test('fake API key is not printed', () => {
    const { taskId, tasksFilePath, runsDir, cleanup } = createTempEnv();
    try {
      const result = runCli(['real-repo-push', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_REPO_PUSH: 'true',
        RUNS_DIR: runsDir,
        KIMI_API_KEY: 'sk-fake12345',
      });
      assert.strictEqual(result.status, 0, `Expected success: ${result.stderr}`);
      assert(!result.stderr.includes('sk-fake'), `Should not leak fake API key: ${result.stderr}`);
      assert(!result.stdout.includes('sk-fake'), `Should not leak fake API key in stdout: ${result.stdout}`);
    } finally {
      cleanup();
    }
  });

  test('no stack trace in failure paths', () => {
    const { taskId, tasksFilePath, repoPath, cleanup } = createTempEnv();
    try {
      writeFileSync(join(repoPath, 'README.md'), '# dirty\n', 'utf-8');
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

  test('no stack trace in state failure path', () => {
    const { taskId, tasksFilePath, runsDir, cleanup } = createTempEnv();
    try {
      rmSync(runsDir, { recursive: true, force: true });
      writeFileSync(runsDir, 'not-a-dir', 'utf-8');
      const result = runCli(['real-repo-push', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_REPO_PUSH: 'true',
        RUNS_DIR: runsDir,
      });
      assert.notStrictEqual(result.status, 0);
      assert(!result.stderr.includes('at '), `Should not contain stack trace: ${result.stderr}`);
    } finally {
      cleanup();
    }
  });

  test('fake API key not printed in state failure path', () => {
    const { taskId, tasksFilePath, runsDir, cleanup } = createTempEnv();
    try {
      rmSync(runsDir, { recursive: true, force: true });
      writeFileSync(runsDir, 'not-a-dir', 'utf-8');
      const result = runCli(['real-repo-push', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_REPO_PUSH: 'true',
        RUNS_DIR: runsDir,
        KIMI_API_KEY: 'sk-fake12345',
      });
      assert.notStrictEqual(result.status, 0);
      assert(!result.stderr.includes('sk-fake'), `Should not leak fake API key: ${result.stderr}`);
      assert(!result.stdout.includes('sk-fake'), `Should not leak fake API key in stdout: ${result.stdout}`);
    } finally {
      cleanup();
    }
  });

  test('push failure prints Git push failed + Manual inspection required', () => {
    const { taskId, tasksFilePath, repoPath, cleanup } = createTempEnv();
    try {
      // Set origin to invalid path to force push failure
      spawnSync('git', ['remote', 'set-url', 'origin', '/nonexistent/remote.git'], {
        cwd: repoPath,
        encoding: 'utf-8',
        shell: false,
      });
      const result = runCli(['real-repo-push', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_REPO_PUSH: 'true',
      });
      assert.notStrictEqual(result.status, 0);
      assert(result.stderr.includes('Git push failed'), `Expected Git push failed: ${result.stderr}`);
      assert(result.stderr.includes('Manual inspection required'), `Expected manual inspection: ${result.stderr}`);
    } finally {
      cleanup();
    }
  });

  test('existing real-repo-apply behavior is unchanged', () => {
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

  test('existing real-repo-commit behavior is unchanged', () => {
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
