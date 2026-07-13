import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getChildEnvValue } from '../../../src/reliability-fixtures/env-runner.js';

test('child process does not inherit SECRET_VAR', () => {
  process.env.SECRET_VAR = 'should-not-leak';
  try {
    const value = getChildEnvValue('SECRET_VAR');
    assert.strictEqual(value, undefined);
  } finally {
    delete process.env.SECRET_VAR;
  }
});
