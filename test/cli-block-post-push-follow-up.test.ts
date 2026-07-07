import { describe, test, afterEach } from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RealBlockRunState, RealBlockRunTaskResult } from '../src/real-block-run-ai-state.js';
import type { RunState } from '../src/types.js';

let counter = 0;

function cli(args: string[], env: Record<string, string> = {}): { stdout: string; stderr: string; exitCode: number | null } {
  const result = spawnSync(
    'node',
    ['dist/cli.js', 'real-block-follow-up', ...args],
    {
      cwd: process.cwd(),
      encoding: 'utf-8',
      env: { ...process.env, ...env },
      shell: false,
    }
  );
  return {
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.status,
  };
}

function createTempRepo(branch = 'ai/task-x'): { repoPath: string; tmpDir: string; cleanup: () => void; headSha: string } {
  const id = `${Date.now()}-${counter++}`;
  const tmpBase = join(process.cwd(), 'tmp');
  if (!existsSync(tmpBase)) {
    mkdirSync(tmpBase);
  }
  const tmpDir = mkdtempSync(join(tmpBase, `blkppfu-cli-${id}-`));
  const repoPath = join(tmpDir, 'repo');
  mkdirSync(repoPath);
  writeFileSync(join(repoPath, 'README.md'), '# hello\n', 'utf-8');
  spawnSync('git', ['init'], { cwd: repoPath, encoding: 'utf-8', shell: false });
  spawnSync('git', ['config', 'user.email', 'ci@example.com'], { cwd: repoPath, encoding: 'utf-8', shell: false });
  spawnSync('git', ['config', 'user.name', 'CI User'], { cwd: repoPath, encoding: 'utf-8', shell: false });
  spawnSync('git', ['add', '.'], { cwd: repoPath, encoding: 'utf-8', shell: false });
  spawnSync('git', ['commit', '-m', 'init', '--no-gpg-sign'], { cwd: repoPath, encoding: 'utf-8', shell: false });
  spawnSync('git', ['branch', '-m', 'main'], { cwd: repoPath, encoding: 'utf-8', shell: false });
  spawnSync('git', ['checkout', '-b', branch], { cwd: repoPath, encoding: 'utf-8', shell: false });
  const headResult = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repoPath, encoding: 'utf-8', shell: false });
  const headSha = headResult.stdout.trim();
  return {
    repoPath,
    tmpDir,
    cleanup: () => rmSync(tmpDir, { recursive: true, force: true }),
    headSha,
  };
}

function buildChildRunState(
  taskId: string,
  repoPath: string,
  branch: string,
  commitSha: string,
  policy: 'post_push_preserve_for_human' | 'rollback_skipped_success',
  overrides: { fixCommitSha?: string; blockingIssues?: string[] } = {}
): RunState {
  const now = new Date().toISOString();
  const state: RunState = {
    task_id: taskId,
    status: 'pushed',
    current_attempt: 1,
    branch,
    repo_path: repoPath,
    created_at: now,
    updated_at: now,
    pushed_remote: 'origin',
    pushed_ref: branch,
    commit_sha: commitSha,
    safety_note: 'Human review required before merge',
    rollback: {
      attempted: false,
      status: 'skipped',
      checkpointHead: commitSha,
      policy,
      reason:
        policy === 'post_push_preserve_for_human'
          ? 'Commit was already pushed; rollback skipped. Human follow-up required.'
          : 'Mutation completed successfully; rollback not needed.',
    },
  };
  const s = state as unknown as Record<string, unknown>;
  if (policy === 'post_push_preserve_for_human') {
    s.reviewer_gate = {
      status: 'blocked',
      source: 'reviewer',
      nextAction: 'block',
      blockingIssues: overrides.blockingIssues ?? ['needs human review'],
      nonBlockingIssues: [],
      reviewSummary: 'Blocked for human review',
    };
  }
  if (overrides.fixCommitSha) {
    s.reviewer_fix_task_second_review = {
      fixTaskId: `${taskId}-fix-1`,
      parentTaskId: taskId,
      attempt: 1,
      fixCommitSha: overrides.fixCommitSha,
      reviewerGate: {
        status: 'blocked',
        source: 'reviewer',
        nextAction: 'block',
        blockingIssues: ['second reviewer blocked'],
        nonBlockingIssues: [],
        reviewSummary: 'Second reviewer blocked',
      },
      finalStatus: 'blocked',
      nextAction: 'block',
      reason: 'Second reviewer blocked the fix commit.',
    };
  }
  return state;
}

function buildBlockRunState(
  blockId: string,
  taskResults: RealBlockRunTaskResult[],
  status: 'completed' | 'blocked' = 'blocked'
): RealBlockRunState {
  const now = new Date().toISOString();
  return {
    block_id: blockId,
    title: `Block ${blockId}`,
    status,
    currentTaskId: null,
    statePath: '',
    taskResults,
    summary: {
      totalTasks: taskResults.length,
      acceptedTasks: 0,
      fixedTasks: 0,
      completedTasks: 0,
    },
    startedAt: now,
    safetyNote: 'Test block state',
  };
}

