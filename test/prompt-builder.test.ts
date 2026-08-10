import { describe, test } from 'node:test';
import assert from 'node:assert';
import { buildKimiPrompt } from '../src/prompt-builder.js';

function makeContext(maxLinesChanged?: number): {
  task_summary: string;
  goal: string;
  constraints: string[];
  files: { path: string; content: string }[];
  max_lines_changed?: number;
} {
  return {
    task_summary: 'Test task',
    goal: 'Test goal',
    constraints: [],
    files: [{ path: 'src/a.ts', content: 'export const a = 1;\n' }],
    max_lines_changed: maxLinesChanged,
  };
}

describe('prompt-builder', () => {
  test('prompt tells model to return full final file content', () => {
    const prompt = buildKimiPrompt(makeContext());
    assert(prompt.includes('full final file content'), `Expected full final file content in prompt`);
    assert(prompt.includes('not a snippet'), `Expected not a snippet in prompt`);
  });

  test('prompt warns against replacing large files with demo placeholders', () => {
    const prompt = buildKimiPrompt(makeContext());
    assert(
      prompt.includes('Do not replace a large existing file with a tiny demo implementation'),
      `Expected demo placeholder warning in prompt`
    );
  });

  test('prompt instructs empty files array when context is insufficient', () => {
    const prompt = buildKimiPrompt(makeContext());
    assert(prompt.includes('"files": []'), `Expected empty files array instruction in prompt`);
    assert(
      prompt.includes('Cannot safely modify files'),
      `Expected cannot safely modify message in prompt`
    );
  });

  test('prompt includes advisory line change budget when max_lines_changed is set', () => {
    const prompt = buildKimiPrompt(makeContext(25));
    assert(prompt.includes('Advisory budget'), 'Expected advisory budget wording');
    assert(prompt.includes('25'), 'Expected limit value in prompt');
    assert(
      prompt.includes('newly created file this is a planning estimate'),
      'Expected new-file advisory explanation'
    );
  });

  test('prompt does not invent line budget when max_lines_changed is absent', () => {
    const prompt = buildKimiPrompt(makeContext());
    assert(!prompt.includes('Advisory budget'), 'Should not include advisory budget without limit');
  });
});
