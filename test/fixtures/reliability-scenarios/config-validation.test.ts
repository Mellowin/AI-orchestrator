import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

test('config has required timeout field', () => {
  const raw = readFileSync(join(process.cwd(), 'test/fixtures/reliability-scenarios/config.json'), 'utf-8');
  const config = JSON.parse(raw) as Record<string, unknown>;
  assert.strictEqual(typeof config.timeout, 'number');
  assert.ok(config.timeout !== undefined);
});
