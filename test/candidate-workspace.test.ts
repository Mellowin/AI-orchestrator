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
import { dirname, join } from 'node:path';
import {
  createCandidateWorkspace,
  validateCandidateWorkspace,
  stageCandidateFiles,
  getCandidateDiff,
  cleanupCandidateWorkspace,
  configureCandidateRemote,
  pushCandidateCommit,
  fastForwardMissionBranch,
} from '../src/candidate-workspace.js';

let counter = 0;

function createTmpDir(): string {
  const id = `${Date.now()}-${counter++}`;
  const base = join(process.cwd(), 'tmp');
  if (!existsSync(base)) mkdirSync(base);
  return mkdtempSync(join(base, `cw-${id}-`));
}

function initRepo(path: string): void {
  mkdirSync(path, { recursive: true });
  spawnSync('git', ['init'], { cwd: path, shell: false, encoding: 'utf-8' });
  spawnSync('git', ['config', 'user.email', 'ci@example.com'], { cwd: path, shell: false, encoding: 'utf-8' });
  spawnSync('git', ['config', 'user.name', 'CI User'], { cwd: path, shell: false, encoding: 'utf-8' });
  writeFileSync(join(path, 'README.md'), '# init\n', 'utf-8');
  spawnSync('git', ['add', '.'], { cwd: path, shell: false, encoding: 'utf-8' });
  spawnSync('git', ['commit', '-m', 'init', '--no-gpg-sign'], { cwd: path, shell: false, encoding: 'utf-8' });
  spawnSync('git', ['branch', '-m', 'main'], { cwd: path, shell: false, encoding: 'utf-8' });
}

function getHeadSha(repoPath: string): string {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repoPath, shell: false, encoding: 'utf-8' });
  return result.stdout.trim();
}

describe('candidate-workspace', () => {
  let tmpDir: string;
  let repoPath: string;
  let baseSha: string;

  before(() => {
    tmpDir = createTmpDir();
    repoPath = join(tmpDir, 'repo');
    initRepo(repoPath);
    baseSha = getHeadSha(repoPath);
  });

  test('createCandidateWorkspace clones and checks out at task base SHA', () => {
    const candidatePath = join(tmpDir, 'workspace');
    const result = createCandidateWorkspace(candidatePath, repoPath, baseSha, 'main', 'task-1');
    assert.strictEqual(result.ok, true, result.reason);
    assert(existsSync(join(candidatePath, '.git')), 'workspace should be a git repo');
    const head = getHeadSha(candidatePath);
    assert.strictEqual(head, baseSha, 'HEAD should equal task base SHA');
  });

  test('validateCandidateWorkspace detects HEAD mismatch', () => {
    const candidatePath = join(tmpDir, 'workspace2');
    createCandidateWorkspace(candidatePath, repoPath, baseSha, 'main', 'task-2');
    const badSha = '0'.repeat(40);
    const result = validateCandidateWorkspace(candidatePath, badSha);
    assert.strictEqual(result.ok, false);
    assert(result.reason?.includes('HEAD mismatch'), result.reason);
  });

  test('stageCandidateFiles and getCandidateDiff detect staged changes', () => {
    const candidatePath = join(tmpDir, 'workspace3');
    createCandidateWorkspace(candidatePath, repoPath, baseSha, 'main', 'task-3');
    writeFileSync(join(candidatePath, 'README.md'), '# updated\n', 'utf-8');
    const stage = stageCandidateFiles(candidatePath, ['README.md']);
    assert.strictEqual(stage.ok, true, stage.reason);
    const diff = getCandidateDiff(candidatePath, baseSha);
    assert(diff.changedFiles.includes('README.md'), diff.changedFiles.join(','));
    assert(diff.diff.includes('+# updated'), diff.diff);
  });

  test('validateCandidateWorkspace rejects unexpected untracked files', () => {
    const candidatePath = join(tmpDir, 'workspace4');
    createCandidateWorkspace(candidatePath, repoPath, baseSha, 'main', 'task-4');
    writeFileSync(join(candidatePath, 'untracked.txt'), 'x', 'utf-8');
    const result = validateCandidateWorkspace(candidatePath, baseSha);
    assert.strictEqual(result.ok, false);
    assert(result.reason?.includes('untracked'), result.reason);
  });

  test('validateCandidateWorkspace with expectedChangedFiles rejects mismatches', () => {
    const candidatePath = join(tmpDir, 'workspace5');
    createCandidateWorkspace(candidatePath, repoPath, baseSha, 'main', 'task-5');
    writeFileSync(join(candidatePath, 'README.md'), '# updated\n', 'utf-8');
    stageCandidateFiles(candidatePath, ['README.md']);
    const ok = validateCandidateWorkspace(candidatePath, baseSha, ['README.md']);
    assert.strictEqual(ok.ok, true, ok.reason);
    const bad = validateCandidateWorkspace(candidatePath, baseSha, ['other.txt']);
    assert.strictEqual(bad.ok, false);
    assert(bad.reason?.includes('Staged files mismatch'), bad.reason);
  });

  test('cleanupCandidateWorkspace removes the workspace', () => {
    const candidatePath = join(tmpDir, 'workspace6');
    createCandidateWorkspace(candidatePath, repoPath, baseSha, 'main', 'task-6');
    cleanupCandidateWorkspace(candidatePath);
    assert(!existsSync(candidatePath), 'workspace should be removed');
  });

  test('pushCandidateCommit and fastForwardMissionBranch propagate the commit', () => {
    const originPath = join(tmpDir, 'origin.git');
    spawnSync('git', ['init', '--bare', originPath], { shell: false, encoding: 'utf-8' });
    spawnSync('git', ['remote', 'add', 'origin', originPath], { cwd: repoPath, shell: false, encoding: 'utf-8' });
    spawnSync('git', ['push', 'origin', 'main'], { cwd: repoPath, shell: false, encoding: 'utf-8' });

    const candidatePath = join(tmpDir, 'workspace7');
    createCandidateWorkspace(candidatePath, repoPath, baseSha, 'main', 'task-7');
    writeFileSync(join(candidatePath, 'README.md'), '# pushed\n', 'utf-8');
    stageCandidateFiles(candidatePath, ['README.md']);
    configureCandidateRemote(candidatePath, originPath);
    spawnSync('git', ['commit', '-m', 'update', '--no-gpg-sign'], { cwd: candidatePath, shell: false, encoding: 'utf-8' });
    const commitSha = getHeadSha(candidatePath);

    const pushResult = pushCandidateCommit(candidatePath, 'feature');
    assert.strictEqual(pushResult.ok, true, pushResult.reason);

    const ffResult = fastForwardMissionBranch(repoPath, 'feature', commitSha);
    assert.strictEqual(ffResult.ok, true, ffResult.reason);
    assert.strictEqual(getHeadSha(repoPath), commitSha, 'main repo should fast-forward to commit');
  });

  test('fastForwardMissionBranch fails for non-ancestor commit', () => {
    const result = fastForwardMissionBranch(repoPath, 'feature', '0'.repeat(40));
    assert.strictEqual(result.ok, false);
  });
});
