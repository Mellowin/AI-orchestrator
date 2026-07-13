import { describe, test } from 'node:test';
import assert from 'node:assert';
import { parseLog } from '../src/diagnose-ci/log-parser.js';
import { buildFakeWorkflowBundle } from '../src/diagnose-ci/github-client.js';

describe('diagnose-ci log-parser', () => {
  test('extracts failed test file, subtest, and assertion from fake red log', () => {
    const bundle = buildFakeWorkflowBundle('red');
    const log = Object.values(bundle.logs)[0];
    const result = parseLog(log);

    assert.strictEqual(result.failedTestFiles.length, 1, 'expected one failed test file');
    const failure = result.failedTestFiles[0];
    assert.strictEqual(failure.file, 'test/verify-testing-summary.test.ts');
    assert.strictEqual(
      failure.subtest,
      'CLI passes on current project evidence'
    );
    assert.ok(failure.message, 'expected failure message');
    assert.strictEqual(failure.expected, '0');
    assert.strictEqual(failure.actual, '1');
    assert.ok(failure.location, 'expected location');
    assert.ok(failure.stack, 'expected stack');
  });

  test('detects stale TESTING_SUMMARY lock', () => {
    const bundle = buildFakeWorkflowBundle('red');
    const log = Object.values(bundle.logs)[0];
    const result = parseLog(log);

    assert.ok(result.summaryLock, 'expected summaryLock');
    assert.strictEqual(result.summaryLock?.staleCommit, 'deadbeef');
    assert.strictEqual(result.summaryLock?.changedFile, 'test/cli-mvp-run.test.ts');
    assert.ok(
      (result.summaryLock?.message ?? '').includes('TESTING_SUMMARY'),
      'expected TESTING_SUMMARY in lock message'
    );
  });

  test('detects chunk runner totals', () => {
    const bundle = buildFakeWorkflowBundle('red');
    const log = Object.values(bundle.logs)[0];
    const result = parseLog(log);

    assert.ok(result.chunkRunner, 'expected chunkRunner');
    assert.strictEqual(result.chunkRunner?.totalTests, 3674);
    assert.strictEqual(result.chunkRunner?.totalSuites, 217);
    assert.strictEqual(result.chunkRunner?.pass, 3673);
    assert.strictEqual(result.chunkRunner?.fail, 1);
    assert.strictEqual(result.chunkRunner?.cancelled, 0);
    assert.strictEqual(result.chunkRunner?.skipped, 0);
    assert.ok(result.chunkRunner?.rawLine?.startsWith('TOTAL:'));
  });

  test('detects timeout keywords in log', () => {
    const log = [
      'Run npm test',
      'Warning: job exceeded time limit of 10 minutes',
      'Error: the step was cancelled by the runner',
    ].join('\n');
    const result = parseLog(log);

    assert.strictEqual(result.timeouts.length, 2, 'expected two timeout matches');
    assert.ok(result.timeouts.some((line) => /exceeded time/i.test(line)));
    assert.ok(result.timeouts.some((line) => /cancelled/i.test(line)));
  });

  test('truncates raw excerpt to max chars', () => {
    const log = 'a'.repeat(10000);
    const result = parseLog(log, 500);
    assert.strictEqual(result.rawExcerpt.length, 500);
  });
});
