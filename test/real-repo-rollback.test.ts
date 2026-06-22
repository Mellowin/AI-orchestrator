import { describe, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  captureCheckpoint,
  rollbackToCheckpoint,
} from '../src/real-repo-rollback.js';

function createTempRepo(): string {
  const tmpBase = join(process.cwd(), 'tmp');
  if (!existsSync(tmpBase)) {
    mkdirSync(tmpBase);
  }
  const repoPath = mkdtempSync(join(tmpBase, 'rollback-'));
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
  spawnSync('git', ['branch', '-m', 'main'], {
    cwd: repoPath,
    encoding: 'utf-8',
    shell: false,
  });
  return repoPath;
}

function getHead(repoPath: string): string {
  const result = spawnSync('git', ['rev-parse', '--verify', 'HEAD'], {
    cwd: repoPath,
    encoding: 'utf-8',
    shell: false,
  });
  return result.stdout.trim();
}

function getCurrentBranch(repoPath: string): string {
  const result = spawnSync('git', ['branch', '--show-current'], {
    cwd: repoPath,
    encoding: 'utf-8',
    shell: false,
  });
  return result.stdout.trim();
}

function getPorcelain(repoPath: string): string {
  const result = spawnSync(
    'git',
    ['status', '--porcelain', '--untracked-files=all'],
    { cwd: repoPath, encoding: 'utf-8', shell: false }
  );
  return result.stdout.trim();
}

describe('real-repo-rollback', () => {
  let repoPath: string;

  beforeEach(() => {
    repoPath = createTempRepo();
  });

  afterEach(() => {
    if (repoPath && existsSync(repoPath)) {
      rmSync(repoPath, { recursive: true, force: true });
    }
  });

  test('captureCheckpoint records branch and head on clean repo', () => {
    const checkpoint = captureCheckpoint(repoPath);
    assert.strictEqual(checkpoint.repoPath, repoPath);
    assert.strictEqual(checkpoint.branch, 'main');
    assert.strictEqual(checkpoint.headSha, getHead(repoPath));
    assert.deepStrictEqual(checkpoint.untrackedFiles, []);
  });

  test('captureCheckpoint throws when working tree is dirty', () => {
    writeFileSync(join(repoPath, 'base.txt'), 'dirty\n', 'utf-8');
    assert.throws(() => captureCheckpoint(repoPath), /not clean/);
  });

  test('rollbackToCheckpoint restores modified tracked files', () => {
    const checkpoint = captureCheckpoint(repoPath);
    const originalHead = checkpoint.headSha;
    writeFileSync(join(repoPath, 'base.txt'), 'changed\n', 'utf-8');
    const result = rollbackToCheckpoint(checkpoint);
    assert.strictEqual(result.status, 'succeeded');
    assert.strictEqual(result.attempted, true);
    assert.strictEqual(result.checkpointHead, originalHead);
    assert.strictEqual(result.finalHead, originalHead);
    assert.strictEqual(readFileSync(join(repoPath, 'base.txt'), 'utf-8'), 'base\n');
    assert.strictEqual(getHead(repoPath), originalHead);
    assert.strictEqual(getPorcelain(repoPath), '');
  });

  test('rollbackToCheckpoint restores original branch', () => {
    spawnSync('git', ['checkout', '-b', 'feature'], {
      cwd: repoPath,
      encoding: 'utf-8',
      shell: false,
    });
    const checkpoint = captureCheckpoint(repoPath);
    spawnSync('git', ['checkout', 'main'], {
      cwd: repoPath,
      encoding: 'utf-8',
      shell: false,
    });
    writeFileSync(join(repoPath, 'base.txt'), 'changed\n', 'utf-8');
    const result = rollbackToCheckpoint(checkpoint);
    assert.strictEqual(result.status, 'succeeded');
    assert.strictEqual(getCurrentBranch(repoPath), 'feature');
    assert.strictEqual(getHead(repoPath), checkpoint.headSha);
    assert.strictEqual(getPorcelain(repoPath), '');
  });

  test('rollbackToCheckpoint removes new untracked files', () => {
    const checkpoint = captureCheckpoint(repoPath);
    writeFileSync(join(repoPath, 'new.txt'), 'new\n', 'utf-8');
    const result = rollbackToCheckpoint(checkpoint);
    assert.strictEqual(result.status, 'succeeded');
    assert.strictEqual(existsSync(join(repoPath, 'new.txt')), false);
    assert.strictEqual(getPorcelain(repoPath), '');
  });

  test('rollbackToCheckpoint removes new directories', () => {
    const checkpoint = captureCheckpoint(repoPath);
    mkdirSync(join(repoPath, 'newdir'));
    writeFileSync(join(repoPath, 'newdir', 'file.txt'), 'x\n', 'utf-8');
    const result = rollbackToCheckpoint(checkpoint);
    assert.strictEqual(result.status, 'succeeded');
    assert.strictEqual(existsSync(join(repoPath, 'newdir')), false);
  });

  test('rollbackToCheckpoint fails for missing repo path', () => {
    const checkpoint = captureCheckpoint(repoPath);
    checkpoint.repoPath = join(repoPath, 'missing');
    const result = rollbackToCheckpoint(checkpoint);
    assert.strictEqual(result.status, 'failed');
    assert.strictEqual(result.attempted, true);
    assert(result.reason?.includes('does not exist'));
  });
});
