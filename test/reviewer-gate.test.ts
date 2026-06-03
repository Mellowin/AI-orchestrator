import { describe, test } from 'node:test';
import assert from 'node:assert';
import { runReviewerGate } from '../src/reviewer/reviewer-gate.js';
import { createFakeReviewerProvider } from '../src/providers/fake/fake-reviewer-provider.js';
import type { ReviewerProvider, ReviewerDecision, ReviewInput } from '../src/providers/provider-types.js';

describe('reviewer-gate', () => {
  const fakeReviewer = createFakeReviewerProvider();

  function makeReviewInput(): ReviewInput {
    return {
      task_id: 't1',
      task_title: 'Test',
      task_goal: 'Goal',
      allowed_files: ['src/test.ts'],
      denied_files: ['.env'],
      max_lines_changed: 100,
      commit_sha: 'a'.repeat(40),
      changed_files: ['src/test.ts'],
      diff: '+line\n',
      typecheck_result: 'pass',
      build_result: 'pass',
      test_result: 'pass',
      git_status: 'clean',
      safety_findings: [],
    };
  }

  test('deterministic fail does not call reviewer', async () => {
    const result = await runReviewerGate({
      reviewer: fakeReviewer,
      reviewInput: makeReviewInput(),
      deterministicResult: {
        ok: false,
        blockingIssues: ['Tests failed'],
        safetyFindings: ['Test failure'],
      },
    });
    assert.strictEqual(result.reviewerCalled, false);
  });

  test('deterministic fail returns rejected decision', async () => {
    const result = await runReviewerGate({
      reviewer: fakeReviewer,
      reviewInput: makeReviewInput(),
      deterministicResult: {
        ok: false,
        blockingIssues: ['Tests failed'],
        safetyFindings: ['Test failure'],
      },
    });
    assert.strictEqual(result.decision.decision, 'rejected');
  });

  test('deterministic fail sets reviewerCalled=false', async () => {
    const result = await runReviewerGate({
      reviewer: fakeReviewer,
      reviewInput: makeReviewInput(),
      deterministicResult: {
        ok: false,
        blockingIssues: ['Bad'],
        safetyFindings: ['Bad thing'],
      },
    });
    assert.strictEqual(result.reviewerCalled, false);
  });

  test('deterministic pass calls reviewer', async () => {
    const result = await runReviewerGate({
      reviewer: fakeReviewer,
      reviewInput: makeReviewInput(),
      deterministicResult: {
        ok: true,
        blockingIssues: [],
        safetyFindings: [],
      },
    });
    assert.strictEqual(result.reviewerCalled, true);
    assert.strictEqual(result.decision.decision, 'accepted');
  });

  test('deterministic pass validates reviewer decision', async () => {
    const customReviewer: ReviewerProvider = {
      id: 'fake',
      role: 'reviewer',
      async reviewCommit(): Promise<ReviewerDecision> {
        return {
          decision: 'rejected',
          confidence: 'medium',
          blocking_issues: ['Missing docs'],
          non_blocking_issues: [],
          review_summary: 'Needs docs',
          fix_task: 'Add docs',
          next_action: 'send_fix_to_coder',
        };
      },
    };

    const result = await runReviewerGate({
      reviewer: customReviewer,
      reviewInput: makeReviewInput(),
      deterministicResult: {
        ok: true,
        blockingIssues: [],
        safetyFindings: [],
      },
    });
    assert.strictEqual(result.reviewerCalled, true);
    assert.strictEqual(result.decision.decision, 'rejected');
    assert.strictEqual(result.decision.next_action, 'send_fix_to_coder');
  });

  test('invalid reviewer decision rejects safely', async () => {
    const badReviewer: ReviewerProvider = {
      id: 'fake',
      role: 'reviewer',
      async reviewCommit(): Promise<ReviewerDecision> {
        // Invalid: accepted with blocking_issues
        return {
          decision: 'accepted' as 'accepted',
          confidence: 'high',
          blocking_issues: ['should be empty'],
          non_blocking_issues: [],
          review_summary: 'bad',
          fix_task: null,
          next_action: 'advance_to_next_task' as 'advance_to_next_task',
        };
      },
    };

    await assert.rejects(
      async () =>
        runReviewerGate({
          reviewer: badReviewer,
          reviewInput: makeReviewInput(),
          deterministicResult: {
            ok: true,
            blockingIssues: [],
            safetyFindings: [],
          },
        }),
      /empty blocking_issues/
    );
  });

  test('severe secret issue returns block_for_human', async () => {
    const result = await runReviewerGate({
      reviewer: fakeReviewer,
      reviewInput: makeReviewInput(),
      deterministicResult: {
        ok: false,
        blockingIssues: ['Secret detected'],
        safetyFindings: ['Secret pattern detected: sk- token'],
      },
    });
    assert.strictEqual(result.decision.next_action, 'block_for_human');
  });

  test('denied file touched returns block_for_human', async () => {
    const result = await runReviewerGate({
      reviewer: fakeReviewer,
      reviewInput: makeReviewInput(),
      deterministicResult: {
        ok: false,
        blockingIssues: ['Denied file touched'],
        safetyFindings: ['Denied file touched: .env'],
      },
    });
    assert.strictEqual(result.decision.next_action, 'block_for_human');
  });

  test('main branch issue returns block_for_human', async () => {
    const result = await runReviewerGate({
      reviewer: fakeReviewer,
      reviewInput: makeReviewInput(),
      deterministicResult: {
        ok: false,
        blockingIssues: ['Current branch is main'],
        safetyFindings: ['main branch violation'],
      },
    });
    assert.strictEqual(result.decision.next_action, 'block_for_human');
  });

  test('normal outside allowed file returns send_fix_to_coder', async () => {
    const result = await runReviewerGate({
      reviewer: fakeReviewer,
      reviewInput: makeReviewInput(),
      deterministicResult: {
        ok: false,
        blockingIssues: ['File outside allowed scope'],
        safetyFindings: ['File outside allowed scope: src/other.ts'],
      },
    });
    assert.strictEqual(result.decision.next_action, 'send_fix_to_coder');
  });

  test('accepted reviewer decision advances', async () => {
    const result = await runReviewerGate({
      reviewer: fakeReviewer,
      reviewInput: makeReviewInput(),
      deterministicResult: {
        ok: true,
        blockingIssues: [],
        safetyFindings: [],
      },
    });
    assert.strictEqual(result.decision.decision, 'accepted');
    assert.strictEqual(result.decision.next_action, 'advance_to_next_task');
  });

  test('rejected reviewer decision sends fix', async () => {
    const customReviewer: ReviewerProvider = {
      id: 'fake',
      role: 'reviewer',
      async reviewCommit(): Promise<ReviewerDecision> {
        return {
          decision: 'rejected',
          confidence: 'medium',
          blocking_issues: ['Missing tests'],
          non_blocking_issues: [],
          review_summary: 'Needs tests',
          fix_task: 'Add tests',
          next_action: 'send_fix_to_coder',
        };
      },
    };

    const result = await runReviewerGate({
      reviewer: customReviewer,
      reviewInput: makeReviewInput(),
      deterministicResult: {
        ok: true,
        blockingIssues: [],
        safetyFindings: [],
      },
    });
    assert.strictEqual(result.decision.decision, 'rejected');
    assert.strictEqual(result.decision.next_action, 'send_fix_to_coder');
  });
});
