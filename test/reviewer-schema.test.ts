import { describe, test } from 'node:test';
import assert from 'node:assert';
import { validateReviewerDecision } from '../src/reviewer/reviewer-schema.js';

describe('reviewer-schema', () => {
  test('accepted decision passes', () => {
    const result = validateReviewerDecision({
      decision: 'accepted',
      confidence: 'high',
      blocking_issues: [],
      non_blocking_issues: ['suggestion'],
      review_summary: 'Looks good',
      fix_task: null,
      next_action: 'advance_to_next_task',
    });
    assert.strictEqual(result.decision, 'accepted');
    assert.strictEqual(result.next_action, 'advance_to_next_task');
    assert.deepStrictEqual(result.blocking_issues, []);
  });

  test('rejected decision with blocking issue passes', () => {
    const result = validateReviewerDecision({
      decision: 'rejected',
      confidence: 'medium',
      blocking_issues: ['Missing tests'],
      non_blocking_issues: [],
      review_summary: 'Needs work',
      fix_task: null,
      next_action: 'send_fix_to_coder',
    });
    assert.strictEqual(result.decision, 'rejected');
    assert.deepStrictEqual(result.blocking_issues, ['Missing tests']);
  });

  test('rejected decision with fix_task passes', () => {
    const result = validateReviewerDecision({
      decision: 'rejected',
      confidence: 'low',
      blocking_issues: [],
      non_blocking_issues: [],
      review_summary: 'Needs fix',
      fix_task: 'Add error handling',
      next_action: 'block_for_human',
    });
    assert.strictEqual(result.decision, 'rejected');
    assert.strictEqual(result.fix_task, 'Add error handling');
  });

  test('missing decision fails', () => {
    assert.throws(
      () =>
        validateReviewerDecision({
          confidence: 'high',
          blocking_issues: [],
          non_blocking_issues: [],
          review_summary: 'x',
          fix_task: null,
          next_action: 'advance_to_next_task',
        }),
      /decision must be/
    );
  });

  test('unknown decision fails', () => {
    assert.throws(
      () =>
        validateReviewerDecision({
          decision: 'maybe',
          confidence: 'high',
          blocking_issues: [],
          non_blocking_issues: [],
          review_summary: 'x',
          fix_task: null,
          next_action: 'advance_to_next_task',
        }),
      /decision must be/
    );
  });

  test('missing confidence fails', () => {
    assert.throws(
      () =>
        validateReviewerDecision({
          decision: 'accepted',
          blocking_issues: [],
          non_blocking_issues: [],
          review_summary: 'x',
          fix_task: null,
          next_action: 'advance_to_next_task',
        }),
      /confidence must be/
    );
  });

  test('missing blocking_issues fails', () => {
    assert.throws(
      () =>
        validateReviewerDecision({
          decision: 'accepted',
          confidence: 'high',
          non_blocking_issues: [],
          review_summary: 'x',
          fix_task: null,
          next_action: 'advance_to_next_task',
        }),
      /blocking_issues must be/
    );
  });

  test('blocking_issues not array fails', () => {
    assert.throws(
      () =>
        validateReviewerDecision({
          decision: 'accepted',
          confidence: 'high',
          blocking_issues: 'none',
          non_blocking_issues: [],
          review_summary: 'x',
          fix_task: null,
          next_action: 'advance_to_next_task',
        }),
      /blocking_issues must be an array/
    );
  });

  test('non_blocking_issues not array fails', () => {
    assert.throws(
      () =>
        validateReviewerDecision({
          decision: 'accepted',
          confidence: 'high',
          blocking_issues: [],
          non_blocking_issues: 'none',
          review_summary: 'x',
          fix_task: null,
          next_action: 'advance_to_next_task',
        }),
      /non_blocking_issues must be an array/
    );
  });

  test('accepted with blocking_issues fails', () => {
    assert.throws(
      () =>
        validateReviewerDecision({
          decision: 'accepted',
          confidence: 'high',
          blocking_issues: ['issue'],
          non_blocking_issues: [],
          review_summary: 'x',
          fix_task: null,
          next_action: 'advance_to_next_task',
        }),
      /Accepted decision must have empty blocking_issues/
    );
  });

  test('rejected without blocking_issues and without fix_task fails', () => {
    assert.throws(
      () =>
        validateReviewerDecision({
          decision: 'rejected',
          confidence: 'high',
          blocking_issues: [],
          non_blocking_issues: [],
          review_summary: 'x',
          fix_task: null,
          next_action: 'send_fix_to_coder',
        }),
      /Rejected decision must have either blocking_issues or fix_task/
    );
  });

  test('rejected with empty fix_task and empty blocking_issues fails', () => {
    assert.throws(
      () =>
        validateReviewerDecision({
          decision: 'rejected',
          confidence: 'high',
          blocking_issues: [],
          non_blocking_issues: [],
          review_summary: 'x',
          fix_task: '',
          next_action: 'send_fix_to_coder',
        }),
      /Rejected decision must have either blocking_issues or fix_task/
    );
  });

  test('unknown next_action fails', () => {
    assert.throws(
      () =>
        validateReviewerDecision({
          decision: 'accepted',
          confidence: 'high',
          blocking_issues: [],
          non_blocking_issues: [],
          review_summary: 'x',
          fix_task: null,
          next_action: 'skip',
        }),
      /next_action must be/
    );
  });

  test('missing review_summary fails', () => {
    assert.throws(
      () =>
        validateReviewerDecision({
          decision: 'accepted',
          confidence: 'high',
          blocking_issues: [],
          non_blocking_issues: [],
          fix_task: null,
          next_action: 'advance_to_next_task',
        }),
      /review_summary must be a string/
    );
  });

  test('missing fix_task fails', () => {
    assert.throws(
      () =>
        validateReviewerDecision({
          decision: 'accepted',
          confidence: 'high',
          blocking_issues: [],
          non_blocking_issues: [],
          review_summary: 'x',
          next_action: 'advance_to_next_task',
        }),
      /fix_task must be a string or null/
    );
  });

  test('non-object input fails', () => {
    assert.throws(() => validateReviewerDecision('string'), /must be an object/);
    assert.throws(() => validateReviewerDecision(null), /must be an object/);
    assert.throws(() => validateReviewerDecision(123), /must be an object/);
    assert.throws(() => validateReviewerDecision([]), /must be an object/);
  });

  test('errors are safe and do not leak secrets', () => {
    const secret = 'sk-test-secret-abc123';
    try {
      validateReviewerDecision({
        decision: secret,
        confidence: 'high',
        blocking_issues: [],
        non_blocking_issues: [],
        review_summary: 'x',
        fix_task: null,
        next_action: 'advance_to_next_task',
      });
      assert.fail('Expected error');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      assert.ok(!message.includes(secret), 'Error must not contain secret');
    }
  });

  test('accepted must have next_action advance_to_next_task', () => {
    assert.throws(
      () =>
        validateReviewerDecision({
          decision: 'accepted',
          confidence: 'high',
          blocking_issues: [],
          non_blocking_issues: [],
          review_summary: 'x',
          fix_task: null,
          next_action: 'send_fix_to_coder',
        }),
      /Accepted decision must have next_action/
    );
  });
});
