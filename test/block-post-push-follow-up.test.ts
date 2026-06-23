import { describe, test, afterEach } from 'node:test';
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
import { runBlockPostPushFollowUp } from '../src/block-post-push-follow-up.js';
import type { RealBlockRunState, RealBlockRunTaskResult } from '../src/real-block-run-ai-state.js';
import type { RunState } from '../src/types.js';

let counter = 0;

function createTempRepo(branch = 'ai/task-x'): { repoPath: string; tmpDir: string; cleanup: () => void; headSha: string } {
  const id = `${Date.now()}-${counter++}`;
  const tmpBase = join(process.cwd(), 'tmp');
  if (!existsSync(tmpBase)) {
    mkdirSync(tmpBase);
  }
  const tmpDir = mkdtempSync(join(tmpBase, `blkppfu-${id}-`));
  const repoPath = join(tmpDir, 'repo');
  mkdirSync(repoPath);
  writeFileSync(join(repoPath, 'README.md'), '# hello\n', 'utf-8');
  spawnSync('git', ['init'], { cwd: repoPath, encoding: 'utf-8', shell: false });
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
  const dir = join(runsDir, taskId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'state.json'), JSON.stringify(state, null, 2), 'utf-8');
}

function saveBlockState(runsDir: string, blockId: string, state: RealBlockRunState): void {
  const dir = join(runsDir, 'block', blockId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'state.json'), JSON.stringify(state, null, 2), 'utf-8');
}

