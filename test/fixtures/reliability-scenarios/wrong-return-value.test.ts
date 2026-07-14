import { test } from 'node:test';
import assert from 'node:assert/strict';
import { add } from '../../../src/reliability-fixtures/math.js';

test('add returns correct sum', () => {
  assert.strictEqual(add(2, 2), 4);
});
