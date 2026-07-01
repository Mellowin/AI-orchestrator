import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const testDir = join(process.cwd(), 'test');
const excluded = new Set(['verify-testing-summary.test.ts']);

const files = readdirSync(testDir)
  .filter((name) => name.endsWith('.test.ts') && !excluded.has(name))
  .map((name) => join('test', name));

if (files.length === 0) {
  console.error('No validation test files found');
  process.exit(1);
}

const tsxPath = join(process.cwd(), 'node_modules', 'tsx', 'dist', 'cli.mjs');

const result = spawnSync(
  process.execPath,
  [tsxPath, '--test', ...files],
  {
    cwd: process.cwd(),
    encoding: 'utf-8',
    shell: false,
    stdio: 'inherit',
  }
);

process.exit(result.status ?? 1);
