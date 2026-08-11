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

describe('ai-safety-policy secret identifier handling', () => {
  test('README mention of KIMI_API_KEY and GITHUB_TOKEN is allowed', () => {
    const repo = mkdtempSync(join(tmpdir(), 'policy-repo-'));
    try {
      const result = validateAiSafetyPolicy({
        repoPath: repo,
        allowedFiles: ['README.md'],
        files: [
          {
            path: 'README.md',
            content: 'Real PR mode requires `KIMI_API_KEY` and `GITHUB_TOKEN` to be set.',
          },
        ],
      });
      assert.strictEqual(result.ok, true, `Expected literal env names to be allowed: ${result.reasons.join('; ')}`);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test('docs configuration mention of KIMI_API_KEY is allowed', () => {
    const repo = mkdtempSync(join(tmpdir(), 'policy-repo-'));
    try {
      const result = validateAiSafetyPolicy({
        repoPath: repo,
        allowedFiles: ['docs/configuration.md'],
        files: [
          {
            path: 'docs/configuration.md',
            content: '`KIMI_API_KEY` contains the provider credential and is configured once.',
          },
        ],
      });
      assert.strictEqual(result.ok, true, `Expected literal env name in docs to be allowed: ${result.reasons.join('; ')}`);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test('source constant with env var name is allowed', () => {
    const repo = mkdtempSync(join(tmpdir(), 'policy-repo-'));
    try {
      const result = validateAiSafetyPolicy({
        repoPath: repo,
        allowedFiles: ['src/env.ts'],
        files: [
          {
            path: 'src/env.ts',
            content: "const name = 'KIMI_API_KEY';\n",
          },
        ],
      });
      assert.strictEqual(result.ok, true, `Expected string constant env name to be allowed: ${result.reasons.join('; ')}`);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test('process.env.KIMI_API_KEY access is still blocked', () => {
    const repo = mkdtempSync(join(tmpdir(), 'policy-repo-'));
    try {
      const result = validateAiSafetyPolicy({
        repoPath: repo,
        allowedFiles: ['src/env.ts'],
        files: [
          {
            path: 'src/env.ts',
            content: 'console.log(process.env.KIMI_API_KEY);\n',
          },
        ],
      });
      assert.strictEqual(result.ok, false, 'Expected process.env access to be blocked');
      assert.ok(result.reasons.some((r) => r.includes('Secret env var access')), `Expected secret env reason: ${result.reasons.join('; ')}`);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test('JSON.stringify(process.env) is still blocked', () => {
    const repo = mkdtempSync(join(tmpdir(), 'policy-repo-'));
    try {
      const result = validateAiSafetyPolicy({
        repoPath: repo,
        allowedFiles: ['src/env.ts'],
        files: [
          {
            path: 'src/env.ts',
            content: 'const x = JSON.stringify(process.env);\n',
          },
        ],
      });
      assert.strictEqual(result.ok, false, 'Expected JSON.stringify(process.env) to be blocked');
      assert.ok(result.reasons.some((r) => r.includes('Serializing process.env')), `Expected serialize env reason: ${result.reasons.join('; ')}`);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test('reading .env file is still blocked', () => {
    const repo = mkdtempSync(join(tmpdir(), 'policy-repo-'));
    try {
      const result = validateAiSafetyPolicy({
        repoPath: repo,
        allowedFiles: ['src/env.ts'],
        files: [
          {
            path: 'src/env.ts',
            content: "const data = readFileSync('.env', 'utf8');\n",
          },
        ],
      });
      assert.strictEqual(result.ok, false, 'Expected .env read to be blocked');
      assert.ok(result.reasons.some((r) => r.includes('Reading .env file')), `Expected .env read reason: ${result.reasons.join('; ')}`);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test('.env file modification is still blocked by path denylist', () => {
    const repo = mkdtempSync(join(tmpdir(), 'policy-repo-'));
    try {
      const result = validateAiSafetyPolicy({
        repoPath: repo,
        allowedFiles: ['.env'],
        files: [
          {
            path: '.env',
            content: 'KIMI_API_KEY=sk-placeholder\n',
          },
        ],
      });
      assert.strictEqual(result.ok, false, 'Expected .env path to be blocked');
      assert.ok(result.reasons.some((r) => r.includes('denied list')), `Expected .env denied reason: ${result.reasons.join('; ')}`);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
