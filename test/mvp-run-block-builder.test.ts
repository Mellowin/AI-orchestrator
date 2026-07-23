import { describe, test } from 'node:test';
import assert from 'node:assert';
import { buildMvpRunBlock } from '../src/mvp-run/block-builder.js';
import type { MvpRunConfig } from '../src/mvp-run/types.js';

function makeConfig(tasks: MvpRunConfig['tasks']): MvpRunConfig {
  return {
    run_id: 'run-1',
    repo_path: '/repo',
    base_branch: 'main',
    work_branch: 'work',
    provider: 'fake',
    tasks,
  };
}

describe('mvp-run block-builder checks precedence', () => {
  test('explicit empty checks list takes precedence over legacy tests', () => {
    const block = buildMvpRunBlock(
      makeConfig([
        {
          id: 't1',
          title: 'Docs',
          goal: 'Add docs',
          allowed_files: ['README.md'],
          tests: ['npm test'],
          checks: [],
        },
      ])
    );
    assert.deepStrictEqual(block.tasks[0].checks, []);
  });

  test('non-empty checks take precedence over legacy tests', () => {
    const block = buildMvpRunBlock(
      makeConfig([
        {
          id: 't1',
          title: 'Feature',
          goal: 'Add feature',
          allowed_files: ['src/feature.ts'],
          tests: ['npm test'],
          checks: ['npm run typecheck', 'npm test'],
        },
      ])
    );
    assert.deepStrictEqual(block.tasks[0].checks, ['npm run typecheck', 'npm test']);
  });

  test('missing checks falls back to legacy tests', () => {
    const block = buildMvpRunBlock(
      makeConfig([
        {
          id: 't1',
          title: 'Feature',
          goal: 'Add feature',
          allowed_files: ['src/feature.ts'],
          tests: ['npm test'],
        },
      ])
    );
    assert.deepStrictEqual(block.tasks[0].checks, ['npm test']);
  });

  test('neither checks nor tests defaults to empty list', () => {
    const block = buildMvpRunBlock(
      makeConfig([
        {
          id: 't1',
          title: 'Feature',
          goal: 'Add feature',
          allowed_files: ['src/feature.ts'],
        },
      ])
    );
    assert.deepStrictEqual(block.tasks[0].checks, []);
  });
});
