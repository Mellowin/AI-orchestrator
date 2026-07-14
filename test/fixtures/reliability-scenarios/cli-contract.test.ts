import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SUPPORTED_COMMANDS } from '../../../src/reliability-fixtures/cli-commands.js';

test('reliability-run command is present', () => {
  assert.ok(SUPPORTED_COMMANDS.includes('reliability-run'));
});
