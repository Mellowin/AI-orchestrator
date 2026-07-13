import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';

const PROJECT_ROOT = process.cwd();
const EXAMPLE_CONFIG = join(PROJECT_ROOT, 'configs', 'autopilot-run.example.json');

function runCli(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(
    process.execPath,
    [join(PROJECT_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs'), 'src/autopilot-run/index.ts', ...args],
    {
      cwd: PROJECT_ROOT,
      encoding: 'utf-8',
      shell: false,
      env: { ...process.env, AI_PROVIDER: 'mock', GITHUB_TOKEN: '' },
    }
  );
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

describe('autopilot-run CLI', () => {
  test('runs example config in safe fake mode and produces report', () => {
    const result = runCli([EXAMPLE_CONFIG]);
    const combined = `${result.stdout}\n${result.stderr}`;

    assert.strictEqual(result.status, 0, `Expected exit 0, got ${result.status}. Output:\n${combined}`);
    assert(combined.includes('AUTOPILOT_MVP_DONE_CI_NOT_OBSERVED'), `Expected done-not-observed verdict in output:\n${combined}`);
    assert(combined.includes('AUTOPILOT RUN'), `Expected header in output:\n${combined}`);
    assert(combined.includes('Token present:'), `Expected token presence in output:\n${combined}`);

    const reportDir = resolve(PROJECT_ROOT, 'reports', 'autopilot', 'autopilot-demo');
    const reportMd = join(reportDir, 'report.md');
    const reportJson = join(reportDir, 'report.json');
    const timelineJson = join(reportDir, 'timeline.json');

    assert(existsSync(reportMd), `Expected report.md at ${reportMd}`);
    assert(existsSync(reportJson), `Expected report.json at ${reportJson}`);
    assert(existsSync(timelineJson), `Expected timeline.json at ${timelineJson}`);

    const reportContent = readFileSync(reportMd, 'utf-8');
    assert(reportContent.includes('Autopilot Run Report'), 'Report should have a title');
    assert(reportContent.includes('repo.status.read'), 'Report should list requested capabilities');
    assert(reportContent.includes('github.merge'), 'Report should list forbidden capabilities');
    assert(!reportContent.includes('ghp_'), 'Report must not contain GitHub token patterns');

    rmSync(reportDir, { recursive: true, force: true });
  });

  test('returns clean error when config path is missing', () => {
    const result = runCli([]);
    const combined = `${result.stdout}\n${result.stderr}`;

    assert.strictEqual(result.status, 1, `Expected exit 1, got ${result.status}`);
    assert(combined.includes('config JSON path is required'), `Expected missing config error:\n${combined}`);
    assert(combined.includes('No provider call was made'), `Expected safety note:\n${combined}`);
    assert(combined.includes('No merge was performed'), `Expected merge safety note:\n${combined}`);
  });

  test('returns clean error for missing config file', () => {
    const result = runCli([join(PROJECT_ROOT, 'tmp', 'nonexistent-autopilot-config.json')]);
    const combined = `${result.stdout}\n${result.stderr}`;

    assert.strictEqual(result.status, 1, `Expected exit 1, got ${result.status}`);
    assert(combined.includes('not found') || combined.includes('unreadable'), `Expected unreadable config error:\n${combined}`);
  });
});
