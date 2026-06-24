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
import YAML from 'yaml';
import { runPostPushFollowUp } from '../src/post-push-follow-up.js';
import { loadState, saveState } from '../src/state-manager.js';
import type { RunState } from '../src/types.js';

let counter = 0;

function createTempRepo(branch = 'ai/task-x'): { repoPath: string; tmpDir: string; cleanup: () => void; headSha: string } {
  const id = `${Date.now()}-${counter++}`;
  const tmpBase = join(process.cwd(), 'tmp');
  if (!existsSync(tmpBase)) {
    mkdirSync(tmpBase);
  }
  const tmpDir = mkdtempSync(join(tmpBase, `ppfu-${id}-`));
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

function buildValidState(
  taskId: string,
  repoPath: string,
  branch: string,
  commitSha: string,
  reviewerStatus: 'blocked' | 'fix_required' = 'blocked',
  overrides: Partial<RunState> = {}
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
      policy: 'post_push_preserve_for_human',
      reason: 'Commit was already pushed; rollback skipped. Human follow-up required.',
    },
    ...(overrides as Partial<RunState>),
  };
  const s = state as unknown as Record<string, unknown>;
  s.reviewer_gate = {
    status: reviewerStatus,
    source: 'reviewer',
    nextAction: reviewerStatus === 'fix_required' ? 'fix' : 'block',
    blockingIssues: ['token sk-reviewer-secret-123456 must be redacted', 'needs human review'],
    nonBlockingIssues: [],
    reviewSummary: `Reviewer ${reviewerStatus}; api_key=super-secret must be redacted`,
    fixTask: reviewerStatus === 'fix_required' ? 'Add more detail' : undefined,
  };
  return state;
}

