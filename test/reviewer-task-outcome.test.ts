import { describe, test } from 'node:test';
import assert from 'node:assert';
import {
  deriveReviewerTaskOutcome,
  type PersistedReviewerGate,
} from '../src/reviewer-task-outcome.js';

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

describe('deriveReviewerTaskOutcome', () => {
  test('null state returns not_ready wait', () => {
    const result = deriveReviewerTaskOutcome({ runState: null });
    assert.strictEqual(result.status, 'not_ready');
    assert.strictEqual(result.nextAction, 'wait');
    assert(result.reason.includes('missing'));
  });

  test('undefined state returns not_ready wait', () => {
    const result = deriveReviewerTaskOutcome({ runState: undefined });
    assert.strictEqual(result.status, 'not_ready');
    assert.strictEqual(result.nextAction, 'wait');
  });

  test('pending state returns not_ready wait', () => {
    const result = deriveReviewerTaskOutcome({ runState: { status: 'pending' } });
    assert.strictEqual(result.status, 'not_ready');
    assert.strictEqual(result.nextAction, 'wait');
  });

  test('failed_guardrails state returns not_ready wait', () => {
    const result = deriveReviewerTaskOutcome({
      runState: { status: 'failed_guardrails' },
    });
    assert.strictEqual(result.status, 'not_ready');
    assert.strictEqual(result.nextAction, 'wait');
  });

  test('failed_max_attempts state returns not_ready wait', () => {
    const result = deriveReviewerTaskOutcome({
      runState: { status: 'failed_max_attempts' },
    });
    assert.strictEqual(result.status, 'not_ready');
    assert.strictEqual(result.nextAction, 'wait');
  });

  test('pushed state without reviewer_gate returns legacy_success continue', () => {
    const result = deriveReviewerTaskOutcome({
      runState: { status: 'pushed', commit_sha: 'abc' },
    });
    assert.strictEqual(result.status, 'legacy_success');
    assert.strictEqual(result.nextAction, 'continue');
    assert(result.reason.includes('legacy'));
  });

  test('approved state without reviewer_gate returns legacy_success continue', () => {
    const result = deriveReviewerTaskOutcome({ runState: { status: 'approved' } });
    assert.strictEqual(result.status, 'legacy_success');
    assert.strictEqual(result.nextAction, 'continue');
  });

  test('accepted reviewer_gate returns accepted continue', () => {
    const gate = makeGate({
      status: 'accepted',
      source: 'reviewer',
      nextAction: 'continue',
      reviewSummary: 'Great work',
    });
    const result = deriveReviewerTaskOutcome({
      runState: { status: 'pushed', reviewer_gate: gate },
    });
    assert.strictEqual(result.status, 'accepted');
    assert.strictEqual(result.nextAction, 'continue');
    assert.strictEqual(result.reason, 'Great work');
  });

  test('accepted reviewer_gate preserves reviewerGate', () => {
    const gate = makeGate({ status: 'accepted' });
    const result = deriveReviewerTaskOutcome({
      runState: { status: 'pushed', reviewer_gate: gate },
    });
    assert.deepStrictEqual(result.reviewerGate, gate);
  });

  test('accepted reviewer_gate reason falls back when reviewSummary empty', () => {
    const gate = makeGate({ status: 'accepted', reviewSummary: '' });
    const result = deriveReviewerTaskOutcome({
      runState: { status: 'pushed', reviewer_gate: gate },
    });
    assert(result.reason.includes('accepted'));
  });

  test('fix_required reviewer_gate returns fix_required fix', () => {
    const gate = makeGate({
      status: 'fix_required',
      source: 'reviewer',
      nextAction: 'fix',
      reviewSummary: 'Needs fix',
    });
    const result = deriveReviewerTaskOutcome({
      runState: { status: 'pushed', reviewer_gate: gate },
    });
    assert.strictEqual(result.status, 'fix_required');
    assert.strictEqual(result.nextAction, 'fix');
  });

  test('fix_required preserves fixTask', () => {
    const gate = makeGate({
      status: 'fix_required',
      nextAction: 'fix',
      fixTask: 'fix the bug',
    });
    const result = deriveReviewerTaskOutcome({
      runState: { status: 'pushed', reviewer_gate: gate },
    });
    assert.strictEqual(result.fixTask, 'fix the bug');
  });

  test('fix_required preserves blockingIssues', () => {
    const gate = makeGate({
      status: 'fix_required',
      nextAction: 'fix',
      blockingIssues: ['bug'],
    });
    const result = deriveReviewerTaskOutcome({
      runState: { status: 'pushed', reviewer_gate: gate },
    });
    assert.deepStrictEqual(result.blockingIssues, ['bug']);
  });

  test('blocked reviewer_gate returns blocked block', () => {
    const gate = makeGate({
      status: 'blocked',
      source: 'reviewer',
      nextAction: 'block',
      reviewSummary: 'Blocked',
    });
    const result = deriveReviewerTaskOutcome({
      runState: { status: 'pushed', reviewer_gate: gate },
    });
    assert.strictEqual(result.status, 'blocked');
    assert.strictEqual(result.nextAction, 'block');
  });

  test('blocked preserves blockingIssues', () => {
    const gate = makeGate({
      status: 'blocked',
      nextAction: 'block',
      blockingIssues: ['unsafe'],
    });
    const result = deriveReviewerTaskOutcome({
      runState: { status: 'pushed', reviewer_gate: gate },
    });
    assert.deepStrictEqual(result.blockingIssues, ['unsafe']);
  });

  test('parser-sourced blocked gate returns blocked block', () => {
    const gate = makeGate({
      status: 'blocked',
      source: 'parser',
      nextAction: 'block',
    });
    const result = deriveReviewerTaskOutcome({
      runState: { status: 'pushed', reviewer_gate: gate },
    });
    assert.strictEqual(result.status, 'blocked');
    assert.strictEqual(result.nextAction, 'block');
    assert.strictEqual(result.reviewerGate?.source, 'parser');
  });

  test('deterministic_safety-sourced blocked gate returns blocked block', () => {
    const gate = makeGate({
      status: 'blocked',
      source: 'deterministic_safety',
      nextAction: 'block',
    });
    const result = deriveReviewerTaskOutcome({
      runState: { status: 'pushed', reviewer_gate: gate },
    });
    assert.strictEqual(result.status, 'blocked');
    assert.strictEqual(result.reviewerGate?.source, 'deterministic_safety');
  });

  test('provider-sourced blocked gate returns blocked block', () => {
    const gate = makeGate({
      status: 'blocked',
      source: 'provider',
      nextAction: 'block',
    });
    const result = deriveReviewerTaskOutcome({
      runState: { status: 'pushed', reviewer_gate: gate },
    });
    assert.strictEqual(result.status, 'blocked');
    assert.strictEqual(result.reviewerGate?.source, 'provider');
  });

  test('helper does not mutate input state', () => {
    const gate = makeGate({
      status: 'fix_required',
      nextAction: 'fix',
      blockingIssues: ['original'],
    });
    const input = { runState: { status: 'pushed', reviewer_gate: gate } };
    const inputJson = JSON.stringify(input);
    deriveReviewerTaskOutcome(input);
    assert.strictEqual(
      JSON.stringify(input),
      inputJson,
      'Input should not be mutated'
    );
  });

  test('helper does not mutate input blockingIssues array', () => {
    const blockingIssues = ['original'];
    const gate = makeGate({
      status: 'blocked',
      nextAction: 'block',
      blockingIssues,
    });
    const input = { runState: { status: 'pushed', reviewer_gate: gate } };
    const result = deriveReviewerTaskOutcome(input);
    result.blockingIssues.push('mutated');
    assert.deepStrictEqual(blockingIssues, ['original']);
  });
});
