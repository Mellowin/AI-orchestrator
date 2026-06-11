import { describe, test } from 'node:test';
import assert from 'node:assert';
import { deriveReviewerFixTaskPlan } from '../src/reviewer-fix-task-plan.js';
import type { ReviewerBlockActionPlan } from '../src/reviewer-block-action-plan.js';
import type { ReviewerTaskTransition } from '../src/reviewer-task-transition.js';

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
      blockingIssues: ['bug'],
    };
  }
  return { ...base, ...overrides };
}

function makeActionPlan(
  action: ReviewerBlockActionPlan['action'],
  overrides: Partial<ReviewerBlockActionPlan> = {}
): ReviewerBlockActionPlan {
  const base: ReviewerBlockActionPlan = {
    blockId: 'block-1',
    action,
    reason: `${action} reason`,
    blockingIssues: [],
  };
  if (action === 'create_fix_task') {
    base.selectedTaskId = 'task-1';
    base.selectedTransition = makeTransition('create_fix_task');
  }
  if (action === 'block_for_human') {
    base.selectedTaskId = 'task-1';
    base.selectedTransition = makeTransition('block_for_human', {
      blockingIssues: ['unsafe'],
    });
    base.blockingIssues = ['unsafe'];
  }
  if (action === 'wait') {
    base.selectedTaskId = 'task-1';
    base.selectedTransition = makeTransition('wait');
  }
  return { ...base, ...overrides };
}

function makeInput(
  actionPlan: ReviewerBlockActionPlan,
  overrides: Partial<Parameters<typeof deriveReviewerFixTaskPlan>[0]> = {}
) {
  return {
    blockId: 'block-1',
    actionPlan,
    maxFixAttempts: 3,
    ...overrides,
  };
}

