import { describe, test } from 'node:test';
import assert from 'node:assert';
import {
  deriveReviewerTaskTransition,
  type ReviewerTaskTransitionInput,
} from '../src/reviewer-task-transition.js';
import type { ReviewerTaskOutcome } from '../src/reviewer-task-outcome.js';

function makeOutcome(
  overrides: Partial<ReviewerTaskOutcome> = {}
): ReviewerTaskOutcome {
  return {
    status: 'accepted',
    nextAction: 'continue',
    reason: 'Looks good',
    blockingIssues: [],
    ...overrides,
  };
}

function makeInput(
  overrides: Partial<ReviewerTaskTransitionInput> = {}
): ReviewerTaskTransitionInput {
  return {
    outcome: makeOutcome(),
    originalTaskId: 'task-123',
    ...overrides,
  };
}

describe('deriveReviewerTaskTransition', () => {
  test('legacy_success outcome maps to continue', () => {
    const result = deriveReviewerTaskTransition(
      makeInput({
        outcome: makeOutcome({
          status: 'legacy_success',
          nextAction: 'continue',
          reason: 'Legacy success',
        }),
      })
    );
    assert.strictEqual(result.action, 'continue');
    assert(result.reason.includes('Legacy success'));
  });

  test('accepted outcome maps to continue', () => {
    const result = deriveReviewerTaskTransition(
      makeInput({
        outcome: makeOutcome({
          status: 'accepted',
          nextAction: 'continue',
          reason: 'Reviewer gate accepted',
        }),
      })
    );
    assert.strictEqual(result.action, 'continue');
    assert(result.reason.includes('accepted'));
  });

  test('fix_required outcome maps to create_fix_task', () => {
    const result = deriveReviewerTaskTransition(
      makeInput({
        outcome: makeOutcome({
          status: 'fix_required',
          nextAction: 'fix',
        }),
      })
    );
    assert.strictEqual(result.action, 'create_fix_task');
  });

  test('fix_required creates fixTask', () => {
    const result = deriveReviewerTaskTransition(
      makeInput({
        outcome: makeOutcome({
          status: 'fix_required',
          nextAction: 'fix',
        }),
      })
    );
    assert(result.fixTask !== undefined);
    assert.strictEqual(result.fixTask.parentTaskId, 'task-123');
  });

  test('fixTask parentTaskId equals originalTaskId', () => {
    const result = deriveReviewerTaskTransition(
      makeInput({
        originalTaskId: 'parent-42',
        outcome: makeOutcome({
          status: 'fix_required',
          nextAction: 'fix',
        }),
      })
    );
    assert.strictEqual(result.fixTask?.parentTaskId, 'parent-42');
  });

  test('fixTask title is deterministic from originalTaskId', () => {
    const result = deriveReviewerTaskTransition(
      makeInput({
        originalTaskId: 'task-abc',
        outcome: makeOutcome({
          status: 'fix_required',
          nextAction: 'fix',
        }),
      })
    );
    assert.strictEqual(result.fixTask?.title, 'Fix reviewer issues for task-abc');
  });

  test('fixTask title uses originalTaskTitle when present', () => {
    const result = deriveReviewerTaskTransition(
      makeInput({
        originalTaskId: 'task-abc',
        originalTaskTitle: 'My Task',
        outcome: makeOutcome({
          status: 'fix_required',
          nextAction: 'fix',
        }),
      })
    );
    assert.strictEqual(result.fixTask?.title, 'Fix reviewer issues for My Task');
  });

  test('fixTask goal uses outcome.fixTask when present', () => {
    const result = deriveReviewerTaskTransition(
      makeInput({
        outcome: makeOutcome({
          status: 'fix_required',
          nextAction: 'fix',
          fixTask: 'Fix the broken parser',
        }),
      })
    );
    assert.strictEqual(result.fixTask?.goal, 'Fix the broken parser');
  });

  test('fix_required without fixTask builds goal from blockingIssues', () => {
    const result = deriveReviewerTaskTransition(
      makeInput({
        outcome: makeOutcome({
          status: 'fix_required',
          nextAction: 'fix',
          blockingIssues: ['missing tests', 'syntax error'],
        }),
      })
    );
    assert.strictEqual(
      result.fixTask?.goal,
      'Fix reviewer blocking issues: missing tests; syntax error'
    );
  });

  test('fix_required preserves blockingIssues', () => {
    const result = deriveReviewerTaskTransition(
      makeInput({
        outcome: makeOutcome({
          status: 'fix_required',
          nextAction: 'fix',
          blockingIssues: ['bug A', 'bug B'],
        }),
      })
    );
    assert.deepStrictEqual(result.blockingIssues, ['bug A', 'bug B']);
    assert.deepStrictEqual(result.fixTask?.blockingIssues, ['bug A', 'bug B']);
  });

  test('blocked outcome maps to block_for_human', () => {
    const result = deriveReviewerTaskTransition(
      makeInput({
        outcome: makeOutcome({
          status: 'blocked',
          nextAction: 'block',
          reason: 'Reviewer gate blocked',
        }),
      })
    );
    assert.strictEqual(result.action, 'block_for_human');
    assert(result.reason.includes('blocked'));
  });

  test('blocked does not create fixTask', () => {
    const result = deriveReviewerTaskTransition(
      makeInput({
        outcome: makeOutcome({
          status: 'blocked',
          nextAction: 'block',
        }),
      })
    );
    assert.strictEqual(result.fixTask, undefined);
  });

  test('blocked preserves blockingIssues', () => {
    const result = deriveReviewerTaskTransition(
      makeInput({
        outcome: makeOutcome({
          status: 'blocked',
          nextAction: 'block',
          blockingIssues: ['security concern'],
        }),
      })
    );
    assert.deepStrictEqual(result.blockingIssues, ['security concern']);
  });

  test('not_ready outcome maps to wait', () => {
    const result = deriveReviewerTaskTransition(
      makeInput({
        outcome: makeOutcome({
          status: 'not_ready',
          nextAction: 'wait',
          reason: 'Missing state',
        }),
      })
    );
    assert.strictEqual(result.action, 'wait');
    assert(result.reason.includes('not ready') || result.reason.includes('Missing state'));
  });

  test('not_ready does not create fixTask', () => {
    const result = deriveReviewerTaskTransition(
      makeInput({
        outcome: makeOutcome({
          status: 'not_ready',
          nextAction: 'wait',
        }),
      })
    );
    assert.strictEqual(result.fixTask, undefined);
  });

  test('helper preserves taskId', () => {
    const result = deriveReviewerTaskTransition(
      makeInput({ originalTaskId: 'my-task-99' })
    );
    assert.strictEqual(result.taskId, 'my-task-99');
  });

  test('helper does not mutate input outcome', () => {
    const outcome = makeOutcome({
      status: 'fix_required',
      nextAction: 'fix',
      blockingIssues: ['original'],
    });
    const input = makeInput({ outcome });
    const inputJson = JSON.stringify(input);
    deriveReviewerTaskTransition(input);
    assert.strictEqual(JSON.stringify(input), inputJson, 'Input should not be mutated');
  });

  test('helper does not mutate input blockingIssues array', () => {
    const blockingIssues = ['original'];
    const outcome = makeOutcome({
      status: 'blocked',
      nextAction: 'block',
      blockingIssues,
    });
    const input = makeInput({ outcome });
    const result = deriveReviewerTaskTransition(input);
    result.blockingIssues.push('mutated');
    assert.deepStrictEqual(blockingIssues, ['original']);
  });

  test('helper does not perform redaction or alter already-redacted text', () => {
    const outcome = makeOutcome({
      status: 'fix_required',
      nextAction: 'fix',
      fixTask: 'use sk-fake-token in fix',
      blockingIssues: ['Bearer fake-token'],
    });
    const result = deriveReviewerTaskTransition(makeInput({ outcome }));
    assert.strictEqual(result.fixTask?.goal, 'use sk-fake-token in fix');
    assert.deepStrictEqual(result.blockingIssues, ['Bearer fake-token']);
  });
});
