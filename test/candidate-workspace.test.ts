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
  reconcileCandidateWorkspace,
} from '../src/candidate-workspace.js';
import { computeFileHash, saveCandidateSnapshot } from '../src/candidate-state.js';

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

  test('validateCandidateWorkspace accepts accepted commit SHA after commit', () => {
    const candidatePath = join(tmpDir, 'workspace-committed');
    createCandidateWorkspace(candidatePath, repoPath, baseSha, 'main', 'task-committed');
    writeFileSync(join(candidatePath, 'README.md'), '# committed\n', 'utf-8');
    stageCandidateFiles(candidatePath, ['README.md']);
    spawnSync('git', ['commit', '-m', 'accepted', '--no-gpg-sign'], { cwd: candidatePath, shell: false, encoding: 'utf-8' });
    const commitSha = getHeadSha(candidatePath);
    const result = validateCandidateWorkspace(candidatePath, baseSha, undefined, commitSha);
    assert.strictEqual(result.ok, true, result.reason);
  });

  test('reconcileCandidateWorkspace: commit and push needed from base', () => {
    const originPath = join(tmpDir, 'origin-base.git');
    spawnSync('git', ['init', '--bare', originPath], { shell: false, encoding: 'utf-8' });
    if (spawnSync('git', ['remote'], { cwd: repoPath, shell: false, encoding: 'utf-8' }).stdout.trim().includes('origin')) {
      spawnSync('git', ['remote', 'remove', 'origin'], { cwd: repoPath, shell: false, encoding: 'utf-8' });
    }
    spawnSync('git', ['remote', 'add', 'origin', originPath], { cwd: repoPath, shell: false, encoding: 'utf-8' });
    spawnSync('git', ['push', 'origin', 'main'], { cwd: repoPath, shell: false, encoding: 'utf-8' });

    const candidatePath = join(tmpDir, 'workspace-reconcile-base');
    createCandidateWorkspace(candidatePath, repoPath, baseSha, 'main', 'task-reconcile-base');
    configureCandidateRemote(candidatePath, originPath);
    writeFileSync(join(candidatePath, 'README.md'), '# updated\n', 'utf-8');
    stageCandidateFiles(candidatePath, ['README.md']);

    const content = '# updated\n';
    saveCandidateSnapshot(tmpDir, 'task-reconcile-base', {
      attemptId: 'test',
      phase: 'accepted',
      taskBaseSha: baseSha,
      changedFiles: ['README.md'],
      fileContents: [{ path: 'README.md', content, sha256: computeFileHash(content) }],
      candidatePackageHash: '',
    });

    const reconcile = reconcileCandidateWorkspace(candidatePath, baseSha, 'feature', {
      attemptId: 'test',
      phase: 'accepted',
      taskBaseSha: baseSha,
      changedFiles: ['README.md'],
      fileContents: [{ path: 'README.md', content, sha256: computeFileHash(content) }],
      candidatePackageHash: '',
    });
    assert.strictEqual(reconcile.ok, true, reconcile.reason);
    assert.strictEqual(reconcile.commitNeeded, true);
    assert.strictEqual(reconcile.pushNeeded, true);
    assert.strictEqual(reconcile.alreadyPushed, false);
  });

  test('reconcileCandidateWorkspace: already pushed when local head reset to base', () => {
    const originPath = join(tmpDir, 'origin-reconcile.git');
    spawnSync('git', ['init', '--bare', originPath], { shell: false, encoding: 'utf-8' });
    spawnSync('git', ['remote', 'add', 'origin', originPath], { cwd: repoPath, shell: false, encoding: 'utf-8' });
    spawnSync('git', ['push', 'origin', 'main'], { cwd: repoPath, shell: false, encoding: 'utf-8' });

    const candidatePath = join(tmpDir, 'workspace-reconcile-remote');
    createCandidateWorkspace(candidatePath, repoPath, baseSha, 'main', 'task-reconcile-remote');
    writeFileSync(join(candidatePath, 'README.md'), '# remote-pushed\n', 'utf-8');
    stageCandidateFiles(candidatePath, ['README.md']);
    configureCandidateRemote(candidatePath, originPath);
    spawnSync('git', ['commit', '-m', 'accepted', '--no-gpg-sign'], { cwd: candidatePath, shell: false, encoding: 'utf-8' });
    const commitSha = getHeadSha(candidatePath);
    const pushResult = pushCandidateCommit(candidatePath, 'feature');
    assert.strictEqual(pushResult.ok, true, pushResult.reason);

    // Simulate crash: reset local candidate workspace back to base but keep remote commit.
    spawnSync('git', ['checkout', '-B', 'candidate/task-reconcile-remote', baseSha], { cwd: candidatePath, shell: false, encoding: 'utf-8' });
    assert.strictEqual(getHeadSha(candidatePath), baseSha);

    const content = '# remote-pushed\n';
    const snapshot = {
      attemptId: 'test',
      phase: 'accepted',
      taskBaseSha: baseSha,
      changedFiles: ['README.md'],
      fileContents: [{ path: 'README.md', content, sha256: computeFileHash(content) }],
      candidatePackageHash: '',
    };

    const reconcile = reconcileCandidateWorkspace(candidatePath, baseSha, 'feature', snapshot);
    assert.strictEqual(reconcile.ok, true, reconcile.reason);
    assert.strictEqual(reconcile.commitNeeded, false);
    assert.strictEqual(reconcile.pushNeeded, false);
    assert.strictEqual(reconcile.alreadyPushed, true);
    assert.strictEqual(reconcile.acceptedCommitSha, commitSha);
  });

  test('reconcileCandidateWorkspace: fail closed on unexpected remote mutation', () => {
    const originPath = join(tmpDir, 'origin-conflict.git');
    spawnSync('git', ['init', '--bare', originPath], { shell: false, encoding: 'utf-8' });
    if (spawnSync('git', ['remote'], { cwd: repoPath, shell: false, encoding: 'utf-8' }).stdout.trim().includes('origin')) {
      spawnSync('git', ['remote', 'remove', 'origin'], { cwd: repoPath, shell: false, encoding: 'utf-8' });
    }
    spawnSync('git', ['remote', 'add', 'origin', originPath], { cwd: repoPath, shell: false, encoding: 'utf-8' });
    spawnSync('git', ['push', 'origin', 'main'], { cwd: repoPath, shell: false, encoding: 'utf-8' });

    const candidatePath = join(tmpDir, 'workspace-conflict');
    createCandidateWorkspace(candidatePath, repoPath, baseSha, 'main', 'task-conflict');
    writeFileSync(join(candidatePath, 'README.md'), '# candidate\n', 'utf-8');
    stageCandidateFiles(candidatePath, ['README.md']);
    configureCandidateRemote(candidatePath, originPath);
    spawnSync('git', ['commit', '-m', 'accepted', '--no-gpg-sign'], { cwd: candidatePath, shell: false, encoding: 'utf-8' });
    const pushResult = pushCandidateCommit(candidatePath, 'feature');
    assert.strictEqual(pushResult.ok, true, pushResult.reason);

    // Concurrent mutation: add a different commit on top of the pushed feature branch.
    spawnSync('git', ['checkout', '-B', 'feature', 'origin/feature'], { cwd: candidatePath, shell: false, encoding: 'utf-8' });
    writeFileSync(join(candidatePath, 'other.txt'), 'concurrent\n', 'utf-8');
    spawnSync('git', ['add', 'other.txt'], { cwd: candidatePath, shell: false, encoding: 'utf-8' });
    spawnSync('git', ['commit', '-m', 'concurrent', '--no-gpg-sign'], { cwd: candidatePath, shell: false, encoding: 'utf-8' });
    const conflictPush = pushCandidateCommit(candidatePath, 'feature');
    assert.strictEqual(conflictPush.ok, true, conflictPush.reason);

    // Reset candidate local head back to base.
    spawnSync('git', ['checkout', '-B', 'candidate/task-conflict', baseSha], { cwd: candidatePath, shell: false, encoding: 'utf-8' });

    const content = '# candidate\n';
    const snapshot = {
      attemptId: 'test',
      phase: 'accepted',
      taskBaseSha: baseSha,
      changedFiles: ['README.md'],
      fileContents: [{ path: 'README.md', content, sha256: computeFileHash(content) }],
      candidatePackageHash: '',
    };

    const reconcile = reconcileCandidateWorkspace(candidatePath, baseSha, 'feature', snapshot);
    assert.strictEqual(reconcile.ok, false, reconcile.reason);
    assert.strictEqual(reconcile.commitNeeded, false);
    assert.strictEqual(reconcile.pushNeeded, false);
    assert.strictEqual(reconcile.alreadyPushed, false);
  });
});
