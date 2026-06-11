import { describe, test } from 'node:test';
import assert from 'node:assert';
import { deriveReviewerBlockActionPlan } from '../src/reviewer-block-action-plan.js';
import type { ReviewerTaskDecision } from '../src/reviewer-task-decision.js';
import type { ReviewerTaskOutcome, ReviewerTaskTransition } from '../src/reviewer-task-outcome.js';

function makeTransition(
  action: ReviewerTaskTransition['action'],
  overrides: Partial<ReviewerTaskTransition> = {}
): ReviewerTaskTransition {
  const base: ReviewerTaskTransition = {
    action,
    reason: `${action} reason`,
    taskId: 'task-1',
    blockingIssues: [],
  };
  if (action === 'create_fix_task') {
    base.fixTask = {
      parentTaskId: 'task-1',
      title: 'Fix reviewer issues for task-1',
      goal: 'Fix it',
      blockingIssues: [],
    };
  }
  return { ...base, ...overrides };
}

function makeOutcome(
  status: ReviewerTaskOutcome['status'],
  overrides: Partial<ReviewerTaskOutcome> = {}
): ReviewerTaskOutcome {
  return {
    status,
    nextAction: status === 'fix_required' ? 'fix' : status === 'blocked' ? 'block' : status === 'not_ready' ? 'wait' : 'continue',
    reason: `${status} reason`,
    blockingIssues: [],
    ...overrides,
  };
}

function makeDecision(
  action: ReviewerTaskTransition['action'],
  overrides: Partial<ReviewerTaskDecision> = {}
): ReviewerTaskDecision {
  return {
    outcome: makeOutcome(action === 'create_fix_task' ? 'fix_required' : action === 'block_for_human' ? 'blocked' : action === 'wait' ? 'not_ready' : 'accepted'),
    transition: makeTransition(action),
    ...overrides,
  };
}

function makeInput(
  decisions: ReviewerTaskDecision[],
  blockId = 'block-1'
) {
  return { blockId, decisions };
}

