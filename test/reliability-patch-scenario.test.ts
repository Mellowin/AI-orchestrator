import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { applyScenarioPatch } from '../src/reliability/patch-scenario.js';

describe('applyScenarioPatch path containment', () => {
  let tempRoot: string;
  let repoPath: string;

  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), 'patch-scen-'));
    repoPath = join(tempRoot, 'repo');
    mkdirSync(join(repoPath, 'src'), { recursive: true });
    writeFileSync(join(repoPath, 'src', 'a.txt'), 'hello world');
  });

  afterEach(() => {
    rmSync(tempRoot, { recursive: true, force: true });
  });

  test('allows a normal nested repo file', () => {
    applyScenarioPatch(repoPath, { path: 'src/a.txt', search: 'world', replace: 'there' });
    assert.strictEqual(readFileSync(join(repoPath, 'src', 'a.txt'), 'utf-8'), 'hello there');
  });

  test('rejects ../ path and does not create a file outside the repo', () => {
    const outside = join(tempRoot, 'escape.txt');
    assert.throws(
      () => applyScenarioPatch(repoPath, { path: '../escape.txt', overwrite: true, replace: 'x' }),
      /RELIABILITY_PATCH_PATH_OUTSIDE_REPO/
    );
    assert.strictEqual(existsSync(outside), false);
  });

  test('rejects multi-level traversal', () => {
    const outside = join(tempRoot, 'escape.txt');
    assert.throws(
      () =>
        applyScenarioPatch(repoPath, {
          path: 'nested/../../escape.txt',
          overwrite: true,
          replace: 'x',
        }),
      /RELIABILITY_PATCH_PATH_OUTSIDE_REPO/
    );
    assert.strictEqual(existsSync(outside), false);
  });

  test('rejects absolute POSIX paths', () => {
    const absolute = resolve(tempRoot, 'abs-evil.txt').replace(/\\/g, '/');
    assert.throws(
      () => applyScenarioPatch(repoPath, { path: absolute, overwrite: true, replace: 'x' }),
      /RELIABILITY_PATCH_PATH_OUTSIDE_REPO/
    );
    assert.strictEqual(existsSync(resolve(tempRoot, 'abs-evil.txt')), false);
  });

  test('rejects Windows drive paths on all platforms', () => {
    assert.throws(
      () =>
        applyScenarioPatch(repoPath, { path: 'C:\\Windows\\evil.txt', overwrite: true, replace: 'x' }),
      /RELIABILITY_PATCH_PATH_OUTSIDE_REPO/
    );
  });

  test('rejects UNC paths', () => {
    assert.throws(
      () =>
        applyScenarioPatch(repoPath, {
          path: '\\\\server\\share\\evil.txt',
          overwrite: true,
          replace: 'x',
        }),
      /RELIABILITY_PATCH_PATH_OUTSIDE_REPO/
    );
  });

  test('rejects mixed separator traversal', () => {
    const outside = join(tempRoot, 'escape.txt');
    assert.throws(
      () =>
        applyScenarioPatch(repoPath, {
          path: 'nested\\../escape.txt',
          overwrite: true,
          replace: 'x',
        }),
      /RELIABILITY_PATCH_PATH_OUTSIDE_REPO/
    );
    assert.strictEqual(existsSync(outside), false);
  });

  test('rejects sibling-prefix paths that only share a string prefix with the repo', () => {
    const sibling = join(tempRoot, 'repo-sibling');
    mkdirSync(sibling, { recursive: true });
    const outside = join(sibling, 'file.txt');
    assert.throws(
      () =>
        applyScenarioPatch(repoPath, {
          path: '../repo-sibling/file.txt',
          overwrite: true,
          replace: 'x',
        }),
      /RELIABILITY_PATCH_PATH_OUTSIDE_REPO/
    );
    assert.strictEqual(existsSync(outside), false);
  });

  test('rejects existing symlink escapes where supported', () => {
    if (process.platform === 'win32') {
      // Symlinks on Windows often require elevated privileges; skip this variant.
      return;
    }
    const outside = join(tempRoot, 'outside-target.txt');
    writeFileSync(outside, 'secret');
    const link = join(repoPath, 'link-escape');
    symlinkSync(outside, link);
    assert.strictEqual(realpathSync(link), outside);

    assert.throws(
      () => applyScenarioPatch(repoPath, { path: 'link-escape', overwrite: true, replace: 'x' }),
      /RELIABILITY_PATCH_PATH_OUTSIDE_REPO/
    );

    // Confirm the symlink target outside the repo was not modified.
    assert.strictEqual(readFileSync(outside, 'utf-8'), 'secret');
  });

  test('does not create or modify any outside file after rejections', () => {
    const outside = join(tempRoot, 'should-not-exist.txt');
    const attempts = [
      { path: '../should-not-exist.txt', overwrite: true, replace: 'x' },
      { path: '/should-not-exist.txt', overwrite: true, replace: 'x' },
      { path: 'C:\\should-not-exist.txt', overwrite: true, replace: 'x' },
      { path: '\\\\server\\share\\should-not-exist.txt', overwrite: true, replace: 'x' },
      { path: 'a/../should-not-exist.txt', overwrite: true, replace: 'x' },
    ];
    for (const patch of attempts) {
      assert.throws(() => applyScenarioPatch(repoPath, patch), /RELIABILITY_PATCH_PATH_OUTSIDE_REPO/);
    }
    assert.strictEqual(existsSync(outside), false);
  });
});
