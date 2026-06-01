import { describe, test } from 'node:test';
import assert from 'node:assert';
import {
  mkdtempSync,
  writeFileSync,
  rmSync,
  existsSync,
  readFileSync,
  mkdirSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { applyFileUpdates, rollbackFileUpdates } from '../src/patch-engine.js';
import type { FileUpdate } from '../src/types.js';

function makeTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

describe('patch-engine', () => {
  test('applyFileUpdates overwrites existing file and creates backup', () => {
    const repo = makeTempDir('patch-repo-');
    const runDir = makeTempDir('patch-run-');
    try {
      writeFileSync(join(repo, 'foo.txt'), 'old content', 'utf-8');

      const manifest = applyFileUpdates(
        repo,
        [{ path: 'foo.txt', content: 'new content' }],
        runDir
      );

      assert.strictEqual(manifest.length, 1);
      assert.strictEqual(manifest[0].path, 'foo.txt');
      assert.strictEqual(manifest[0].existedBefore, true);
      assert.ok(manifest[0].backupPath.length > 0);
      assert.ok(existsSync(manifest[0].backupPath));
      assert.strictEqual(readFileSync(manifest[0].backupPath, 'utf-8'), 'old content');
      assert.strictEqual(readFileSync(join(repo, 'foo.txt'), 'utf-8'), 'new content');
    } finally {
      rmSync(repo, { recursive: true });
      rmSync(runDir, { recursive: true });
    }
  });

  test('applyFileUpdates creates new file', () => {
    const repo = makeTempDir('patch-repo-');
    const runDir = makeTempDir('patch-run-');
    try {
      const manifest = applyFileUpdates(
        repo,
        [{ path: 'bar.txt', content: 'hello' }],
        runDir
      );

      assert.strictEqual(manifest.length, 1);
      assert.strictEqual(manifest[0].path, 'bar.txt');
      assert.strictEqual(manifest[0].existedBefore, false);
      assert.strictEqual(manifest[0].backupPath, '');
      assert.strictEqual(readFileSync(join(repo, 'bar.txt'), 'utf-8'), 'hello');
    } finally {
      rmSync(repo, { recursive: true });
      rmSync(runDir, { recursive: true });
    }
  });

  test('applyFileUpdates creates nested directories', () => {
    const repo = makeTempDir('patch-repo-');
    const runDir = makeTempDir('patch-run-');
    try {
      const manifest = applyFileUpdates(
        repo,
        [{ path: 'src/nested/deep.txt', content: 'deep' }],
        runDir
      );

      assert.strictEqual(manifest.length, 1);
      assert.ok(existsSync(join(repo, 'src', 'nested', 'deep.txt')));
      assert.strictEqual(
        readFileSync(join(repo, 'src', 'nested', 'deep.txt'), 'utf-8'),
        'deep'
      );
    } finally {
      rmSync(repo, { recursive: true });
      rmSync(runDir, { recursive: true });
    }
  });

  test('applyFileUpdates rejects absolute path', () => {
    const repo = makeTempDir('patch-repo-');
    const runDir = makeTempDir('patch-run-');
    try {
      assert.throws(
        () =>
          applyFileUpdates(repo, [{ path: '/etc/passwd', content: 'x' }], runDir),
        /Absolute paths are not allowed/
      );
    } finally {
      rmSync(repo, { recursive: true });
      rmSync(runDir, { recursive: true });
    }
  });

  test('applyFileUpdates rejects path traversal', () => {
    const repo = makeTempDir('patch-repo-');
    const runDir = makeTempDir('patch-run-');
    try {
      assert.throws(
        () =>
          applyFileUpdates(repo, [{ path: '../secret.txt', content: 'x' }], runDir),
        /Path traversal detected/
      );
    } finally {
      rmSync(repo, { recursive: true });
      rmSync(runDir, { recursive: true });
    }
  });

  test('applyFileUpdates rejects backslash paths', () => {
    const repo = makeTempDir('patch-repo-');
    const runDir = makeTempDir('patch-run-');
    try {
      assert.throws(
        () =>
          applyFileUpdates(repo, [{ path: 'src\\file.txt', content: 'x' }], runDir),
        /Backslash not allowed/
      );
    } finally {
      rmSync(repo, { recursive: true });
      rmSync(runDir, { recursive: true });
    }
  });

  test('applyFileUpdates rejects duplicate paths', () => {
    const repo = makeTempDir('patch-repo-');
    const runDir = makeTempDir('patch-run-');
    try {
      assert.throws(
        () =>
          applyFileUpdates(repo, [
            { path: 'dup.txt', content: 'a' },
            { path: 'dup.txt', content: 'b' },
          ], runDir),
        /Duplicate file update/
      );
    } finally {
      rmSync(repo, { recursive: true });
      rmSync(runDir, { recursive: true });
    }
  });

  test('applyFileUpdates handles multiple file updates', () => {
    const repo = makeTempDir('patch-repo-');
    const runDir = makeTempDir('patch-run-');
    try {
      writeFileSync(join(repo, 'existing.txt'), 'original', 'utf-8');

      const manifest = applyFileUpdates(
        repo,
        [
          { path: 'existing.txt', content: 'updated' },
          { path: 'new.txt', content: 'fresh' },
        ],
        runDir
      );

      assert.strictEqual(manifest.length, 2);
      assert.strictEqual(readFileSync(join(repo, 'existing.txt'), 'utf-8'), 'updated');
      assert.strictEqual(readFileSync(join(repo, 'new.txt'), 'utf-8'), 'fresh');
    } finally {
      rmSync(repo, { recursive: true });
      rmSync(runDir, { recursive: true });
    }
  });

  test('applyFileUpdates rolls back on write failure', () => {
    const repo = makeTempDir('patch-repo-');
    const runDir = makeTempDir('patch-run-');
    try {
      writeFileSync(join(repo, 'existing.txt'), 'original', 'utf-8');
      writeFileSync(join(repo, 'new.txt'), 'new-original', 'utf-8');
      // Create a file where a directory is expected for the third update
      writeFileSync(join(repo, 'blocker'), 'block', 'utf-8');

      assert.throws(() => {
        applyFileUpdates(
          repo,
          [
            { path: 'existing.txt', content: 'updated' },
            { path: 'new.txt', content: 'new-updated' },
            { path: 'blocker/inside.txt', content: 'x' },
          ],
          runDir
        );
      }, /ENOTDIR|ENOENT|not a directory/);

      // Rollback should restore original files
      assert.strictEqual(readFileSync(join(repo, 'existing.txt'), 'utf-8'), 'original');
      assert.strictEqual(readFileSync(join(repo, 'new.txt'), 'utf-8'), 'new-original');
      assert.ok(!existsSync(join(repo, 'blocker', 'inside.txt')));
    } finally {
      rmSync(repo, { recursive: true });
      rmSync(runDir, { recursive: true });
    }
  });

  test('rollbackFileUpdates restores overwritten files', () => {
    const repo = makeTempDir('patch-repo-');
    const runDir = makeTempDir('patch-run-');
    try {
      writeFileSync(join(repo, 'foo.txt'), 'old', 'utf-8');

      const manifest = applyFileUpdates(
        repo,
        [{ path: 'foo.txt', content: 'new' }],
        runDir
      );

      rollbackFileUpdates(repo, manifest);

      assert.strictEqual(readFileSync(join(repo, 'foo.txt'), 'utf-8'), 'old');
    } finally {
      rmSync(repo, { recursive: true });
      rmSync(runDir, { recursive: true });
    }
  });

  test('rollbackFileUpdates deletes newly created files', () => {
    const repo = makeTempDir('patch-repo-');
    const runDir = makeTempDir('patch-run-');
    try {
      const manifest = applyFileUpdates(
        repo,
        [{ path: 'create.txt', content: 'created' }],
        runDir
      );

      rollbackFileUpdates(repo, manifest);

      assert.ok(!existsSync(join(repo, 'create.txt')));
    } finally {
      rmSync(repo, { recursive: true });
      rmSync(runDir, { recursive: true });
    }
  });

  test('rollbackFileUpdates throws when backup is missing', () => {
    const repo = makeTempDir('patch-repo-');
    try {
      assert.throws(
        () =>
          rollbackFileUpdates(repo, [
            { path: 'foo.txt', existedBefore: true, backupPath: join(repo, 'nonexistent') },
          ]),
        /Rollback failed: backup missing/
      );
    } finally {
      rmSync(repo, { recursive: true });
    }
  });

  test('rollbackFileUpdates validates paths', () => {
    const repo = makeTempDir('patch-repo-');
    try {
      assert.throws(
        () =>
          rollbackFileUpdates(repo, [
            { path: '../escape.txt', existedBefore: false, backupPath: '' },
          ]),
        /Path traversal detected/
      );
    } finally {
      rmSync(repo, { recursive: true });
    }
  });

  test('applyFileUpdates does not escape repo via relative resolution', () => {
    const repo = makeTempDir('patch-repo-');
    const runDir = makeTempDir('patch-run-');
    try {
      // The validateUpdatePath checks relative(repoPath, resolve(repoPath, filePath))
      // For a path like 'a/../../outside.txt', resolve(repo, 'a/../../outside.txt')
      // escapes the repo, and relative() starts with '..'
      assert.throws(
        () =>
          applyFileUpdates(repo, [{ path: 'a/../../outside.txt', content: 'x' }], runDir),
        /Path traversal detected|escapes repo_path/
      );
    } finally {
      rmSync(repo, { recursive: true });
      rmSync(runDir, { recursive: true });
    }
  });
});
