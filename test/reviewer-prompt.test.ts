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

  test('labels max_lines_changed as advisory budget, not a hard rule', () => {
    const prompt = buildReviewerPrompt(makeInput({ max_lines_changed: 100 }));
    assert(prompt.includes('# Max Lines Changed (advisory budget)'));
    assert(
      !prompt.includes('- max_lines_changed exceeded\n'),
      'Prompt must not instruct unconditional rejection for exceeding the advisory budget'
    );
    assert(
      prompt.includes('HARD safety rule'),
      'Prompt should explain that hard rejection only applies to explicit user limits'
    );
  });

  test('handles unspecified max_lines_changed gracefully', () => {
    const prompt = buildReviewerPrompt(makeInput({ max_lines_changed: undefined }));
    assert(prompt.includes('# Max Lines Changed (advisory budget)'));
    assert(prompt.includes('not specified'));
  });

  test('uses commit semantics when candidate_state is absent', () => {
    const prompt = buildReviewerPrompt(makeInput());
    assert(prompt.includes('# Commit SHA'));
    assert(!prompt.includes('# Candidate Base SHA'));
    assert(prompt.includes('You look at actual commits, diffs, and check results'));
  });

  test('uses candidate semantics when candidate_state is present', () => {
    const prompt = buildReviewerPrompt(
      makeInput({
        candidate_state: {
          base_sha: 'b'.repeat(40),
          package_hash: 'c'.repeat(64),
          files: [
            {
              path: 'docs/new.md',
              bytes: 12,
              lines: 2,
              sha256: 'd'.repeat(64),
              content: '# New\nfile\n',
            },
          ],
        },
      })
    );
    assert(prompt.includes('# Candidate Base SHA'));
    assert(prompt.includes('b'.repeat(40)));
    assert(prompt.includes('# Candidate Package Hash'));
    assert(prompt.includes('c'.repeat(64)));
    assert(prompt.includes('pre-commit staged candidate'));
    assert(!prompt.includes('# Commit SHA\n'));
    assert(prompt.includes('Candidate File Metadata'));
    assert(prompt.includes('docs/new.md'));
  });

  test('includes read-only repository context when provided', () => {
    const prompt = buildReviewerPrompt(
      makeInput({
        read_only_context: {
          files: [
            {
              path: 'src/cli.ts',
              bytes: 10,
              lines: 1,
              sha256: 'e'.repeat(64),
              content: 'export const cli = 1;',
            },
          ],
          total_bytes: 10,
          truncated: false,
        },
      })
    );
    assert(prompt.includes('## Read-Only Repository Context'));
    assert(prompt.includes('src/cli.ts'));
    assert(prompt.includes('export const cli = 1;'));
  });
});
