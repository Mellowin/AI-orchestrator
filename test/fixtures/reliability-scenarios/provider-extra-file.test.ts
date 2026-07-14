import { test } from 'node:test';
import assert from 'node:assert/strict';
import { suggestFiles } from '../../../src/reliability-fixtures/provider-files.js';

test('suggested files are within allowed scope', () => {
  const allowed = ['docs/proofs/ALLOWED.md'];
  const files = suggestFiles();
  for (const file of files) {
    assert.ok(allowed.includes(file), `unexpected file: ${file}`);
  }
});
