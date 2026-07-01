import { describe, test } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateAiSafetyPolicy } from '../src/ai-safety-policy.js';

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ai-safety-policy-test-'));
  return dir;
}

describe('ai-safety-policy', () => {
  test('accepts a normal README update', () => {
    const repo = makeRepo();
    const result = validateAiSafetyPolicy({
      repoPath: repo,
      allowedFiles: ['README.md'],
      deniedFiles: ['.env'],
      files: [{ path: 'README.md', content: '# Updated README\n\nNote.\n' }],
    });
    assert.strictEqual(result.ok, true);
    assert.deepStrictEqual(result.reasons, []);
  });

  test('rejects commenting out an assertion in a test file', () => {
    const repo = makeRepo();
    const result = validateAiSafetyPolicy({
      repoPath: repo,
      allowedFiles: ['test.js'],
      deniedFiles: [],
      files: [
        {
          path: 'test.js',
          content: "const { add } = require('./math.js');\n// if (add(2,3) !== 5) { console.error('fail'); process.exit(1); }\nconsole.log('ok');\n",
        },
      ],
    });
    assert.strictEqual(result.ok, false);
    assert.ok(result.reasons.some((r) => r.includes('Commented-out assertion')));
  });

  test('rejects test file reduced to only console.log ok', () => {
    const repo = makeRepo();
    const result = validateAiSafetyPolicy({
      repoPath: repo,
      allowedFiles: ['test.js'],
      deniedFiles: [],
      files: [
        {
          path: 'test.js',
          content: "const { add } = require('./math.js');\nconsole.log('ok');\n",
        },
      ],
    });
    assert.strictEqual(result.ok, false);
    assert.ok(result.reasons.some((r) => r.includes('no assertions and only prints ok')));
  });

  test('rejects test.only and test.skip', () => {
    const repo = makeRepo();
    for (const selector of ['.only', '.skip']) {
      const result = validateAiSafetyPolicy({
        repoPath: repo,
        allowedFiles: ['test.js'],
        deniedFiles: [],
        files: [
          {
            path: 'test.js',
            content: `test${selector}('add', () => { assert.strictEqual(add(2,3), 5); });`,
          },
        ],
      });
      assert.strictEqual(result.ok, false, `should reject ${selector}`);
      assert.ok(result.reasons.some((r) => r.includes('Test selector')));
    }
  });

  test('rejects empty test file', () => {
    const repo = makeRepo();
    const result = validateAiSafetyPolicy({
      repoPath: repo,
      allowedFiles: ['test.js'],
      deniedFiles: [],
      files: [{ path: 'test.js', content: '   \n\n  ' }],
    });
    assert.strictEqual(result.ok, false);
    assert.ok(result.reasons.some((r) => r.includes('Test file would be empty')));
  });

  test('rejects continue-on-error in CI workflow', () => {
    const repo = makeRepo();
    const result = validateAiSafetyPolicy({
      repoPath: repo,
      allowedFiles: ['.github/workflows/ci.yml'],
      deniedFiles: [],
      files: [
        {
          path: '.github/workflows/ci.yml',
          content: 'jobs:\n  build:\n    steps:\n      - run: npm test\n        continue-on-error: true\n',
        },
      ],
    });
    assert.strictEqual(result.ok, false);
    assert.ok(result.reasons.some((r) => r.includes('continue-on-error')));
  });

  test('rejects path traversal outside repo', () => {
    const repo = makeRepo();
    for (const path of ['../outside.txt', '..\\outside.txt']) {
      const result = validateAiSafetyPolicy({
        repoPath: repo,
        allowedFiles: [path],
        deniedFiles: [],
        files: [{ path, content: 'outside' }],
      });
      assert.strictEqual(result.ok, false, `should reject ${path}`);
      assert.ok(
        result.reasons.some((r) => r.includes('escapes repository root') || r.includes('parent directory')),
        `expected escape reason for ${path}, got ${result.reasons.join('; ')}`
      );
    }
  });

  test('rejects absolute paths', () => {
    const repo = makeRepo();
    for (const path of ['C:\\stage18-evil.txt', '/tmp/stage18-evil.txt']) {
      const result = validateAiSafetyPolicy({
        repoPath: repo,
        allowedFiles: [path],
        deniedFiles: [],
        files: [{ path, content: 'evil' }],
      });
      assert.strictEqual(result.ok, false, `should reject ${path}`);
      assert.ok(result.reasons.some((r) => r.includes('absolute')));
    }
  });

  test('rejects printing KIMI_API_KEY', () => {
    const repo = makeRepo();
    const result = validateAiSafetyPolicy({
      repoPath: repo,
      allowedFiles: ['README.md'],
      deniedFiles: [],
      files: [{ path: 'README.md', content: "console.log(process.env.KIMI_API_KEY)\n" }],
    });
    assert.strictEqual(result.ok, false);
    assert.ok(result.reasons.some((r) => r.includes('Secret env var access')));
  });

  test('rejects logging process.env object', () => {
    const repo = makeRepo();
    const result = validateAiSafetyPolicy({
      repoPath: repo,
      allowedFiles: ['README.md'],
      deniedFiles: [],
      files: [{ path: 'README.md', content: "console.error('env dump', process.env)\n" }],
    });
    assert.strictEqual(result.ok, false);
    assert.ok(result.reasons.some((r) => r.includes('Logging process.env')));
  });

  test('rejects reading .env', () => {
    const repo = makeRepo();
    const dotenv = validateAiSafetyPolicy({
      repoPath: repo,
      allowedFiles: ['index.js'],
      deniedFiles: [],
      files: [{ path: 'index.js', content: "require('dotenv').config();\n" }],
    });
    assert.strictEqual(dotenv.ok, false);
    assert.ok(dotenv.reasons.some((r) => r.includes('Loading .env file')));

    const read = validateAiSafetyPolicy({
      repoPath: repo,
      allowedFiles: ['index.js'],
      deniedFiles: [],
      files: [{ path: 'index.js', content: "const fs = require('fs'); fs.readFileSync('.env')\n" }],
    });
    assert.strictEqual(read.ok, false);
    assert.ok(read.reasons.some((r) => r.includes('Reading .env file')));
  });

  test('rejects .env path', () => {
    const repo = makeRepo();
    const result = validateAiSafetyPolicy({
      repoPath: repo,
      allowedFiles: ['.env'],
      deniedFiles: [],
      files: [{ path: '.env', content: 'KEY=value\n' }],
    });
    assert.strictEqual(result.ok, false);
    assert.ok(result.reasons.some((r) => r.includes('denied list')));
  });

  test('rejects path not in allowed_files', () => {
    const repo = makeRepo();
    const result = validateAiSafetyPolicy({
      repoPath: repo,
      allowedFiles: ['README.md'],
      deniedFiles: [],
      files: [{ path: 'secret.txt', content: 'x' }],
    });
    assert.strictEqual(result.ok, false);
    assert.ok(result.reasons.some((r) => r.includes('not in allowed_files')));
  });

  test('returns multiple reasons for a multi-violation plan', () => {
    const repo = makeRepo();
    const result = validateAiSafetyPolicy({
      repoPath: repo,
      allowedFiles: ['../outside.txt'],
      deniedFiles: [],
      files: [
        {
          path: '../outside.txt',
          content: "console.log(process.env.KIMI_API_KEY);\n",
        },
      ],
    });
    assert.strictEqual(result.ok, false);
    assert.ok(result.reasons.length >= 2);
  });
});
