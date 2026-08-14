import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runIntegratedValidation } from '../src/autopilot-one-click/multitask/integrated-validator.js';

let counter = 0;

function createTempRepo(): string {
  const tmpBase = join(process.cwd(), 'tmp');
  if (!existsSync(tmpBase)) {
    mkdirSync(tmpBase);
  }
  const tmpDir = mkdtempSync(join(tmpBase, `integrated-validator-${Date.now()}-${counter++}-`));
  const repoPath = join(tmpDir, 'repo');
  mkdirSync(repoPath);

  spawnSync('git', ['init'], { cwd: repoPath, encoding: 'utf-8', shell: false });
  spawnSync('git', ['config', 'user.email', 'ci@example.com'], { cwd: repoPath, encoding: 'utf-8', shell: false });
  spawnSync('git', ['config', 'user.name', 'CI User'], { cwd: repoPath, encoding: 'utf-8', shell: false });

  // Minimal package.json with the verify:summary script the validator discovers.
  writeFileSync(
    join(repoPath, 'package.json'),
    JSON.stringify({
      name: 'temp-repo',
      version: '0.0.1',
      scripts: {
        'verify:summary': 'node scripts/verify-testing-summary.mjs',
        'verify:product': 'echo ok',
        'verify:product:ci': 'echo ok',
        'test:chunks:product': 'echo ok',
        'test:chunks:product:ci': 'echo ok',
      },
    }),
    'utf-8'
  );

  // Copy the real verifier so behavior matches production.
  const realVerifier = readFileSync(join(process.cwd(), 'scripts', 'verify-testing-summary.mjs'), 'utf-8');
  mkdirSync(join(repoPath, 'scripts'));
  writeFileSync(join(repoPath, 'scripts', 'verify-testing-summary.mjs'), realVerifier, 'utf-8');

  // Required workflow file.
  mkdirSync(join(repoPath, '.github', 'workflows'), { recursive: true });
  writeFileSync(
    join(repoPath, '.github', 'workflows', 'product-verify.yml'),
    'on:\n  workflow_dispatch:\n',
    'utf-8'
  );

  // Initial TESTING_SUMMARY.md locked to the initial commit.
  writeFileSync(
    join(repoPath, 'TESTING_SUMMARY.md'),
    '# Summary\n\n**Last verified:** `INITIAL_SHA_PLACEHOLDER`\n\n## Test metrics\n\n- **Last verified commit:** `INITIAL_SHA_PLACEHOLDER`\n',
    'utf-8'
  );

  spawnSync('git', ['add', '.'], { cwd: repoPath, encoding: 'utf-8', shell: false });
  spawnSync('git', ['commit', '-m', 'init', '--no-gpg-sign'], { cwd: repoPath, encoding: 'utf-8', shell: false });

  const headResult = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repoPath, encoding: 'utf-8', shell: false });
  const headSha = headResult.stdout.trim();
  const summary = readFileSync(join(repoPath, 'TESTING_SUMMARY.md'), 'utf-8')
    .replace(/INITIAL_SHA_PLACEHOLDER/g, headSha);
  writeFileSync(join(repoPath, 'TESTING_SUMMARY.md'), summary, 'utf-8');
  spawnSync('git', ['add', 'TESTING_SUMMARY.md'], { cwd: repoPath, encoding: 'utf-8', shell: false });
  spawnSync('git', ['commit', '-m', 'lock summary', '--no-gpg-sign'], { cwd: repoPath, encoding: 'utf-8', shell: false });

  return repoPath;
}

describe('integrated-validator', () => {
  test('passes when TESTING_SUMMARY is locked to HEAD and no other files changed', () => {
    const repoPath = createTempRepo();
    const result = runIntegratedValidation(repoPath);
    assert.strictEqual(result.ok, true, `Expected validation to pass: ${result.output}`);
    assert.strictEqual(result.classification, 'success');
    rmSync(repoPath, { recursive: true, force: true });
  });

  test('classifies TESTING_SUMMARY non-summary failure as REPAIRABLE_REPOSITORY_FAILURE', () => {
    const repoPath = createTempRepo();

    // Add a non-summary file after the lock.
    mkdirSync(join(repoPath, 'docs'), { recursive: true });
    writeFileSync(join(repoPath, 'docs', 'new.md'), '# new doc\n', 'utf-8');
    spawnSync('git', ['add', 'docs/new.md'], { cwd: repoPath, encoding: 'utf-8', shell: false });
    spawnSync('git', ['commit', '-m', 'add doc', '--no-gpg-sign'], { cwd: repoPath, encoding: 'utf-8', shell: false });

    const result = runIntegratedValidation(repoPath);
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.classification, 'REPAIRABLE_REPOSITORY_FAILURE');
    assert(Array.isArray(result.changedFiles));
    assert(result.changedFiles?.includes('docs/new.md'));
    assert.deepStrictEqual(result.maintenanceFiles, ['TESTING_SUMMARY.md']);
    assert(result.output.includes('Non-summary files changed'));

    rmSync(repoPath, { recursive: true, force: true });
  });

  test('classifies an unknown validation failure as EXTERNAL_BLOCKER', () => {
    const repoPath = createTempRepo();
    const result = runIntegratedValidation(repoPath, { command: 'node -e process.exit(1)' });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.classification, 'EXTERNAL_BLOCKER');
    rmSync(repoPath, { recursive: true, force: true });
  });
});
