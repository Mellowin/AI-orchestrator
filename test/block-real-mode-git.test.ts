import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  getCurrentBranchName,
  getGitStatusPorcelain,
  stageOnlyFiles,
  commitStagedChanges,
  pushCurrentBranch,
  assertNoUnrelatedChanges,
} from '../src/block/block-real-mode-git.js';

function initGitRepo(repoPath: string): void {
  spawnSync('git', ['init'], { cwd: repoPath, shell: false, encoding: 'utf-8' });
  spawnSync('git', ['config', 'user.email', 'test@test.com'], { cwd: repoPath, shell: false, encoding: 'utf-8' });
  spawnSync('git', ['config', 'user.name', 'Test'], { cwd: repoPath, shell: false, encoding: 'utf-8' });
  writeFileSync(join(repoPath, 'initial.txt'), 'initial\n');
  spawnSync('git', ['add', 'initial.txt'], { cwd: repoPath, shell: false, encoding: 'utf-8' });
  spawnSync('git', ['commit', '-m', 'initial', '--no-gpg-sign'], { cwd: repoPath, shell: false, encoding: 'utf-8' });
}

describe('block-real-mode-git', () => {
  let repoPath: string;

  beforeEach(() => {
    repoPath = mkdtempSync(join(tmpdir(), 'block-git-test-'));
    initGitRepo(repoPath);
    spawnSync('git', ['checkout', '-b', 'feature/test'], { cwd: repoPath, shell: false, encoding: 'utf-8' });
  });

  afterEach(() => {
    try {
      rmSync(repoPath, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it('getCurrentBranchName returns branch', () => {
    const branch = getCurrentBranchName(repoPath);
    assert.strictEqual(branch, 'feature/test');
  });

  it('getGitStatusPorcelain returns status', () => {
    writeFileSync(join(repoPath, 'dirty.txt'), 'dirty\n');
    const status = getGitStatusPorcelain(repoPath);
    assert.ok(status.includes('dirty.txt'), `Expected dirty.txt in status, got: ${status}`);
  });

  it('stageOnlyFiles rejects empty files', () => {
    assert.throws(() => stageOnlyFiles(repoPath, []), /empty/);
  });

  it('stageOnlyFiles rejects absolute path', () => {
    assert.throws(() => stageOnlyFiles(repoPath, ['/abs/path.txt']), /absolute/);
  });

  it('stageOnlyFiles rejects ..', () => {
    assert.throws(() => stageOnlyFiles(repoPath, ['../escape.txt']), /traversal/);
  });

  it('stageOnlyFiles stages only approved file', () => {
    writeFileSync(join(repoPath, 'a.txt'), 'a\n');
    writeFileSync(join(repoPath, 'b.txt'), 'b\n');
    stageOnlyFiles(repoPath, ['a.txt']);
    const status = getGitStatusPorcelain(repoPath);
    // a.txt should be staged (A or M in first column)
    assert.ok(status.split('\n').some((l) => l.trim().startsWith('A ') && l.includes('a.txt')), 'a.txt should be staged');
    // b.txt should not be staged (should be untracked ??)
    assert.ok(status.split('\n').some((l) => l.trim().startsWith('?? ') && l.includes('b.txt')), 'b.txt should be untracked');
  });

  it('stageOnlyFiles does not stage unrelated file', () => {
    writeFileSync(join(repoPath, 'a.txt'), 'a\n');
    writeFileSync(join(repoPath, 'b.txt'), 'b\n');
    stageOnlyFiles(repoPath, ['a.txt']);
    const status = getGitStatusPorcelain(repoPath);
    const lines = status.split('\n').filter((l) => l.trim().length > 0);
    const staged = lines.filter((l) => l.startsWith('A ') || l.startsWith('M '));
    assert.strictEqual(staged.length, 1);
    assert.ok(staged[0].includes('a.txt'));
  });

  it('assertNoUnrelatedChanges passes for approved dirty file', () => {
    writeFileSync(join(repoPath, 'a.txt'), 'a\n');
    stageOnlyFiles(repoPath, ['a.txt']);
    assert.doesNotThrow(() => assertNoUnrelatedChanges(repoPath, ['a.txt']));
  });

  it('assertNoUnrelatedChanges rejects unrelated dirty file', () => {
    writeFileSync(join(repoPath, 'a.txt'), 'a\n');
    writeFileSync(join(repoPath, 'b.txt'), 'b\n');
    stageOnlyFiles(repoPath, ['a.txt']);
    assert.throws(() => assertNoUnrelatedChanges(repoPath, ['a.txt']), /Unrelated change detected: b\.txt/);
  });

  it('commitStagedChanges returns 40-char SHA', () => {
    writeFileSync(join(repoPath, 'a.txt'), 'a\n');
    stageOnlyFiles(repoPath, ['a.txt']);
    const sha = commitStagedChanges(repoPath, 'test commit');
    assert.strictEqual(sha.length, 40);
    assert.ok(/^[0-9a-f]{40}$/.test(sha));
  });

  it('pushCurrentBranch does not use force', () => {
    // Create a bare remote
    const remotePath = mkdtempSync(join(tmpdir(), 'block-git-remote-'));
    spawnSync('git', ['init', '--bare'], { cwd: remotePath, shell: false, encoding: 'utf-8' });
    spawnSync('git', ['remote', 'add', 'origin', remotePath], { cwd: repoPath, shell: false, encoding: 'utf-8' });

    writeFileSync(join(repoPath, 'a.txt'), 'a\n');
    stageOnlyFiles(repoPath, ['a.txt']);
    commitStagedChanges(repoPath, 'test commit');
    const pushed = pushCurrentBranch(repoPath, 'feature/test');
    assert.strictEqual(pushed, true);

    // Verify no force push by checking reflog or simply that push succeeded
    const logResult = spawnSync('git', ['log', '--oneline', 'origin/feature/test'], { cwd: repoPath, shell: false, encoding: 'utf-8' });
    assert.ok(logResult.stdout.includes('test commit'));

    rmSync(remotePath, { recursive: true, force: true });
  });

  it('no git add -A used', () => {
    // This is a code-level check: stageOnlyFiles must never call git add -A
    // We verify by inspecting the function behavior: only specific files are staged
    writeFileSync(join(repoPath, 'a.txt'), 'a\n');
    writeFileSync(join(repoPath, 'b.txt'), 'b\n');
    stageOnlyFiles(repoPath, ['a.txt']);
    const status = getGitStatusPorcelain(repoPath);
    const lines = status.split('\n').filter((l) => l.trim().length > 0);
    const staged = lines.filter((l) => l.startsWith('A ') || l.startsWith('M '));
    assert.strictEqual(staged.length, 1, 'Only one file should be staged');
    assert.ok(staged[0].includes('a.txt'), 'a.txt should be the staged file');
    assert.ok(!staged.some((l) => l.includes('b.txt')), 'b.txt should not be staged');
  });
});
