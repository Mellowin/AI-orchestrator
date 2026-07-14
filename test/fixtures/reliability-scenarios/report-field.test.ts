import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSummary } from '../../../src/reliability-fixtures/report.js';

test('report summary has durationMs field', () => {
  const summary = buildSummary('ok', 100);
  assert.strictEqual(summary.durationMs, 100);
});
