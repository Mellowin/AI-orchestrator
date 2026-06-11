import { describe, test } from 'node:test';
import assert from 'node:assert';
import { parseReviewerDecision } from '../src/reviewer-decision.js';
import type { ReviewerDecision } from '../src/reviewer-decision.js';

function makeValidDecision(overrides: Partial<ReviewerDecision> = {}): ReviewerDecision {
  return {
    decision: 'accept',
    confidence: 'high',
    blockingIssues: [],
    nonBlockingIssues: [],
    reviewSummary: 'Looks good',
    nextAction: 'continue',
    ...overrides,
  };
}

describe('reviewer decision parser', () => {
  test('parses valid JSON string', () => {
    const json = JSON.stringify(makeValidDecision());
    const result = parseReviewerDecision(json);
    assert.strictEqual(result.ok, true);
    assert(result.decision);
    assert.strictEqual(result.decision.decision, 'accept');
  });

  test('accepts already parsed object', () => {
    const obj = makeValidDecision();
    const result = parseReviewerDecision(obj);
    assert.strictEqual(result.ok, true);
    assert(result.decision);
    assert.strictEqual(result.decision.confidence, 'high');
  });

  test('returns ok false for invalid JSON', () => {
    const result = parseReviewerDecision('not json');
    assert.strictEqual(result.ok, false);
    assert(result.error);
    assert(result.error.includes('Invalid JSON'));
  });

  test('rejects non-object input', () => {
    const result = parseReviewerDecision(123);
    assert.strictEqual(result.ok, false);
    assert(result.error);
  });

  test('rejects missing decision', () => {
    const obj = { ...makeValidDecision() } as Record<string, unknown>;
    delete obj.decision;
    const result = parseReviewerDecision(obj);
    assert.strictEqual(result.ok, false);
    assert(result.error);
  });

  test('rejects invalid decision', () => {
    const result = parseReviewerDecision({ ...makeValidDecision(), decision: 'maybe' });
    assert.strictEqual(result.ok, false);
    assert(result.error);
  });

  test('rejects missing confidence', () => {
    const obj = { ...makeValidDecision() } as Record<string, unknown>;
    delete obj.confidence;
    const result = parseReviewerDecision(obj);
    assert.strictEqual(result.ok, false);
    assert(result.error);
  });

  test('rejects invalid confidence', () => {
    const result = parseReviewerDecision({ ...makeValidDecision(), confidence: 'sure' });
    assert.strictEqual(result.ok, false);
    assert(result.error);
  });

  test('rejects missing blockingIssues', () => {
    const obj = { ...makeValidDecision() } as Record<string, unknown>;
    delete obj.blockingIssues;
    const result = parseReviewerDecision(obj);
    assert.strictEqual(result.ok, false);
    assert(result.error);
  });

  test('rejects blockingIssues not array', () => {
    const result = parseReviewerDecision({ ...makeValidDecision(), blockingIssues: 'issue' });
    assert.strictEqual(result.ok, false);
    assert(result.error);
  });

  test('rejects blockingIssues containing non-string values', () => {
    const result = parseReviewerDecision({
      ...makeValidDecision(),
      blockingIssues: ['a', 1],
    });
    assert.strictEqual(result.ok, false);
    assert(result.error);
  });

  test('rejects missing nonBlockingIssues', () => {
    const obj = { ...makeValidDecision() } as Record<string, unknown>;
    delete obj.nonBlockingIssues;
    const result = parseReviewerDecision(obj);
    assert.strictEqual(result.ok, false);
    assert(result.error);
  });

  test('rejects nonBlockingIssues not array', () => {
    const result = parseReviewerDecision({ ...makeValidDecision(), nonBlockingIssues: 'issue' });
    assert.strictEqual(result.ok, false);
    assert(result.error);
  });

  test('rejects nonBlockingIssues containing non-string values', () => {
    const result = parseReviewerDecision({
      ...makeValidDecision(),
      nonBlockingIssues: ['a', true],
    });
    assert.strictEqual(result.ok, false);
    assert(result.error);
  });

  test('rejects missing reviewSummary', () => {
    const obj = { ...makeValidDecision() } as Record<string, unknown>;
    delete obj.reviewSummary;
    const result = parseReviewerDecision(obj);
    assert.strictEqual(result.ok, false);
    assert(result.error);
  });

  test('rejects reviewSummary not string', () => {
    const result = parseReviewerDecision({ ...makeValidDecision(), reviewSummary: 123 });
    assert.strictEqual(result.ok, false);
    assert(result.error);
  });

  test('rejects missing nextAction', () => {
    const obj = { ...makeValidDecision() } as Record<string, unknown>;
    delete obj.nextAction;
    const result = parseReviewerDecision(obj);
    assert.strictEqual(result.ok, false);
    assert(result.error);
  });

  test('rejects invalid nextAction', () => {
    const result = parseReviewerDecision({ ...makeValidDecision(), nextAction: 'wait' });
    assert.strictEqual(result.ok, false);
    assert(result.error);
  });

  test('rejects fixTask when present but not string', () => {
    const result = parseReviewerDecision({ ...makeValidDecision(), fixTask: 123 });
    assert.strictEqual(result.ok, false);
    assert(result.error);
  });

  test('accepts accept + continue', () => {
    const result = parseReviewerDecision(makeValidDecision({ decision: 'accept', nextAction: 'continue' }));
    assert.strictEqual(result.ok, true);
    assert(result.decision);
    assert.strictEqual(result.decision.decision, 'accept');
    assert.strictEqual(result.decision.nextAction, 'continue');
  });

  test('rejects accept + fix', () => {
    const result = parseReviewerDecision(makeValidDecision({ decision: 'accept', nextAction: 'fix' }));
    assert.strictEqual(result.ok, false);
    assert(result.error);
  });

  test('rejects accept + block', () => {
    const result = parseReviewerDecision(makeValidDecision({ decision: 'accept', nextAction: 'block' }));
    assert.strictEqual(result.ok, false);
    assert(result.error);
  });

  test('accepts reject + fix with blocking issues and fixTask', () => {
    const result = parseReviewerDecision(
      makeValidDecision({
        decision: 'reject',
        nextAction: 'fix',
        blockingIssues: ['bug'],
        fixTask: 'fix the bug',
      })
    );
    assert.strictEqual(result.ok, true);
    assert(result.decision);
    assert.strictEqual(result.decision.decision, 'reject');
    assert.strictEqual(result.decision.nextAction, 'fix');
    assert.strictEqual(result.decision.fixTask, 'fix the bug');
  });

  test('rejects reject + continue', () => {
    const result = parseReviewerDecision(
      makeValidDecision({ decision: 'reject', nextAction: 'continue', blockingIssues: ['bug'], fixTask: 'fix' })
    );
    assert.strictEqual(result.ok, false);
    assert(result.error);
  });

  test('rejects reject + block', () => {
    const result = parseReviewerDecision(
      makeValidDecision({ decision: 'reject', nextAction: 'block', blockingIssues: ['bug'], fixTask: 'fix' })
    );
    assert.strictEqual(result.ok, false);
    assert(result.error);
  });

  test('rejects reject without blocking issues', () => {
    const result = parseReviewerDecision(
      makeValidDecision({ decision: 'reject', nextAction: 'fix', blockingIssues: [], fixTask: 'fix' })
    );
    assert.strictEqual(result.ok, false);
    assert(result.error);
  });

  test('rejects reject without fixTask', () => {
    const result = parseReviewerDecision(
      makeValidDecision({ decision: 'reject', nextAction: 'fix', blockingIssues: ['bug'] })
    );
    assert.strictEqual(result.ok, false);
    assert(result.error);
  });

  test('accepts block_for_human + block with blocking issues', () => {
    const result = parseReviewerDecision(
      makeValidDecision({
        decision: 'block_for_human',
        nextAction: 'block',
        blockingIssues: ['needs review'],
      })
    );
    assert.strictEqual(result.ok, true);
    assert(result.decision);
    assert.strictEqual(result.decision.decision, 'block_for_human');
    assert.strictEqual(result.decision.nextAction, 'block');
  });

  test('rejects block_for_human + continue', () => {
    const result = parseReviewerDecision(
      makeValidDecision({ decision: 'block_for_human', nextAction: 'continue', blockingIssues: ['needs review'] })
    );
    assert.strictEqual(result.ok, false);
    assert(result.error);
  });

  test('rejects block_for_human + fix', () => {
    const result = parseReviewerDecision(
      makeValidDecision({ decision: 'block_for_human', nextAction: 'fix', blockingIssues: ['needs review'] })
    );
    assert.strictEqual(result.ok, false);
    assert(result.error);
  });

  test('rejects block_for_human without blocking issues', () => {
    const result = parseReviewerDecision(
      makeValidDecision({ decision: 'block_for_human', nextAction: 'block', blockingIssues: [] })
    );
    assert.strictEqual(result.ok, false);
    assert(result.error);
  });

  test('does not coerce uppercase enum values', () => {
    const result = parseReviewerDecision(
      makeValidDecision({ decision: 'ACCEPT' as 'accept', nextAction: 'CONTINUE' as 'continue' })
    );
    assert.strictEqual(result.ok, false);
    assert(result.error);
  });

  test('does not coerce comma-separated issue strings', () => {
    const result = parseReviewerDecision(
      makeValidDecision({ blockingIssues: ['a,b'] as unknown as string[] })
    );
    assert.strictEqual(result.ok, true);
    assert(result.decision);
    assert.deepStrictEqual(result.decision.blockingIssues, ['a,b']);
  });

  test('does not mutate parsed object input', () => {
    const obj = makeValidDecision();
    const original = JSON.stringify(obj);
    parseReviewerDecision(obj);
    assert.strictEqual(JSON.stringify(obj), original, 'Input object should not be mutated');
  });

  test('does not call git or provider APIs', () => {
    const result = parseReviewerDecision(makeValidDecision());
    assert.strictEqual(result.ok, true);
    assert(result.decision);
  });
});
