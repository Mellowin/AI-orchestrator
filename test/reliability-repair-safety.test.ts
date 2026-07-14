import { describe, test } from 'node:test';
import assert from 'node:assert';
import { checkRepairSafety } from '../src/reliability/repair-safety.js';

describe('reliability repair safety', () => {
  test('detects token-like strings in multiple files without stateful regex skipping', () => {
    const files = [
      { path: 'a.ts', content: 'const token = "ghp_abcdefghijklmnopqrstuvwxyz1234";' },
      { path: 'b.ts', content: 'const token = "ghp_abcdefghijklmnopqrstuvwxyz5678";' },
    ];
    const violations = checkRepairSafety(files, ['a.ts', 'b.ts'], false);
    assert.strictEqual(violations.filter((v) => v.type === 'token_exposed').length, 2);
  });

  test('detects skipped tests in multiple files without stateful regex skipping', () => {
    const files = [
      { path: 'a.test.ts', content: 'test.skip("a", () => {});' },
      { path: 'b.test.ts', content: 'test.skip("b", () => {});' },
    ];
    const violations = checkRepairSafety(files, ['a.test.ts', 'b.test.ts'], false);
    assert.strictEqual(violations.filter((v) => v.type === 'skip_only_todo').length, 2);
  });

  test('flags out-of-scope files', () => {
    const violations = checkRepairSafety([{ path: 'secret.ts', content: 'const x = 1;' }], ['allowed.ts'], false);
    assert.strictEqual(violations.some((v) => v.type === 'destructive'), true);
  });

  test('allows TESTING_SUMMARY.md in scope', () => {
    const violations = checkRepairSafety([{ path: 'TESTING_SUMMARY.md', content: '# Summary\n' }], ['TESTING_SUMMARY.md'], false);
    assert.strictEqual(violations.length, 0);
  });
});
