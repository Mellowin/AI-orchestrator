import { describe, test } from 'node:test';
import assert from 'node:assert';
import { deriveReviewerBlockResolutionPlan } from '../src/reviewer-block-resolution-plan.js';
import type { ReviewerBlockActionPlan, ReviewerTaskTransition } from '../src/reviewer-block-action-plan.js';
import type { ReviewerFixTaskPlan } from '../src/reviewer-fix-task-plan.js';

function makeFixTask(
  overrides: Partial<NonNullable<ReviewerFixTaskPlan['fixTask']>> = {}
): NonNullable<ReviewerFixTaskPlan['fixTask']> {
  return {
    taskId: 'fix-task-1-reviewer-1',
    parentTaskId: 'task-1',
    title: 'Fix reviewer issues for task-1',
    goal: 'Fix it',
    attempt: 1,
    blockingIssues: ['bug'],
    source: 'reviewer_gate',
    ...overrides,
  };
}

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

function makeFixTaskPlan(
  action: ReviewerFixTaskPlan['action'],
  overrides: Partial<ReviewerFixTaskPlan> = {}
): ReviewerFixTaskPlan {
  const base: ReviewerFixTaskPlan = {
    blockId: 'block-1',
    action,
    reason: `${action} reason`,
    blockingIssues: [],
  };
  if (action === 'create_fix_task') {
    base.fixTask = makeFixTask();
    base.blockingIssues = ['bug'];
  }
  if (action === 'block_for_human') {
    base.blockingIssues = ['unsafe'];
  }
  return { ...base, ...overrides };
}

function makeInput(
  actionPlan: ReviewerBlockActionPlan,
  fixTaskPlan: ReviewerFixTaskPlan,
  blockId = 'block-1'
) {
  return { blockId, actionPlan, fixTaskPlan };
}

