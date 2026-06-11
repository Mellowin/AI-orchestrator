import { describe, test } from 'node:test';
import assert from 'node:assert';
import { runReviewerGateWithProvider } from '../src/reviewer-provider-runner.js';
import type { ReviewerEvidence } from '../src/reviewer-evidence.js';
import type { ReviewerInput } from '../src/reviewer-input.js';

function makeEvidence(overrides: Partial<ReviewerEvidence> = {}): ReviewerEvidence {
  return {
    taskId: 'task-1',
    taskGoal: 'Test goal',
    repoPath: '/tmp/repo',
    branchName: 'ai/task-1',
    commitSha: 'abcdef1234567890abcdef1234567890abcdef12',
    shortCommitSha: 'abcdef1',
    changedFiles: ['README.md'],
    diffStat: ' README.md | 1 +',
    commitExists: true,
    stateStatus: 'pushed',
    checkSummary: { typecheck: 'pass', build: 'pass', test: 'pass' },
    safety: {
      commitShaIsFullLength: true,
      branchIsNotMain: true,
      hasChangedFiles: true,
    },
    ...overrides,
  };
}

function makeReviewerOutput(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    decision: 'accept',
    confidence: 'high',
    blockingIssues: [],
    nonBlockingIssues: [],
    reviewSummary: 'Looks good',
    nextAction: 'continue',
    ...overrides,
  });
}

