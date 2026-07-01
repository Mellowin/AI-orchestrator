import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const WORKFLOW_PATH = join(process.cwd(), '.github', 'workflows', 'ci.yml');

describe('operator-golden-path-ci', () => {
  test('ci.yml exists', () => {
    assert(existsSync(WORKFLOW_PATH), `Expected workflow to exist: ${WORKFLOW_PATH}`);
  });

  test('operator-golden-path-smoke job exists and depends on checks', () => {
    const workflow = readFileSync(WORKFLOW_PATH, 'utf-8');
    assert(workflow.includes('operator-golden-path-smoke:'), 'Missing operator-golden-path-smoke job');
    assert(workflow.includes('needs: checks'), 'operator-golden-path-smoke must depend on checks');
  });

  test('operator-golden-path-smoke job runs npm run demo:operator-golden-path', () => {
    const workflow = readFileSync(WORKFLOW_PATH, 'utf-8');
    assert(
      workflow.includes('npm run demo:operator-golden-path'),
      'operator-golden-path-smoke must run npm run demo:operator-golden-path'
    );
  });

  test('operator-golden-path-smoke job checks out full git history', () => {
    const workflow = readFileSync(WORKFLOW_PATH, 'utf-8');
    assert(workflow.includes('fetch-depth: 0'), 'operator-golden-path-smoke must use fetch-depth: 0');
  });

  test('operator-golden-path-smoke job does not use continue-on-error', () => {
    const workflow = readFileSync(WORKFLOW_PATH, 'utf-8');
    assert(
      !workflow.includes('continue-on-error'),
      'operator-golden-path-smoke must not use continue-on-error'
    );
  });
});
