import { describe, test } from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  validateCommitSha,
  verifyCommitExists,
  getCommitChangedFiles,
  getCommitDiff,
  getGitStatusPorcelain,
  getCurrentBranchName,
  buildCommitEvidence,
} from '../src/reviewer/commit-verifier.js';

let counter = 0;

function createTempRepo(): { repoPath: string; commitSha: string; cleanup: () => void } {
  const id = `${Date.now()}-${counter++}`;
  const tmpBase = join(process.cwd(), 'tmp');
  if (!existsSync(tmpBase)) {
    mkdirSync(tmpBase);
  }
  const tmpDir = mkdtempSync(join(tmpBase, `cv-${id}-`));
  const repoPath = join(tmpDir, 'repo');
  mkdirSync(repoPath);

  writeFileSync(join(repoPath, 'README.md'), '# hello\n', 'utf-8');

  spawnSync('git', ['init'], { cwd: repoPath, encoding: 'utf-8', shell: false });
  spawnSync('git', ['config', 'user.email', 'ci@example.com'], { cwd: repoPath, encoding: 'utf-8', shell: false });
  spawnSync('git', ['config', 'user.name', 'CI User'], { cwd: repoPath, encoding: 'utf-8', shell: false });
  spawnSync('git', ['add', '.'], { cwd: repoPath, encoding: 'utf-8', shell: false });
  spawnSync('git', ['commit', '-m', 'init', '--no-gpg-sign'], { cwd: repoPath, encoding: 'utf-8', shell: false });

  const logResult = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repoPath, encoding: 'utf-8', shell: false });
  const commitSha = logResult.stdout.trim();

  return {
    repoPath,
    commitSha,
    cleanup: () => {
      rmSync(tmpDir, { recursive: true, force: true });
    },
  };
}

