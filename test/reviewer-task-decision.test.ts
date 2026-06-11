import { describe, test } from 'node:test';
import assert from 'node:assert';
import { deriveReviewerTaskDecision } from '../src/reviewer-task-decision.js';
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

function makeInput(overrides: Record<string, unknown> = {}) {
  return {
    runState: { status: 'pushed' } as
      | { status?: string; reviewer_gate?: PersistedReviewerGate }
      | null,
    originalTaskId: 'task-123',
    ...overrides,
  };
}

describe('deriveReviewerTaskDecision', () => {
  test('null state produces outcome not_ready and transition wait', () => {
    const result = deriveReviewerTaskDecision(makeInput({ runState: null }));
    assert.strictEqual(result.outcome.status, 'not_ready');
    assert.strictEqual(result.outcome.nextAction, 'wait');
    assert.strictEqual(result.transition.action, 'wait');
    assert.strictEqual(result.transition.taskId, 'task-123');
  });

  test('undefined state produces outcome not_ready and transition wait', () => {
    const result = deriveReviewerTaskDecision(
      makeInput({ runState: undefined })
    );
    assert.strictEqual(result.outcome.status, 'not_ready');
    assert.strictEqual(result.transition.action, 'wait');
  });

  test('pending state produces outcome not_ready and transition wait', () => {
    const result = deriveReviewerTaskDecision(
      makeInput({ runState: { status: 'pending' } })
    );
    assert.strictEqual(result.outcome.status, 'not_ready');
    assert.strictEqual(result.transition.action, 'wait');
  });

  test('committed state without reviewer_gate produces legacy_success and continue', () => {
    const result = deriveReviewerTaskDecision(
      makeInput({ runState: { status: 'committed', commit_sha: 'abc' } })
    );
    assert.strictEqual(result.outcome.status, 'legacy_success');
    assert.strictEqual(result.transition.action, 'continue');
  });

  test('pushed state without reviewer_gate produces legacy_success and continue', () => {
    const result = deriveReviewerTaskDecision(
      makeInput({ runState: { status: 'pushed', commit_sha: 'abc' } })
    );
    assert.strictEqual(result.outcome.status, 'legacy_success');
    assert.strictEqual(result.transition.action, 'continue');
  });

  test('accepted reviewer_gate produces accepted and continue', () => {
    const result = deriveReviewerTaskDecision(
      makeInput({
        runState: { status: 'pushed', reviewer_gate: makeGate() },
      })
    );
    assert.strictEqual(result.outcome.status, 'accepted');
    assert.strictEqual(result.transition.action, 'continue');
  });

  test('fix_required reviewer_gate produces fix_required and create_fix_task', () => {
    const result = deriveReviewerTaskDecision(
      makeInput({
        runState: {
          status: 'pushed',
          reviewer_gate: makeGate({
            status: 'fix_required',
            source: 'reviewer',
            nextAction: 'fix',
            reviewSummary: 'Needs fix',
          }),
        },
      })
    );
    assert.strictEqual(result.outcome.status, 'fix_required');
    assert.strictEqual(result.transition.action, 'create_fix_task');
  });

  test('fix_required creates fixTask', () => {
    const result = deriveReviewerTaskDecision(
      makeInput({
        runState: {
          status: 'pushed',
          reviewer_gate: makeGate({
            status: 'fix_required',
            nextAction: 'fix',
          }),
        },
      })
    );
    assert(result.transition.fixTask !== undefined);
    assert.strictEqual(result.transition.fixTask.parentTaskId, 'task-123');
  });

  test('fixTask parentTaskId equals originalTaskId', () => {
    const result = deriveReviewerTaskDecision(
      makeInput({
        originalTaskId: 'parent-42',
        runState: {
          status: 'pushed',
          reviewer_gate: makeGate({
            status: 'fix_required',
            nextAction: 'fix',
          }),
        },
      })
    );
    assert.strictEqual(result.transition.fixTask?.parentTaskId, 'parent-42');
  });

  test('fixTask title uses originalTaskTitle when present', () => {
    const result = deriveReviewerTaskDecision(
      makeInput({
        originalTaskId: 'task-abc',
        originalTaskTitle: 'My Task',
        runState: {
          status: 'pushed',
          reviewer_gate: makeGate({
            status: 'fix_required',
            nextAction: 'fix',
          }),
        },
      })
    );
    assert.strictEqual(
      result.transition.fixTask?.title,
      'Fix reviewer issues for My Task'
    );
  });

  test('fixTask goal uses reviewer fixTask when present', () => {
    const result = deriveReviewerTaskDecision(
      makeInput({
        runState: {
          status: 'pushed',
          reviewer_gate: makeGate({
            status: 'fix_required',
            nextAction: 'fix',
            fixTask: 'Fix the broken parser',
          }),
        },
      })
    );
    assert.strictEqual(
      result.transition.fixTask?.goal,
      'Fix the broken parser'
    );
  });

  test('fix_required without fixTask falls back to blockingIssues', () => {
    const result = deriveReviewerTaskDecision(
      makeInput({
        runState: {
          status: 'pushed',
          reviewer_gate: makeGate({
            status: 'fix_required',
            nextAction: 'fix',
            blockingIssues: ['missing tests', 'syntax error'],
          }),
        },
      })
    );
    assert.strictEqual(
      result.transition.fixTask?.goal,
      'Fix reviewer blocking issues: missing tests; syntax error'
    );
  });

  test('blocked reviewer_gate produces blocked and block_for_human', () => {
    const result = deriveReviewerTaskDecision(
      makeInput({
        runState: {
          status: 'pushed',
          reviewer_gate: makeGate({
            status: 'blocked',
            source: 'reviewer',
            nextAction: 'block',
            reviewSummary: 'Blocked',
          }),
        },
      })
    );
    assert.strictEqual(result.outcome.status, 'blocked');
    assert.strictEqual(result.transition.action, 'block_for_human');
  });

  test('parser-sourced blocked gate produces blocked and block_for_human', () => {
    const result = deriveReviewerTaskDecision(
      makeInput({
        runState: {
          status: 'pushed',
          reviewer_gate: makeGate({
            status: 'blocked',
            source: 'parser',
            nextAction: 'block',
          }),
        },
      })
    );
    assert.strictEqual(result.outcome.reviewerGate?.source, 'parser');
    assert.strictEqual(result.transition.action, 'block_for_human');
  });

  test('deterministic_safety-sourced blocked gate produces blocked and block_for_human', () => {
    const result = deriveReviewerTaskDecision(
      makeInput({
        runState: {
          status: 'pushed',
          reviewer_gate: makeGate({
            status: 'blocked',
            source: 'deterministic_safety',
            nextAction: 'block',
          }),
        },
      })
    );
    assert.strictEqual(result.outcome.reviewerGate?.source, 'deterministic_safety');
    assert.strictEqual(result.transition.action, 'block_for_human');
  });

  test('provider-sourced blocked gate produces blocked and block_for_human', () => {
    const result = deriveReviewerTaskDecision(
      makeInput({
        runState: {
          status: 'pushed',
          reviewer_gate: makeGate({
            status: 'blocked',
            source: 'provider',
            nextAction: 'block',
          }),
        },
      })
    );
    assert.strictEqual(result.outcome.reviewerGate?.source, 'provider');
    assert.strictEqual(result.transition.action, 'block_for_human');
  });

  test('blockingIssues are preserved in outcome and transition', () => {
    const result = deriveReviewerTaskDecision(
      makeInput({
        runState: {
          status: 'pushed',
          reviewer_gate: makeGate({
            status: 'fix_required',
            nextAction: 'fix',
            blockingIssues: ['bug A', 'bug B'],
          }),
        },
      })
    );
    assert.deepStrictEqual(result.outcome.blockingIssues, ['bug A', 'bug B']);
    assert.deepStrictEqual(result.transition.blockingIssues, ['bug A', 'bug B']);
    assert.deepStrictEqual(result.transition.fixTask?.blockingIssues, [
      'bug A',
      'bug B',
    ]);
  });

  test('composer does not mutate input', () => {
    const gate = makeGate({
      status: 'fix_required',
      nextAction: 'fix',
      blockingIssues: ['original'],
    });
    const input = makeInput({
      runState: { status: 'pushed', reviewer_gate: gate },
    });
    const inputJson = JSON.stringify(input);
    deriveReviewerTaskDecision(input);
    assert.strictEqual(JSON.stringify(input), inputJson);
  });

  test('composer does not perform redaction or alter already-redacted text', () => {
    const result = deriveReviewerTaskDecision(
      makeInput({
        runState: {
          status: 'pushed',
          reviewer_gate: makeGate({
            status: 'fix_required',
            nextAction: 'fix',
            fixTask: 'use sk-fake-token in fix',
            blockingIssues: ['Bearer fake-token'],
          }),
        },
      })
    );
    assert.strictEqual(result.transition.fixTask?.goal, 'use sk-fake-token in fix');
    assert.deepStrictEqual(result.transition.blockingIssues, ['Bearer fake-token']);
    assert.deepStrictEqual(result.outcome.blockingIssues, ['Bearer fake-token']);
  });
});
