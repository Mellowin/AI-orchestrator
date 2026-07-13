import { test } from 'node:test';
import assert from 'node:assert/strict';
import { helperValue } from '../../../src/reliability-fixtures/missing-helper.js';

test('helper value is correct', () => {
  assert.strictEqual(helperValue(), 42);
});
