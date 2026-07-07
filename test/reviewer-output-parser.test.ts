import { describe, test } from 'node:test';
import assert from 'node:assert';
import {
  parseReviewerDecisionText,
  buildParseFailureResult,
} from '../src/reviewer/reviewer-output-parser.js';

const validDecision = {
  decision: 'accepted',
  confidence: 'high',
  blocking_issues: [],
  non_blocking_issues: [],
  review_summary: 'Looks good',
  fix_task: null,
  next_action: 'advance_to_next_task',
};

describe('reviewer-output-parser', () => {
  test('strict JSON parses', () => {
    const result = parseReviewerDecisionText(JSON.stringify(validDecision));
    assert.strictEqual(result.decision.decision, 'accepted');
    assert.strictEqual(result.extractionMethod, 'strict');
  });

  test('fenced JSON parses', () => {
    const raw = '```json\n' + JSON.stringify(validDecision) + '\n```';
    const result = parseReviewerDecisionText(raw);
    assert.strictEqual(result.decision.decision, 'accepted');
    assert.strictEqual(result.extractionMethod, 'fenced');
  });

  test('fenced block without language parses', () => {
    const raw = '```\n' + JSON.stringify(validDecision) + '\n```';
    const result = parseReviewerDecisionText(raw);
    assert.strictEqual(result.decision.decision, 'accepted');
  });

  test('prose before JSON parses', () => {
    const raw = 'Here is my review:\n' + JSON.stringify(validDecision) + '\nHope this helps.';
    const result = parseReviewerDecisionText(raw);
    assert.strictEqual(result.decision.decision, 'accepted');
    assert.strictEqual(result.extractionMethod, 'top_level_object');
  });

  test('prose after JSON parses', () => {
    const raw = JSON.stringify(validDecision) + '\nThis is my final answer.';
    const result = parseReviewerDecisionText(raw);
    assert.strictEqual(result.decision.decision, 'accepted');
  });

  test('invalid JSON throws safe error', () => {
    assert.throws(() => parseReviewerDecisionText('not json'), /not valid JSON/);
  });

  test('raw excerpt is masked', () => {
    const secret = 'sk-test-secret-abc123';
    try {
      parseReviewerDecisionText(`not json ${secret}`);
      assert.fail('Expected error');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      assert.ok(!message.includes(secret), 'Error must not contain secret');
    }
  });

  test('buildParseFailureResult masks secrets', () => {
    const secret = 'sk-leaked-xyz';
    const result = buildParseFailureResult(3, `bad output ${secret}`);
    assert.strictEqual(result.decision, 'blocked');
    assert.strictEqual(result.reason, 'reviewer_json_parse_failed');
    assert.strictEqual(result.parseAttempts, 3);
    assert.ok(!result.rawExcerptMasked.includes(secret));
  });

  test('buildParseFailureResult handles non-string raw', () => {
    const result = buildParseFailureResult(1, { foo: 'bar' });
    assert.strictEqual(result.parseAttempts, 1);
    assert.ok(result.rawExcerptMasked.includes('foo'));
  });
});
