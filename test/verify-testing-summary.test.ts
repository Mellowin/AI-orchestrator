import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { validateTestingSummary } from '../scripts/verify-testing-summary.mjs';

const STALE_SHA = '15943265c3f083b9c48cdcb437cec41f9527fec7';

function getActualHead(): string {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], {
    cwd: process.cwd(),
    encoding: 'utf-8',
    shell: false,
  });
  if (result.status !== 0) {
    throw new Error('Failed to read current HEAD');
  }
  return result.stdout.trim();
}

function getActualHeadParent(): string {
  const result = spawnSync('git', ['rev-parse', 'HEAD~1'], {
    cwd: process.cwd(),
    encoding: 'utf-8',
    shell: false,
  });
  if (result.status !== 0) {
    throw new Error('Failed to read HEAD~1');
  }
  return result.stdout.trim();
}

function validSummary(headSha: string): string {
  return `# MVP Test Hardening Summary**Branch:** \`main\`**Last verified:** \`${headSha}\`## Test metrics- **Last verified commit:** \`${headSha}\` (Stage 17.14)- **GitHub CI:** verified successful — Mini-MVP CI run \`421\` completed with \`success\` on \`${headSha}\`- **Product verification:** manual-only (\`workflow_dispatch\`); latest heavy run \`75\` completed with \`success\` and verified \`10d4a9afb6ad3bdcb73f79b24040136baff47a8e\`- **Debug markers:** none (DEBUG_CHUNK2, CHECK_DEBUG absent)## Documentation stages| Stage | Description | Commit ||---|---|---|`;
}

function runCli(): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [join(process.cwd(), 'scripts', 'verify-testing-summary.mjs')], {
    cwd: process.cwd(),
    encoding: 'utf-8',
    shell: false,
  });
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

describe('verify-testing-summary', () => {
  test('CLI passes on current project evidence', () => {
    const result = runCli();
    assert.strictEqual(result.status, 0, `Verifier failed: ${result.stderr}`);
    assert(result.stdout.includes('TESTING_SUMMARY verification passed'));
  });

  test('validateTestingSummary fails when Last verified does not match HEAD or HEAD~1', () => {
    const head = getActualHead();
    const result = validateTestingSummary({
      summaryText: validSummary(STALE_SHA),
      headSha: head,
      root: process.cwd(),
    });
    assert.strictEqual(result.ok, false, 'Expected validation to fail for stale Last verified');
    assert(
      result.errors.some((e) => e.includes('Last verified') && e.includes('does not match current HEAD')),
      `Expected HEAD mismatch error, got: ${result.errors.join('; ')}`
    );
  });

  test('validateTestingSummary fails when Last verified commit does not match HEAD or HEAD~1', () => {
    const head = getActualHead();
    const summary = `# MVP Test Hardening Summary**Last verified:** \`${head}\`## Test metrics- **Last verified commit:** \`${STALE_SHA}\` (Stage 17.14)## Documentation stages`;
    const result = validateTestingSummary({
      summaryText: summary,
      headSha: head,
      root: process.cwd(),
    });
    assert.strictEqual(result.ok, false);
    assert(
      result.errors.some((e) => e.includes('Last verified commit') && e.includes('does not match current HEAD')),
      `Expected Last verified commit mismatch error, got: ${result.errors.join('; ')}`
    );
  });

  test('validateTestingSummary passes when summary matches HEAD', () => {
    const head = getActualHead();
    const result = validateTestingSummary({
      summaryText: validSummary(head),
      headSha: head,
      root: process.cwd(),
    });
    assert.strictEqual(result.ok, true, `Expected validation to pass, got: ${result.errors.join('; ')}`);
    assert.strictEqual(result.matchedHead, true);
    assert.strictEqual(result.matchedParent, false);
  });

  test('validateTestingSummary passes when Last verified is HEAD~1 and current commit is docs-only', () => {
    const head = getActualHead();
    const parent = getActualHeadParent();
    const result = validateTestingSummary({
      summaryText: validSummary(parent),
      headSha: head,
      root: process.cwd(),
      parentFiles: ['TESTING_SUMMARY.md'],
    });
    assert.strictEqual(result.ok, true, `Expected validation to pass, got: ${result.errors.join('; ')}`);
    assert.strictEqual(result.matchedHead, false);
    assert.strictEqual(result.matchedParent, true);
  });

  test('validateTestingSummary fails when Last verified is HEAD~1 but current commit changes non-summary files', () => {
    const head = getActualHead();
    const parent = getActualHeadParent();
    const result = validateTestingSummary({
      summaryText: validSummary(parent),
      headSha: head,
      root: process.cwd(),
      parentFiles: ['scripts/verify-testing-summary.mjs', 'TESTING_SUMMARY.md'],
    });
    assert.strictEqual(result.ok, false, 'Expected validation to fail for non-docs HEAD~1 evidence');
    assert(
      result.errors.some((e) => e.includes('not docs-only') && e.includes('scripts/verify-testing-summary.mjs')),
      `Expected docs-only error, got: ${result.errors.join('; ')}`
    );
  });

  test('validateTestingSummary fails when Last verified is HEAD~1 but current commit changes test files', () => {
    const head = getActualHead();
    const parent = getActualHeadParent();
    const result = validateTestingSummary({
      summaryText: validSummary(parent),
      headSha: head,
      root: process.cwd(),
      parentFiles: ['test/verify-testing-summary.test.ts'],
    });
    assert.strictEqual(result.ok, false, 'Expected validation to fail for test-only HEAD~1 evidence');
    assert(
      result.errors.some((e) => e.includes('not docs-only') && e.includes('test/verify-testing-summary.test.ts')),
      `Expected docs-only error, got: ${result.errors.join('; ')}`
    );
  });
});
