import { describe, test } from 'node:test';
import assert from 'node:assert';
import { buildReviewerInput } from '../src/reviewer-input.js';
import type { ReviewerEvidence } from '../src/reviewer-evidence.js';

function makeEvidence(overrides: Partial<ReviewerEvidence> = {}): ReviewerEvidence {
  return {
    taskId: 'task-1',
    taskGoal: 'Test goal',
    repoPath: '/tmp/repo',
    branchName: 'ai/task-1',
    commitSha: 'abcdef1234567890abcdef1234567890abcdef12',
    shortCommitSha: 'abcdef1',
    changedFiles: ['README.md'],
    diffStat: ' README.md | 1 +\n 1 file changed, 1 insertion(+)',
    commitExists: true,
    stateStatus: 'pushed',
    checkSummary: {
      typecheck: 'pass',
      build: 'pass',
      test: 'pass',
      tests: { total: 10, suites: 1, failures: 0 },
    },
    safety: {
      commitShaIsFullLength: true,
      branchIsNotMain: true,
      hasChangedFiles: true,
    },
    ...overrides,
  };
}

describe('reviewer input builder', () => {
  test('builds reviewer input from valid evidence', () => {
    const evidence = makeEvidence();
    const input = buildReviewerInput(evidence);
    assert.strictEqual(input.role, 'reviewer');
    assert.strictEqual(input.taskId, 'task-1');
    assert(input.instructions.length > 0);
    assert(input.requiredOutputFormat);
  });

  test('preserves task id and task goal', () => {
    const evidence = makeEvidence();
    const input = buildReviewerInput(evidence);
    assert.strictEqual(input.taskId, evidence.taskId);
    assert.strictEqual(input.taskGoal, evidence.taskGoal);
  });

  test('preserves full commit SHA', () => {
    const evidence = makeEvidence();
    const input = buildReviewerInput(evidence);
    assert.strictEqual(input.commitSha, evidence.commitSha);
    assert.strictEqual(input.commitSha.length, 40);
  });

  test('preserves branch name', () => {
    const evidence = makeEvidence();
    const input = buildReviewerInput(evidence);
    assert.strictEqual(input.branchName, evidence.branchName);
  });

  test('preserves changed files', () => {
    const evidence = makeEvidence();
    const input = buildReviewerInput(evidence);
    assert.deepStrictEqual(input.changedFiles, evidence.changedFiles);
  });

  test('preserves diff stat', () => {
    const evidence = makeEvidence();
    const input = buildReviewerInput(evidence);
    assert.strictEqual(input.diffStat, evidence.diffStat);
  });

  test('preserves check summary', () => {
    const evidence = makeEvidence();
    const input = buildReviewerInput(evidence);
    assert.deepStrictEqual(input.checkSummary, evidence.checkSummary);
  });

  test('preserves state status', () => {
    const evidence = makeEvidence();
    const input = buildReviewerInput(evidence);
    assert.strictEqual(input.stateStatus, evidence.stateStatus);
  });

  test('preserves safety flags', () => {
    const evidence = makeEvidence();
    const input = buildReviewerInput(evidence);
    assert.deepStrictEqual(input.safety, evidence.safety);
  });

  test('includes reviewer role', () => {
    const evidence = makeEvidence();
    const input = buildReviewerInput(evidence);
    assert.strictEqual(input.role, 'reviewer');
  });

  test('includes instructions to review only factual evidence', () => {
    const evidence = makeEvidence();
    const input = buildReviewerInput(evidence);
    const found = input.instructions.some((i) =>
      i.toLowerCase().includes('review only the provided factual evidence')
    );
    assert(found, `Expected instruction about factual evidence: ${input.instructions.join(' | ')}`);
  });

  test('includes instruction not to assume tests passed unless check summary says so', () => {
    const evidence = makeEvidence();
    const input = buildReviewerInput(evidence);
    const found = input.instructions.some((i) =>
      i.toLowerCase().includes('do not assume tests passed')
    );
    assert(found, `Expected instruction about tests: ${input.instructions.join(' | ')}`);
  });

  test('includes instruction to treat missing changed files as blocking', () => {
    const evidence = makeEvidence();
    const input = buildReviewerInput(evidence);
    const found = input.instructions.some((i) =>
      i.toLowerCase().includes('missing or empty changed files')
    );
    assert(found, `Expected instruction about changed files: ${input.instructions.join(' | ')}`);
  });

  test('includes instruction to treat non-full commit SHA as blocking', () => {
    const evidence = makeEvidence();
    const input = buildReviewerInput(evidence);
    const found = input.instructions.some((i) =>
      i.toLowerCase().includes('non-full-length')
    );
    assert(found, `Expected instruction about SHA length: ${input.instructions.join(' | ')}`);
  });

  test('includes instruction to treat main branch as blocking', () => {
    const evidence = makeEvidence();
    const input = buildReviewerInput(evidence);
    const found = input.instructions.some((i) =>
      i.toLowerCase().includes('main branch')
    );
    assert(found, `Expected instruction about main branch: ${input.instructions.join(' | ')}`);
  });

  test('includes structured required output format with accept reject block_for_human', () => {
    const evidence = makeEvidence();
    const input = buildReviewerInput(evidence);
    assert.strictEqual(typeof input.requiredOutputFormat, 'object');
    assert('decision' in input.requiredOutputFormat);
    assert('confidence' in input.requiredOutputFormat);
    assert('blockingIssues' in input.requiredOutputFormat);
    assert('nonBlockingIssues' in input.requiredOutputFormat);
    assert('reviewSummary' in input.requiredOutputFormat);
    assert('nextAction' in input.requiredOutputFormat);
    const allowedDecisions = ['accept', 'reject', 'block_for_human'];
    assert(
      allowedDecisions.includes(input.requiredOutputFormat.decision),
      `Expected decision to be one of ${allowedDecisions.join(', ')}`
    );
    const allowedConfidence = ['low', 'medium', 'high'];
    assert(
      allowedConfidence.includes(input.requiredOutputFormat.confidence),
      `Expected confidence to be one of ${allowedConfidence.join(', ')}`
    );
    const allowedNextActions = ['continue', 'fix', 'block'];
    assert(
      allowedNextActions.includes(input.requiredOutputFormat.nextAction),
      `Expected nextAction to be one of ${allowedNextActions.join(', ')}`
    );
  });

  test('does not include full diff field', () => {
    const evidence = makeEvidence();
    const input = buildReviewerInput(evidence);
    assert(!('fullDiff' in input), `Should not include fullDiff field`);
  });

  test('does not call git or provider APIs', () => {
    const evidence = makeEvidence();
    const input = buildReviewerInput(evidence);
    assert.strictEqual(input.role, 'reviewer');
  });

  test('does not mutate input evidence', () => {
    const evidence = makeEvidence();
    const original = JSON.stringify(evidence);
    buildReviewerInput(evidence);
    assert.strictEqual(JSON.stringify(evidence), original, 'Evidence should not be mutated');
  });
});
