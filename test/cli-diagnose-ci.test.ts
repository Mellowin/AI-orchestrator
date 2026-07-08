import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';

const PROJECT_ROOT = process.cwd();
const EXAMPLE_CONFIG = join(PROJECT_ROOT, 'configs', 'diagnose-ci.example.json');

function runCli(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(
    process.execPath,
    [join(PROJECT_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs'), 'src/cli.ts', 'diagnose-ci', ...args],
    {
      cwd: PROJECT_ROOT,
      encoding: 'utf-8',
      shell: false,
      env: { ...process.env, GITHUB_TOKEN: '' },
    }
  );
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

describe('diagnose-ci CLI', () => {
  test('runs fake example config and produces DIAGNOSE_CI_GREEN reports', () => {
    const result = runCli([EXAMPLE_CONFIG]);
    const combined = `${result.stdout}\n${result.stderr}`;

    assert.strictEqual(result.status, 0, `Expected exit 0, got ${result.status}. Output:\n${combined}`);
    assert(combined.includes('DIAGNOSE_CI_GREEN'), `Expected green verdict in output:\n${combined}`);
    assert(combined.includes('Classification: CI_GREEN'), `Expected classification in output:\n${combined}`);

    const reportDir = resolve(PROJECT_ROOT, 'reports', 'diagnostics', '123456789');
    const reportMd = join(reportDir, 'report.md');
    const reportJson = join(reportDir, 'report.json');
    const fixTaskMd = join(reportDir, 'fix-task.md');
    const fixTaskJson = join(reportDir, 'fix-task.json');

    assert(existsSync(reportMd), `Expected report.md at ${reportMd}`);
    assert(existsSync(reportJson), `Expected report.json at ${reportJson}`);
    assert(existsSync(fixTaskMd), `Expected fix-task.md at ${fixTaskMd}`);
    assert(existsSync(fixTaskJson), `Expected fix-task.json at ${fixTaskJson}`);

    const reportContent = readFileSync(reportMd, 'utf-8');
    assert(reportContent.includes('CI Diagnostic Report'), 'Report should have a title');
    assert(reportContent.includes('github.pr.read'), 'Report should list requested capabilities');
    assert(reportContent.includes('github.merge'), 'Report should list forbidden capabilities');
    assert(!reportContent.includes('ghp_'), 'Report must not contain GitHub token patterns');

    // Cleanup the generated reports so they do not accumulate across test runs.
    rmSync(reportDir, { recursive: true, force: true });
  });

  test('returns clean error when config path is missing', () => {
    const result = runCli([]);
    const combined = `${result.stdout}\n${result.stderr}`;

    assert.strictEqual(result.status, 1, `Expected exit 1, got ${result.status}`);
    assert(combined.includes('config JSON path is required'), `Expected missing config error:\n${combined}`);
    assert(combined.includes('No GitHub API call was made'), `Expected safety note:\n${combined}`);
  });

  test('returns clean error for missing config file', () => {
    const result = runCli([join(PROJECT_ROOT, 'tmp', 'nonexistent-diagnose-ci-config.json')]);
    const combined = `${result.stdout}\n${result.stderr}`;

    assert.strictEqual(result.status, 1, `Expected exit 1, got ${result.status}`);
    assert(combined.includes('not found or unreadable'), `Expected unreadable config error:\n${combined}`);
  });
});
