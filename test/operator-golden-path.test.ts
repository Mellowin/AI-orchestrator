import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const PROJECT_ROOT = process.cwd();
const SCRIPT_PATH = join(PROJECT_ROOT, 'scripts', 'run-operator-golden-path.mjs');
const PACKAGE_PATH = join(PROJECT_ROOT, 'package.json');

const FORBIDDEN_PATTERNS = [
  'git push',
  'git commit',
  'git merge',
  'git checkout',
  'git switch',
  'ALLOW_REAL_PROVIDER',
  'KIMI_API_KEY',
  'REAL_REPO_PROVIDER_RESPONSE',
];

describe('operator-golden-path', () => {
  test('golden path script exists', () => {
    assert(existsSync(SCRIPT_PATH), `Expected script to exist: ${SCRIPT_PATH}`);
  });

  test('golden path script does not contain forbidden commands or opt-ins', () => {
    const scriptContent = readFileSync(SCRIPT_PATH, 'utf-8');
    for (const pattern of FORBIDDEN_PATTERNS) {
      assert(
        !scriptContent.includes(pattern),
        `Forbidden pattern "${pattern}" found in ${SCRIPT_PATH}`
      );
    }
  });

  test('package.json contains demo:operator-golden-path script', () => {
    const pkg = JSON.parse(readFileSync(PACKAGE_PATH, 'utf-8'));
    assert(typeof pkg.scripts === 'object' && pkg.scripts !== null, 'package.json scripts missing');
    assert(
      typeof pkg.scripts['demo:operator-golden-path'] === 'string',
      'package.json is missing demo:operator-golden-path script'
    );
    assert(
      pkg.scripts['demo:operator-golden-path'].includes('run-operator-golden-path.mjs'),
      'demo:operator-golden-path script does not point to run-operator-golden-path.mjs'
    );
  });
});