function buildStateWithFixCommit(
  taskId: string,
  repoPath: string,
  branch: string,
  originalCommitSha: string,
  fixCommitSha: string
): RunState {
  const state = buildValidState(taskId, repoPath, branch, originalCommitSha, 'fix_required');
  const s = state as unknown as Record<string, unknown>;
  s.reviewer_fix_task_second_review = {
    fixTaskId: `${taskId}-fix-1`,
    parentTaskId: taskId,
    attempt: 1,
    fixCommitSha,
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
  return state;
}

describe('post-push follow-up', () => {
  const cleanups: Array<() => void> = [];

  afterEach(() => {
    while (cleanups.length > 0) {
      cleanups.pop()?.();
    }
  });

  test('report-only succeeds for valid post_push_preserve_for_human state', () => {
    const { repoPath, cleanup, headSha } = createTempRepo('ai/follow-up-valid');
    cleanups.push(cleanup);
    const taskId = 'follow-up-valid';
    const runsDir = join(process.cwd(), 'tmp', `ppfu-runs-${Date.now()}`);
    mkdirSync(runsDir, { recursive: true });
    cleanups.push(() => rmSync(runsDir, { recursive: true, force: true }));
    const state = buildValidState(taskId, repoPath, 'ai/follow-up-valid', headSha);
    saveState(taskId, state, runsDir);

    const result = runPostPushFollowUp({ taskId, reportOnly: true, runsDir });
    assert.strictEqual(result.exitCode, 0, result.report);
    assert.strictEqual(result.ok, true);
    assert.ok(result.report.includes('Human follow-up required before merge'));
  });

  test('report-only prints preserved original commit', () => {
    const { repoPath, cleanup, headSha } = createTempRepo('ai/follow-up-commit');
    cleanups.push(cleanup);
    const taskId = 'follow-up-commit';
    const runsDir = join(process.cwd(), 'tmp', `ppfu-runs-${Date.now()}`);
    mkdirSync(runsDir, { recursive: true });
    cleanups.push(() => rmSync(runsDir, { recursive: true, force: true }));
    const state = buildValidState(taskId, repoPath, 'ai/follow-up-commit', headSha);
    saveState(taskId, state, runsDir);

    const result = runPostPushFollowUp({ taskId, reportOnly: true, runsDir });
    assert.strictEqual(result.exitCode, 0, result.report);
    assert.ok(result.report.includes(`Preserved original commit: ${headSha}`));
  });

  test('report-only prints preserved fix commit if present', () => {
    const { repoPath, cleanup, headSha } = createTempRepo('ai/follow-up-fix');
    cleanups.push(cleanup);
    const taskId = 'follow-up-fix';
    const runsDir = join(process.cwd(), 'tmp', `ppfu-runs-${Date.now()}`);
    mkdirSync(runsDir, { recursive: true });
    cleanups.push(() => rmSync(runsDir, { recursive: true, force: true }));
    // Create a second commit to act as fix commit
    writeFileSync(join(repoPath, 'fix.txt'), 'fix\n', 'utf-8');
    spawnSync('git', ['add', '.'], { cwd: repoPath, encoding: 'utf-8', shell: false });
    spawnSync('git', ['commit', '-m', 'fix', '--no-gpg-sign'], { cwd: repoPath, encoding: 'utf-8', shell: false });
    const fixHeadResult = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repoPath, encoding: 'utf-8', shell: false });
    const fixCommitSha = fixHeadResult.stdout.trim();

    const state = buildStateWithFixCommit(taskId, repoPath, 'ai/follow-up-fix', headSha, fixCommitSha);
    saveState(taskId, state, runsDir);

    const result = runPostPushFollowUp({ taskId, reportOnly: true, runsDir });
    assert.strictEqual(result.exitCode, 0, result.report);
    assert.ok(result.report.includes(`Preserved fix commit: ${fixCommitSha}`));
  });

  test('report-only prints rollback skipped reason', () => {
    const { repoPath, cleanup, headSha } = createTempRepo('ai/follow-up-reason');
    cleanups.push(cleanup);
    const taskId = 'follow-up-reason';
    const runsDir = join(process.cwd(), 'tmp', `ppfu-runs-${Date.now()}`);
    mkdirSync(runsDir, { recursive: true });
    cleanups.push(() => rmSync(runsDir, { recursive: true, force: true }));
    const state = buildValidState(taskId, repoPath, 'ai/follow-up-reason', headSha);
    saveState(taskId, state, runsDir);

    const result = runPostPushFollowUp({ taskId, reportOnly: true, runsDir });
    assert.strictEqual(result.exitCode, 0, result.report);
    assert.ok(result.report.includes('Rollback reason:'));
    assert.ok(result.report.includes('Human follow-up required'));
  });

  test('report-only redacts token-like reviewer and blocking issue strings', () => {
    const { repoPath, cleanup, headSha } = createTempRepo('ai/follow-up-redact');
    cleanups.push(cleanup);
    const taskId = 'follow-up-redact';
    const runsDir = join(process.cwd(), 'tmp', `ppfu-runs-${Date.now()}`);
    mkdirSync(runsDir, { recursive: true });
    cleanups.push(() => rmSync(runsDir, { recursive: true, force: true }));
    const state = buildValidState(taskId, repoPath, 'ai/follow-up-redact', headSha, 'fix_required');
    saveState(taskId, state, runsDir);

    const result = runPostPushFollowUp({ taskId, reportOnly: true, runsDir });
    assert.strictEqual(result.exitCode, 0, result.report);
    assert.ok(!result.report.includes('sk-reviewer-secret-123456'), 'raw secret should be redacted');
    assert.ok(!result.report.includes('super-secret'), 'api key value should be redacted');
    assert.ok(result.report.includes('[REDACTED]'), 'report should contain redaction marker');
  });

  test('refuses non-post-push rollback state', () => {
    const { repoPath, cleanup, headSha } = createTempRepo('ai/follow-up-wrong-policy');
    cleanups.push(cleanup);
    const taskId = 'follow-up-wrong-policy';
    const runsDir = join(process.cwd(), 'tmp', `ppfu-runs-${Date.now()}`);
    mkdirSync(runsDir, { recursive: true });
    cleanups.push(() => rmSync(runsDir, { recursive: true, force: true }));
    const state = buildValidState(taskId, repoPath, 'ai/follow-up-wrong-policy', headSha);
    state.rollback = {
      attempted: true,
      status: 'succeeded',
      checkpointHead: headSha,
      policy: 'pre_push_failure',
      reason: 'Rolled back before push',
    };
    saveState(taskId, state, runsDir);

    const result = runPostPushFollowUp({ taskId, reportOnly: true, runsDir });
    assert.strictEqual(result.exitCode, 1, result.report);
    assert.ok(result.report.includes('expected skipped') || result.report.includes('post_push_preserve_for_human'));
  });

  test('refuses missing state', () => {
    const runsDir = join(process.cwd(), 'tmp', `ppfu-runs-missing-${Date.now()}`);
    mkdirSync(runsDir, { recursive: true });
    cleanups.push(() => rmSync(runsDir, { recursive: true, force: true }));
    const result = runPostPushFollowUp({ taskId: 'missing-task', reportOnly: true, runsDir });
    assert.strictEqual(result.exitCode, 1);
    assert.ok(result.report.includes('does not exist'));
  });

  test('refuses corrupted state', () => {
    const taskId = 'corrupted-task';
    const runsDir = join(process.cwd(), 'tmp', `ppfu-runs-corrupt-${Date.now()}`);
    const runDir = join(runsDir, taskId);
    mkdirSync(runDir, { recursive: true });
    cleanups.push(() => rmSync(runsDir, { recursive: true, force: true }));
    writeFileSync(join(runDir, 'state.json'), '{ invalid json', 'utf-8');

    const result = runPostPushFollowUp({ taskId, reportOnly: true, runsDir });
    assert.strictEqual(result.exitCode, 1);
    assert.ok(result.report.includes('JSON') || result.report.includes('Invalid'));
  });

  test('refuses invalid commit sha', () => {
    const { repoPath, cleanup } = createTempRepo('ai/follow-up-bad-sha');
    cleanups.push(cleanup);
    const taskId = 'follow-up-bad-sha';
    const runsDir = join(process.cwd(), 'tmp', `ppfu-runs-${Date.now()}`);
    mkdirSync(runsDir, { recursive: true });
    cleanups.push(() => rmSync(runsDir, { recursive: true, force: true }));
    const state = buildValidState(taskId, repoPath, 'ai/follow-up-bad-sha', 'deadbeef');
    saveState(taskId, state, runsDir);

    const result = runPostPushFollowUp({ taskId, reportOnly: true, runsDir });
    assert.strictEqual(result.exitCode, 1);
    assert.ok(result.report.includes('commit SHA'));
  });

  test('refuses main work branch', () => {
    const { repoPath, cleanup, headSha } = createTempRepo('main');
    cleanups.push(cleanup);
    const taskId = 'follow-up-main';
    const runsDir = join(process.cwd(), 'tmp', `ppfu-runs-${Date.now()}`);
    mkdirSync(runsDir, { recursive: true });
    cleanups.push(() => rmSync(runsDir, { recursive: true, force: true }));
    const state = buildValidState(taskId, repoPath, 'main', headSha);
    saveState(taskId, state, runsDir);

    const result = runPostPushFollowUp({ taskId, reportOnly: true, runsDir });
    assert.strictEqual(result.exitCode, 1);
    assert.ok(result.report.includes('main'));
  });

  test('refuses master work branch', () => {
    const { repoPath, cleanup, headSha } = createTempRepo('master');
    cleanups.push(cleanup);
    const taskId = 'follow-up-master';
    const runsDir = join(process.cwd(), 'tmp', `ppfu-runs-${Date.now()}`);
    mkdirSync(runsDir, { recursive: true });
    cleanups.push(() => rmSync(runsDir, { recursive: true, force: true }));
    const state = buildValidState(taskId, repoPath, 'master', headSha);
    saveState(taskId, state, runsDir);

    const result = runPostPushFollowUp({ taskId, reportOnly: true, runsDir });
    assert.strictEqual(result.exitCode, 1);
    assert.ok(result.report.includes('master'));
  });

  test('create-follow-up writes follow-up task file under runs dir only', () => {
    const { repoPath, cleanup, headSha } = createTempRepo('ai/follow-up-create');
    cleanups.push(cleanup);
    const taskId = 'follow-up-create';
    const newTaskId = 'follow-up-create-next';
    const runsDir = join(process.cwd(), 'tmp', `ppfu-runs-${Date.now()}`);
    mkdirSync(runsDir, { recursive: true });
    cleanups.push(() => rmSync(runsDir, { recursive: true, force: true }));
    const state = buildValidState(taskId, repoPath, 'ai/follow-up-create', headSha, 'fix_required');
    saveState(taskId, state, runsDir);

    const beforeFiles = existsSync(join(runsDir, taskId, `follow-up-${newTaskId}.yaml`));
    assert.strictEqual(beforeFiles, false);

    const result = runPostPushFollowUp({ taskId, reportOnly: false, followUpTaskId: newTaskId, runsDir });
    assert.strictEqual(result.exitCode, 0, result.report);
    const filePath = join(runsDir, taskId, `follow-up-${newTaskId}.yaml`);
    assert.strictEqual(result.followUpFilePath, filePath);
    assert.ok(existsSync(filePath));
    assert.ok(filePath.startsWith(runsDir), 'follow-up file must be inside runs dir');
  });

  test('create-follow-up includes blocking issues as context, redacted', () => {
    const { repoPath, cleanup, headSha } = createTempRepo('ai/follow-up-context');
    cleanups.push(cleanup);
    const taskId = 'follow-up-context';
    const newTaskId = 'follow-up-context-next';
    const runsDir = join(process.cwd(), 'tmp', `ppfu-runs-${Date.now()}`);
    mkdirSync(runsDir, { recursive: true });
    cleanups.push(() => rmSync(runsDir, { recursive: true, force: true }));
    const state = buildValidState(taskId, repoPath, 'ai/follow-up-context', headSha, 'fix_required');
    saveState(taskId, state, runsDir);

    const result = runPostPushFollowUp({ taskId, reportOnly: false, followUpTaskId: newTaskId, runsDir });
    assert.strictEqual(result.exitCode, 0, result.report);
    const filePath = result.followUpFilePath!;
    const content = readFileSync(filePath, 'utf-8');
    const doc = YAML.parse(content);
    assert.ok(Array.isArray(doc.tasks));
    assert.strictEqual(doc.tasks[0].id, newTaskId);
    const goal = doc.tasks[0].goal as string;
    assert.ok(goal.includes('Blocking issues:'));
    assert.ok(!goal.includes('sk-reviewer-secret-123456'));
    assert.ok(goal.includes('[REDACTED]'));
  });

  test('create-follow-up prints next command', () => {
    const { repoPath, cleanup, headSha } = createTempRepo('ai/follow-up-command');
    cleanups.push(cleanup);
    const taskId = 'follow-up-command';
    const newTaskId = 'follow-up-command-next';
    const runsDir = join(process.cwd(), 'tmp', `ppfu-runs-${Date.now()}`);
    mkdirSync(runsDir, { recursive: true });
    cleanups.push(() => rmSync(runsDir, { recursive: true, force: true }));
    const state = buildValidState(taskId, repoPath, 'ai/follow-up-command', headSha, 'blocked');
    saveState(taskId, state, runsDir);

    const result = runPostPushFollowUp({ taskId, reportOnly: false, followUpTaskId: newTaskId, runsDir });
    assert.strictEqual(result.exitCode, 0, result.report);
    assert.ok(result.nextCommand);
    assert.ok(result.nextCommand!.includes('real-repo-run-ai'));
    assert.ok(result.nextCommand!.includes(newTaskId));
    assert.ok(result.nextCommand!.includes(result.followUpFilePath!));
  });

  test('create-follow-up does not mutate repo', () => {
    const { repoPath, cleanup, headSha } = createTempRepo('ai/follow-up-no-mutate');
    cleanups.push(cleanup);
    const taskId = 'follow-up-no-mutate';
    const newTaskId = 'follow-up-no-mutate-next';
    const runsDir = join(process.cwd(), 'tmp', `ppfu-runs-${Date.now()}`);
    mkdirSync(runsDir, { recursive: true });
    cleanups.push(() => rmSync(runsDir, { recursive: true, force: true }));
    const state = buildValidState(taskId, repoPath, 'ai/follow-up-no-mutate', headSha);
    saveState(taskId, state, runsDir);

    const statusBefore = spawnSync('git', ['status', '--porcelain'], { cwd: repoPath, encoding: 'utf-8', shell: false });
    const branchBefore = spawnSync('git', ['branch', '--show-current'], { cwd: repoPath, encoding: 'utf-8', shell: false });
    const headBefore = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repoPath, encoding: 'utf-8', shell: false });

    runPostPushFollowUp({ taskId, reportOnly: false, followUpTaskId: newTaskId, runsDir });

    const statusAfter = spawnSync('git', ['status', '--porcelain'], { cwd: repoPath, encoding: 'utf-8', shell: false });
    const branchAfter = spawnSync('git', ['branch', '--show-current'], { cwd: repoPath, encoding: 'utf-8', shell: false });
    const headAfter = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repoPath, encoding: 'utf-8', shell: false });

    assert.strictEqual(statusAfter.stdout, statusBefore.stdout);
    assert.strictEqual(branchAfter.stdout.trim(), branchBefore.stdout.trim());
    assert.strictEqual(headAfter.stdout.trim(), headBefore.stdout.trim());
  });

  test('no provider or reviewer calls are made', () => {
    const { repoPath, cleanup, headSha } = createTempRepo('ai/follow-up-no-ai');
    cleanups.push(cleanup);
    const taskId = 'follow-up-no-ai';
    const runsDir = join(process.cwd(), 'tmp', `ppfu-runs-${Date.now()}`);
    mkdirSync(runsDir, { recursive: true });
    cleanups.push(() => rmSync(runsDir, { recursive: true, force: true }));
    const state = buildValidState(taskId, repoPath, 'ai/follow-up-no-ai', headSha);
    saveState(taskId, state, runsDir);

    const result = runPostPushFollowUp({ taskId, reportOnly: true, runsDir });
    assert.strictEqual(result.exitCode, 0);
    assert.ok(result.report.includes('No provider call was made'));
    assert.ok(result.report.includes('No repository mutation was performed'));
  });

  test('state load returns correct task via state-manager', () => {
    const { repoPath, cleanup, headSha } = createTempRepo('ai/follow-up-load');
    cleanups.push(cleanup);
    const taskId = 'follow-up-load';
    const runsDir = join(process.cwd(), 'tmp', `ppfu-runs-${Date.now()}`);
    mkdirSync(runsDir, { recursive: true });
    cleanups.push(() => rmSync(runsDir, { recursive: true, force: true }));
    const state = buildValidState(taskId, repoPath, 'ai/follow-up-load', headSha);
    saveState(taskId, state, runsDir);

    const loaded = loadState(taskId, runsDir);
    assert.ok(loaded);
    assert.strictEqual(loaded!.task_id, taskId);
    assert.strictEqual(loaded!.status, 'pushed');
  });

  test('rejects state with mismatched internal task_id', () => {
    const { repoPath, cleanup, headSha } = createTempRepo('ai/follow-up-mismatch');
    cleanups.push(cleanup);
    const requestedTaskId = 'follow-up-mismatch';
    const internalTaskId = 'different-task-id';
    const runsDir = join(process.cwd(), 'tmp', `ppfu-runs-${Date.now()}`);
    mkdirSync(runsDir, { recursive: true });
    cleanups.push(() => rmSync(runsDir, { recursive: true, force: true }));
    const state = buildValidState(internalTaskId, repoPath, 'ai/follow-up-mismatch', headSha);
    saveState(requestedTaskId, state, runsDir);

    const result = runPostPushFollowUp({ taskId: requestedTaskId, reportOnly: true, runsDir });
    assert.strictEqual(result.exitCode, 1, result.report);
    assert.ok(
      result.report.includes('task_id mismatch') || result.report.includes('mismatch'),
      `report should mention task_id mismatch, got: ${result.report}`
    );
    assert.ok(result.report.includes('No provider call was made'));
    assert.ok(result.report.includes('No repository mutation was performed'));
  });

  test('rejects invalid fix commit SHA format', () => {
    const { repoPath, cleanup, headSha } = createTempRepo('ai/follow-up-bad-fix-sha');
    cleanups.push(cleanup);
    const taskId = 'follow-up-bad-fix-sha';
    const runsDir = join(process.cwd(), 'tmp', `ppfu-runs-${Date.now()}`);
    mkdirSync(runsDir, { recursive: true });
    cleanups.push(() => rmSync(runsDir, { recursive: true, force: true }));
    const state = buildStateWithFixCommit(taskId, repoPath, 'ai/follow-up-bad-fix-sha', headSha, 'deadbeef');
    saveState(taskId, state, runsDir);

    const result = runPostPushFollowUp({ taskId, reportOnly: true, runsDir });
    assert.strictEqual(result.exitCode, 1, result.report);
    assert.ok(result.report.includes('commit SHA'));
  });

  test('rejects nonexistent fix commit SHA', () => {
    const { repoPath, cleanup, headSha } = createTempRepo('ai/follow-up-missing-fix-sha');
    cleanups.push(cleanup);
    const taskId = 'follow-up-missing-fix-sha';
    const runsDir = join(process.cwd(), 'tmp', `ppfu-runs-${Date.now()}`);
    mkdirSync(runsDir, { recursive: true });
    cleanups.push(() => rmSync(runsDir, { recursive: true, force: true }));
    const state = buildStateWithFixCommit(
      taskId,
      repoPath,
      'ai/follow-up-missing-fix-sha',
      headSha,
      '0000000000000000000000000000000000000000'
    );
    saveState(taskId, state, runsDir);

    const result = runPostPushFollowUp({ taskId, reportOnly: true, runsDir });
    assert.strictEqual(result.exitCode, 1, result.report);
    assert.ok(result.report.includes('commit SHA'));
  });
});
