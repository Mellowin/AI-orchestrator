import { test } from 'node:test';
import assert from 'node:assert/strict';
import { quotePath } from '../../../src/reliability-fixtures/paths.js';

test('quotePath quotes paths with spaces', () => {
  assert.strictEqual(quotePath('C:\\My Folder\\file.txt'), '"C:\\My Folder\\file.txt"');
});
