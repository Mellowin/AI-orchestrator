import { describe, test } from 'node:test';
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
  acquireRunLock,
  formatRunLockError,
  getRepoRunLockPath,
  readRunLockMetadata,
  releaseRunLock,
  RunLockError,
} from '../src/run-lock.js';

function tmpDir(): string {
  const base = join(process.cwd(), 'tmp');
  if (!existsSync(base)) {
    mkdirSync(base);
  }
  return mkdtempSync(join(base, 'run-lock-test-'));
}

describe('run-lock', () => {
  test('acquires lock when no lock exists', () => {
    const dir = tmpDir();
    const lockPath = join(dir, 'test.lock');
    try {
      acquireRunLock(lockPath, {
        pid: process.pid,
        command: 'test',
        createdAt: new Date().toISOString(),
      });
      assert(existsSync(lockPath), 'Lock file should be created');
    } finally {
      releaseRunLock(lockPath);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('writes metadata to lock file', () => {
    const dir = tmpDir();
    const lockPath = join(dir, 'test.lock');
    const metadata = {
      pid: 12345,
      command: 'real-block-run-ai',
      blockId: 'block-test',
      createdAt: '2024-01-01T00:00:00.000Z',
    };
    try {
      acquireRunLock(lockPath, metadata);
      const raw = readFileSync(lockPath, 'utf-8');
      const parsed = JSON.parse(raw);
      assert.strictEqual(parsed.pid, 12345);
      assert.strictEqual(parsed.command, 'real-block-run-ai');
      assert.strictEqual(parsed.blockId, 'block-test');
      assert.strictEqual(parsed.createdAt, '2024-01-01T00:00:00.000Z');
    } finally {
      releaseRunLock(lockPath);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('refuses when lock exists', () => {
    const dir = tmpDir();
    const lockPath = join(dir, 'test.lock');
    try {
      acquireRunLock(lockPath, {
        pid: process.pid,
        command: 'first',
        createdAt: new Date().toISOString(),
      });
      assert.throws(
        () =>
          acquireRunLock(lockPath, {
            pid: process.pid,
            command: 'second',
            createdAt: new Date().toISOString(),
          }),
        (err: unknown) => err instanceof RunLockError
      );
    } finally {
      releaseRunLock(lockPath);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('releases lock', () => {
    const dir = tmpDir();
    const lockPath = join(dir, 'test.lock');
    try {
      acquireRunLock(lockPath, {
        pid: process.pid,
        command: 'test',
        createdAt: new Date().toISOString(),
      });
      releaseRunLock(lockPath);
      assert(!existsSync(lockPath), 'Lock file should be removed');
    } finally {
      releaseRunLock(lockPath);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('release is idempotent', () => {
    const dir = tmpDir();
    const lockPath = join(dir, 'test.lock');
    try {
      acquireRunLock(lockPath, {
        pid: process.pid,
        command: 'test',
        createdAt: new Date().toISOString(),
      });
      releaseRunLock(lockPath);
      releaseRunLock(lockPath);
      releaseRunLock(lockPath);
      assert(!existsSync(lockPath), 'Lock file should remain removed');
    } finally {
      releaseRunLock(lockPath);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('formatRunLockError includes lock path and owner info', () => {
    const message = formatRunLockError('/tmp/test.lock', {
      pid: 123,
      command: 'real-block-run-ai',
      blockId: 'block-abc',
      createdAt: new Date().toISOString(),
    });
    assert(message.includes('Another run appears to be active'));
    assert(message.includes('/tmp/test.lock'));
    assert(message.includes('pid=123'));
    assert(message.includes('block_id=block-abc'));
    assert(message.includes('remove it manually'));
  });

  test('formatRunLockError redacts token-like strings', () => {
    const message = formatRunLockError('/tmp/test.lock', {
      pid: 123,
      command: 'real-repo-run-ai',
      repoPath: '/tmp/repo-sk-fake-lock-secret',
      workBranch: 'ai/work',
      createdAt: new Date().toISOString(),
    });
    assert(!message.includes('sk-fake-lock-secret'), `Secret leaked: ${message}`);
  });

  test('readRunLockMetadata returns null for missing lock', () => {
    const dir = tmpDir();
    const lockPath = join(dir, 'missing.lock');
    try {
      assert.strictEqual(readRunLockMetadata(lockPath), null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('readRunLockMetadata returns null for invalid JSON', () => {
    const dir = tmpDir();
    const lockPath = join(dir, 'test.lock');
    try {
      writeFileSync(lockPath, 'not json', 'utf-8');
      assert.strictEqual(readRunLockMetadata(lockPath), null);
    } finally {
      releaseRunLock(lockPath);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('getRepoRunLockPath scopes by repo path and work branch', () => {
    const p1 = getRepoRunLockPath('/tmp/repo', 'ai/branch-a', '/tmp/runs');
    const p2 = getRepoRunLockPath('/tmp/repo', 'ai/branch-a', '/tmp/runs');
    const p3 = getRepoRunLockPath('/tmp/repo', 'ai/branch-b', '/tmp/runs');
    const p4 = getRepoRunLockPath('/tmp/other-repo', 'ai/branch-a', '/tmp/runs');
    assert.strictEqual(p1, p2, 'Same repo and branch should produce same lock path');
    assert.notStrictEqual(p1, p3, 'Different branch should produce different lock path');
    assert.notStrictEqual(p1, p4, 'Different repo should produce different lock path');
  });

  test('lock error contains existing metadata', () => {
    const dir = tmpDir();
    const lockPath = join(dir, 'test.lock');
    try {
      const existing = {
        pid: 999,
        command: 'existing',
        createdAt: new Date().toISOString(),
      };
      acquireRunLock(lockPath, existing);
      try {
        acquireRunLock(lockPath, {
          pid: process.pid,
          command: 'contender',
          createdAt: new Date().toISOString(),
        });
        assert.fail('Expected lock error');
      } catch (err) {
        assert(err instanceof RunLockError);
        assert.strictEqual((err as RunLockError).lockPath, lockPath);
        assert.strictEqual((err as RunLockError).metadata?.pid, 999);
        assert.strictEqual((err as RunLockError).metadata?.command, 'existing');
      }
    } finally {
      releaseRunLock(lockPath);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
