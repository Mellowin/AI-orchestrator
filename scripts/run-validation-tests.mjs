import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const PROJECT_ROOT = process.cwd();
const CHUNK_RUNNER = join(PROJECT_ROOT, 'scripts', 'run-test-chunks.mjs');

const result = spawnSync(
  process.execPath,
  [
    CHUNK_RUNNER,
    '--exclude',
    'verify-testing-summary.test.ts',
    '--chunk-timeout-ms',
    '600000',
    '--output-dir',
    join(PROJECT_ROOT, 'tmp', 'validation-test-logs'),
  ],
  {
    cwd: PROJECT_ROOT,
    encoding: 'utf-8',
    shell: false,
    stdio: 'inherit',
  }
);

process.exit(result.status ?? 1);