describe('deriveReviewerBlockResolutionPlan', () => {
  test('no_fix_needed maps to continue_block / ready_to_continue', () => {
    const result = deriveReviewerBlockResolutionPlan(
      makeInput(makeActionPlan('continue'), makeFixTaskPlan('no_fix_needed'))
    );
    assert.strictEqual(result.action, 'continue_block');
    assert.strictEqual(result.status, 'ready_to_continue');
    assert.deepStrictEqual(result.blockingIssues, []);
  });

  test('wait maps to wait / not_ready', () => {
    const result = deriveReviewerBlockResolutionPlan(
      makeInput(makeActionPlan('wait'), makeFixTaskPlan('wait'))
    );
    assert.strictEqual(result.action, 'wait');
    assert.strictEqual(result.status, 'not_ready');
  });

  test('block_for_human maps to block_for_human / blocked', () => {
    const result = deriveReviewerBlockResolutionPlan(
      makeInput(
        makeActionPlan('block_for_human'),
        makeFixTaskPlan('block_for_human')
      )
    );
    assert.strictEqual(result.action, 'block_for_human');
    assert.strictEqual(result.status, 'blocked');
  });

  test('create_fix_task maps to append_fix_task / needs_fix', () => {
    const result = deriveReviewerBlockResolutionPlan(
      makeInput(
        makeActionPlan('create_fix_task'),
        makeFixTaskPlan('create_fix_task')
      )
    );
    assert.strictEqual(result.action, 'append_fix_task');
    assert.strictEqual(result.status, 'needs_fix');
  });

  test('append_fix_task preserves fixTask', () => {
    const fixTask = makeFixTask({ goal: 'Specific fix goal' });
    const result = deriveReviewerBlockResolutionPlan(
      makeInput(
        makeActionPlan('create_fix_task'),
        makeFixTaskPlan('create_fix_task', { fixTask })
      )
    );
    assert.strictEqual(result.fixTask?.goal, 'Specific fix goal');
    assert.strictEqual(result.fixTask?.source, 'reviewer_gate');
  });

  test('append_fix_task preserves selectedTaskId', () => {
    const result = deriveReviewerBlockResolutionPlan(
      makeInput(
        makeActionPlan('create_fix_task', { selectedTaskId: 'task-42' }),
        makeFixTaskPlan('create_fix_task')
      )
    );
    assert.strictEqual(result.selectedTaskId, 'task-42');
  });

  test('append_fix_task preserves blockingIssues from fixTaskPlan', () => {
    const result = deriveReviewerBlockResolutionPlan(
      makeInput(
        makeActionPlan('create_fix_task'),
        makeFixTaskPlan('create_fix_task', { blockingIssues: ['from plan'] })
      )
    );
    assert.deepStrictEqual(result.blockingIssues, ['from plan']);
  });

  test('append_fix_task falls back to actionPlan.blockingIssues when fixTaskPlan blockingIssues is empty', () => {
    const result = deriveReviewerBlockResolutionPlan(
      makeInput(
        makeActionPlan('create_fix_task', { blockingIssues: ['from action'] }),
        makeFixTaskPlan('create_fix_task', { blockingIssues: [] })
      )
    );
    assert.deepStrictEqual(result.blockingIssues, ['from action']);
  });

  test('block_for_human preserves selectedTaskId', () => {
    const result = deriveReviewerBlockResolutionPlan(
      makeInput(
        makeActionPlan('block_for_human', { selectedTaskId: 'task-99' }),
        makeFixTaskPlan('block_for_human')
      )
    );
    assert.strictEqual(result.selectedTaskId, 'task-99');
  });

  test('block_for_human preserves blockingIssues', () => {
    const result = deriveReviewerBlockResolutionPlan(
      makeInput(
        makeActionPlan('block_for_human'),
        makeFixTaskPlan('block_for_human', { blockingIssues: ['security'] })
      )
    );
    assert.deepStrictEqual(result.blockingIssues, ['security']);
  });

  test('wait preserves selectedTaskId', () => {
    const result = deriveReviewerBlockResolutionPlan(
      makeInput(
        makeActionPlan('wait', { selectedTaskId: 'task-wait' }),
        makeFixTaskPlan('wait')
      )
    );
    assert.strictEqual(result.selectedTaskId, 'task-wait');
  });

  test('blockId is preserved', () => {
    const result = deriveReviewerBlockResolutionPlan(
      makeInput(
        makeActionPlan('continue'),
        makeFixTaskPlan('no_fix_needed'),
        'my-block-99'
      )
    );
    assert.strictEqual(result.blockId, 'my-block-99');
  });

  test('inconsistent create_fix_task + no_fix_needed blocks for human', () => {
    const result = deriveReviewerBlockResolutionPlan(
      makeInput(
        makeActionPlan('create_fix_task'),
        makeFixTaskPlan('no_fix_needed')
      )
    );
    assert.strictEqual(result.action, 'block_for_human');
    assert.strictEqual(result.status, 'blocked');
    assert(result.reason.includes('Inconsistent'));
  });

  test('inconsistent block_for_human + no_fix_needed blocks for human', () => {
    const result = deriveReviewerBlockResolutionPlan(
      makeInput(
        makeActionPlan('block_for_human'),
        makeFixTaskPlan('no_fix_needed')
      )
    );
    assert.strictEqual(result.action, 'block_for_human');
    assert.strictEqual(result.status, 'blocked');
  });

  test('inconsistent wait + no_fix_needed waits / not_ready', () => {
    const result = deriveReviewerBlockResolutionPlan(
      makeInput(makeActionPlan('wait'), makeFixTaskPlan('no_fix_needed'))
    );
    assert.strictEqual(result.action, 'wait');
    assert.strictEqual(result.status, 'not_ready');
  });

  test('helper does not mutate input actionPlan', () => {
    const actionPlan = makeActionPlan('create_fix_task');
    const fixTaskPlan = makeFixTaskPlan('create_fix_task');
    const input = makeInput(actionPlan, fixTaskPlan);
    const inputJson = JSON.stringify(input);
    deriveReviewerBlockResolutionPlan(input);
    assert.strictEqual(JSON.stringify(input), inputJson);
  });

  test('helper does not mutate input fixTaskPlan', () => {
    const fixTaskPlan = makeFixTaskPlan('create_fix_task');
    const input = makeInput(makeActionPlan('create_fix_task'), fixTaskPlan);
    const inputJson = JSON.stringify(input);
    deriveReviewerBlockResolutionPlan(input);
    assert.strictEqual(JSON.stringify(input), inputJson);
  });

  test('helper clones fixTask draft', () => {
    const fixTask = makeFixTask();
    const result = deriveReviewerBlockResolutionPlan(
      makeInput(
        makeActionPlan('create_fix_task'),
        makeFixTaskPlan('create_fix_task', { fixTask })
      )
    );
    result.fixTask!.blockingIssues.push('mutated');
    assert.deepStrictEqual(fixTask.blockingIssues, ['bug']);
  });

  test('helper does not perform redaction or alter already-redacted text', () => {
    const fixTask = makeFixTask({
      goal: 'use sk-fake-token in fix',
      blockingIssues: ['Bearer fake-token'],
    });
    const result = deriveReviewerBlockResolutionPlan(
      makeInput(
        makeActionPlan('create_fix_task'),
        makeFixTaskPlan('create_fix_task', { fixTask, blockingIssues: ['Bearer fake-token'] })
      )
    );
    assert.strictEqual(result.fixTask?.goal, 'use sk-fake-token in fix');
    assert.deepStrictEqual(result.blockingIssues, ['Bearer fake-token']);
  });
});