describe('deriveReviewerBlockActionPlan', () => {
  test('empty decisions returns wait', () => {
    const result = deriveReviewerBlockActionPlan(makeInput([]));
    assert.strictEqual(result.action, 'wait');
    assert(result.reason.includes('No reviewer task decisions'));
  });

  test('all continue transitions returns continue', () => {
    const result = deriveReviewerBlockActionPlan(
      makeInput([makeDecision('continue'), makeDecision('continue')])
    );
    assert.strictEqual(result.action, 'continue');
    assert.strictEqual(result.blockId, 'block-1');
  });

  test('accepted + legacy_success continue transitions returns continue', () => {
    const d1: ReviewerTaskDecision = {
      outcome: makeOutcome('accepted'),
      transition: makeTransition('continue', { taskId: 't-accepted' }),
    };
    const d2: ReviewerTaskDecision = {
      outcome: makeOutcome('legacy_success'),
      transition: makeTransition('continue', { taskId: 't-legacy' }),
    };
    const result = deriveReviewerBlockActionPlan(makeInput([d1, d2]));
    assert.strictEqual(result.action, 'continue');
  });

  test('one wait transition returns wait', () => {
    const result = deriveReviewerBlockActionPlan(
      makeInput([makeDecision('continue'), makeDecision('wait')])
    );
    assert.strictEqual(result.action, 'wait');
  });

  test('wait preserves selectedTaskId', () => {
    const result = deriveReviewerBlockActionPlan(
      makeInput([
        makeDecision('continue', { transition: makeTransition('continue', { taskId: 't-continue' }) }),
        makeDecision('wait', { transition: makeTransition('wait', { taskId: 't-wait' }) }),
      ])
    );
    assert.strictEqual(result.selectedTaskId, 't-wait');
  });

  test('one create_fix_task transition returns create_fix_task', () => {
    const result = deriveReviewerBlockActionPlan(
      makeInput([makeDecision('continue'), makeDecision('create_fix_task')])
    );
    assert.strictEqual(result.action, 'create_fix_task');
  });

  test('create_fix_task preserves selectedTaskId', () => {
    const result = deriveReviewerBlockActionPlan(
      makeInput([
        makeDecision('create_fix_task', {
          transition: makeTransition('create_fix_task', { taskId: 't-fix' }),
        }),
      ])
    );
    assert.strictEqual(result.selectedTaskId, 't-fix');
  });

  test('create_fix_task preserves selectedTransition', () => {
    const transition = makeTransition('create_fix_task', {
      taskId: 't-fix',
      fixTask: {
        parentTaskId: 't-fix',
        title: 'Fix title',
        goal: 'Fix goal',
        blockingIssues: ['bug'],
      },
    });
    const result = deriveReviewerBlockActionPlan(
      makeInput([makeDecision('create_fix_task', { transition })])
    );
    assert.deepStrictEqual(result.selectedTransition, transition);
  });

  test('create_fix_task preserves blockingIssues', () => {
    const result = deriveReviewerBlockActionPlan(
      makeInput([
        makeDecision('create_fix_task', {
          transition: makeTransition('create_fix_task', {
            taskId: 't-fix',
            blockingIssues: ['bug A', 'bug B'],
          }),
        }),
      ])
    );
    assert.deepStrictEqual(result.blockingIssues, ['bug A', 'bug B']);
  });

  test('one block_for_human transition returns block_for_human', () => {
    const result = deriveReviewerBlockActionPlan(
      makeInput([makeDecision('continue'), makeDecision('block_for_human')])
    );
    assert.strictEqual(result.action, 'block_for_human');
  });

  test('block_for_human preserves selectedTaskId', () => {
    const result = deriveReviewerBlockActionPlan(
      makeInput([
        makeDecision('block_for_human', {
          transition: makeTransition('block_for_human', { taskId: 't-block' }),
        }),
      ])
    );
    assert.strictEqual(result.selectedTaskId, 't-block');
  });

  test('block_for_human preserves selectedTransition', () => {
    const transition = makeTransition('block_for_human', {
      taskId: 't-block',
      blockingIssues: ['unsafe'],
    });
    const result = deriveReviewerBlockActionPlan(
      makeInput([makeDecision('block_for_human', { transition })])
    );
    assert.deepStrictEqual(result.selectedTransition, transition);
  });

  test('block_for_human preserves blockingIssues', () => {
    const result = deriveReviewerBlockActionPlan(
      makeInput([
        makeDecision('block_for_human', {
          transition: makeTransition('block_for_human', {
            taskId: 't-block',
            blockingIssues: ['security'],
          }),
        }),
      ])
    );
    assert.deepStrictEqual(result.blockingIssues, ['security']);
  });

  test('block_for_human has priority over create_fix_task', () => {
    const result = deriveReviewerBlockActionPlan(
      makeInput([
        makeDecision('create_fix_task', { transition: makeTransition('create_fix_task', { taskId: 't-fix' }) }),
        makeDecision('block_for_human', { transition: makeTransition('block_for_human', { taskId: 't-block' }) }),
      ])
    );
    assert.strictEqual(result.action, 'block_for_human');
    assert.strictEqual(result.selectedTaskId, 't-block');
  });

  test('create_fix_task has priority over wait', () => {
    const result = deriveReviewerBlockActionPlan(
      makeInput([
        makeDecision('wait', { transition: makeTransition('wait', { taskId: 't-wait' }) }),
        makeDecision('create_fix_task', { transition: makeTransition('create_fix_task', { taskId: 't-fix' }) }),
      ])
    );
    assert.strictEqual(result.action, 'create_fix_task');
    assert.strictEqual(result.selectedTaskId, 't-fix');
  });

  test('wait has priority over continue', () => {
    const result = deriveReviewerBlockActionPlan(
      makeInput([
        makeDecision('continue'),
        makeDecision('wait', { transition: makeTransition('wait', { taskId: 't-wait' }) }),
      ])
    );
    assert.strictEqual(result.action, 'wait');
    assert.strictEqual(result.selectedTaskId, 't-wait');
  });

  test('first matching priority transition is selected', () => {
    const result = deriveReviewerBlockActionPlan(
      makeInput([
        makeDecision('block_for_human', { transition: makeTransition('block_for_human', { taskId: 'first-block' }) }),
        makeDecision('block_for_human', { transition: makeTransition('block_for_human', { taskId: 'second-block' }) }),
      ])
    );
    assert.strictEqual(result.selectedTaskId, 'first-block');
  });

  test('blockId is preserved', () => {
    const result = deriveReviewerBlockActionPlan(makeInput([], 'my-block-99'));
    assert.strictEqual(result.blockId, 'my-block-99');
  });

  test('helper does not mutate input decisions', () => {
    const decisions = [
      makeDecision('continue'),
      makeDecision('block_for_human', {
        transition: makeTransition('block_for_human', {
          taskId: 't-block',
          blockingIssues: ['original'],
        }),
      }),
    ];
    const input = { blockId: 'block-1', decisions };
    const inputJson = JSON.stringify(input);
    deriveReviewerBlockActionPlan(input);
    assert.strictEqual(JSON.stringify(input), inputJson);
  });

  test('helper does not perform redaction or alter already-redacted text', () => {
    const transition = makeTransition('create_fix_task', {
      taskId: 't-fix',
      fixTask: {
        parentTaskId: 't-fix',
        title: 'Fix reviewer issues for t-fix',
        goal: 'use sk-fake-token in fix',
        blockingIssues: ['Bearer fake-token'],
      },
      blockingIssues: ['Bearer fake-token'],
    });
    const result = deriveReviewerBlockActionPlan(
      makeInput([makeDecision('create_fix_task', { transition })])
    );
    assert.strictEqual(result.selectedTransition?.fixTask?.goal, 'use sk-fake-token in fix');
    assert.deepStrictEqual(result.blockingIssues, ['Bearer fake-token']);
  });
});
