import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { validateTestingSummary } from '../scripts/verify-testing-summary.mjs';

const HEAD_SHA = '4f038950ca2790828310558a65caf163400426b7';
const STALE_SHA = '15943265c3f083b9c48cdcb437cec41f9527fec7';

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
    assert(result.stdout.includes(`current HEAD: ${HEAD_SHA}`));
  });

  test('validateTestingSummary fails when Last verified does not match HEAD', () => {
    const result = validateTestingSummary({
      summaryText: validSummary(STALE_SHA),
      headSha: HEAD_SHA,
      root: process.cwd(),
    });
    assert.strictEqual(result.ok, false, 'Expected validation to fail for stale Last verified');
    assert(
      result.errors.some((e) => e.includes('Last verified') && e.includes('does not match current HEAD')),
      `Expected HEAD mismatch error, got: ${result.errors.join('; ')}`
    );
  });

  test('validateTestingSummary fails when Last verified commit does not match HEAD', () => {
    const summary = `# MVP Test Hardening Summary**Last verified:** \`${HEAD_SHA}\`## Test metrics- **Last verified commit:** \`${STALE_SHA}\` (Stage 17.14)## Documentation stages`;
    const result = validateTestingSummary({
      summaryText: summary,
      headSha: HEAD_SHA,
      root: process.cwd(),
    });
    assert.strictEqual(result.ok, false);
    assert(
      result.errors.some((e) => e.includes('Last verified commit') && e.includes('does not match current HEAD')),
      `Expected Last verified commit mismatch error, got: ${result.errors.join('; ')}`
    );
  });

  test('validateTestingSummary passes when summary matches HEAD', () => {
    const result = validateTestingSummary({
      summaryText: validSummary(HEAD_SHA),
      headSha: HEAD_SHA,
      root: process.cwd(),
    });
    assert.strictEqual(result.ok, true, `Expected validation to pass, got: ${result.errors.join('; ')}`);
  });
});