function buildTaskResult(
  taskId: string,
  options: Partial<RealBlockRunTaskResult> = {}
): RealBlockRunTaskResult {
  return {
    taskId,
    title: `Task ${taskId}`,
    status: 'blocked',
    originalCommitSha: options.originalCommitSha ?? '',
    fixAttempted: false,
    finalStatus: 'blocked',
    nextAction: 'block',
    childStateTaskId: taskId,
    rollbackPolicy: 'post_push_preserve_for_human',
    rollbackReason: 'Commit was already pushed; rollback skipped. Human follow-up required.',
    ...options,
  } as RealBlockRunTaskResult;
}

function saveChildState(runsDir: string, taskId: string, state: RunState): void {
  const dir = join(runsDir, 'tasks', taskId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'state.json'), JSON.stringify(state, null, 2), 'utf-8');
}

function saveBlockState(runsDir: string, blockId: string, state: RealBlockRunState): void {
  const dir = join(runsDir, 'block', blockId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'state.json'), JSON.stringify(state, null, 2), 'utf-8');
}

describe('cli real-block-follow-up', () => {
  const cleanups: Array<() => void> = [];

  afterEach(() => {
    while (cleanups.length > 0) {
      cleanups.pop()?.();
    }
  });

  test('prints report and exits 0 when follow-up tasks exist', () => {
    const { repoPath, cleanup, headSha } = createTempRepo('ai/blk-cli-1');
    cleanups.push(cleanup);
    const blockId = 'blk-cli-1';
    const runsDir = join(process.cwd(), 'tmp', `blkppfu-cli-runs-${Date.now()}`);
    mkdirSync(runsDir, { recursive: true });
    cleanups.push(() => rmSync(runsDir, { recursive: true, force: true }));

    const childState = buildChildRunState('task-1', repoPath, 'ai/blk-cli-1', headSha, 'post_push_preserve_for_human');
    saveChildState(runsDir, 'task-1', childState);
    const blockState = buildBlockRunState(blockId, [buildTaskResult('task-1', { originalCommitSha: headSha })]);
    saveBlockState(runsDir, blockId, blockState);

    const { stdout, stderr, exitCode } = cli([blockId, '--report-only'], { RUNS_DIR: runsDir });
    assert.strictEqual(exitCode, 0, stderr + stdout);
    assert.ok(stdout.includes('Tasks needing human follow-up: 1'));
    assert.ok(stdout.includes('task-1'));
    assert.ok(stdout.includes(headSha));
  });

  test('exits 0 with clear message when no follow-up required', () => {
    const { repoPath, cleanup, headSha } = createTempRepo('ai/blk-cli-ok');
    cleanups.push(cleanup);
    const blockId = 'blk-cli-ok';
    const runsDir = join(process.cwd(), 'tmp', `blkppfu-cli-runs-${Date.now()}`);
    mkdirSync(runsDir, { recursive: true });
    cleanups.push(() => rmSync(runsDir, { recursive: true, force: true }));

    const childState = buildChildRunState('task-1', repoPath, 'ai/blk-cli-ok', headSha, 'rollback_skipped_success');
    saveChildState(runsDir, 'task-1', childState);
    const blockState = buildBlockRunState(blockId, [
      buildTaskResult('task-1', {
        originalCommitSha: headSha,
        status: 'accepted',
        rollbackPolicy: 'rollback_skipped_success',
        rollbackReason: 'Mutation completed successfully; rollback not needed.',
      }),
    ]);
    saveBlockState(runsDir, blockId, blockState);

    const { stdout, stderr, exitCode } = cli([blockId, '--report-only'], { RUNS_DIR: runsDir });
    assert.strictEqual(exitCode, 0, stderr + stdout);
    assert.ok(stdout.includes('No tasks require post-push human follow-up'));
  });

  test('exits non-zero for missing block state', () => {
    const runsDir = join(process.cwd(), 'tmp', `blkppfu-cli-missing-${Date.now()}`);
    mkdirSync(runsDir, { recursive: true });
    cleanups.push(() => rmSync(runsDir, { recursive: true, force: true }));
    const { stdout, exitCode } = cli(['missing-block', '--report-only'], { RUNS_DIR: runsDir });
    assert.strictEqual(exitCode, 1);
    assert.ok(stdout.includes('does not exist'));
  });

  test('--create-follow-ups writes follow-up yaml file under runs dir', () => {
    const { repoPath, cleanup, headSha } = createTempRepo('ai/blk-cli-create');
    cleanups.push(cleanup);
    const blockId = 'blk-cli-create';
    const runsDir = join(process.cwd(), 'tmp', `blkppfu-cli-runs-${Date.now()}`);
    mkdirSync(runsDir, { recursive: true });
    cleanups.push(() => rmSync(runsDir, { recursive: true, force: true }));

    const childState = buildChildRunState('task-1', repoPath, 'ai/blk-cli-create', headSha, 'post_push_preserve_for_human');
    saveChildState(runsDir, 'task-1', childState);
    const blockState = buildBlockRunState(blockId, [buildTaskResult('task-1', { originalCommitSha: headSha })]);
    saveBlockState(runsDir, blockId, blockState);

    const { stderr, exitCode } = cli([blockId, '--create-follow-ups'], { RUNS_DIR: runsDir });
    assert.strictEqual(exitCode, 0, stderr);
    const filePath = join(runsDir, 'task-1', 'follow-up-task-1-follow-up.yaml');
    assert.ok(existsSync(filePath));
    assert.ok(filePath.startsWith(runsDir));
  });

  test('--create-follow-ups does not mutate repo', () => {
    const { repoPath, cleanup, headSha } = createTempRepo('ai/blk-cli-no-mutate');
    cleanups.push(cleanup);
    const blockId = 'blk-cli-no-mutate';
    const runsDir = join(process.cwd(), 'tmp', `blkppfu-cli-runs-${Date.now()}`);
    mkdirSync(runsDir, { recursive: true });
    cleanups.push(() => rmSync(runsDir, { recursive: true, force: true }));

    const childState = buildChildRunState('task-1', repoPath, 'ai/blk-cli-no-mutate', headSha, 'post_push_preserve_for_human');
    saveChildState(runsDir, 'task-1', childState);
    const blockState = buildBlockRunState(blockId, [buildTaskResult('task-1', { originalCommitSha: headSha })]);
    saveBlockState(runsDir, blockId, blockState);

    const statusBefore = spawnSync('git', ['status', '--porcelain'], { cwd: repoPath, encoding: 'utf-8', shell: false }).stdout;
    const headBefore = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repoPath, encoding: 'utf-8', shell: false }).stdout.trim();

    const { stderr, exitCode } = cli([blockId, '--create-follow-ups'], { RUNS_DIR: runsDir });
    assert.strictEqual(exitCode, 0, stderr);

    const statusAfter = spawnSync('git', ['status', '--porcelain'], { cwd: repoPath, encoding: 'utf-8', shell: false }).stdout;
    const headAfter = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repoPath, encoding: 'utf-8', shell: false }).stdout.trim();

    assert.strictEqual(statusAfter, statusBefore);
    assert.strictEqual(headAfter, headBefore);
  });

  test('redacts token-like strings in output', () => {
    const { repoPath, cleanup, headSha } = createTempRepo('ai/blk-cli-redact');
    cleanups.push(cleanup);
    const blockId = 'blk-cli-redact';
    const runsDir = join(process.cwd(), 'tmp', `blkppfu-cli-runs-${Date.now()}`);
    mkdirSync(runsDir, { recursive: true });
    cleanups.push(() => rmSync(runsDir, { recursive: true, force: true }));

    const childState = buildChildRunState('task-1', repoPath, 'ai/blk-cli-redact', headSha, 'post_push_preserve_for_human', {
      blockingIssues: ['api_key=secret-cli-key'],
    });
    saveChildState(runsDir, 'task-1', childState);
    const task = buildTaskResult('task-1', { originalCommitSha: headSha });
    task.rollbackReason = 'Token sk-cli-fake-key-1234567890 was rejected';
    const blockState = buildBlockRunState(blockId, [task]);
    saveBlockState(runsDir, blockId, blockState);

    const { stdout, exitCode } = cli([blockId, '--report-only'], { RUNS_DIR: runsDir });
    assert.strictEqual(exitCode, 0, stdout);
    assert.ok(!stdout.includes('secret-cli-key'));
    assert.ok(!stdout.includes('sk-cli-fake-key-1234567890'));
    assert.ok(stdout.includes('[REDACTED]'));
  });

  test('without flags reports usage', () => {
    const { stderr, exitCode } = cli(['some-block']);
    assert.notStrictEqual(exitCode, 0);
    assert.ok(stderr.includes('--report-only') || stderr.includes('--create-follow-ups') || stderr.includes('Usage'));
  });

  test('no network calls during CLI run', () => {
    const { repoPath, cleanup, headSha } = createTempRepo('ai/blk-cli-net');
    cleanups.push(cleanup);
    const blockId = 'blk-cli-net';
    const runsDir = join(process.cwd(), 'tmp', `blkppfu-cli-runs-${Date.now()}`);
    mkdirSync(runsDir, { recursive: true });
    cleanups.push(() => rmSync(runsDir, { recursive: true, force: true }));

    const childState = buildChildRunState('task-1', repoPath, 'ai/blk-cli-net', headSha, 'post_push_preserve_for_human');
    saveChildState(runsDir, 'task-1', childState);
    const blockState = buildBlockRunState(blockId, [buildTaskResult('task-1', { originalCommitSha: headSha })]);
    saveBlockState(runsDir, blockId, blockState);

    const { stdout, exitCode } = cli([blockId, '--report-only'], {
      RUNS_DIR: runsDir,
      KIMI_API_KEY: 'sk-test',
      OPENAI_API_KEY: 'sk-test',
    });
    assert.strictEqual(exitCode, 0, stdout);
    assert.ok(stdout.includes('No provider call was made'));
  });
});
