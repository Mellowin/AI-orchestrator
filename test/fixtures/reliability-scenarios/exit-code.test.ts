import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mapExitCode } from '../../../src/reliability-fixtures/exit-codes.js';

test('mapExitCode maps non-zero to 1', () => {
  assert.strictEqual(mapExitCode(0), 0);
  assert.strictEqual(mapExitCode(2), 1);
});