describe('block post-push follow-up', () => {
  const cleanups: Array<() => void> = [];

  afterEach(() => {
    while (cleanups.length > 0) {
      cleanups.pop()?.();
    }
  });

  test('report succeeds for block with one post-push manual task', () => {
    const { repoPath, cleanup, headSha } = createTempRepo('ai/blk-follow-up-1');
    cleanups.push(cleanup);
    const blockId = 'blk-follow-up-1';
    const runsDir = join(process.cwd(), 'tmp', `blkppfu-runs-${Date.now()}`);
    mkdirSync(runsDir, { recursive: true });
    cleanups.push(() => rmSync(runsDir, { recursive: true, force: true }));

    const childState = buildChildRunState('task-1', repoPath, 'ai/blk-follow-up-1', headSha, 'post_push_preserve_for_human');
    saveChildState(runsDir, 'task-1', childState);
    const blockState = buildBlockRunState(blockId, [buildTaskResult('task-1', { originalCommitSha: headSha })]);
    saveBlockState(runsDir, blockId, blockState);

    const result = runBlockPostPushFollowUp({ blockId, createFollowUps: false, runsDir });
    assert.strictEqual(result.exitCode, 0, result.report);
    assert.strictEqual(result.followUpCount, 1);
    assert.ok(result.report.includes('Tasks needing human follow-up: 1'));
  });

  test('report prints task id, original commit, rollback policy, rollback reason', () => {
    const { repoPath, cleanup, headSha } = createTempRepo('ai/blk-follow-up-2');
    cleanups.push(cleanup);
    const blockId = 'blk-follow-up-2';
    const runsDir = join(process.cwd(), 'tmp', `blkppfu-runs-${Date.now()}`);
    mkdirSync(runsDir, { recursive: true });
    cleanups.push(() => rmSync(runsDir, { recursive: true, force: true }));

    const childState = buildChildRunState('task-1', repoPath, 'ai/blk-follow-up-2', headSha, 'post_push_preserve_for_human');
    saveChildState(runsDir, 'task-1', childState);
    const blockState = buildBlockRunState(blockId, [buildTaskResult('task-1', { originalCommitSha: headSha })]);
    saveBlockState(runsDir, blockId, blockState);

    const result = runBlockPostPushFollowUp({ blockId, createFollowUps: false, runsDir });
    assert.strictEqual(result.exitCode, 0, result.report);
    assert.ok(result.report.includes('task-1'));
    assert.ok(result.report.includes(headSha));
    assert.ok(result.report.includes('post_push_preserve_for_human'));
    assert.ok(result.report.includes('Human follow-up required'));
  });

  test('report prints fix commit if child task has pushed fix commit', () => {
    const { repoPath, cleanup, headSha } = createTempRepo('ai/blk-follow-up-3');
    cleanups.push(cleanup);
    const blockId = 'blk-follow-up-3';
    const runsDir = join(process.cwd(), 'tmp', `blkppfu-runs-${Date.now()}`);
    mkdirSync(runsDir, { recursive: true });
    cleanups.push(() => rmSync(runsDir, { recursive: true, force: true }));

    writeFileSync(join(repoPath, 'fix.txt'), 'fix\n', 'utf-8');
    spawnSync('git', ['add', '.'], { cwd: repoPath, encoding: 'utf-8', shell: false });
    spawnSync('git', ['commit', '-m', 'fix', '--no-gpg-sign'], { cwd: repoPath, encoding: 'utf-8', shell: false });
    const fixHeadResult = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repoPath, encoding: 'utf-8', shell: false });
    const fixCommitSha = fixHeadResult.stdout.trim();

    const childState = buildChildRunState('task-1', repoPath, 'ai/blk-follow-up-3', headSha, 'post_push_preserve_for_human', { fixCommitSha });
    saveChildState(runsDir, 'task-1', childState);
    const blockState = buildBlockRunState(blockId, [buildTaskResult('task-1', { originalCommitSha: headSha, fixCommitSha })]);
    saveBlockState(runsDir, blockId, blockState);

    const result = runBlockPostPushFollowUp({ blockId, createFollowUps: false, runsDir });
    assert.strictEqual(result.exitCode, 0, result.report);
    assert.ok(result.report.includes('Fix commit'));
    assert.ok(result.report.includes(fixCommitSha));
  });

  test('report prints recommended real-repo-follow-up command', () => {
    const { repoPath, cleanup, headSha } = createTempRepo('ai/blk-follow-up-4');
    cleanups.push(cleanup);
    const blockId = 'blk-follow-up-4';
    const runsDir = join(process.cwd(), 'tmp', `blkppfu-runs-${Date.now()}`);
    mkdirSync(runsDir, { recursive: true });
    cleanups.push(() => rmSync(runsDir, { recursive: true, force: true }));

    const childState = buildChildRunState('task-1', repoPath, 'ai/blk-follow-up-4', headSha, 'post_push_preserve_for_human');
    saveChildState(runsDir, 'task-1', childState);
    const blockState = buildBlockRunState(blockId, [buildTaskResult('task-1', { originalCommitSha: headSha })]);
    saveBlockState(runsDir, blockId, blockState);

    const result = runBlockPostPushFollowUp({ blockId, createFollowUps: false, runsDir });
    assert.strictEqual(result.exitCode, 0, result.report);
    assert.ok(result.report.includes('real-repo-follow-up task-1 --report-only'));
    assert.ok(result.report.includes('real-repo-follow-up task-1 --create-follow-up task-1-follow-up'));
  });

  test('report redacts token-like rollback/reviewer strings', () => {
    const { repoPath, cleanup, headSha } = createTempRepo('ai/blk-follow-up-5');
    cleanups.push(cleanup);
    const blockId = 'blk-follow-up-5';
    const runsDir = join(process.cwd(), 'tmp', `blkppfu-runs-${Date.now()}`);
    mkdirSync(runsDir, { recursive: true });
    cleanups.push(() => rmSync(runsDir, { recursive: true, force: true }));

    const childState = buildChildRunState('task-1', repoPath, 'ai/blk-follow-up-5', headSha, 'post_push_preserve_for_human', {
      blockingIssues: ['api_key=secret-block-key', 'token=secret-block-token'],
    });
    saveChildState(runsDir, 'task-1', childState);
    const task = buildTaskResult('task-1', { originalCommitSha: headSha });
    task.rollbackReason = 'Token sk-block-fake-key-1234567890 was rejected';
    const blockState = buildBlockRunState(blockId, [task]);
    saveBlockState(runsDir, blockId, blockState);

    const result = runBlockPostPushFollowUp({ blockId, createFollowUps: false, runsDir });
    assert.strictEqual(result.exitCode, 0, result.report);
    assert.ok(!result.report.includes('secret-block-key'));
    assert.ok(!result.report.includes('secret-block-token'));
    assert.ok(!result.report.includes('sk-block-fake-key-1234567890'));
    assert.ok(result.report.includes('[REDACTED]'));
  });

  test('exits 0 when no tasks require follow-up and prints clear message', () => {
    const { repoPath, cleanup, headSha } = createTempRepo('ai/blk-follow-up-ok');
    cleanups.push(cleanup);
    const blockId = 'blk-follow-up-ok';
    const runsDir = join(process.cwd(), 'tmp', `blkppfu-runs-${Date.now()}`);
    mkdirSync(runsDir, { recursive: true });
    cleanups.push(() => rmSync(runsDir, { recursive: true, force: true }));

    const childState = buildChildRunState('task-1', repoPath, 'ai/blk-follow-up-ok', headSha, 'rollback_skipped_success');
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

    const result = runBlockPostPushFollowUp({ blockId, createFollowUps: false, runsDir });
    assert.strictEqual(result.exitCode, 0, result.report);
    assert.strictEqual(result.followUpCount, 0);
    assert.ok(result.report.includes('No tasks require post-push human follow-up'));
  });

  test('refuses missing block state', () => {
    const runsDir = join(process.cwd(), 'tmp', `blkppfu-runs-missing-${Date.now()}`);
    mkdirSync(runsDir, { recursive: true });
    cleanups.push(() => rmSync(runsDir, { recursive: true, force: true }));
    const result = runBlockPostPushFollowUp({ blockId: 'missing-block', createFollowUps: false, runsDir });
    assert.strictEqual(result.exitCode, 1);
    assert.ok(result.report.includes('does not exist'));
  });

  test('refuses corrupted block state', () => {
    const blockId = 'corrupted-block';
    const runsDir = join(process.cwd(), 'tmp', `blkppfu-runs-corrupt-${Date.now()}`);
    const blockDir = join(runsDir, 'block', blockId);
    mkdirSync(blockDir, { recursive: true });
    cleanups.push(() => rmSync(runsDir, { recursive: true, force: true }));
    writeFileSync(join(blockDir, 'state.json'), '{ invalid json', 'utf-8');

    const result = runBlockPostPushFollowUp({ blockId, createFollowUps: false, runsDir });
    assert.strictEqual(result.exitCode, 1);
    assert.ok(result.report.includes('JSON') || result.report.includes('valid'));
  });

  test('refuses mismatched block id', () => {
    const { repoPath, cleanup, headSha } = createTempRepo('ai/blk-follow-up-mismatch');
    cleanups.push(cleanup);
    const blockId = 'requested-block';
    const runsDir = join(process.cwd(), 'tmp', `blkppfu-runs-${Date.now()}`);
    mkdirSync(runsDir, { recursive: true });
    cleanups.push(() => rmSync(runsDir, { recursive: true, force: true }));

    const childState = buildChildRunState('task-1', repoPath, 'ai/blk-follow-up-mismatch', headSha, 'post_push_preserve_for_human');
    saveChildState(runsDir, 'task-1', childState);
    const blockState = buildBlockRunState('actual-block', [buildTaskResult('task-1', { originalCommitSha: headSha })]);
    saveBlockState(runsDir, blockId, blockState);

    const result = runBlockPostPushFollowUp({ blockId, createFollowUps: false, runsDir });
    assert.strictEqual(result.exitCode, 1);
    assert.ok(result.report.includes('mismatch'));
  });

  test('exits non-zero if child task state is missing for manual follow-up task', () => {
    const { repoPath, cleanup, headSha } = createTempRepo('ai/blk-follow-up-missing-child');
    cleanups.push(cleanup);
    const blockId = 'blk-follow-up-missing-child';
    const runsDir = join(process.cwd(), 'tmp', `blkppfu-runs-${Date.now()}`);
    mkdirSync(runsDir, { recursive: true });
    cleanups.push(() => rmSync(runsDir, { recursive: true, force: true }));

    const blockState = buildBlockRunState(blockId, [buildTaskResult('task-1', { originalCommitSha: headSha })]);
    saveBlockState(runsDir, blockId, blockState);

    const result = runBlockPostPushFollowUp({ blockId, createFollowUps: false, runsDir });
    assert.strictEqual(result.exitCode, 1);
    assert.ok(result.report.includes('does not exist'));
  });

  test('refuses invalid original commit SHA', () => {
    const { repoPath, cleanup } = createTempRepo('ai/blk-follow-up-bad-sha');
    cleanups.push(cleanup);
    const blockId = 'blk-follow-up-bad-sha';
    const runsDir = join(process.cwd(), 'tmp', `blkppfu-runs-${Date.now()}`);
    mkdirSync(runsDir, { recursive: true });
    cleanups.push(() => rmSync(runsDir, { recursive: true, force: true }));

    const childState = buildChildRunState('task-1', repoPath, 'ai/blk-follow-up-bad-sha', 'deadbeef', 'post_push_preserve_for_human');
    saveChildState(runsDir, 'task-1', childState);
    const blockState = buildBlockRunState(blockId, [buildTaskResult('task-1', { originalCommitSha: 'deadbeef' })]);
    saveBlockState(runsDir, blockId, blockState);

    const result = runBlockPostPushFollowUp({ blockId, createFollowUps: false, runsDir });
    assert.strictEqual(result.exitCode, 1);
    assert.ok(result.report.includes('commit SHA'));
  });

  test('refuses invalid fix commit SHA', () => {
    const { repoPath, cleanup, headSha } = createTempRepo('ai/blk-follow-up-bad-fix');
    cleanups.push(cleanup);
    const blockId = 'blk-follow-up-bad-fix';
    const runsDir = join(process.cwd(), 'tmp', `blkppfu-runs-${Date.now()}`);
    mkdirSync(runsDir, { recursive: true });
    cleanups.push(() => rmSync(runsDir, { recursive: true, force: true }));

    const childState = buildChildRunState('task-1', repoPath, 'ai/blk-follow-up-bad-fix', headSha, 'post_push_preserve_for_human', {
      fixCommitSha: 'deadbeef',
    });
    saveChildState(runsDir, 'task-1', childState);
    const blockState = buildBlockRunState(blockId, [
      buildTaskResult('task-1', { originalCommitSha: headSha, fixCommitSha: 'deadbeef' }),
    ]);
    saveBlockState(runsDir, blockId, blockState);

    const result = runBlockPostPushFollowUp({ blockId, createFollowUps: false, runsDir });
    assert.strictEqual(result.exitCode, 1);
    assert.ok(result.report.includes('commit SHA'));
  });

  test('refuses main work branch', () => {
    const { repoPath, cleanup, headSha } = createTempRepo('main');
    cleanups.push(cleanup);
    const blockId = 'blk-follow-up-main';
    const runsDir = join(process.cwd(), 'tmp', `blkppfu-runs-${Date.now()}`);
    mkdirSync(runsDir, { recursive: true });
    cleanups.push(() => rmSync(runsDir, { recursive: true, force: true }));

    const childState = buildChildRunState('task-1', repoPath, 'main', headSha, 'post_push_preserve_for_human');
    saveChildState(runsDir, 'task-1', childState);
    const blockState = buildBlockRunState(blockId, [buildTaskResult('task-1', { originalCommitSha: headSha })]);
    saveBlockState(runsDir, blockId, blockState);

    const result = runBlockPostPushFollowUp({ blockId, createFollowUps: false, runsDir });
    assert.strictEqual(result.exitCode, 1);
    assert.ok(result.report.includes('main'));
  });

  test('create-follow-ups writes deterministic follow-up files only under runs dir', () => {
    const { repoPath, cleanup, headSha } = createTempRepo('ai/blk-follow-up-create');
    cleanups.push(cleanup);
    const blockId = 'blk-follow-up-create';
    const runsDir = join(process.cwd(), 'tmp', `blkppfu-runs-${Date.now()}`);
    mkdirSync(runsDir, { recursive: true });
    cleanups.push(() => rmSync(runsDir, { recursive: true, force: true }));

    const childState = buildChildRunState('task-1', repoPath, 'ai/blk-follow-up-create', headSha, 'post_push_preserve_for_human');
    saveChildState(runsDir, 'task-1', childState);
    const blockState = buildBlockRunState(blockId, [buildTaskResult('task-1', { originalCommitSha: headSha })]);
    saveBlockState(runsDir, blockId, blockState);

    const result = runBlockPostPushFollowUp({ blockId, createFollowUps: true, runsDir });
    assert.strictEqual(result.exitCode, 0, result.report);
    const filePath = join(runsDir, 'task-1', 'follow-up-task-1-follow-up.yaml');
    assert.ok(existsSync(filePath), `follow-up file should exist: ${filePath}`);
    assert.ok(filePath.startsWith(runsDir), 'follow-up file must be inside runs dir');
  });

  test('create-follow-ups redacts token-like strings inside files', () => {
    const { repoPath, cleanup, headSha } = createTempRepo('ai/blk-follow-up-redact-file');
    cleanups.push(cleanup);
    const blockId = 'blk-follow-up-redact-file';
    const runsDir = join(process.cwd(), 'tmp', `blkppfu-runs-${Date.now()}`);
    mkdirSync(runsDir, { recursive: true });
    cleanups.push(() => rmSync(runsDir, { recursive: true, force: true }));

    const childState = buildChildRunState('task-1', repoPath, 'ai/blk-follow-up-redact-file', headSha, 'post_push_preserve_for_human', {
      blockingIssues: ['api_key=secret-yaml-key', 'token=secret-yaml-token'],
    });
    saveChildState(runsDir, 'task-1', childState);
    const blockState = buildBlockRunState(blockId, [buildTaskResult('task-1', { originalCommitSha: headSha })]);
    saveBlockState(runsDir, blockId, blockState);

    const result = runBlockPostPushFollowUp({ blockId, createFollowUps: true, runsDir });
    assert.strictEqual(result.exitCode, 0, result.report);
    const filePath = join(runsDir, 'task-1', 'follow-up-task-1-follow-up.yaml');
    const content = readFileSync(filePath, 'utf-8');
    assert.ok(!content.includes('secret-yaml-key'));
    assert.ok(!content.includes('secret-yaml-token'));
    assert.ok(content.includes('[REDACTED]'));
  });

  test('create-follow-ups does not mutate repo', () => {
    const { repoPath, cleanup, headSha } = createTempRepo('ai/blk-follow-up-no-mutate');
    cleanups.push(cleanup);
    const blockId = 'blk-follow-up-no-mutate';
    const runsDir = join(process.cwd(), 'tmp', `blkppfu-runs-${Date.now()}`);
    mkdirSync(runsDir, { recursive: true });
    cleanups.push(() => rmSync(runsDir, { recursive: true, force: true }));

    const childState = buildChildRunState('task-1', repoPath, 'ai/blk-follow-up-no-mutate', headSha, 'post_push_preserve_for_human');
    saveChildState(runsDir, 'task-1', childState);
    const blockState = buildBlockRunState(blockId, [buildTaskResult('task-1', { originalCommitSha: headSha })]);
    saveBlockState(runsDir, blockId, blockState);

    const statusBefore = spawnSync('git', ['status', '--porcelain'], { cwd: repoPath, encoding: 'utf-8', shell: false }).stdout;
    const headBefore = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repoPath, encoding: 'utf-8', shell: false }).stdout.trim();

    runBlockPostPushFollowUp({ blockId, createFollowUps: true, runsDir });

    const statusAfter = spawnSync('git', ['status', '--porcelain'], { cwd: repoPath, encoding: 'utf-8', shell: false }).stdout;
    const headAfter = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repoPath, encoding: 'utf-8', shell: false }).stdout.trim();

    assert.strictEqual(statusAfter, statusBefore);
    assert.strictEqual(headAfter, headBefore);
  });

  test('no provider or reviewer calls are made', () => {
    const { repoPath, cleanup, headSha } = createTempRepo('ai/blk-follow-up-no-ai');
    cleanups.push(cleanup);
    const blockId = 'blk-follow-up-no-ai';
    const runsDir = join(process.cwd(), 'tmp', `blkppfu-runs-${Date.now()}`);
    mkdirSync(runsDir, { recursive: true });
    cleanups.push(() => rmSync(runsDir, { recursive: true, force: true }));

    const childState = buildChildRunState('task-1', repoPath, 'ai/blk-follow-up-no-ai', headSha, 'post_push_preserve_for_human');
    saveChildState(runsDir, 'task-1', childState);
    const blockState = buildBlockRunState(blockId, [buildTaskResult('task-1', { originalCommitSha: headSha })]);
    saveBlockState(runsDir, blockId, blockState);

    const result = runBlockPostPushFollowUp({ blockId, createFollowUps: false, runsDir });
    assert.strictEqual(result.exitCode, 0);
    assert.ok(result.report.includes('No provider call was made'));
    assert.ok(result.report.includes('No repository mutation was performed'));
  });
});
