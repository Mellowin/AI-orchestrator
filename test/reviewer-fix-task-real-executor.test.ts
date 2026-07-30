import { describe, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { createReviewerFixTaskRealExecutor } from '../src/reviewer-fix-task-real-executor.js';
import type { Task } from '../src/types.js';
import type { ReviewerFixTaskExecutorInput } from '../src/reviewer-fix-task-runner.js';

const envBackup: Record<string, string | undefined> = {};

function setEnv(key: string, value: string): void {
  if (!(key in envBackup)) {
    envBackup[key] = process.env[key];
  }
  process.env[key] = value;
}

function restoreEnv(): void {
  for (const [key, value] of Object.entries(envBackup)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

function createTempRepo(): { repoPath: string; baseBranch: string } {
  const tmpBase = join(process.cwd(), 'tmp');
  if (!existsSync(tmpBase)) {
    mkdirSync(tmpBase);
  }
  const repoPath = mkdtempSync(join(tmpBase, 'fix-real-exec-'));
  spawnSync('git', ['init'], { cwd: repoPath, encoding: 'utf-8', shell: false });
  spawnSync('git', ['config', 'user.email', 'test@test.com'], {
    cwd: repoPath,
    encoding: 'utf-8',
    shell: false,
  });
  spawnSync('git', ['config', 'user.name', 'Test'], {
    cwd: repoPath,
    encoding: 'utf-8',
    shell: false,
  });
  spawnSync('git', ['config', 'core.autocrlf', 'false'], {
    cwd: repoPath,
    encoding: 'utf-8',
    shell: false,
  });
  writeFileSync(join(repoPath, 'base.txt'), 'base\n', 'utf-8');
  spawnSync('git', ['add', '.'], { cwd: repoPath, encoding: 'utf-8', shell: false });
  spawnSync('git', ['commit', '-m', 'init', '--no-gpg-sign'], {
    cwd: repoPath,
    encoding: 'utf-8',
    shell: false,
  });

  const branchResult = spawnSync('git', ['branch', '--show-current'], {
    cwd: repoPath,
    encoding: 'utf-8',
    shell: false,
  });
  const baseBranch = branchResult.stdout.trim();

  spawnSync('git', ['checkout', '-b', 'ai/parent-1'], {
    cwd: repoPath,
    encoding: 'utf-8',
    shell: false,
  });

  return { repoPath, baseBranch };
}

function makeFakeResponse(filePath: string, content: string): string {
  return JSON.stringify({
    notes: 'apply fix',
    files: [{ path: filePath, content }],
  });
}

function makeParentTask(
  repoPath: string,
  baseBranch: string,
  checks: Task['checks']
): Task {
  return {
    id: 'parent-1',
    title: 'Parent task',
    repo_path: repoPath,
    base_branch: baseBranch,
    work_branch: 'ai/parent-1',
    goal: 'Fix the bug',
    context_files: [],
    checks,
    guardrails: {
      allow_modify: ['fix.txt'],
      deny_modify: [],
      auto_commit: false,
      auto_push: false,
      auto_merge: false,
    },
  };
}

function makeInput(fixTaskGoal: string): ReviewerFixTaskExecutorInput {
  return {
    executionRequest: {
      kind: 'reviewer_fix_task',
      status: 'pending',
      source: 'reviewer_gate',
      taskId: 'fix-task-1',
      parentTaskId: 'parent-1',
      attempt: 1,
      title: 'Fix task',
      goal: fixTaskGoal,
      blockingIssues: ['something is wrong'],
      task: {
        taskId: 'fix-task-1',
        parentTaskId: 'parent-1',
        title: 'Fix task',
        goal: fixTaskGoal,
        attempt: 1,
        blockingIssues: ['something is wrong'],
        source: 'reviewer_gate',
      },
    },
    fixTask: {
      taskId: 'fix-task-1',
      parentTaskId: 'parent-1',
      title: 'Fix task',
      goal: fixTaskGoal,
      attempt: 1,
      blockingIssues: ['something is wrong'],
      source: 'reviewer_gate',
    },
    taskId: 'fix-task-1',
    parentTaskId: 'parent-1',
    attempt: 1,
    title: 'Fix task',
    goal: fixTaskGoal,
    blockingIssues: ['something is wrong'],
  };
}

describe('createReviewerFixTaskRealExecutor', () => {
  beforeEach(() => {
    envBackup['ALLOW_REAL_PROVIDER'] = process.env.ALLOW_REAL_PROVIDER;
    envBackup['ALLOW_REAL_REPO_APPLY'] = process.env.ALLOW_REAL_REPO_APPLY;
    envBackup['ALLOW_REAL_REPO_COMMIT'] = process.env.ALLOW_REAL_REPO_COMMIT;
    envBackup['ALLOW_REAL_REPO_PUSH'] = process.env.ALLOW_REAL_REPO_PUSH;
    envBackup['KIMI_API_KEY'] = process.env.KIMI_API_KEY;
    envBackup['KIMI_BASE_URL'] = process.env.KIMI_BASE_URL;
    envBackup['KIMI_MODEL'] = process.env.KIMI_MODEL;
    envBackup['REAL_REPO_REVIEWER_FIX_TASK_KIMI_FAKE_RESPONSE'] =
      process.env.REAL_REPO_REVIEWER_FIX_TASK_KIMI_FAKE_RESPONSE;

    setEnv('ALLOW_REAL_PROVIDER', 'true');
    setEnv('ALLOW_REAL_REPO_APPLY', 'true');
    setEnv('ALLOW_REAL_REPO_COMMIT', 'true');
    setEnv('KIMI_API_KEY', 'fake-key');
    setEnv('KIMI_BASE_URL', 'https://api.moonshot.cn/v1');
  });

  afterEach(() => {
    restoreEnv();
  });

  test('completed run returns actual passing check summary', async () => {
    const { repoPath, baseBranch } = createTempRepo();
    writeFileSync(join(repoPath, 'fix.txt'), 'initial\n', 'utf-8');
    spawnSync('git', ['add', 'fix.txt'], {
      cwd: repoPath,
      encoding: 'utf-8',
      shell: false,
    });
    spawnSync('git', ['commit', '-m', 'add fix file', '--no-gpg-sign'], {
      cwd: repoPath,
      encoding: 'utf-8',
      shell: false,
    });

    const checks: Task['checks'] = [
      {
        command: 'node',
        args: ['-e', 'console.log("typecheck"); process.exit(0);'],
      },
      {
        command: 'node',
        args: ['-e', 'console.log("build"); process.exit(0);'],
      },
      {
        command: 'node',
        args: ['-e', 'console.log("test"); process.exit(0);'],
      },
    ];
    const parentTask = makeParentTask(repoPath, baseBranch, checks);

    setEnv(
      'REAL_REPO_REVIEWER_FIX_TASK_KIMI_FAKE_RESPONSE',
      makeFakeResponse('fix.txt', 'fixed\n')
    );

    const executor = createReviewerFixTaskRealExecutor({ parentTask });
    const result = await executor(makeInput('Fix the thing'));

    assert.strictEqual(result.status, 'completed');
    assert(result.commitSha);
    assert.strictEqual(result.commitSha.length, 40);
    assert(result.changedFiles?.includes('fix.txt'));
    assert(result.checkSummary);
    assert.strictEqual(result.checkSummary.typecheck, 'pass');
    assert.strictEqual(result.checkSummary.build, 'pass');
    assert.strictEqual(result.checkSummary.test, 'pass');
    assert.deepStrictEqual(result.checkSummary.tests, {
      total: 3,
      suites: 0,
      failures: 0,
    });

    const committedContent = readFileSync(join(repoPath, 'fix.txt'), 'utf-8');
    assert.strictEqual(committedContent, 'fixed\n');
  });

  test('failed sandbox preflight returns failing check summary without mutation', async () => {
    const { repoPath, baseBranch } = createTempRepo();
    writeFileSync(join(repoPath, 'fix.txt'), 'initial\n', 'utf-8');
    spawnSync('git', ['add', 'fix.txt'], {
      cwd: repoPath,
      encoding: 'utf-8',
      shell: false,
    });
    spawnSync('git', ['commit', '-m', 'add fix file', '--no-gpg-sign'], {
      cwd: repoPath,
      encoding: 'utf-8',
      shell: false,
    });

    const checks: Task['checks'] = [
      {
        command: 'node',
        args: ['-e', 'console.log("test"); process.exit(1);'],
      },
    ];
    const parentTask = makeParentTask(repoPath, baseBranch, checks);

    setEnv(
      'REAL_REPO_REVIEWER_FIX_TASK_KIMI_FAKE_RESPONSE',
      makeFakeResponse('fix.txt', 'broken\n')
    );

    const executor = createReviewerFixTaskRealExecutor({ parentTask });
    const result = await executor(makeInput('Fix the thing'));

    assert.strictEqual(result.status, 'blocked');
    assert(result.checkSummary);
    assert.strictEqual(result.checkSummary.typecheck, 'not_run');
    assert.strictEqual(result.checkSummary.build, 'not_run');
    assert.strictEqual(result.checkSummary.test, 'fail');
    assert.deepStrictEqual(result.checkSummary.tests, {
      total: 1,
      suites: 0,
      failures: 1,
    });

    const rolledBackContent = readFileSync(join(repoPath, 'fix.txt'), 'utf-8');
    assert.strictEqual(rolledBackContent, 'initial\n');

    const statusResult = spawnSync(
      'git',
      ['status', '--porcelain', '--untracked-files=all'],
      { cwd: repoPath, encoding: 'utf-8', shell: false }
    );
    assert.strictEqual(statusResult.stdout.trim(), '');
  });

  test('fix commit is not pushed by the executor; pushing is handled after reviewer acceptance', async () => {
    const { repoPath, baseBranch } = createTempRepo();
    writeFileSync(join(repoPath, 'fix.txt'), 'initial\n', 'utf-8');
    spawnSync('git', ['add', 'fix.txt'], {
      cwd: repoPath,
      encoding: 'utf-8',
      shell: false,
    });
    spawnSync('git', ['commit', '-m', 'add fix file', '--no-gpg-sign'], {
      cwd: repoPath,
      encoding: 'utf-8',
      shell: false,
    });

    // Set an invalid remote. If the executor tried to push, it would fail.
    spawnSync('git', ['remote', 'add', 'origin', '/nonexistent/remote'], {
      cwd: repoPath,
      encoding: 'utf-8',
      shell: false,
    });

    const checks: Task['checks'] = [
      {
        command: 'node',
        args: ['-e', 'console.log("test"); process.exit(0);'],
      },
    ];
    const parentTask = makeParentTask(repoPath, baseBranch, checks);

    setEnv('ALLOW_REAL_REPO_PUSH', 'true');
    setEnv(
      'REAL_REPO_REVIEWER_FIX_TASK_KIMI_FAKE_RESPONSE',
      makeFakeResponse('fix.txt', 'fixed\n')
    );

    const beforeHead = spawnSync('git', ['rev-parse', '--verify', 'HEAD'], {
      cwd: repoPath,
      encoding: 'utf-8',
      shell: false,
    }).stdout.trim();

    const executor = createReviewerFixTaskRealExecutor({ parentTask });
    const result = await executor(makeInput('Fix the thing'));

    assert.strictEqual(result.status, 'completed', `Expected completed status despite invalid remote: ${result.reason}`);
    assert(result.commitSha && result.commitSha.length === 40, 'Expected valid local fix commit');
    assert.strictEqual(result.baseCommitSha, beforeHead, 'baseCommitSha should be pre-fix HEAD');

    const afterHead = spawnSync('git', ['rev-parse', '--verify', 'HEAD'], {
      cwd: repoPath,
      encoding: 'utf-8',
      shell: false,
    }).stdout.trim();
    assert.strictEqual(afterHead, result.commitSha, 'Fix commit should be local HEAD');

    const content = readFileSync(join(repoPath, 'fix.txt'), 'utf-8');
    assert.strictEqual(content, 'fixed\n');

    const statusResult = spawnSync(
      'git',
      ['status', '--porcelain', '--untracked-files=all'],
      { cwd: repoPath, encoding: 'utf-8', shell: false }
    );
    assert.strictEqual(statusResult.stdout.trim(), '');
  });

  test('no working tree changes after fix is a retryable failed attempt, not terminal block', async () => {
    const { repoPath, baseBranch } = createTempRepo();
    writeFileSync(join(repoPath, 'fix.txt'), 'initial\n', 'utf-8');
    spawnSync('git', ['add', 'fix.txt'], {
      cwd: repoPath,
      encoding: 'utf-8',
      shell: false,
    });
    spawnSync('git', ['commit', '-m', 'add fix file', '--no-gpg-sign'], {
      cwd: repoPath,
      encoding: 'utf-8',
      shell: false,
    });

    const beforeHead = spawnSync('git', ['rev-parse', '--verify', 'HEAD'], {
      cwd: repoPath,
      encoding: 'utf-8',
      shell: false,
    }).stdout.trim();

    const checks: Task['checks'] = [
      {
        command: 'node',
        args: ['-e', 'console.log("test"); process.exit(0);'],
      },
    ];
    const parentTask = makeParentTask(repoPath, baseBranch, checks);

    // Kimi returns the same content that is already committed, so the working
    // tree has no actual changes after apply. The new pipeline classifies this
    // as ALL_IDENTICAL and fails the fix attempt without blocking it.
    setEnv(
      'REAL_REPO_REVIEWER_FIX_TASK_KIMI_FAKE_RESPONSE',
      makeFakeResponse('fix.txt', 'initial\n')
    );

    const executor = createReviewerFixTaskRealExecutor({ parentTask });
    const result = await executor(makeInput('Fix the thing'));

    assert.strictEqual(result.status, 'failed', `Expected retryable failed status, got ${result.status}: ${result.reason}`);
    assert(
      result.reason.includes('PROVIDER_NO_EFFECT_OUTPUT') || result.reason.includes('ALL_IDENTICAL'),
      `Expected no-effect classification reason: ${result.reason}`
    );
    assert(result.baseCommitSha, 'Result should include the base commit SHA before the fix attempt');
    assert.strictEqual(result.baseCommitSha, beforeHead, 'baseCommitSha should be the pre-fix HEAD');
    assert(result.commitSha === undefined || result.commitSha.length === 0, 'No valid fix commit should be produced');

    const afterHead = spawnSync('git', ['rev-parse', '--verify', 'HEAD'], {
      cwd: repoPath,
      encoding: 'utf-8',
      shell: false,
    }).stdout.trim();
    assert.strictEqual(afterHead, beforeHead, 'Pre-fix HEAD should be restored');

    const content = readFileSync(join(repoPath, 'fix.txt'), 'utf-8');
    assert.strictEqual(content, 'initial\n', 'Original file content should be preserved');

    const statusResult = spawnSync(
      'git',
      ['status', '--porcelain', '--untracked-files=all'],
      { cwd: repoPath, encoding: 'utf-8', shell: false }
    );
    assert.strictEqual(statusResult.stdout.trim(), '', 'Working tree should be clean after rollback');
  });

  test('malformed JSON response is corrected and then completed', async () => {
    const { repoPath, baseBranch } = createTempRepo();
    writeFileSync(join(repoPath, 'fix.txt'), 'initial\n', 'utf-8');
    spawnSync('git', ['add', 'fix.txt'], { cwd: repoPath, encoding: 'utf-8', shell: false });
    spawnSync('git', ['commit', '-m', 'add fix file', '--no-gpg-sign'], { cwd: repoPath, encoding: 'utf-8', shell: false });

    const parentTask = makeParentTask(repoPath, baseBranch, []);
    setEnv(
      'REAL_REPO_REVIEWER_FIX_TASK_KIMI_FAKE_RESPONSES',
      JSON.stringify(['not valid json', makeFakeResponse('fix.txt', 'fixed\n')])
    );

    const executor = createReviewerFixTaskRealExecutor({ parentTask });
    const result = await executor(makeInput('Fix the thing'));

    assert.strictEqual(result.status, 'completed');
    assert(result.commitSha && result.commitSha.length === 40);
    assert(result.changedFiles?.includes('fix.txt'));

    const logResult = spawnSync('git', ['log', '--oneline', '--all'], { cwd: repoPath, encoding: 'utf-8', shell: false });
    const commitCount = logResult.stdout.trim().split('\n').length;
    assert.strictEqual(commitCount, 3, 'Expected init + add fix file + fix commit');
  });

  test('missing files field is corrected and then completed', async () => {
    const { repoPath, baseBranch } = createTempRepo();
    writeFileSync(join(repoPath, 'fix.txt'), 'initial\n', 'utf-8');
    spawnSync('git', ['add', 'fix.txt'], { cwd: repoPath, encoding: 'utf-8', shell: false });
    spawnSync('git', ['commit', '-m', 'add fix file', '--no-gpg-sign'], { cwd: repoPath, encoding: 'utf-8', shell: false });

    const parentTask = makeParentTask(repoPath, baseBranch, []);
    setEnv(
      'REAL_REPO_REVIEWER_FIX_TASK_KIMI_FAKE_RESPONSES',
      JSON.stringify([JSON.stringify({ mode: 'file_update' }), makeFakeResponse('fix.txt', 'fixed\n')])
    );

    const executor = createReviewerFixTaskRealExecutor({ parentTask });
    const result = await executor(makeInput('Fix the thing'));

    assert.strictEqual(result.status, 'completed');
    assert(result.changedFiles?.includes('fix.txt'));
  });

  test('non-array files is corrected and then completed', async () => {
    const { repoPath, baseBranch } = createTempRepo();
    writeFileSync(join(repoPath, 'fix.txt'), 'initial\n', 'utf-8');
    spawnSync('git', ['add', 'fix.txt'], { cwd: repoPath, encoding: 'utf-8', shell: false });
    spawnSync('git', ['commit', '-m', 'add fix file', '--no-gpg-sign'], { cwd: repoPath, encoding: 'utf-8', shell: false });

    const parentTask = makeParentTask(repoPath, baseBranch, []);
    setEnv(
      'REAL_REPO_REVIEWER_FIX_TASK_KIMI_FAKE_RESPONSES',
      JSON.stringify([JSON.stringify({ mode: 'file_update', files: 'not-an-array' }), makeFakeResponse('fix.txt', 'fixed\n')])
    );

    const executor = createReviewerFixTaskRealExecutor({ parentTask });
    const result = await executor(makeInput('Fix the thing'));

    assert.strictEqual(result.status, 'completed');
    assert(result.changedFiles?.includes('fix.txt'));
  });

  test('exhausted malformed responses result in failed, not blocked', async () => {
    const { repoPath, baseBranch } = createTempRepo();
    writeFileSync(join(repoPath, 'fix.txt'), 'initial\n', 'utf-8');
    spawnSync('git', ['add', 'fix.txt'], { cwd: repoPath, encoding: 'utf-8', shell: false });
    spawnSync('git', ['commit', '-m', 'add fix file', '--no-gpg-sign'], { cwd: repoPath, encoding: 'utf-8', shell: false });

    const parentTask = makeParentTask(repoPath, baseBranch, []);
    setEnv(
      'REAL_REPO_REVIEWER_FIX_TASK_KIMI_FAKE_RESPONSES',
      JSON.stringify(['bad', 'still bad', 'also bad'])
    );

    const executor = createReviewerFixTaskRealExecutor({ parentTask });
    const result = await executor(makeInput('Fix the thing'));

    assert.strictEqual(result.status, 'failed', `Expected failed, got ${result.status}: ${result.reason}`);
    assert(!result.commitSha, 'No fix commit should be created');
  });

  test('no-effect response is corrected and then completed', async () => {
    const { repoPath, baseBranch } = createTempRepo();
    writeFileSync(join(repoPath, 'fix.txt'), 'initial\n', 'utf-8');
    spawnSync('git', ['add', 'fix.txt'], { cwd: repoPath, encoding: 'utf-8', shell: false });
    spawnSync('git', ['commit', '-m', 'add fix file', '--no-gpg-sign'], { cwd: repoPath, encoding: 'utf-8', shell: false });

    const parentTask = makeParentTask(repoPath, baseBranch, []);
    setEnv('REAL_REPO_REVIEWER_MAX_FIX_ATTEMPTS', '2');
    setEnv(
      'REAL_REPO_REVIEWER_FIX_TASK_KIMI_FAKE_RESPONSES',
      JSON.stringify([makeFakeResponse('fix.txt', 'initial\n'), makeFakeResponse('fix.txt', 'fixed\n')])
    );

    const executor = createReviewerFixTaskRealExecutor({ parentTask });
    const result = await executor(makeInput('Fix the thing'));

    assert.strictEqual(result.status, 'completed');
    assert(result.changedFiles?.includes('fix.txt'));

    const logResult = spawnSync('git', ['log', '--oneline', '--all'], { cwd: repoPath, encoding: 'utf-8', shell: false });
    const commitCount = logResult.stdout.trim().split('\n').length;
    assert.strictEqual(commitCount, 3, 'Expected exactly one fix commit on top of setup');
  });

  test('auth error is blocked without retry', async () => {
    const { repoPath, baseBranch } = createTempRepo();
    writeFileSync(join(repoPath, 'fix.txt'), 'initial\n', 'utf-8');
    spawnSync('git', ['add', 'fix.txt'], { cwd: repoPath, encoding: 'utf-8', shell: false });
    spawnSync('git', ['commit', '-m', 'add fix file', '--no-gpg-sign'], { cwd: repoPath, encoding: 'utf-8', shell: false });

    const parentTask = makeParentTask(repoPath, baseBranch, []);
    setEnv(
      'REAL_REPO_REVIEWER_FIX_TASK_KIMI_FAKE_RESPONSES',
      JSON.stringify(['__AUTH_ERROR__'])
    );

    const executor = createReviewerFixTaskRealExecutor({ parentTask });
    const result = await executor(makeInput('Fix the thing'));

    assert.strictEqual(result.status, 'blocked', `Expected blocked, got ${result.status}: ${result.reason}`);
    assert(!result.commitSha, 'No fix commit should be created');
  });

  test('denied file path is blocked without apply', async () => {
    const { repoPath, baseBranch } = createTempRepo();
    writeFileSync(join(repoPath, 'fix.txt'), 'initial\n', 'utf-8');
    spawnSync('git', ['add', 'fix.txt'], { cwd: repoPath, encoding: 'utf-8', shell: false });
    spawnSync('git', ['commit', '-m', 'add fix file', '--no-gpg-sign'], { cwd: repoPath, encoding: 'utf-8', shell: false });

    const parentTask: Task = {
      ...makeParentTask(repoPath, baseBranch, []),
      guardrails: {
        allow_modify: ['fix.txt'],
        deny_modify: ['denied.txt'],
        auto_commit: false,
        auto_push: false,
        auto_merge: false,
      },
    };
    setEnv(
      'REAL_REPO_REVIEWER_FIX_TASK_KIMI_FAKE_RESPONSE',
      makeFakeResponse('denied.txt', 'x')
    );

    const executor = createReviewerFixTaskRealExecutor({ parentTask });
    const result = await executor(makeInput('Fix the thing'));

    assert.strictEqual(result.status, 'blocked', `Expected blocked, got ${result.status}: ${result.reason}`);
    assert(!result.commitSha, 'No fix commit should be created');
    assert(!existsSync(join(repoPath, 'denied.txt')), 'Denied file should not be created');
  });
});
