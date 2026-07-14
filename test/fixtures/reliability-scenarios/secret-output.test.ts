import { test } from 'node:test';
import assert from 'node:assert/strict';
import { providerNote } from '../../../src/reliability-fixtures/secret-output.js';

test('provider note does not expose token-like value', () => {
  const note = providerNote();
  assert.ok(!/github_pat_[a-zA-Z0-9_]{20,}/.test(note), 'token-like string exposed');
  assert.ok(note.includes('[REDACTED]'));
});
