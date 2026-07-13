import { test } from 'node:test';
import assert from 'node:assert/strict';
import { double } from '../../../src/reliability-fixtures/typed.js';

test('double returns a number', () => {
  const result = double(2);
  assert.strictEqual(typeof result, 'number');
  assert.strictEqual(result, 4);
});
