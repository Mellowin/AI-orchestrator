import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

function runScript(): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [join(process.cwd(), 'scripts', 'verify-testing-summary.mjs')], {
    cwd: process.cwd(),
    encoding: 'utf-8',
    shell: false,
  });
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

describe('verify-testing-summary', () => {
  test('passes on current project evidence', () => {
    const result = runScript();
    assert.strictEqual(result.status, 0, `Verifier failed: ${result.stderr}`);
    assert(result.stdout.includes('TESTING_SUMMARY verification passed'));
  });
});
