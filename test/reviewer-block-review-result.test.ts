import { describe, test } from 'node:test';
import assert from 'node:assert';
import { deriveReviewerBlockReviewResult } from '../src/reviewer-block-review-result.js';
import type { ReviewerBlockTaskInput } from '../src/reviewer-block-decision.js';
import type { PersistedReviewerGate } from '../src/reviewer-task-outcome.js';

function makeGate(
  overrides: Partial<PersistedReviewerGate> = {}
): PersistedReviewerGate {
  return {
    status: 'accepted',
    source: 'reviewer',
    nextAction: 'continue',
    blockingIssues: [],
    nonBlockingIssues: [],
    reviewSummary: 'Looks good',
    ...overrides,
  };
}

function makeTask(
  taskId: string,
  runState: {
    status?: string;
    reviewer_gate?: PersistedReviewerGate;
  } | null,
  overrides: Record<string, unknown> = {}
): ReviewerBlockTaskInput {
  return {
    taskId,
    runState,
    ...overrides,
  };
}

function makeInput(
  tasks: ReviewerBlockTaskInput[],
  blockId = 'block-1',
  maxFixAttempts = 3,
  existingFixAttemptsByParentTaskId?: Record<string, number>
) {
  return {
    blockId,
    tasks,
    maxFixAttempts,
    existingFixAttemptsByParentTaskId,
  };
}

