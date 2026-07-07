import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  verifyCommitExists,
  verifyCommitIsAncestor,
  verifyTaskResultHistory,
  prepareFreshBlockRun,
} from '../src/block/block-state-consistency.js';
import type { RealBlockRunTaskResult } from '../src/real-block-run-ai-state.js';

function runGit(cwd: string, args: string[]): { ok: boolean; stdout: string; stderr: string } {
  const result = spawnSync('git', args, { cwd, encoding: 'utf-8', shell: false });
  return {
    ok: result.status === 0,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
  };
}

function createTempRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'block-consistency-test-'));
  runGit(dir, ['init', '--initial-branch=main']);
  runGit(dir, ['config', 'user.email', 'test@example.com']);
  runGit(dir, ['config', 'user.name', 'Test']);
  writeFileSync(join(dir, 'base.txt'), 'base');
  runGit(dir, ['add', 'base.txt']);
  runGit(dir, ['commit', '-m', 'base']);
  return dir;
}

function makeResult(status: RealBlockRunTaskResult['status'], originalSha: string, fixSha?: string): RealBlockRunTaskResult {
  return {
    taskId: 'task_1',
    title: 'Task 1',
    status,
    fixAttempted: false,
    finalStatus: status,
    nextAction: 'continue',
    childStateTaskId: 'task_1',
    originalCommitSha: originalSha,
    fixCommitSha: fixSha,
  } as RealBlockRunTaskResult;
}

describe('verifyCommitExists', () => {
  it('returns ok true when commit exists', () => {
    const repo = createTempRepo();
    const head = runGit(repo, ['rev-parse', 'HEAD']).stdout.trim();
    const result = verifyCommitExists(repo, head);
    assert.equal(result.ok, true);
  });

  it('returns ok false when commit is missing', () => {
    const repo = createTempRepo();
    const result = verifyCommitExists(repo, '0'.repeat(40));
    assert.equal(result.ok, false);
    assert.match(result.reason || '', /does not exist/);
  });
});

describe('verifyCommitIsAncestor', () => {
  it('returns ok true when commit is ancestor of HEAD', () => {
    const repo = createTempRepo();
    const base = runGit(repo, ['rev-parse', 'HEAD']).stdout.trim();
    runGit(repo, ['checkout', '-b', 'work']);
    writeFileSync(join(repo, 'work.txt'), 'work');
    runGit(repo, ['add', 'work.txt']);
    runGit(repo, ['commit', '-m', 'work']);
    const result = verifyCommitIsAncestor(repo, base, 'HEAD');
    assert.equal(result.ok, true);
  });

  it('returns ok false when commit is not ancestor of HEAD', () => {
    const repo = createTempRepo();
    runGit(repo, ['checkout', '-b', 'orphan']);
    writeFileSync(join(repo, 'orphan.txt'), 'orphan');
    runGit(repo, ['add', 'orphan.txt']);
    runGit(repo, ['commit', '-m', 'orphan']);
    const orphanSha = runGit(repo, ['rev-parse', 'HEAD']).stdout.trim();
    runGit(repo, ['checkout', 'main']);
    const result = verifyCommitIsAncestor(repo, orphanSha, 'HEAD');
    assert.equal(result.ok, false);
    assert.match(result.reason || '', /not an ancestor/);
  });

  it('returns ok false when commit is missing', () => {
    const repo = createTempRepo();
    const result = verifyCommitIsAncestor(repo, '0'.repeat(40), 'HEAD');
    assert.equal(result.ok, false);
  });
});