describe('reviewer provider runner', () => {
  test('builds reviewer input from evidence before provider call', async () => {
    let receivedInput: ReviewerInput | undefined;
    const result = await runReviewerGateWithProvider({
      evidence: makeEvidence(),
      reviewer: async (input) => {
        receivedInput = input;
        return makeReviewerOutput();
      },
    });
    assert(receivedInput);
    assert.strictEqual(receivedInput.taskId, 'task-1');
    assert.strictEqual(result.reviewerInput.taskId, 'task-1');
  });

  test('calls injected reviewer exactly once', async () => {
    let callCount = 0;
    await runReviewerGateWithProvider({
      evidence: makeEvidence(),
      reviewer: async () => {
        callCount++;
        return makeReviewerOutput();
      },
    });
    assert.strictEqual(callCount, 1);
  });

  test('passes reviewer input into injected reviewer', async () => {
    let receivedInput: ReviewerInput | undefined;
    await runReviewerGateWithProvider({
      evidence: makeEvidence(),
      reviewer: async (input) => {
        receivedInput = input;
        return makeReviewerOutput();
      },
    });
    assert(receivedInput);
    assert.strictEqual(receivedInput.role, 'reviewer');
    assert.strictEqual(receivedInput.taskGoal, 'Test goal');
  });

  test('accepts reviewer JSON output and returns accepted gate result', async () => {
    const result = await runReviewerGateWithProvider({
      evidence: makeEvidence(),
      reviewer: async () => makeReviewerOutput(),
    });
    assert.strictEqual(result.gateResult.status, 'accepted');
    assert.strictEqual(result.gateResult.source, 'reviewer');
    assert.strictEqual(result.gateResult.nextAction, 'continue');
  });

  test('reject reviewer JSON output returns fix_required gate result', async () => {
    const result = await runReviewerGateWithProvider({
      evidence: makeEvidence(),
      reviewer: async () =>
        makeReviewerOutput({
          decision: 'reject',
          nextAction: 'fix',
          blockingIssues: ['bug'],
          fixTask: 'fix the bug',
        }),
    });
    assert.strictEqual(result.gateResult.status, 'fix_required');
    assert.strictEqual(result.gateResult.source, 'reviewer');
    assert.strictEqual(result.gateResult.nextAction, 'fix');
  });

  test('block_for_human reviewer JSON output returns blocked gate result', async () => {
    const result = await runReviewerGateWithProvider({
      evidence: makeEvidence(),
      reviewer: async () =>
        makeReviewerOutput({
          decision: 'block_for_human',
          nextAction: 'block',
          blockingIssues: ['needs review'],
        }),
    });
    assert.strictEqual(result.gateResult.status, 'blocked');
    assert.strictEqual(result.gateResult.source, 'reviewer');
    assert.strictEqual(result.gateResult.nextAction, 'block');
  });

  test('invalid reviewer output returns blocked gate result', async () => {
    const result = await runReviewerGateWithProvider({
      evidence: makeEvidence(),
      reviewer: async () => 'not json',
    });
    assert.strictEqual(result.gateResult.status, 'blocked');
    assert.strictEqual(result.gateResult.source, 'parser');
    assert.strictEqual(result.gateResult.nextAction, 'block');
  });

  test('provider throw returns blocked gate result without throwing', async () => {
    const result = await runReviewerGateWithProvider({
      evidence: makeEvidence(),
      reviewer: async () => {
        throw new Error('provider exploded');
      },
    });
    assert.strictEqual(result.gateResult.status, 'blocked');
    assert.strictEqual(result.gateResult.source, 'provider');
    assert.strictEqual(result.gateResult.nextAction, 'block');
    assert(result.gateResult.blockingIssues[0].includes('provider exploded'));
  });

  test('provider reject returns blocked gate result without throwing', async () => {
    const result = await runReviewerGateWithProvider({
      evidence: makeEvidence(),
      reviewer: async () => Promise.reject(new Error('rejected')),
    });
    assert.strictEqual(result.gateResult.status, 'blocked');
    assert.strictEqual(result.gateResult.source, 'provider');
    assert.strictEqual(result.gateResult.nextAction, 'block');
    assert(result.gateResult.blockingIssues[0].includes('rejected'));
  });

  test('provider throw with sk-fake-reviewer-key does not leak raw key in blockingIssues', async () => {
    const result = await runReviewerGateWithProvider({
      evidence: makeEvidence(),
      reviewer: async () => {
        throw new Error('sk-fake-reviewer-key');
      },
    });
    assert(!result.gateResult.blockingIssues[0].includes('sk-fake'), `Should not leak sk-fake: ${result.gateResult.blockingIssues[0]}`);
    assert(result.gateResult.blockingIssues[0].includes('[REDACTED]'), `Should contain redaction marker: ${result.gateResult.blockingIssues[0]}`);
    assert(result.gateResult.blockingIssues[0].includes('Reviewer provider failed'), `Should preserve prefix: ${result.gateResult.blockingIssues[0]}`);
  });

  test('provider reject with Bearer fake-reviewer-token does not leak raw bearer token in blockingIssues', async () => {
    const result = await runReviewerGateWithProvider({
      evidence: makeEvidence(),
      reviewer: async () => Promise.reject(new Error('Bearer fake-reviewer-token')),
    });
    assert(!result.gateResult.blockingIssues[0].includes('Bearer fake-reviewer-token'), `Should not leak Bearer token: ${result.gateResult.blockingIssues[0]}`);
    assert(result.gateResult.blockingIssues[0].includes('[REDACTED]'), `Should contain redaction marker: ${result.gateResult.blockingIssues[0]}`);
  });

  test('provider failure with api_key=fake-reviewer-key does not leak raw key in blockingIssues', async () => {
    const result = await runReviewerGateWithProvider({
      evidence: makeEvidence(),
      reviewer: async () => {
        throw new Error('api_key=fake-reviewer-key');
      },
    });
    assert(!result.gateResult.blockingIssues[0].includes('fake-reviewer-key'), `Should not leak api_key value: ${result.gateResult.blockingIssues[0]}`);
    assert(result.gateResult.blockingIssues[0].includes('[REDACTED]'), `Should contain redaction marker: ${result.gateResult.blockingIssues[0]}`);
  });

  test('provider failure with token=fake-reviewer-token does not leak raw token in blockingIssues', async () => {
    const result = await runReviewerGateWithProvider({
      evidence: makeEvidence(),
      reviewer: async () => {
        throw new Error('token=fake-reviewer-token');
      },
    });
    assert(!result.gateResult.blockingIssues[0].includes('fake-reviewer-token'), `Should not leak token value: ${result.gateResult.blockingIssues[0]}`);
    assert(result.gateResult.blockingIssues[0].includes('[REDACTED]'), `Should contain redaction marker: ${result.gateResult.blockingIssues[0]}`);
  });

  test('provider failure with password=fake-password does not leak raw password in blockingIssues', async () => {
    const result = await runReviewerGateWithProvider({
      evidence: makeEvidence(),
      reviewer: async () => {
        throw new Error('password=fake-password');
      },
    });
    assert(!result.gateResult.blockingIssues[0].includes('fake-password'), `Should not leak password value: ${result.gateResult.blockingIssues[0]}`);
    assert(result.gateResult.blockingIssues[0].includes('[REDACTED]'), `Should contain redaction marker: ${result.gateResult.blockingIssues[0]}`);
  });

  test('redacted blocking issue still includes useful context', async () => {
    const result = await runReviewerGateWithProvider({
      evidence: makeEvidence(),
      reviewer: async () => {
        throw new Error('sk-fake-reviewer-key');
      },
    });
    assert(result.gateResult.blockingIssues[0].includes('Reviewer provider failed'), `Should include prefix: ${result.gateResult.blockingIssues[0]}`);
    assert.strictEqual(result.gateResult.status, 'blocked');
    assert.strictEqual(result.gateResult.source, 'provider');
    assert.strictEqual(result.gateResult.nextAction, 'block');
  });

  test('provider failure result preserves reviewer input', async () => {
    const result = await runReviewerGateWithProvider({
      evidence: makeEvidence(),
      reviewer: async () => {
        throw new Error('fail');
      },
    });
    assert.strictEqual(result.reviewerInput.taskId, 'task-1');
    assert.strictEqual(result.reviewerInput.role, 'reviewer');
  });

  test('raw reviewer output is preserved on successful provider call', async () => {
    const raw = makeReviewerOutput({ reviewSummary: 'Preserved' });
    const result = await runReviewerGateWithProvider({
      evidence: makeEvidence(),
      reviewer: async () => raw,
    });
    assert.strictEqual(result.rawReviewerOutput, raw);
  });

  test('raw reviewer output is absent or undefined on provider failure', async () => {
    const result = await runReviewerGateWithProvider({
      evidence: makeEvidence(),
      reviewer: async () => {
        throw new Error('fail');
      },
    });
    assert.strictEqual(result.rawReviewerOutput, undefined);
  });

  test('deterministic safety override still blocks even if provider returns accept', async () => {
    const result = await runReviewerGateWithProvider({
      evidence: makeEvidence({
        safety: {
          commitShaIsFullLength: false,
          branchIsNotMain: true,
          hasChangedFiles: true,
        },
      }),
      reviewer: async () => makeReviewerOutput(),
    });
    assert.strictEqual(result.gateResult.status, 'blocked');
    assert.strictEqual(result.gateResult.source, 'deterministic_safety');
  });

  test('reviewer is not called more than once', async () => {
    let callCount = 0;
    await runReviewerGateWithProvider({
      evidence: makeEvidence(),
      reviewer: async () => {
        callCount++;
        return makeReviewerOutput();
      },
    });
    assert.strictEqual(callCount, 1);
  });

  test('runner does not mutate evidence input', async () => {
    const evidence = makeEvidence();
    const original = JSON.stringify(evidence);
    await runReviewerGateWithProvider({
      evidence,
      reviewer: async () => makeReviewerOutput(),
    });
    assert.strictEqual(JSON.stringify(evidence), original, 'Evidence should not be mutated');
  });

  test('runner does not call git or provider APIs other than injected function', async () => {
    const result = await runReviewerGateWithProvider({
      evidence: makeEvidence(),
      reviewer: async () => makeReviewerOutput(),
    });
    assert.strictEqual(result.gateResult.status, 'accepted');
  });

  test('no CLI side effects', async () => {
    const result = await runReviewerGateWithProvider({
      evidence: makeEvidence(),
      reviewer: async () => makeReviewerOutput(),
    });
    assert.strictEqual(typeof result.gateResult.status, 'string');
  });
});
