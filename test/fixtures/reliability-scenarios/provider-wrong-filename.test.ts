import { test } from 'node:test';
import assert from 'node:assert/strict';
import { suggestFile } from '../../../src/reliability-fixtures/provider-output.js';

test('suggested file is within allowed scope', () => {
  const allowed = ['docs/proofs/ALLOWED.md'];
  assert.ok(allowed.includes(suggestFile()), `unexpected file: ${suggestFile()}`);
});
