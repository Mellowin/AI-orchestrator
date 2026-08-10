import { describe, test } from 'node:test';
import assert from 'node:assert';
import { validateAiSafetyPolicy } from '../src/ai-safety-policy.js';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('ai-safety-policy test-weakening detection', () => {
  test('Markdown heading with asserted does not trigger test weakening', () => {
    const repo = mkdtempSync(join(tmpdir(), 'policy-repo-'));
    try {
      const result = validateAiSafetyPolicy({
        repoPath: repo,
        allowedFiles: ['docs/part1.md'],
        files: [
          {
            path: 'docs/part1.md',
            content: '# Invariants asserted in PART1-PART2\n\nSome description.\n',
          },
        ],
      });
      assert.strictEqual(result.ok, true, `Expected no test weakening: ${result.reasons.join('; ')}`);
      assert.strictEqual(result.reasons.length, 0);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test('test file with .only is blocked as test weakening', () => {
    const repo = mkdtempSync(join(tmpdir(), 'policy-repo-'));
    try {
      const result = validateAiSafetyPolicy({
        repoPath: repo,
        allowedFiles: ['src/foo.test.ts'],
        files: [
          {
            path: 'src/foo.test.ts',
            content: "describe('foo', () => { it.only('x', () => {}); });\n",
          },
        ],
      });
      assert.strictEqual(result.ok, false, 'Expected .only to be blocked');
      assert.ok(result.reasons.some((r) => r.includes('.only')), `Expected .only reason: ${result.reasons.join('; ')}`);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test('test file with no assertions and only console.log ok is blocked', () => {
    const repo = mkdtempSync(join(tmpdir(), 'policy-repo-'));
    try {
      const result = validateAiSafetyPolicy({
        repoPath: repo,
        allowedFiles: ['tests/bar.test.js'],
        files: [
          {
            path: 'tests/bar.test.js',
            content: "console.log('ok');\n",
          },
        ],
      });
      assert.strictEqual(result.ok, false, 'Expected no-assertion test to be blocked');
      assert.ok(result.reasons.some((r) => r.includes('no assertions')), `Expected no assertions reason: ${result.reasons.join('; ')}`);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test('commented-out assertion in a real test file is still blocked', () => {
    const repo = mkdtempSync(join(tmpdir(), 'policy-repo-'));
    try {
      const result = validateAiSafetyPolicy({
        repoPath: repo,
        allowedFiles: ['src/baz.test.ts'],
        files: [
          {
            path: 'src/baz.test.ts',
            content: "describe('baz', () => {\n  // assert(foo)\n});\n",
          },
        ],
      });
      assert.strictEqual(result.ok, false, 'Expected commented-out assertion to be blocked');
      assert.ok(result.reasons.some((r) => r.includes('Commented-out assertion')), `Expected commented-out assertion reason: ${result.reasons.join('; ')}`);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
