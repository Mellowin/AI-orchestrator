import { describe, test, before } from 'node:test';
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
import {
  createCandidateWorkspace,
  stageCandidateFiles,
  getCandidateDiff,
} from '../src/candidate-workspace.js';

let counter = 0;

function createTmpDir(): string {
  const id = `${Date.now()}-${counter++}`;
  const base = join(process.cwd(), 'tmp');
  if (!existsSync(base)) mkdirSync(base);
  return mkdtempSync(join(base, `db-${id}-`));
}

function initRepo(path: string): void {
  mkdirSync(path, { recursive: true });
  spawnSync('git', ['init'], { cwd: path, shell: false, encoding: 'utf-8' });
  spawnSync('git', ['config', 'user.email', 'ci@example.com'], { cwd: path, shell: false, encoding: 'utf-8' });
  spawnSync('git', ['config', 'user.name', 'CI User'], { cwd: path, shell: false, encoding: 'utf-8' });
  writeFileSync(join(path, 'base.txt'), 'base\n', 'utf-8');
  spawnSync('git', ['add', '.'], { cwd: path, shell: false, encoding: 'utf-8' });
  spawnSync('git', ['commit', '-m', 'init', '--no-gpg-sign'], { cwd: path, shell: false, encoding: 'utf-8' });
  spawnSync('git', ['branch', '-m', 'main'], { cwd: path, shell: false, encoding: 'utf-8' });
}

function getHeadSha(repoPath: string): string {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repoPath, shell: false, encoding: 'utf-8' });
  return result.stdout.trim();
}

describe('diff-baseline', () => {
  let tmpDir: string;
  let repoPath: string;
  let baseSha: string;
  let candidatePath: string;

  before(() => {
    tmpDir = createTmpDir();
    repoPath = join(tmpDir, 'repo');
    initRepo(repoPath);
    baseSha = getHeadSha(repoPath);
    candidatePath = join(tmpDir, 'candidate');
    createCandidateWorkspace(candidatePath, repoPath, baseSha, 'main', 'task-db');
  });

  test('getCandidateDiff compares against taskBaseSha, not HEAD', () => {
    // First commit a new file in the candidate workspace.
    writeFileSync(join(candidatePath, 'first.txt'), 'first\n', 'utf-8');
    stageCandidateFiles(candidatePath, ['first.txt']);
    spawnSync('git', ['commit', '-m', 'first', '--no-gpg-sign'], { cwd: candidatePath, shell: false, encoding: 'utf-8' });

    // Stage a second file. HEAD now has first.txt, but the cached diff should
    // still be relative to the immutable task base SHA and include both additions.
    writeFileSync(join(candidatePath, 'second.txt'), 'second\n', 'utf-8');
    stageCandidateFiles(candidatePath, ['second.txt']);

    const diff = getCandidateDiff(candidatePath, baseSha);
    assert(diff.changedFiles.includes('first.txt'), diff.changedFiles.join(','));
    assert(diff.changedFiles.includes('second.txt'), diff.changedFiles.join(','));
    assert(diff.diff.includes('+first'), diff.diff);
    assert(diff.diff.includes('+second'), diff.diff);
  });

  test('getCandidateDiff is empty when no staged changes exist', () => {
    const freshPath = join(tmpDir, 'fresh');
    createCandidateWorkspace(freshPath, repoPath, baseSha, 'main', 'task-fresh');
    const diff = getCandidateDiff(freshPath, baseSha);
    assert.strictEqual(diff.diff, '');
    assert.deepStrictEqual(diff.changedFiles, []);
  });
});