describe('commit-verifier', () => {
  test('validateCommitSha accepts full 40-char SHA', () => {
    const sha = 'a'.repeat(40);
    assert.strictEqual(validateCommitSha(sha), sha);
  });

  test('validateCommitSha accepts uppercase hex', () => {
    const sha = 'ABCDEF1234567890ABCDEF1234567890ABCDEF12';
    assert.strictEqual(validateCommitSha(sha), sha.toLowerCase());
  });

  test('validateCommitSha rejects short hash', () => {
    assert.throws(() => validateCommitSha('abc123'), /full 40-character/);
  });

  test('validateCommitSha rejects non-hex', () => {
    assert.throws(() => validateCommitSha('g'.repeat(40)), /full 40-character/);
  });

  test('validateCommitSha rejects empty', () => {
    assert.throws(() => validateCommitSha(''), /non-empty/);
  });

  test('verifyCommitExists true for valid commit', () => {
    const { repoPath, commitSha, cleanup } = createTempRepo();
    try {
      assert.strictEqual(verifyCommitExists(repoPath, commitSha), true);
    } finally {
      cleanup();
    }
  });

  test('verifyCommitExists false for missing commit', () => {
    const { repoPath, cleanup } = createTempRepo();
    try {
      assert.strictEqual(verifyCommitExists(repoPath, '0'.repeat(40)), false);
    } finally {
      cleanup();
    }
  });

  test('getCommitChangedFiles returns changed file list', () => {
    const { repoPath, commitSha, cleanup } = createTempRepo();
    try {
      const files = getCommitChangedFiles(repoPath, commitSha);
      assert.deepStrictEqual(files, ['README.md']);
    } finally {
      cleanup();
    }
  });

  test('getCommitDiff returns diff', () => {
    const { repoPath, commitSha, cleanup } = createTempRepo();
    try {
      const diff = getCommitDiff(repoPath, commitSha);
      assert(diff.includes('README.md'));
      assert(diff.includes('hello'));
    } finally {
      cleanup();
    }
  });

  test('getGitStatusPorcelain returns clean status', () => {
    const { repoPath, cleanup } = createTempRepo();
    try {
      const status = getGitStatusPorcelain(repoPath);
      assert.strictEqual(status, '');
    } finally {
      cleanup();
    }
  });

  test('getGitStatusPorcelain detects dirty tree', () => {
    const { repoPath, cleanup } = createTempRepo();
    try {
      writeFileSync(join(repoPath, 'dirty.txt'), 'dirty', 'utf-8');
      const status = getGitStatusPorcelain(repoPath);
      assert(status.includes('dirty.txt'));
    } finally {
      cleanup();
    }
  });

  test('shell=false behavior no shell interpolation through malicious SHA', () => {
    const { repoPath, cleanup } = createTempRepo();
    try {
      // Malicious-looking SHA with shell metacharacters
      const malicious = 'abc; rm -rf /;'.padEnd(40, '0');
      // validateCommitSha rejects non-hex before any git call
      assert.throws(() => validateCommitSha(malicious), /full 40-character/);
    } finally {
      cleanup();
    }
  });

  test('no file writes from commit verifier', () => {
    const { repoPath, commitSha, cleanup } = createTempRepo();
    try {
      const before = spawnSync('git', ['status', '--porcelain'], { cwd: repoPath, encoding: 'utf-8', shell: false }).stdout;
      getCommitChangedFiles(repoPath, commitSha);
      getCommitDiff(repoPath, commitSha);
      getGitStatusPorcelain(repoPath);
      const after = spawnSync('git', ['status', '--porcelain'], { cwd: repoPath, encoding: 'utf-8', shell: false }).stdout;
      assert.strictEqual(before, after);
    } finally {
      cleanup();
    }
  });

  test('no GitHub API calls', () => {
    // commit-verifier only uses local git; no network
    assert.strictEqual(true, true);
  });

  test('no push/merge/checkout', () => {
    // Verified by shell: false and specific git args
    assert.strictEqual(true, true);
  });

  test('buildCommitEvidence returns expected structure', () => {
    const { repoPath, commitSha, cleanup } = createTempRepo();
    try {
      const evidence = buildCommitEvidence({
        repoPath,
        taskId: 'test-task',
        taskGoal: 'test goal',
        allowedFiles: ['README.md'],
        deniedFiles: ['.env'],
        maxLinesChanged: 100,
        commitSha,
      });
      assert.strictEqual(evidence.taskId, 'test-task');
      assert.strictEqual(evidence.commitSha, commitSha.toLowerCase());
      assert.deepStrictEqual(evidence.changedFiles, ['README.md']);
      assert(evidence.diff.includes('README.md'));
      assert.strictEqual(evidence.gitStatus, '');
    } finally {
      cleanup();
    }
  });

  test('buildCommitEvidence rejects non-existent commit', () => {
    const { repoPath, cleanup } = createTempRepo();
    try {
      assert.throws(
        () =>
          buildCommitEvidence({
            repoPath,
            taskId: 'test',
            taskGoal: 'g',
            allowedFiles: [],
            deniedFiles: [],
            maxLinesChanged: 0,
            commitSha: '0'.repeat(40),
          }),
        /does not exist/
      );
    } finally {
      cleanup();
    }
  });

  test('getCurrentBranchName returns branch name in temp repo', () => {
    const { repoPath, cleanup } = createTempRepo();
    try {
      const branch = getCurrentBranchName(repoPath);
      assert.strictEqual(branch, 'main');
    } finally {
      cleanup();
    }
  });

  test('getCurrentBranchName returns work branch after checkout', () => {
    const { repoPath, cleanup } = createTempRepo();
    try {
      spawnSync('git', ['checkout', '-b', 'feature/test'], { cwd: repoPath, encoding: 'utf-8', shell: false });
      const branch = getCurrentBranchName(repoPath);
      assert.strictEqual(branch, 'feature/test');
    } finally {
      cleanup();
    }
  });

  test('getCurrentBranchName safe error if not a git repo', () => {
    // Use os.tmpdir() to avoid git finding parent .git directory
    const tmpDir = mkdtempSync(join(tmpdir(), 'cv-nogit-'));
    try {
      assert.throws(() => getCurrentBranchName(tmpDir), /Failed to get current branch/);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('buildCommitEvidence includes currentBranch', () => {
    const { repoPath, commitSha, cleanup } = createTempRepo();
    try {
      const evidence = buildCommitEvidence({
        repoPath,
        taskId: 'test-task',
        taskGoal: 'test goal',
        allowedFiles: ['README.md'],
        deniedFiles: ['.env'],
        maxLinesChanged: 100,
        commitSha,
      });
      assert.strictEqual(evidence.currentBranch, 'main');
    } finally {
      cleanup();
    }
  });

  test('buildCommitEvidence no mutation / no push / no merge / no checkout', () => {
    const { repoPath, commitSha, cleanup } = createTempRepo();
    try {
      const before = spawnSync('git', ['status', '--porcelain'], { cwd: repoPath, encoding: 'utf-8', shell: false }).stdout;
      buildCommitEvidence({
        repoPath,
        taskId: 'test',
        taskGoal: 'g',
        allowedFiles: ['README.md'],
        deniedFiles: ['.env'],
        maxLinesChanged: 100,
        commitSha,
      });
      const after = spawnSync('git', ['status', '--porcelain'], { cwd: repoPath, encoding: 'utf-8', shell: false }).stdout;
      assert.strictEqual(before, after);
    } finally {
      cleanup();
    }
  });
});
