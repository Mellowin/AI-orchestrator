import { describe, test } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareSandboxBase } from '../src/sandbox-base-preparer.js';

describe('sandbox-base-preparer', () => {
  test('generates package-lock.json from package.json', () => {
    const repo = mkdtempSync(join(tmpdir(), 'sandbox-base-'));
    writeFileSync(
      join(repo, 'package.json'),
      JSON.stringify({ name: 'test-base', version: '1.0.0', dependencies: {} }),
      'utf-8'
    );

    const result = prepareSandboxBase(repo);

    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.packageLockGenerated, true);
    assert.ok(existsSync(join(repo, 'package-lock.json')));
  });

  test('fails when npm install --package-lock-only cannot run', () => {
    const repo = mkdtempSync(join(tmpdir(), 'sandbox-base-bad-'));
    const result = prepareSandboxBase(repo);

    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.packageLockGenerated, false);
  });
});
