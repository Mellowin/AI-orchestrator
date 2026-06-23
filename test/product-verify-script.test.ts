import { describe, test } from 'node:test';
import assert from 'node:assert';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const PACKAGE_JSON_PATH = join(process.cwd(), 'package.json');
const README_PATH = join(process.cwd(), 'README.md');
const QUICKSTART_PATH = join(process.cwd(), 'docs', 'REAL_BLOCK_RUN_QUICKSTART.md');

function readPackage(): { scripts?: Record<string, string> } {
  return JSON.parse(readFileSync(PACKAGE_JSON_PATH, 'utf-8'));
}

describe('product verification script', () => {
  test('package.json contains verify:product script', () => {
    const pkg = readPackage();
    assert.ok(pkg.scripts, 'package.json must have scripts');
    assert.strictEqual(typeof pkg.scripts['verify:product'], 'string');
  });

  test('verify:product includes typecheck', () => {
    const pkg = readPackage();
    const script = pkg.scripts?.['verify:product'] ?? '';
    assert.match(script, /npm run typecheck/);
  });

  test('verify:product includes build', () => {
    const pkg = readPackage();
    const script = pkg.scripts?.['verify:product'] ?? '';
    assert.match(script, /npm run build/);
  });

  test('verify:product includes test:chunks', () => {
    const pkg = readPackage();
    const script = pkg.scripts?.['verify:product'] ?? '';
    assert.match(script, /npm run test:chunks/);
  });

  test('verify:product includes demo:block:fake', () => {
    const pkg = readPackage();
    const script = pkg.scripts?.['verify:product'] ?? '';
    assert.match(script, /npm run demo:block:fake/);
  });

  test('README mentions verify:product', () => {
    assert.ok(existsSync(README_PATH), 'README.md must exist');
    const readme = readFileSync(README_PATH, 'utf-8');
    assert.match(readme, /npm run verify:product/);
  });

  test('quickstart mentions verify:product', () => {
    assert.ok(existsSync(QUICKSTART_PATH), 'REAL_BLOCK_RUN_QUICKSTART.md must exist');
    const doc = readFileSync(QUICKSTART_PATH, 'utf-8');
    assert.match(doc, /npm run verify:product/);
  });
});