describe('deriveReviewerBlockReviewResult', () => {
  test('empty tasks maps to wait / wait / wait', () => {
    const result = deriveReviewerBlockReviewResult(makeInput([]));
    assert.strictEqual(result.blockDecision.actionPlan.action, 'wait');
    assert.strictEqual(result.fixTaskPlan.action, 'wait');
    assert.strictEqual(result.resolutionPlan.action, 'wait');
  });

  test('committed task without reviewer_gate maps to continue / no_fix_needed / continue_block', () => {
    const result = deriveReviewerBlockReviewResult(
      makeInput([makeTask('t-1', { status: 'committed', commit_sha: 'abc' })])
    );
    assert.strictEqual(result.blockDecision.actionPlan.action, 'continue');
    assert.strictEqual(result.fixTaskPlan.action, 'no_fix_needed');
    assert.strictEqual(result.resolutionPlan.action, 'continue_block');
  });

  test('pushed task without reviewer_gate maps to continue / no_fix_needed / continue_block', () => {
    const result = deriveReviewerBlockReviewResult(
      makeInput([makeTask('t-1', { status: 'pushed', commit_sha: 'abc' })])
    );
    assert.strictEqual(result.blockDecision.actionPlan.action, 'continue');
    assert.strictEqual(result.fixTaskPlan.action, 'no_fix_needed');
    assert.strictEqual(result.resolutionPlan.action, 'continue_block');
  });

  test('accepted reviewer_gate maps to continue / no_fix_needed / continue_block', () => {
    const result = deriveReviewerBlockReviewResult(
      makeInput([
        makeTask('t-1', {
          status: 'pushed',
          reviewer_gate: makeGate(),
        }),
      ])
    );
    assert.strictEqual(result.blockDecision.actionPlan.action, 'continue');
    assert.strictEqual(result.fixTaskPlan.action, 'no_fix_needed');
    assert.strictEqual(result.resolutionPlan.action, 'continue_block');
  });

  test('pending task maps to wait / wait / wait', () => {
    const result = deriveReviewerBlockReviewResult(
      makeInput([makeTask('t-1', { status: 'pending' })])
    );
    assert.strictEqual(result.blockDecision.actionPlan.action, 'wait');
    assert.strictEqual(result.fixTaskPlan.action, 'wait');
    assert.strictEqual(result.resolutionPlan.action, 'wait');
  });

  test('fix_required reviewer_gate within max attempts maps to create_fix_task / create_fix_task / append_fix_task', () => {
    const result = deriveReviewerBlockReviewResult(
      makeInput([
        makeTask('t-1', {
          status: 'pushed',
          reviewer_gate: makeGate({
            status: 'fix_required',
            source: 'reviewer',
            nextAction: 'fix',
            fixTask: 'Fix it',
          }),
        }),
      ])
    );
    assert.strictEqual(result.blockDecision.actionPlan.action, 'create_fix_task');
    assert.strictEqual(result.fixTaskPlan.action, 'create_fix_task');
    assert.strictEqual(result.resolutionPlan.action, 'append_fix_task');
  });

  test('fix_required generated fixTask uses taskTitle in title', () => {
    const result = deriveReviewerBlockReviewResult(
      makeInput([
        makeTask(
          't-1',
          {
            status: 'pushed',
            reviewer_gate: makeGate({
              status: 'fix_required',
              nextAction: 'fix',
            }),
          },
          { taskTitle: 'Important Task' }
        ),
      ])
    );
    assert.strictEqual(
      result.fixTaskPlan.fixTask?.title,
      'Fix reviewer issues for Important Task'
    );
  });

  test('fix_required generated fixTask uses reviewer fixTask as goal', () => {
    const result = deriveReviewerBlockReviewResult(
      makeInput([
        makeTask('t-1', {
          status: 'pushed',
          reviewer_gate: makeGate({
            status: 'fix_required',
            nextAction: 'fix',
            fixTask: 'Specific fix goal',
          }),
        }),
      ])
    );
    assert.strictEqual(result.fixTaskPlan.fixTask?.goal, 'Specific fix goal');
    assert.strictEqual(result.resolutionPlan.fixTask?.goal, 'Specific fix goal');
  });

  test('fix_required generated fixTask preserves parentTaskId', () => {
    const result = deriveReviewerBlockReviewResult(
      makeInput([
        makeTask('t-1', {
          status: 'pushed',
          reviewer_gate: makeGate({
            status: 'fix_required',
            nextAction: 'fix',
          }),
        }),
      ])
    );
    assert.strictEqual(result.fixTaskPlan.fixTask?.parentTaskId, 't-1');
  });

  test('fix_required generated fixTask has deterministic taskId', () => {
    const result = deriveReviewerBlockReviewResult(
      makeInput([
        makeTask('t-1', {
          status: 'pushed',
          reviewer_gate: makeGate({
            status: 'fix_required',
            nextAction: 'fix',
          }),
        }),
      ])
    );
    assert.strictEqual(result.fixTaskPlan.fixTask?.taskId, 'fix-t-1-reviewer-1');
  });

  test('fix_required generated fixTask attempt uses existing attempts + 1', () => {
    const result = deriveReviewerBlockReviewResult(
      makeInput(
        [
          makeTask('t-1', {
            status: 'pushed',
            reviewer_gate: makeGate({
              status: 'fix_required',
              nextAction: 'fix',
            }),
          }),
        ],
        'block-1',
        3,
        { 't-1': 2 }
      )
    );
    assert.strictEqual(result.fixTaskPlan.fixTask?.attempt, 3);
    assert.strictEqual(result.fixTaskPlan.fixTask?.taskId, 'fix-t-1-reviewer-3');
  });

  test('fix_required beyond max attempts maps to create_fix_task / block_for_human / block_for_human', () => {
    const result = deriveReviewerBlockReviewResult(
      makeInput(
        [
          makeTask('t-1', {
            status: 'pushed',
            reviewer_gate: makeGate({
              status: 'fix_required',
              nextAction: 'fix',
            }),
          }),
        ],
        'block-1',
        3,
        { 't-1': 3 }
      )
    );
    assert.strictEqual(result.blockDecision.actionPlan.action, 'create_fix_task');
    assert.strictEqual(result.fixTaskPlan.action, 'block_for_human');
    assert.strictEqual(result.resolutionPlan.action, 'block_for_human');
  });

  test('blocked reviewer_gate maps to block_for_human / block_for_human / block_for_human', () => {
    const result = deriveReviewerBlockReviewResult(
      makeInput([
        makeTask('t-1', {
          status: 'pushed',
          reviewer_gate: makeGate({
            status: 'blocked',
            source: 'reviewer',
            nextAction: 'block',
          }),
        }),
      ])
    );
    assert.strictEqual(result.blockDecision.actionPlan.action, 'block_for_human');
    assert.strictEqual(result.fixTaskPlan.action, 'block_for_human');
    assert.strictEqual(result.resolutionPlan.action, 'block_for_human');
  });

  test('parser-sourced blocked gate maps to block_for_human / block_for_human / block_for_human', () => {
    const result = deriveReviewerBlockReviewResult(
      makeInput([
        makeTask('t-1', {
          status: 'pushed',
          reviewer_gate: makeGate({
            status: 'blocked',
            source: 'parser',
            nextAction: 'block',
          }),
        }),
      ])
    );
    assert.strictEqual(
      result.blockDecision.taskDecisions[0].outcome.reviewerGate?.source,
      'parser'
    );
    assert.strictEqual(result.resolutionPlan.action, 'block_for_human');
  });

  test('deterministic_safety-sourced blocked gate maps to block_for_human / block_for_human / block_for_human', () => {
    const result = deriveReviewerBlockReviewResult(
      makeInput([
        makeTask('t-1', {
          status: 'pushed',
          reviewer_gate: makeGate({
            status: 'blocked',
            source: 'deterministic_safety',
            nextAction: 'block',
          }),
        }),
      ])
    );
    assert.strictEqual(
      result.blockDecision.taskDecisions[0].outcome.reviewerGate?.source,
      'deterministic_safety'
    );
    assert.strictEqual(result.resolutionPlan.action, 'block_for_human');
  });

  test('provider-sourced blocked gate maps to block_for_human / block_for_human / block_for_human', () => {
    const result = deriveReviewerBlockReviewResult(
      makeInput([
        makeTask('t-1', {
          status: 'pushed',
          reviewer_gate: makeGate({
            status: 'blocked',
            source: 'provider',
            nextAction: 'block',
          }),
        }),
      ])
    );
    assert.strictEqual(
      result.blockDecision.taskDecisions[0].outcome.reviewerGate?.source,
      'provider'
    );
    assert.strictEqual(result.resolutionPlan.action, 'block_for_human');
  });

  test('block_for_human priority beats create_fix_task', () => {
    const result = deriveReviewerBlockReviewResult(
      makeInput([
        makeTask('t-fix', {
          status: 'pushed',
          reviewer_gate: makeGate({
            status: 'fix_required',
            nextAction: 'fix',
          }),
        }),
        makeTask('t-block', {
          status: 'pushed',
          reviewer_gate: makeGate({
            status: 'blocked',
            nextAction: 'block',
          }),
        }),
      ])
    );
    assert.strictEqual(result.resolutionPlan.action, 'block_for_human');
    assert.strictEqual(result.resolutionPlan.selectedTaskId, 't-block');
  });

  test('create_fix_task priority beats wait', () => {
    const result = deriveReviewerBlockReviewResult(
      makeInput([
        makeTask('t-wait', { status: 'pending' }),
        makeTask('t-fix', {
          status: 'pushed',
          reviewer_gate: makeGate({
            status: 'fix_required',
            nextAction: 'fix',
          }),
        }),
      ])
    );
    assert.strictEqual(result.resolutionPlan.action, 'append_fix_task');
    assert.strictEqual(result.resolutionPlan.selectedTaskId, 't-fix');
  });

  test('wait priority beats continue', () => {
    const result = deriveReviewerBlockReviewResult(
      makeInput([
        makeTask('t-continue', { status: 'pushed' }),
        makeTask('t-wait', { status: 'pending' }),
      ])
    );
    assert.strictEqual(result.resolutionPlan.action, 'wait');
    assert.strictEqual(result.resolutionPlan.selectedTaskId, 't-wait');
  });

  test('first matching priority task is selected', () => {
    const result = deriveReviewerBlockReviewResult(
      makeInput([
        makeTask('first-block', {
          status: 'pushed',
          reviewer_gate: makeGate({
            status: 'blocked',
            nextAction: 'block',
          }),
        }),
        makeTask('second-block', {
          status: 'pushed',
          reviewer_gate: makeGate({
            status: 'blocked',
            nextAction: 'block',
          }),
        }),
      ])
    );
    assert.strictEqual(result.resolutionPlan.selectedTaskId, 'first-block');
  });

  test('blockId is preserved across all result objects', () => {
    const result = deriveReviewerBlockReviewResult(makeInput([], 'my-block-99'));
    assert.strictEqual(result.blockId, 'my-block-99');
    assert.strictEqual(result.blockDecision.blockId, 'my-block-99');
    assert.strictEqual(result.fixTaskPlan.blockId, 'my-block-99');
    assert.strictEqual(result.resolutionPlan.blockId, 'my-block-99');
  });

  test('blockingIssues are preserved through blockDecision, fixTaskPlan, and resolutionPlan', () => {
    const result = deriveReviewerBlockReviewResult(
      makeInput([
        makeTask('t-1', {
          status: 'pushed',
          reviewer_gate: makeGate({
            status: 'fix_required',
            nextAction: 'fix',
            blockingIssues: ['bug A', 'bug B'],
          }),
        }),
      ])
    );
    assert.deepStrictEqual(
      result.blockDecision.actionPlan.blockingIssues,
      ['bug A', 'bug B']
    );
    assert.deepStrictEqual(result.fixTaskPlan.blockingIssues, ['bug A', 'bug B']);
    assert.deepStrictEqual(result.resolutionPlan.blockingIssues, ['bug A', 'bug B']);
  });

  test('helper does not mutate input', () => {
    const gate = makeGate({
      status: 'fix_required',
      nextAction: 'fix',
      blockingIssues: ['original'],
    });
    const input = makeInput([
      makeTask('t-1', { status: 'pushed', reviewer_gate: gate }),
    ]);
    const inputJson = JSON.stringify(input);
    deriveReviewerBlockReviewResult(input);
    assert.strictEqual(JSON.stringify(input), inputJson);
  });

  test('helper does not perform redaction or alter already-redacted text', () => {
    const result = deriveReviewerBlockReviewResult(
      makeInput([
        makeTask('t-1', {
          status: 'pushed',
          reviewer_gate: makeGate({
            status: 'fix_required',
            nextAction: 'fix',
            fixTask: 'use sk-fake-token in fix',
            blockingIssues: ['Bearer fake-token'],
          }),
        }),
      ])
    );
    assert.strictEqual(result.fixTaskPlan.fixTask?.goal, 'use sk-fake-token in fix');
    assert.deepStrictEqual(result.resolutionPlan.blockingIssues, ['Bearer fake-token']);
  });
});