describe('deriveReviewerFixTaskPlan', () => {
  test('continue action maps to no_fix_needed', () => {
    const result = deriveReviewerFixTaskPlan(
      makeInput(makeActionPlan('continue'))
    );
    assert.strictEqual(result.action, 'no_fix_needed');
    assert(result.reason.includes('no fix needed'));
  });

  test('wait action maps to wait', () => {
    const result = deriveReviewerFixTaskPlan(makeInput(makeActionPlan('wait')));
    assert.strictEqual(result.action, 'wait');
    assert(result.reason.includes('wait'));
  });

  test('block_for_human action maps to block_for_human', () => {
    const result = deriveReviewerFixTaskPlan(
      makeInput(makeActionPlan('block_for_human'))
    );
    assert.strictEqual(result.action, 'block_for_human');
    assert(result.reason.includes('human review'));
  });

  test('block_for_human preserves blockingIssues', () => {
    const result = deriveReviewerFixTaskPlan(
      makeInput(makeActionPlan('block_for_human'))
    );
    assert.deepStrictEqual(result.blockingIssues, ['unsafe']);
  });

  test('create_fix_task action creates fixTask draft', () => {
    const result = deriveReviewerFixTaskPlan(
      makeInput(makeActionPlan('create_fix_task'))
    );
    assert.strictEqual(result.action, 'create_fix_task');
    assert(result.fixTask !== undefined);
  });

  test('fixTask draft taskId is deterministic', () => {
    const result = deriveReviewerFixTaskPlan(
      makeInput(makeActionPlan('create_fix_task'))
    );
    assert.strictEqual(result.fixTask?.taskId, 'fix-task-1-reviewer-1');
  });

  test('fixTask draft parentTaskId is preserved', () => {
    const result = deriveReviewerFixTaskPlan(
      makeInput(makeActionPlan('create_fix_task'))
    );
    assert.strictEqual(result.fixTask?.parentTaskId, 'task-1');
  });

  test('fixTask draft title is preserved', () => {
    const result = deriveReviewerFixTaskPlan(
      makeInput(makeActionPlan('create_fix_task'))
    );
    assert.strictEqual(
      result.fixTask?.title,
      'Fix reviewer issues for task-1'
    );
  });

  test('fixTask draft goal is preserved', () => {
    const result = deriveReviewerFixTaskPlan(
      makeInput(makeActionPlan('create_fix_task'))
    );
    assert.strictEqual(result.fixTask?.goal, 'Fix it');
  });

  test('fixTask draft attempt is existing attempts + 1', () => {
    const result = deriveReviewerFixTaskPlan(
      makeInput(makeActionPlan('create_fix_task'), {
        existingFixAttemptsByParentTaskId: { 'task-1': 2 },
      })
    );
    assert.strictEqual(result.fixTask?.attempt, 3);
    assert.strictEqual(result.fixTask?.taskId, 'fix-task-1-reviewer-3');
  });

  test('missing existing attempts means attempt 1', () => {
    const result = deriveReviewerFixTaskPlan(
      makeInput(makeActionPlan('create_fix_task'))
    );
    assert.strictEqual(result.fixTask?.attempt, 1);
    assert.strictEqual(result.fixTask?.taskId, 'fix-task-1-reviewer-1');
  });

  test('existing attempts are read by parentTaskId', () => {
    const actionPlan = makeActionPlan('create_fix_task', {
      selectedTransition: makeTransition('create_fix_task', {
        taskId: 'parent-x',
        fixTask: {
          parentTaskId: 'parent-x',
          title: 'Fix x',
          goal: 'Fix x goal',
          blockingIssues: [],
        },
      }),
      selectedTaskId: 'parent-x',
    });
    const result = deriveReviewerFixTaskPlan(
      makeInput(actionPlan, {
        existingFixAttemptsByParentTaskId: { 'other-task': 5, 'parent-x': 1 },
      })
    );
    assert.strictEqual(result.fixTask?.attempt, 2);
    assert.strictEqual(result.fixTask?.parentTaskId, 'parent-x');
  });

  test('maxFixAttempts reached maps to block_for_human', () => {
    const result = deriveReviewerFixTaskPlan(
      makeInput(makeActionPlan('create_fix_task'), {
        existingFixAttemptsByParentTaskId: { 'task-1': 3 },
        maxFixAttempts: 3,
      })
    );
    assert.strictEqual(result.action, 'block_for_human');
    assert(result.reason.includes('Max fix attempts'));
  });

  test('maxFixAttempts reached does not create fixTask', () => {
    const result = deriveReviewerFixTaskPlan(
      makeInput(makeActionPlan('create_fix_task'), {
        existingFixAttemptsByParentTaskId: { 'task-1': 3 },
        maxFixAttempts: 3,
      })
    );
    assert.strictEqual(result.fixTask, undefined);
  });

  test('missing selectedTransition maps to block_for_human', () => {
    const actionPlan = makeActionPlan('create_fix_task', {
      selectedTransition: undefined,
    });
    const result = deriveReviewerFixTaskPlan(makeInput(actionPlan));
    assert.strictEqual(result.action, 'block_for_human');
    assert(result.reason.includes('missing fix task data'));
  });

  test('missing selectedTransition.fixTask maps to block_for_human', () => {
    const actionPlan = makeActionPlan('create_fix_task', {
      selectedTransition: makeTransition('create_fix_task', {
        fixTask: undefined,
      }),
    });
    const result = deriveReviewerFixTaskPlan(makeInput(actionPlan));
    assert.strictEqual(result.action, 'block_for_human');
  });

  test('blockingIssues use fixTask.blockingIssues when present', () => {
    const result = deriveReviewerFixTaskPlan(
      makeInput(makeActionPlan('create_fix_task'))
    );
    assert.deepStrictEqual(result.fixTask?.blockingIssues, ['bug']);
  });

  test('blockingIssues fall back to actionPlan.blockingIssues when fixTask.blockingIssues is empty', () => {
    const actionPlan = makeActionPlan('create_fix_task', {
      selectedTransition: makeTransition('create_fix_task', {
        fixTask: {
          parentTaskId: 'task-1',
          title: 'Fix',
          goal: 'Fix goal',
          blockingIssues: [],
        },
      }),
      blockingIssues: ['fallback issue'],
    });
    const result = deriveReviewerFixTaskPlan(makeInput(actionPlan));
    assert.deepStrictEqual(result.fixTask?.blockingIssues, ['fallback issue']);
  });

  test('source is reviewer_gate', () => {
    const result = deriveReviewerFixTaskPlan(
      makeInput(makeActionPlan('create_fix_task'))
    );
    assert.strictEqual(result.fixTask?.source, 'reviewer_gate');
  });

  test('blockId is preserved', () => {
    const result = deriveReviewerFixTaskPlan(
      makeInput(makeActionPlan('continue'), { blockId: 'my-block-99' })
    );
    assert.strictEqual(result.blockId, 'my-block-99');
  });

  test('helper does not mutate input', () => {
    const actionPlan = makeActionPlan('create_fix_task');
    const input = makeInput(actionPlan, {
      existingFixAttemptsByParentTaskId: { 'task-1': 1 },
    });
    const inputJson = JSON.stringify(input);
    deriveReviewerFixTaskPlan(input);
    assert.strictEqual(JSON.stringify(input), inputJson);
  });

  test('helper does not perform redaction or alter already-redacted text', () => {
    const actionPlan = makeActionPlan('create_fix_task', {
      selectedTransition: makeTransition('create_fix_task', {
        fixTask: {
          parentTaskId: 'task-1',
          title: 'Fix reviewer issues for task-1',
          goal: 'use sk-fake-token in fix',
          blockingIssues: ['Bearer fake-token'],
        },
      }),
      blockingIssues: ['Bearer fake-token'],
    });
    const result = deriveReviewerFixTaskPlan(makeInput(actionPlan));
    assert.strictEqual(result.fixTask?.goal, 'use sk-fake-token in fix');
    assert.deepStrictEqual(result.fixTask?.blockingIssues, ['Bearer fake-token']);
    assert.deepStrictEqual(result.blockingIssues, ['Bearer fake-token']);
  });
});