describe('verifyTaskResultHistory', () => {
  it('passes when accepted commit is ancestor of work branch', () => {
    const repo = createTempRepo();
    runGit(repo, ['checkout', '-b', 'work']);
    writeFileSync(join(repo, 'a.txt'), 'a');
    runGit(repo, ['add', 'a.txt']);
    runGit(repo, ['commit', '-m', 'task1']);
    const taskSha = runGit(repo, ['rev-parse', 'HEAD']).stdout.trim();
    const result = verifyTaskResultHistory(makeResult('accepted', taskSha), repo, 'HEAD');
    assert.equal(result.ok, true);
  });

  it('fails when accepted commit is missing', () => {
    const repo = createTempRepo();
    const result = verifyTaskResultHistory(makeResult('accepted', '0'.repeat(40)), repo, 'HEAD');
    assert.equal(result.ok, false);
    assert.match(result.reason || '', /does not exist/);
  });

  it('fails when accepted commit exists but is not ancestor of work branch', () => {
    const repo = createTempRepo();
    runGit(repo, ['checkout', '-b', 'work']);
    writeFileSync(join(repo, 'a.txt'), 'a');
    runGit(repo, ['add', 'a.txt']);
    runGit(repo, ['commit', '-m', 'task1']);
    const taskSha = runGit(repo, ['rev-parse', 'HEAD']).stdout.trim();
    runGit(repo, ['checkout', 'main']);
    const result = verifyTaskResultHistory(makeResult('accepted', taskSha), repo, 'HEAD');
    assert.equal(result.ok, false);
    assert.match(result.reason || '', /not an ancestor/);
  });

  it('fails for fixed_and_accepted when fix commit is not ancestor', () => {
    const repo = createTempRepo();
    runGit(repo, ['checkout', '-b', 'work']);
    writeFileSync(join(repo, 'a.txt'), 'a');
    runGit(repo, ['add', 'a.txt']);
    runGit(repo, ['commit', '-m', 'original']);
    const originalSha = runGit(repo, ['rev-parse', 'HEAD']).stdout.trim();
    runGit(repo, ['checkout', 'main']);
    writeFileSync(join(repo, 'fix.txt'), 'fix');
    runGit(repo, ['add', 'fix.txt']);
    runGit(repo, ['commit', '-m', 'fix']);
    const fixSha = runGit(repo, ['rev-parse', 'HEAD']).stdout.trim();
    runGit(repo, ['checkout', 'work']);
    const result = verifyTaskResultHistory(makeResult('fixed_and_accepted', originalSha, fixSha), repo, 'HEAD');
    assert.equal(result.ok, false);
    assert.match(result.reason || '', /not an ancestor/);
  });
});

describe('prepareFreshBlockRun', () => {
  it('removes only current block state and task states', () => {
    const runsDir = mkdtempSync(join(tmpdir(), 'fresh-runs-'));
    const block = {
      block_id: 'test_block',
      title: 'Test',
      repo_path: '/tmp/repo',
      base_branch: 'main',
      work_branch: 'work',
      providers: { coder: { provider: 'kimi', model: 'kimi-k2.6' }, reviewer: { provider: 'kimi', model: 'kimi-k2.6' } },
      review_policy: { require_deterministic_checks: true, max_fix_attempts: 1, reviewer_mode: 'single' },
      tasks: [
        { task_id: 'task_a', title: 'A', goal: 'a', allowed_files: [], denied_files: [], max_lines_changed: 10, checks: [] },
        { task_id: 'task_b', title: 'B', goal: 'b', allowed_files: [], denied_files: [], max_lines_changed: 10, checks: [] },
      ],
    } as unknown as import('../src/block/block-types.js').BlockDefinition;

    const blockStatePath = join(runsDir, 'block', 'test_block', 'state.json');
    const taskAStatePath = join(runsDir, 'tasks', 'task_a', 'state.json');
    const taskBStatePath = join(runsDir, 'tasks', 'task_b', 'state.json');
    const unrelatedStatePath = join(runsDir, 'other_task', 'state.json');

    mkdirSync(join(runsDir, 'block', 'test_block'), { recursive: true });
    mkdirSync(join(runsDir, 'tasks', 'task_a'), { recursive: true });
    mkdirSync(join(runsDir, 'tasks', 'task_b'), { recursive: true });
    mkdirSync(join(runsDir, 'other_task'), { recursive: true });
    writeFileSync(blockStatePath, '{}');
    writeFileSync(taskAStatePath, '{}');
    writeFileSync(taskBStatePath, '{}');
    writeFileSync(unrelatedStatePath, '{}');

    const removed = prepareFreshBlockRun(block, runsDir);

    assert.equal(existsSync(blockStatePath), false);
    assert.equal(existsSync(taskAStatePath), false);
    assert.equal(existsSync(taskBStatePath), false);
    assert.equal(existsSync(unrelatedStatePath), true);
    assert.ok(removed.blockStatePath.includes('test_block'));
    assert.equal(removed.taskStatePaths.length, 2);
  });
});
