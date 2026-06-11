import { describe, test } from 'node:test';
import assert from 'node:assert';
import { deriveReviewerBlockDecision } from '../src/reviewer-block-decision.js';
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
) {
  return {
    taskId,
    runState,
    ...overrides,
  };
}

function makeInput(tasks: ReturnType<typeof makeTask>[], blockId = 'block-1') {
  return { blockId, tasks };
}

describe('deriveReviewerBlockDecision', () => {
  test('empty tasks returns no taskDecisions and actionPlan wait', () => {
    const result = deriveReviewerBlockDecision(makeInput([]));
    assert.deepStrictEqual(result.taskDecisions, []);
    assert.strictEqual(result.actionPlan.action, 'wait');
    assert.strictEqual(result.blockId, 'block-1');
  });

  test('one committed task without reviewer_gate creates legacy_success task decision', () => {
    const result = deriveReviewerBlockDecision(
      makeInput([makeTask('t-1', { status: 'committed', commit_sha: 'abc' })])
    );
    assert.strictEqual(result.taskDecisions.length, 1);
    assert.strictEqual(result.taskDecisions[0].outcome.status, 'legacy_success');
    assert.strictEqual(result.taskDecisions[0].transition.action, 'continue');
  });

  test('one pushed task without reviewer_gate creates legacy_success task decision', () => {
    const result = deriveReviewerBlockDecision(
      makeInput([makeTask('t-1', { status: 'pushed', commit_sha: 'abc' })])
    );
    assert.strictEqual(result.taskDecisions[0].outcome.status, 'legacy_success');
    assert.strictEqual(result.actionPlan.action, 'continue');
  });

  test('all accepted/legacy_success tasks produce actionPlan continue', () => {
    const result = deriveReviewerBlockDecision(
      makeInput([
        makeTask('t-1', { status: 'pushed' }),
        makeTask('t-2', {
          status: 'pushed',
          reviewer_gate: makeGate(),
        }),
      ])
    );
    assert.strictEqual(result.actionPlan.action, 'continue');
  });

  test('pending task produces task decision not_ready and actionPlan wait', () => {
    const result = deriveReviewerBlockDecision(
      makeInput([
        makeTask('t-1', { status: 'pushed' }),
        makeTask('t-2', { status: 'pending' }),
      ])
    );
    assert.strictEqual(result.taskDecisions[1].outcome.status, 'not_ready');
    assert.strictEqual(result.actionPlan.action, 'wait');
  });

  test('accepted reviewer_gate produces accepted task decision and actionPlan continue', () => {
    const result = deriveReviewerBlockDecision(
      makeInput([
        makeTask('t-1', {
          status: 'pushed',
          reviewer_gate: makeGate({
            status: 'accepted',
            source: 'reviewer',
            nextAction: 'continue',
          }),
        }),
      ])
    );
    assert.strictEqual(result.taskDecisions[0].outcome.status, 'accepted');
    assert.strictEqual(result.actionPlan.action, 'continue');
  });

  test('fix_required reviewer_gate produces fix_required task decision and actionPlan create_fix_task', () => {
    const result = deriveReviewerBlockDecision(
      makeInput([
        makeTask('t-1', {
          status: 'pushed',
          reviewer_gate: makeGate({
            status: 'fix_required',
            source: 'reviewer',
            nextAction: 'fix',
            reviewSummary: 'Needs fix',
          }),
        }),
      ])
    );
    assert.strictEqual(result.taskDecisions[0].outcome.status, 'fix_required');
    assert.strictEqual(result.actionPlan.action, 'create_fix_task');
  });

  test('fix_required preserves taskId in transition', () => {
    const result = deriveReviewerBlockDecision(
      makeInput([
        makeTask('t-fix-123', {
          status: 'pushed',
          reviewer_gate: makeGate({
            status: 'fix_required',
            nextAction: 'fix',
          }),
        }),
      ])
    );
    assert.strictEqual(result.actionPlan.selectedTaskId, 't-fix-123');
    assert.strictEqual(result.actionPlan.selectedTransition?.taskId, 't-fix-123');
  });

  test('fix_required uses taskTitle in generated fix task title', () => {
    const result = deriveReviewerBlockDecision(
      makeInput([
        makeTask(
          't-fix-123',
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
      result.actionPlan.selectedTransition?.fixTask?.title,
      'Fix reviewer issues for Important Task'
    );
  });

  test('fix_required uses reviewer fixTask as generated fix task goal', () => {
    const result = deriveReviewerBlockDecision(
      makeInput([
        makeTask('t-fix-123', {
          status: 'pushed',
          reviewer_gate: makeGate({
            status: 'fix_required',
            nextAction: 'fix',
            fixTask: 'Fix the parser',
          }),
        }),
      ])
    );
    assert.strictEqual(
      result.actionPlan.selectedTransition?.fixTask?.goal,
      'Fix the parser'
    );
  });

  test('fix_required without reviewer fixTask falls back to blockingIssues', () => {
    const result = deriveReviewerBlockDecision(
      makeInput([
        makeTask('t-fix-123', {
          status: 'pushed',
          reviewer_gate: makeGate({
            status: 'fix_required',
            nextAction: 'fix',
            blockingIssues: ['missing tests', 'syntax error'],
          }),
        }),
      ])
    );
    assert.strictEqual(
      result.actionPlan.selectedTransition?.fixTask?.goal,
      'Fix reviewer blocking issues: missing tests; syntax error'
    );
  });

  test('blocked reviewer_gate produces blocked task decision and actionPlan block_for_human', () => {
    const result = deriveReviewerBlockDecision(
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
    assert.strictEqual(result.taskDecisions[0].outcome.status, 'blocked');
    assert.strictEqual(result.actionPlan.action, 'block_for_human');
  });

  test('parser-sourced blocked gate is handled', () => {
    const result = deriveReviewerBlockDecision(
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
    assert.strictEqual(result.actionPlan.action, 'block_for_human');
    assert.strictEqual(
      result.taskDecisions[0].outcome.reviewerGate?.source,
      'parser'
    );
  });

  test('deterministic_safety-sourced blocked gate is handled', () => {
    const result = deriveReviewerBlockDecision(
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
      result.taskDecisions[0].outcome.reviewerGate?.source,
      'deterministic_safety'
    );
  });

  test('provider-sourced blocked gate is handled', () => {
    const result = deriveReviewerBlockDecision(
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
      result.taskDecisions[0].outcome.reviewerGate?.source,
      'provider'
    );
  });

  test('block_for_human priority beats create_fix_task', () => {
    const result = deriveReviewerBlockDecision(
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
    assert.strictEqual(result.actionPlan.action, 'block_for_human');
    assert.strictEqual(result.actionPlan.selectedTaskId, 't-block');
  });

  test('create_fix_task priority beats wait', () => {
    const result = deriveReviewerBlockDecision(
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
    assert.strictEqual(result.actionPlan.action, 'create_fix_task');
    assert.strictEqual(result.actionPlan.selectedTaskId, 't-fix');
  });

  test('wait priority beats continue', () => {
    const result = deriveReviewerBlockDecision(
      makeInput([
        makeTask('t-continue', { status: 'pushed' }),
        makeTask('t-wait', { status: 'pending' }),
      ])
    );
    assert.strictEqual(result.actionPlan.action, 'wait');
    assert.strictEqual(result.actionPlan.selectedTaskId, 't-wait');
  });

  test('first matching priority task is selected', () => {
    const result = deriveReviewerBlockDecision(
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
    assert.strictEqual(result.actionPlan.selectedTaskId, 'first-block');
  });

  test('blockId is preserved', () => {
    const result = deriveReviewerBlockDecision(makeInput([], 'my-block-99'));
    assert.strictEqual(result.blockId, 'my-block-99');
  });

  test('blockingIssues are preserved', () => {
    const result = deriveReviewerBlockDecision(
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
    assert.deepStrictEqual(result.actionPlan.blockingIssues, ['bug A', 'bug B']);
    assert.deepStrictEqual(
      result.actionPlan.selectedTransition?.blockingIssues,
      ['bug A', 'bug B']
    );
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
    deriveReviewerBlockDecision(input);
    assert.strictEqual(JSON.stringify(input), inputJson);
  });

  test('helper does not perform redaction or alter already-redacted text', () => {
    const result = deriveReviewerBlockDecision(
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
    assert.strictEqual(
      result.actionPlan.selectedTransition?.fixTask?.goal,
      'use sk-fake-token in fix'
    );
    assert.deepStrictEqual(result.actionPlan.blockingIssues, ['Bearer fake-token']);
  });
});
