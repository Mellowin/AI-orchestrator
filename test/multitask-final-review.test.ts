import { describe, test } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { collectUnauthorizedFiles, collectDiff } from '../src/autopilot-one-click/multitask/final-review.js';

describe('collectUnauthorizedFiles validates both sides of renames', () => {
  test('create outside allowlist is unauthorized', () => {
    const diff = [
      'diff --git a/new-file.ts b/new-file.ts',
      'new file mode 100644',
      'index 0000000..e69de29',
      '--- /dev/null',
      '+++ b/new-file.ts',
    ].join('\n');
    const files = collectUnauthorizedFiles(diff, ['src/**']);
    assert.deepStrictEqual(files, ['new-file.ts']);
  });

  test('delete outside allowlist is unauthorized', () => {
    const diff = [
      'diff --git a/old-file.ts b/old-file.ts',
      'deleted file mode 100644',
      'index e69de29..0000000',
      '--- a/old-file.ts',
      '+++ /dev/null',
    ].join('\n');
    const files = collectUnauthorizedFiles(diff, ['src/**']);
    assert.deepStrictEqual(files, ['old-file.ts']);
  });

  test('rename from allowed to out-of-scope fails on destination', () => {
    const diff = [
      'diff --git a/src/old.ts b/out/new.ts',
      'similarity index 100%',
      'rename from src/old.ts',
      'rename to out/new.ts',
    ].join('\n');
    const files = collectUnauthorizedFiles(diff, ['src/**']);
    assert.ok(files.includes('out/new.ts'), `expected out/new.ts in ${files.join(', ')}`);
  });

  test('rename from out-of-scope to allowed fails on source', () => {
    const diff = [
      'diff --git a/out/old.ts b/src/new.ts',
      'similarity index 100%',
      'rename from out/old.ts',
      'rename to src/new.ts',
    ].join('\n');
    const files = collectUnauthorizedFiles(diff, ['src/**']);
    assert.ok(files.includes('out/old.ts'), `expected out/old.ts in ${files.join(', ')}`);
  });

  test('rename within allowlist is authorized', () => {
    const diff = [
      'diff --git a/src/old.ts b/src/new.ts',
      'similarity index 100%',
      'rename from src/old.ts',
      'rename to src/new.ts',
    ].join('\n');
    const files = collectUnauthorizedFiles(diff, ['src/**']);
    assert.deepStrictEqual(files, []);
  });

  test('normal modification within allowlist stays authorized', () => {
    const diff = [
      'diff --git a/src/foo.ts b/src/foo.ts',
      'index e69de29..d8649da 100644',
      '--- a/src/foo.ts',
      '+++ b/src/foo.ts',
      '@@ -1 +1 @@',
      '-old',
      '+new',
    ].join('\n');
    const files = collectUnauthorizedFiles(diff, ['src/**']);
    assert.deepStrictEqual(files, []);
  });
});


describe('collectDiff fails closed', () => {
  test('throws when both git diff attempts fail in a non-git directory', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'no-git-'));
    assert.throws(
      () => collectDiff(tmpDir, 'main', 'work'),
      /Could not collect diff/
    );
    rmSync(tmpDir, { recursive: true, force: true });
  });
});
