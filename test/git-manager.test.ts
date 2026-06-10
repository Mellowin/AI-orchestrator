import { describe, test } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { sync as spawnSync } from 'cross-spawn';
import {
  ensureClean,
  getCurrentBranch,
  branchExists,
  checkoutExistingBranch,
  getChangedFiles,
  getCurrentDiff,
  getDiffStat,
  getWorkingTreeDiffStat,
  prepareWorkBranch,
} from '../src/git-manager.js';

function createTempGitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'git-manager-test-'));
  const initResult = spawnSync('git', ['init', '-b', 'main'], { cwd: dir, encoding: 'utf-8' });
  if (initResult.status !== 0) {
    spawnSync('git', ['init'], { cwd: dir, encoding: 'utf-8' });
    spawnSync('git', ['branch', '-M', 'main'], { cwd: dir, encoding: 'utf-8' });
  }
  spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir, encoding: 'utf-8' });
  spawnSync('git', ['config', 'user.name', 'Test User'], { cwd: dir, encoding: 'utf-8' });
  writeFileSync(join(dir, 'README.md'), '# Hello', 'utf-8');
  spawnSync('git', ['add', 'README.md'], { cwd: dir, encoding: 'utf-8' });
  spawnSync('git', ['commit', '-m', 'init'], { cwd: dir, encoding: 'utf-8' });
  return dir;
}

function createTempGitRepoWithBranch(branch: string): string {
  const dir = createTempGitRepo();
  spawnSync('git', ['checkout', '-b', branch], { cwd: dir, encoding: 'utf-8' });
  spawnSync('git', ['checkout', 'main'], { cwd: dir, encoding: 'utf-8' });
  return dir;
}

describe('git-manager', () => {
  test('ensureClean passes on clean repository', () => {
    const dir = createTempGitRepo();
    try {
      ensureClean(dir);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  test('ensureClean throws when repository has uncommitted changes', () => {
    const dir = createTempGitRepo();
    try {
      writeFileSync(join(dir, 'dirty.txt'), 'x', 'utf-8');
      assert.throws(() => ensureClean(dir), /Working tree is not clean/);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  test('getCurrentBranch returns main', () => {
    const dir = createTempGitRepo();
    try {
      const branch = getCurrentBranch(dir);
      assert.strictEqual(branch, 'main');
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  test('branchExists returns true for existing branch', () => {
    const dir = createTempGitRepoWithBranch('feature-x');
    try {
      assert.strictEqual(branchExists(dir, 'feature-x'), true);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  test('branchExists returns false for missing branch', () => {
    const dir = createTempGitRepo();
    try {
      assert.strictEqual(branchExists(dir, 'nonexistent'), false);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  test('checkoutExistingBranch switches to branch', () => {
    const dir = createTempGitRepoWithBranch('feature-x');
    try {
      assert.strictEqual(getCurrentBranch(dir), 'main');
      checkoutExistingBranch(dir, 'feature-x');
      assert.strictEqual(getCurrentBranch(dir), 'feature-x');
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  test('getChangedFiles returns modified files', () => {
    const dir = createTempGitRepo();
    try {
      writeFileSync(join(dir, 'README.md'), '# Hello World', 'utf-8');
      const files = getChangedFiles(dir);
      assert.deepStrictEqual(files, ['README.md']);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  test('getChangedFiles returns untracked files', () => {
    const dir = createTempGitRepo();
    try {
      writeFileSync(join(dir, 'new.txt'), 'x', 'utf-8');
      const files = getChangedFiles(dir);
      assert.deepStrictEqual(files, ['new.txt']);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  test('getCurrentDiff returns diff text for modifications', () => {
    const dir = createTempGitRepo();
    try {
      writeFileSync(join(dir, 'README.md'), '# Hello World', 'utf-8');
      const diff = getCurrentDiff(dir);
      assert(diff.includes('Hello World'), `Expected diff to contain changes, got: ${diff}`);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  test('getDiffStat counts insertions and deletions', () => {
    const dir = createTempGitRepo();
    try {
      writeFileSync(join(dir, 'README.md'), '# Hello World\nextra line', 'utf-8');
      const stat = getDiffStat(dir);
      assert.strictEqual(stat.files.length, 1);
      assert.strictEqual(stat.files[0], 'README.md');
      assert(stat.insertions > 0, `Expected insertions > 0, got: ${stat.insertions}`);
      assert.strictEqual(stat.binaryFiles.length, 0);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  test('getWorkingTreeDiffStat includes untracked files', () => {
    const dir = createTempGitRepo();
    try {
      writeFileSync(join(dir, 'untracked.txt'), 'line1\nline2\n', 'utf-8');
      const stat = getWorkingTreeDiffStat(dir);
      assert(stat.files.includes('untracked.txt'), `Expected files to include untracked.txt, got: ${stat.files.join(', ')}`);
      assert(stat.insertions >= 2, `Expected insertions >= 2, got: ${stat.insertions}`);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  test('prepareWorkBranch resume switches to existing work branch', () => {
    const dir = createTempGitRepoWithBranch('ai/resume-task');
    try {
      assert.strictEqual(getCurrentBranch(dir), 'main');
      prepareWorkBranch(dir, 'main', 'ai/resume-task', true);
      assert.strictEqual(getCurrentBranch(dir), 'ai/resume-task');
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  test('prepareWorkBranch resume throws when work branch does not exist', () => {
    const dir = createTempGitRepo();
    try {
      assert.throws(
        () => prepareWorkBranch(dir, 'main', 'ai/missing', true),
        /Cannot resume/
      );
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  test('prepareWorkBranch new throws when work branch already exists', () => {
    const dir = createTempGitRepoWithBranch('ai/exists');
    try {
      assert.throws(
        () => prepareWorkBranch(dir, 'main', 'ai/exists', false),
        /Work branch "ai\/exists" already exists/
      );
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  test('prepareWorkBranch new throws when working tree is dirty', () => {
    const dir = createTempGitRepo();
    try {
      writeFileSync(join(dir, 'dirty.txt'), 'x', 'utf-8');
      assert.throws(
        () => prepareWorkBranch(dir, 'main', 'ai/new-task', false),
        /Working tree is not clean/
      );
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});
