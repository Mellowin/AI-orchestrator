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

function isAncestorOfHead(sha: string, head: string): boolean {
  const result = spawnSync('git', ['merge-base', '--is-ancestor', sha, head], {
    cwd: process.cwd(),
    encoding: 'utf-8',
    shell: false,
  });
  return result.status === 0;
}

function validSummary(verifiedSha: string): string {
  return `# MVP Test Hardening Summary**Branch:** \`main\`**Last verified:** \`${verifiedSha}\`## Test metrics- **Last verified commit:** \`${verifiedSha}\` (Stage 17.15)- **GitHub CI:** verified successful — Mini-MVP CI run \`421\` completed with \`success\` on \`${verifiedSha}\`- **Product verification:** manual-only (\`workflow_dispatch\`); latest heavy run \`75\` completed with \`success\` and verified \`10d4a9afb6ad3bdcb73f79b24040136baff47a8e\`- **Debug markers:** none (DEBUG_CHUNK2, CHECK_DEBUG absent)## Documentation stages| Stage | Description | Commit ||---|---|---|`;
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

  test('validateTestingSummary passes when Last verified equals HEAD and there are no changes after it', () => {
    const head = getActualHead();
    const result = validateTestingSummary({
      summaryText: validSummary(head),
      headSha: head,
      root: process.cwd(),
      verifiedShaAncestorOfHead: true,
      changedFilesAfterVerified: [],
    });
    assert.strictEqual(result.ok, true, `Expected validation to pass, got: ${result.errors.join('; ')}`);
    assert.strictEqual(result.verifiedSha, head);
  });

  test('validateTestingSummary passes when Last verified is an ancestor and only TESTING_SUMMARY.md changed after it', () => {
    const head = getActualHead();
    const verifiedSha = '659363509d633971b6431311abfd31c03b3b39cb';
    assert(
      isAncestorOfHead(verifiedSha, head),
      `Expected ${verifiedSha} to be an ancestor of current HEAD ${head} for this test fixture`
    );
    const result = validateTestingSummary({
      summaryText: validSummary(verifiedSha),
      headSha: head,
      root: process.cwd(),
      verifiedShaAncestorOfHead: true,
      changedFilesAfterVerified: ['TESTING_SUMMARY.md'],
    });
    assert.strictEqual(result.ok, true, `Expected validation to pass, got: ${result.errors.join('; ')}`);
    assert.strictEqual(result.verifiedSha, verifiedSha);
  });

  test('validateTestingSummary passes with multiple summary-only commits after verified SHA', () => {
    const head = getActualHead();
    const verifiedSha = '659363509d633971b6431311abfd31c03b3b39cb';
    const result = validateTestingSummary({
      summaryText: validSummary(verifiedSha),
      headSha: head,
      root: process.cwd(),
      verifiedShaAncestorOfHead: true,
      changedFilesAfterVerified: ['TESTING_SUMMARY.md', 'TESTING_SUMMARY.md', 'TESTING_SUMMARY.md'],
    });
    assert.strictEqual(result.ok, true, `Expected validation to pass, got: ${result.errors.join('; ')}`);
  });

  test('validateTestingSummary fails when Last verified is not an ancestor of HEAD', () => {
    const head = getActualHead();
    const result = validateTestingSummary({
      summaryText: validSummary(STALE_SHA),
      headSha: head,
      root: process.cwd(),
      verifiedShaAncestorOfHead: false,
      changedFilesAfterVerified: [],
    });
    assert.strictEqual(result.ok, false, 'Expected validation to fail when verified SHA is not an ancestor');
    assert(
      result.errors.some((e) => e.includes('not an ancestor')),
      `Expected ancestor error, got: ${result.errors.join('; ')}`
    );
  });

  test('validateTestingSummary fails when non-summary files changed after verified SHA', () => {
    const head = getActualHead();
    const verifiedSha = '659363509d633971b6431311abfd31c03b3b39cb';
    const result = validateTestingSummary({
      summaryText: validSummary(verifiedSha),
      headSha: head,
      root: process.cwd(),
      verifiedShaAncestorOfHead: true,
      changedFilesAfterVerified: ['scripts/run-operator-golden-path.mjs'],
    });
    assert.strictEqual(result.ok, false, 'Expected validation to fail for non-summary changes after verified SHA');
    assert(
      result.errors.some(
        (e) =>
          e.includes('Non-summary files changed') && e.includes('scripts/run-operator-golden-path.mjs')
      ),
      `Expected non-summary error, got: ${result.errors.join('; ')}`
    );
  });

  test('validateTestingSummary fails when test files changed after verified SHA', () => {
    const head = getActualHead();
    const verifiedSha = '659363509d633971b6431311abfd31c03b3b39cb';
    const result = validateTestingSummary({
      summaryText: validSummary(verifiedSha),
      headSha: head,
      root: process.cwd(),
      verifiedShaAncestorOfHead: true,
      changedFilesAfterVerified: ['test/operator-golden-path.test.ts'],
    });
    assert.strictEqual(result.ok, false, 'Expected validation to fail for test changes after verified SHA');
    assert(
      result.errors.some(
        (e) =>
          e.includes('Non-summary files changed') && e.includes('test/operator-golden-path.test.ts')
      ),
      `Expected non-summary error, got: ${result.errors.join('; ')}`
    );
  });

  test('validateTestingSummary fails when package.json changed after verified SHA', () => {
    const head = getActualHead();
    const verifiedSha = '659363509d633971b6431311abfd31c03b3b39cb';
    const result = validateTestingSummary({
      summaryText: validSummary(verifiedSha),
      headSha: head,
      root: process.cwd(),
      verifiedShaAncestorOfHead: true,
      changedFilesAfterVerified: ['package.json', 'TESTING_SUMMARY.md'],
    });
    assert.strictEqual(result.ok, false, 'Expected validation to fail for package.json change after verified SHA');
    assert(
      result.errors.some(
        (e) => e.includes('Non-summary files changed') && e.includes('package.json')
      ),
      `Expected non-summary error, got: ${result.errors.join('; ')}`
    );
  });

  test('validateTestingSummary fails when Last verified and Last verified commit differ', () => {
    const head = getActualHead();
    const summary = `# MVP Test Hardening Summary**Last verified:** \`${head}\`## Test metrics- **Last verified commit:** \`${STALE_SHA}\` (Stage 17.15)## Documentation stages`;
    const result = validateTestingSummary({
      summaryText: summary,
      headSha: head,
      root: process.cwd(),
      verifiedShaAncestorOfHead: true,
      changedFilesAfterVerified: [],
    });
    assert.strictEqual(result.ok, false, 'Expected validation to fail when Last verified fields differ');
    assert(
      result.errors.some((e) => e.includes('must match')),
      `Expected mismatch error, got: ${result.errors.join('; ')}`
    );
  });

  test('validateTestingSummary fails for missing Last verified SHA', () => {
    const head = getActualHead();
    const summary = `# MVP Test Hardening Summary## Test metrics- **Last verified commit:** \`${head}\` (Stage 17.15)## Documentation stages`;
    const result = validateTestingSummary({
      summaryText: summary,
      headSha: head,
      root: process.cwd(),
    });
    assert.strictEqual(result.ok, false, 'Expected validation to fail for missing Last verified');
    assert(
      result.errors.some((e) => e.includes('missing "Last verified"')),
      `Expected missing Last verified error, got: ${result.errors.join('; ')}`
    );
  });

  test('validateTestingSummary fails for invalid Last verified SHA', () => {
    const head = getActualHead();
    const invalidSha = 'gggggggggggggggggggggggggggggggggggggggg';
    const summary = `# MVP Test Hardening Summary**Last verified:** \`${invalidSha}\`## Test metrics- **Last verified commit:** \`${invalidSha}\` (Stage 17.15)## Documentation stages`;
    const result = validateTestingSummary({
      summaryText: summary,
      headSha: head,
      root: process.cwd(),
    });
    assert.strictEqual(result.ok, false, 'Expected validation to fail for invalid SHA');
    assert(
      result.errors.some((e) => e.includes('not a valid 40-char SHA')),
      `Expected invalid SHA error, got: ${result.errors.join('; ')}`
    );
  });
});
