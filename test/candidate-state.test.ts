import { describe, test, before } from 'node:test';
import assert from 'node:assert';
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
  computeFileHash,
  computeCandidatePackageHash,
  saveCandidateSnapshot,
  loadLatestCandidateSnapshot,
  restoreCandidateSnapshot,
  type CandidateSnapshot,
} from '../src/candidate-state.js';

let counter = 0;

function createTmpDir(): string {
  const id = `${Date.now()}-${counter++}`;
  const base = join(process.cwd(), 'tmp');
  if (!existsSync(base)) mkdirSync(base);
  return mkdtempSync(join(base, `cs-${id}-`));
}

describe('candidate-state', () => {
  let tmpDir: string;
  let runsDir: string;
  let workspace: string;

  before(() => {
    tmpDir = createTmpDir();
    runsDir = join(tmpDir, 'runs');
    workspace = join(tmpDir, 'workspace');
    mkdirSync(workspace, { recursive: true });
    writeFileSync(join(workspace, 'a.txt'), 'alpha', 'utf-8');
    writeFileSync(join(workspace, 'b.txt'), 'beta', 'utf-8');
  });

  test('computeFileHash is deterministic', () => {
    const h1 = computeFileHash('hello');
    const h2 = computeFileHash('hello');
    assert.strictEqual(h1, h2);
    assert.notStrictEqual(h1, computeFileHash('world'));
  });

  test('computeCandidatePackageHash changes with file contents', () => {
    const s1: CandidateSnapshot = {
      attemptId: 'a',
      phase: 'test',
      taskBaseSha: '0'.repeat(40),
      changedFiles: ['a.txt'],
      fileContents: [{ path: 'a.txt', content: 'alpha', sha256: computeFileHash('alpha') }],
      candidatePackageHash: '',
    };
    const h1 = computeCandidatePackageHash(s1);
    s1.fileContents[0].content = 'beta';
    s1.fileContents[0].sha256 = computeFileHash('beta');
    const h2 = computeCandidatePackageHash(s1);
    assert.notStrictEqual(h1, h2);
  });

  test('save and load snapshot roundtrip', () => {
    const taskId = 'task-1';
    const snapshot: CandidateSnapshot = {
      attemptId: 'phase-1',
      phase: 'generating',
      taskBaseSha: '1'.repeat(40),
      changedFiles: ['a.txt'],
      fileContents: [{ path: 'a.txt', content: 'alpha', sha256: computeFileHash('alpha') }],
      candidatePackageHash: '',
    };
    saveCandidateSnapshot(runsDir, taskId, snapshot);
    const loaded = loadLatestCandidateSnapshot(runsDir, taskId);
    assert.ok(loaded);
    assert.strictEqual(loaded.attemptId, 'phase-1');
    assert.strictEqual(loaded.phase, 'generating');
    assert.strictEqual(loaded.candidatePackageHash, computeCandidatePackageHash(snapshot));
  });

  test('loadLatestCandidateSnapshot returns latest by file sort', () => {
    const taskId = 'task-2';
    const base: Omit<CandidateSnapshot, 'attemptId' | 'phase' | 'candidatePackageHash'> = {
      taskBaseSha: '2'.repeat(40),
      changedFiles: ['a.txt'],
      fileContents: [{ path: 'a.txt', content: 'alpha', sha256: computeFileHash('alpha') }],
    };
    saveCandidateSnapshot(runsDir, taskId, { ...base, attemptId: 'a-phase', phase: 'a', candidatePackageHash: '' });
    saveCandidateSnapshot(runsDir, taskId, { ...base, attemptId: 'z-phase', phase: 'z', candidatePackageHash: '' });
    saveCandidateSnapshot(runsDir, taskId, { ...base, attemptId: 'm-phase', phase: 'm', candidatePackageHash: '' });
    const loaded = loadLatestCandidateSnapshot(runsDir, taskId);
    assert.strictEqual(loaded?.phase, 'z');
  });

  test('restoreCandidateSnapshot writes files and validates hashes', () => {
    const snapshot: CandidateSnapshot = {
      attemptId: 'restore',
      phase: 'test',
      taskBaseSha: '3'.repeat(40),
      changedFiles: ['a.txt', 'nested/b.txt'],
      fileContents: [
        { path: 'a.txt', content: 'alpha', sha256: computeFileHash('alpha') },
        { path: 'nested/b.txt', content: 'beta', sha256: computeFileHash('beta') },
      ],
      candidatePackageHash: '',
    };
    const restore = restoreCandidateSnapshot(workspace, snapshot);
    assert.strictEqual(restore.ok, true, restore.reason);
    assert.strictEqual(readFileSync(join(workspace, 'a.txt'), 'utf-8'), 'alpha');
    assert.strictEqual(readFileSync(join(workspace, 'nested', 'b.txt'), 'utf-8'), 'beta');
  });

  test('restoreCandidateSnapshot fails on hash mismatch', () => {
    const snapshot: CandidateSnapshot = {
      attemptId: 'bad',
      phase: 'test',
      taskBaseSha: '4'.repeat(40),
      changedFiles: ['a.txt'],
      fileContents: [{ path: 'a.txt', content: 'alpha', sha256: 'deadbeef' }],
      candidatePackageHash: '',
    };
    const restore = restoreCandidateSnapshot(workspace, snapshot);
    assert.strictEqual(restore.ok, false);
    assert(restore.reason?.includes('hash mismatch'), restore.reason);
  });
});
