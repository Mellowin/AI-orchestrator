import { describe, test } from 'node:test';
import assert from 'node:assert';
import { buildReviewerPrompt } from '../src/reviewer/reviewer-prompt.js';
import type { ReviewInput } from '../src/providers/provider-types.js';

function makeInput(overrides: Partial<ReviewInput> = {}): ReviewInput {
  return {
    task_id: 'task-1',
    task_title: 'Test Task',
    task_goal: 'Do something',
    allowed_files: ['src/test.ts'],
    denied_files: ['.env'],
    max_lines_changed: 100,
    commit_sha: 'a'.repeat(40),
    changed_files: ['src/test.ts'],
    diff: '+line\n',
    typecheck_result: 'pass',
    build_result: 'pass',
    test_result: 'pass',
    git_status: '',
    safety_findings: [],
    ...overrides,
  };
}

describe('reviewer prompt builder', () => {
  test('includes acceptance criteria section when provided', () => {
    const prompt = buildReviewerPrompt(
      makeInput({
        acceptance_criteria: ['must end with exact sentence'],
      })
    );
    assert(prompt.includes('# Acceptance Criteria (task-level)'));
    assert(prompt.includes('must end with exact sentence'));
  });

  test('instructs to reject when acceptance criteria are not satisfied', () => {
    const prompt = buildReviewerPrompt(makeInput({ acceptance_criteria: ['must mention X'] }));
    assert(
      prompt.includes('ANY acceptance criterion is not satisfied'),
      `Expected rejection instruction in prompt: ${prompt}`
    );
  });

  test('instructs to accept only when all acceptance criteria are satisfied', () => {
    const prompt = buildReviewerPrompt(makeInput({ acceptance_criteria: ['must mention X'] }));
    assert(
      prompt.includes('ALL acceptance criteria are satisfied'),
      `Expected acceptance instruction in prompt: ${prompt}`
    );
  });

  test('uses fallback text when no acceptance criteria are provided', () => {
    const prompt = buildReviewerPrompt(makeInput());
    assert(prompt.includes('# Acceptance Criteria (task-level)'));
    assert(prompt.includes('No specific acceptance criteria provided'));
  });
});
