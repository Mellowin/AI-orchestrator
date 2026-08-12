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

  test('propagates acceptance_criteria to block task definition', () => {
    const block = buildMvpRunBlock(
      makeConfig([
        {
          id: 't1',
          title: 'Feature',
          goal: 'Add feature',
          allowed_files: ['src/feature.ts'],
          acceptance_criteria: ['must end with exact sentence'],
        },
      ])
    );
    assert.deepStrictEqual(block.tasks[0].acceptance_criteria, ['must end with exact sentence']);
  });

  test('omits acceptance_criteria when not provided', () => {
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
    assert.strictEqual(block.tasks[0].acceptance_criteria, undefined);
  });

  test('omits max_lines_changed when not provided (no hard default 100)', () => {
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
    assert.strictEqual(block.tasks[0].max_lines_changed, undefined);
  });

  test('preserves explicit max_lines_changed value', () => {
    const block = buildMvpRunBlock(
      makeConfig([
        {
          id: 't1',
          title: 'Feature',
          goal: 'Add feature',
          allowed_files: ['src/feature.ts'],
          max_lines_changed: 250,
        },
      ])
    );
    assert.strictEqual(block.tasks[0].max_lines_changed, 250);
  });

  test('propagates context_files to block task definition', () => {
    const block = buildMvpRunBlock(
      makeConfig([
        {
          id: 't1',
          title: 'Docs',
          goal: 'Add docs based on existing code',
          allowed_files: ['docs/new.md'],
          context_files: ['src/cli.ts', 'src/autopilot-one-click/runner.ts'],
        },
      ])
    );
    assert.deepStrictEqual(block.tasks[0].context_files, [
      'src/cli.ts',
      'src/autopilot-one-click/runner.ts',
    ]);
  });

  test('omits context_files when not provided', () => {
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
    assert.strictEqual(block.tasks[0].context_files, undefined);
  });
});
