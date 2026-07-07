import { describe, test } from 'node:test';
import assert from 'node:assert';
import { buildFakeResponseArrays } from '../../src/acceptance-matrix/fake-response-builder.js';

describe('acceptance-matrix fake-response-builder', () => {
  test('golden_real_multitask has response for every task', () => {
    const arrays = buildFakeResponseArrays('golden_real_multitask');
    assert.strictEqual(arrays.kimi.length, 2);
    assert.strictEqual(arrays.reviewer.length, 2);
    assert.strictEqual(arrays.fixKimi.length, 2);
    assert.strictEqual(arrays.secondReviewer.length, 2);

    assert.ok(arrays.kimi[0]?.includes('README.md'));
    assert.ok(arrays.kimi[1]?.includes('feature.txt'));

    const firstReview = JSON.parse(arrays.reviewer[0] ?? '{}');
    assert.strictEqual(firstReview.decision, 'accepted');

    const secondReview = JSON.parse(arrays.reviewer[1] ?? '{}');
    assert.strictEqual(secondReview.decision, 'rejected');
    assert.strictEqual(secondReview.next_action, 'send_fix_to_coder');

    assert.strictEqual(arrays.fixKimi[0], undefined);
    assert.ok(arrays.fixKimi[1]?.includes('feature.txt'));
  });

  test('blocked_stop injects unsafe response in allowed file for second task', () => {
    const arrays = buildFakeResponseArrays('blocked_stop');
    assert.strictEqual(arrays.kimi.length, 2);
    assert.ok(arrays.kimi[1]?.includes('README.md'));
    assert.ok(arrays.kimi[1]?.includes('process.env.KIMI_API_KEY'));
    assert.strictEqual(arrays.reviewer[1], undefined);
  });

  test('blocked_continue skips unsafe task and completes third task', () => {
    const arrays = buildFakeResponseArrays('blocked_continue');
    assert.strictEqual(arrays.kimi.length, 3);
    assert.ok(arrays.kimi[1]?.includes('README.md'));
    assert.ok(arrays.kimi[1]?.includes('process.env.KIMI_API_KEY'));
    assert.ok(arrays.kimi[2]?.includes('feature.txt'));
    assert.strictEqual(arrays.reviewer[1], undefined);
  });
});
