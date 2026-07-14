import { test } from 'node:test';
import assert from 'node:assert/strict';
import pkg from '../../../package.json' assert { type: 'json' };

test('package.json has reliability script', () => {
  assert.ok(typeof pkg.scripts.reliability === 'string');
  assert.ok(pkg.scripts.reliability.includes('reliability-run'));
});
