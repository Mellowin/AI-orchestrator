import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

test('doc contract has required section', () => {
  const content = readFileSync(join(process.cwd(), 'test/fixtures/reliability-scenarios/doc-contract.md'), 'utf-8');
  assert.ok(content.includes('## Required Section'));
  assert.ok(content.includes('- item 1'));
});
