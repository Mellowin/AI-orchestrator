import { describe, test } from 'node:test';
import assert from 'node:assert';
import { runReviewerGateWithProvider } from '../src/reviewer-provider-runner.js';
import type { ReviewerEvidence, ReviewerEvidenceInput } from '../src/reviewer-evidence.js';
import type { ReviewerInput } from '../src/reviewer-input.js';

function buildEvidence(overrides: Partial<ReviewerEvidenceInput> = {}): ReviewerEvidence {
  return {
    repoPath: '.',
    taskId: 't1',
    taskGoal: 'goal',
    branchName: 'ai/test',
    commitSha: 'a'.repeat(40),
    shortCommitSha: 'aaaaaaa',
    changedFiles: ['src/test.ts'],
    diffStat: '1 file changed, 1 insertion(+)',
    commitExists: true,
    checkSummary: { test: 'pass' },
    safety: {
      commitShaIsFullLength: true,
      branchIsNotMain: true,
      hasChangedFiles: true,
    },
    ...overrides,
  };
}

const validDecision = {
  decision: 'accepted',
  confidence: 'high',
  blocking_issues: [],
  non_blocking_issues: [],
  review_summary: 'Looks good',
  fix_task: null,
  next_action: 'advance_to_next_task',
};

function buildValidResponse(): string {
  return JSON.stringify(validDecision);
}

describe('reviewer-provider-runner', () => {
  test('strict JSON parses', async () => {
    const result = await runReviewerGateWithProvider({
      evidence: buildEvidence(),
      reviewer: async () => buildValidResponse(),
    });
    assert.strictEqual(result.gateResult.status, 'accepted');
    assert.strictEqual(result.gateResult.parseAttempts, 1);
  });

  test('fenced JSON parses', async () => {
    const result = await runReviewerGateWithProvider({
      evidence: buildEvidence(),
      reviewer: async () => '```json\n' + buildValidResponse() + '\n```',
    });
    assert.strictEqual(result.gateResult.status, 'accepted');
  });

  test('prose around JSON parses', async () => {
    const result = await runReviewerGateWithProvider({
      evidence: buildEvidence(),
      reviewer: async () => 'Review:\n' + buildValidResponse() + '\nDone.',
    });
    assert.strictEqual(result.gateResult.status, 'accepted');
  });

  test('invalid JSON retries and returns structured blocked result', async () => {
    let calls = 0;
    const result = await runReviewerGateWithProvider({
      evidence: buildEvidence(),
      reviewer: async () => {
        calls++;
        return 'not json';
      },
      maxParseRetries: 2,
    });
    assert.strictEqual(calls, 3);
    assert.strictEqual(result.gateResult.status, 'blocked');
    assert.strictEqual(result.gateResult.source, 'parser');
    assert.strictEqual(result.gateResult.parseAttempts, 3);
    assert.ok(result.parseFailure);
    assert.strictEqual(result.parseFailure?.decision, 'blocked');
    assert.strictEqual(result.parseFailure?.reason, 'reviewer_json_parse_failed');
  });

  test('retry succeeds on second attempt', async () => {
    let calls = 0;
    const result = await runReviewerGateWithProvider({
      evidence: buildEvidence(),
      reviewer: async (_input: ReviewerInput) => {
        calls++;
        return calls === 1 ? 'bad' : buildValidResponse();
      },
      maxParseRetries: 2,
    });
    assert.strictEqual(calls, 2);
    assert.strictEqual(result.gateResult.status, 'accepted');
    assert.strictEqual(result.gateResult.parseAttempts, 2);
  });

  test('non-parse provider error does not retry', async () => {
    let calls = 0;
    const result = await runReviewerGateWithProvider({
      evidence: buildEvidence(),
      reviewer: async () => {
        calls++;
        throw new Error('network failure');
      },
      maxParseRetries: 2,
    });
    assert.strictEqual(calls, 1);
    assert.strictEqual(result.gateResult.status, 'blocked');
    assert.strictEqual(result.gateResult.source, 'provider');
  });

  test('raw excerpt is masked in blocked result', async () => {
    const secret = 'sk-test-secret-xyz';
    const result = await runReviewerGateWithProvider({
      evidence: buildEvidence(),
      reviewer: async () => `not json ${secret}`,
      maxParseRetries: 0,
    });
    assert.strictEqual(result.gateResult.status, 'blocked');
    const issues = result.gateResult.blockingIssues.join(' ');
    assert.ok(!issues.includes(secret), 'Blocking issues must not contain secret');
    assert.ok(!result.parseFailure?.rawExcerptMasked.includes(secret));
  });

  test('passes acceptance_criteria to reviewer input when present in evidence', async () => {
    let receivedInput: ReviewerInput | undefined;
    await runReviewerGateWithProvider({
      evidence: buildEvidence({
        acceptance_criteria: ['must mention X', 'must end with Y'],
      }),
      reviewer: async (input: ReviewerInput) => {
        receivedInput = input;
        return buildValidResponse();
      },
    });
    assert.ok(receivedInput);
    assert.deepStrictEqual(receivedInput!.acceptance_criteria, ['must mention X', 'must end with Y']);
  });

  test('maxParseRetries 0 means one attempt', async () => {
    let calls = 0;
    await runReviewerGateWithProvider({
      evidence: buildEvidence(),
      reviewer: async () => {
        calls++;
        return 'not json';
      },
      maxParseRetries: 0,
    });
    assert.strictEqual(calls, 1);
  });
});
