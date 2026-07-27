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

  test('denied_files wins over allowed_files when patterns overlap', () => {
    const repo = makeRepo();
    const result = validateAiSafetyPolicy({
      repoPath: repo,
      allowedFiles: ['src/**'],
      deniedFiles: ['**/*'],
      files: [{ path: 'src/foo.ts', content: 'x' }],
    });
    assert.strictEqual(result.ok, false);
    assert.ok(result.reasons.some((r) => r.includes('denied_files')));
  });

  test('denied hardcoded .env wins even when explicitly allowed', () => {
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

  test('accepts paths matched by glob allowed_files', () => {
    const repo = makeRepo();
    const result = validateAiSafetyPolicy({
      repoPath: repo,
      allowedFiles: ['demo-repo/**'],
      deniedFiles: [],
      files: [
        { path: 'demo-repo/src/math/add.ts', content: 'export const add = (a: number, b: number) => a + b;\n' },
        { path: 'demo-repo/src/math/add.test.ts', content: 'test' },
        { path: 'demo-repo/package.json', content: '{"scripts":{"test":"node --test"}}' },
      ],
    });
    assert.strictEqual(result.ok, true, `Expected glob allowed_files to pass, got: ${result.reasons.join('; ')}`);
  });

  test('rejects paths outside glob allowed_files', () => {
    const repo = makeRepo();
    const result = validateAiSafetyPolicy({
      repoPath: repo,
      allowedFiles: ['demo-repo/**'],
      deniedFiles: [],
      files: [{ path: 'src/outside.ts', content: 'x' }],
    });
    assert.strictEqual(result.ok, false);
    assert.ok(result.reasons.some((r) => r.includes('not in allowed_files')));
  });

  test('demo-repo prefix does not match demo-repo-other', () => {
    const repo = makeRepo();
    const result = validateAiSafetyPolicy({
      repoPath: repo,
      allowedFiles: ['demo-repo/**'],
      deniedFiles: [],
      files: [{ path: 'demo-repo-other/file.ts', content: 'x' }],
    });
    assert.strictEqual(result.ok, false);
    assert.ok(result.reasons.some((r) => r.includes('not in allowed_files')));
  });

  test('normalizes Windows separators and still applies glob restriction', () => {
    const repo = makeRepo();
    const allowed = validateAiSafetyPolicy({
      repoPath: repo,
      allowedFiles: ['demo-repo/**'],
      deniedFiles: [],
      files: [{ path: 'demo-repo\\src\\math\\add.ts', content: 'x' }],
    });
    assert.strictEqual(allowed.ok, true, `Expected Windows path inside glob to pass, got: ${allowed.reasons.join('; ')}`);

    const escape = validateAiSafetyPolicy({
      repoPath: repo,
      allowedFiles: ['demo-repo/**'],
      deniedFiles: [],
      files: [{ path: 'demo-repo\\..\\outside.ts', content: 'x' }],
    });
    assert.strictEqual(escape.ok, false);
    assert.ok(escape.reasons.some((r) => r.includes('parent directory') || r.includes('escapes repository root')));
  });

  test('empty allowed_files rejects all files', () => {
    const repo = makeRepo();
    const result = validateAiSafetyPolicy({
      repoPath: repo,
      allowedFiles: [],
      deniedFiles: [],
      files: [{ path: 'demo-repo/src/math/add.ts', content: 'x' }],
    });
    assert.strictEqual(result.ok, false);
    assert.ok(result.reasons.some((r) => r.includes('not in allowed_files')));
  });

  test('invalid allowed_files does not become allow-all', () => {
    const repo = makeRepo();
    const result = validateAiSafetyPolicy({
      repoPath: repo,
      allowedFiles: 'demo-repo/**' as unknown as string[],
      deniedFiles: [],
      files: [{ path: 'demo-repo/src/math/add.ts', content: 'x' }],
    });
    assert.strictEqual(result.ok, false);
    assert.ok(result.reasons.some((r) => r.includes('Invalid allowed_files')));
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

  describe('content-level path operations', () => {
    test('blocks fs.writeFileSync("../outside.txt")', () => {
      const repo = makeRepo();
      const result = validateAiSafetyPolicy({
        repoPath: repo,
        allowedFiles: ['src/expense-store.js'],
        deniedFiles: [],
        files: [
          {
            path: 'src/expense-store.js',
            content: "const fs = require('fs');\nfs.writeFileSync('../outside.txt', 'pwned');\n",
          },
        ],
      });
      assert.strictEqual(result.ok, false);
      assert.ok(result.reasons.some((r) => r.includes('File operation targets dangerous path')));
    });

    test('blocks fs.promises.writeFile("../outside.txt")', () => {
      const repo = makeRepo();
      const result = validateAiSafetyPolicy({
        repoPath: repo,
        allowedFiles: ['src/expense-store.js'],
        deniedFiles: [],
        files: [
          {
            path: 'src/expense-store.js',
            content: "const fs = require('fs');\nfs.promises.writeFile('../outside.txt', 'pwned');\n",
          },
        ],
      });
      assert.strictEqual(result.ok, false);
      assert.ok(result.reasons.some((r) => r.includes('File operation targets dangerous path')));
    });

    test('blocks readFileSync("../outside.txt")', () => {
      const repo = makeRepo();
      const result = validateAiSafetyPolicy({
        repoPath: repo,
        allowedFiles: ['src/expense-store.js'],
        deniedFiles: [],
        files: [
          {
            path: 'src/expense-store.js',
            content: "const fs = require('fs');\nreadFileSync('../outside.txt');\n",
          },
        ],
      });
      assert.strictEqual(result.ok, false);
      assert.ok(result.reasons.some((r) => r.includes('File operation targets dangerous path')));
    });

    test('blocks path.join("..", "outside.txt")', () => {
      const repo = makeRepo();
      const result = validateAiSafetyPolicy({
        repoPath: repo,
        allowedFiles: ['src/expense-store.js'],
        deniedFiles: [],
        files: [
          {
            path: 'src/expense-store.js',
            content: "const path = require('path');\nconst out = path.join('..', 'outside.txt');\n",
          },
        ],
      });
      assert.strictEqual(result.ok, false);
      assert.ok(result.reasons.some((r) => r.includes('path.join with parent directory reference')));
    });

    test('blocks Windows absolute path write', () => {
      const repo = makeRepo();
      const result = validateAiSafetyPolicy({
        repoPath: repo,
        allowedFiles: ['src/expense-store.js'],
        deniedFiles: [],
        files: [
          {
            path: 'src/expense-store.js',
            content: "const fs = require('fs');\nfs.writeFileSync('C:\\\\temp\\\\outside.txt', 'pwned');\n",
          },
        ],
      });
      assert.strictEqual(result.ok, false);
      assert.ok(result.reasons.some((r) => r.includes('File operation targets dangerous path')));
    });

    test('blocks Unix absolute path write', () => {
      const repo = makeRepo();
      const result = validateAiSafetyPolicy({
        repoPath: repo,
        allowedFiles: ['src/expense-store.js'],
        deniedFiles: [],
        files: [
          {
            path: 'src/expense-store.js',
            content: "const fs = require('fs');\nfs.writeFileSync('/tmp/outside.txt', 'pwned');\n",
          },
        ],
      });
      assert.strictEqual(result.ok, false);
      assert.ok(result.reasons.some((r) => r.includes('File operation targets dangerous path')));
    });

    test('blocks suspicious child_process write outside repo', () => {
      const repo = makeRepo();
      const result = validateAiSafetyPolicy({
        repoPath: repo,
        allowedFiles: ['src/expense-store.js'],
        deniedFiles: [],
        files: [
          {
            path: 'src/expense-store.js',
            content: "const { execSync } = require('child_process');\nexecSync('echo pwned > ../outside.txt');\n",
          },
        ],
      });
      assert.strictEqual(result.ok, false);
      assert.ok(result.reasons.some((r) => r.includes('child_process operation targets outside repository')));
    });

    test('does not block harmless README prose', () => {
      const repo = makeRepo();
      const result = validateAiSafetyPolicy({
        repoPath: repo,
        allowedFiles: ['README.md'],
        deniedFiles: [],
        files: [
          {
            path: 'README.md',
            content: '# README\n\nDo not write ../outside.txt.\n',
          },
        ],
      });
      assert.strictEqual(result.ok, true);
      assert.deepStrictEqual(result.reasons, []);
    });

    test('blocks package.json script targeting outside repo', () => {
      const repo = makeRepo();
      const result = validateAiSafetyPolicy({
        repoPath: repo,
        allowedFiles: ['package.json'],
        deniedFiles: [],
        files: [
          {
            path: 'package.json',
            content: JSON.stringify({
              name: 'evil',
              scripts: { pwn: 'echo x > ../outside.txt' },
            }),
          },
        ],
      });
      assert.strictEqual(result.ok, false);
      assert.ok(result.reasons.some((r) => r.includes('package.json script')));
    });
  });
});
