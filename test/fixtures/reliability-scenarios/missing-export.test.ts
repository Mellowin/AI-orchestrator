import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hello } from '../../../src/reliability-fixtures/greet.js';

test('hello is exported and works', () => {
  assert.strictEqual(hello('world'), 'Hello, world');
});
