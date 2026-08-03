import { describe, test } from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { evaluateReviewerGate } from '../src/reviewer-gate.js';
import type { ReviewerEvidence } from '../src/reviewer-evidence.js';

function createTempRepo(): string {
  const tmpBase = join(process.cwd(), 'tmp');
  if (!existsSync(tmpBase)) {
    mkdirSync(tmpBase);
  }
  const repoPath = mkdtempSync(join(tmpBase, 'reviewer-gate-eval-'));
  spawnSync('git', ['init'], { cwd: repoPath, encoding: 'utf-8', shell: false });
  spawnSync('git', ['config', 'user.email', 'test@test.com'], {
    cwd: repoPath,
    encoding: 'utf-8',
    shell: false,
  });
  spawnSync('git', ['config', 'user.name', 'Test'], {
    cwd: repoPath,
    encoding: 'utf-8',
    shell: false,
  });
  writeFileSync(join(repoPath, 'README.md'), '# hello\n', 'utf-8');
  spawnSync('git', ['add', '.'], { cwd: repoPath, encoding: 'utf-8', shell: false });
  spawnSync('git', ['commit', '-m', 'init', '--no-gpg-sign'], {
    cwd: repoPath,
    encoding: 'utf-8',
    shell: false,
  });
  return repoPath;
}

function getCommitSha(repoPath: string): string {
  const result = spawnSync('git', ['log', '-1', '--format=%H'], {
    cwd: repoPath,
    encoding: 'utf-8',
    shell: false,
  });
  return result.stdout.trim();
}

function addCommitFile(repoPath: string, path: string, content: string): void {
  const fullPath = join(repoPath, path);
  const dir = join(fullPath, '..');
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(fullPath, content, 'utf-8');
  spawnSync('git', ['add', path], { cwd: repoPath, encoding: 'utf-8', shell: false });
  spawnSync('git', ['commit', '-m', `add ${path}`, '--no-gpg-sign'], {
    cwd: repoPath,
    encoding: 'utf-8',
    shell: false,
  });
}

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

describe('reviewer gate evaluator', () => {
  test('builds reviewer input from evidence', () => {
    const evidence = makeEvidence();
    const result = evaluateReviewerGate({
      evidence,
      reviewerOutput: makeReviewerOutput(),
    });
    assert.strictEqual(result.reviewerInput.taskId, 'task-1');
    assert.strictEqual(result.reviewerInput.taskGoal, 'Test goal');
    assert.strictEqual(result.reviewerInput.role, 'reviewer');
  });

  test('accepts valid reviewer accept + continue', () => {
    const result = evaluateReviewerGate({
      evidence: makeEvidence(),
      reviewerOutput: makeReviewerOutput(),
    });
    assert.strictEqual(result.status, 'accepted');
  });

  test('maps accept to status accepted', () => {
    const result = evaluateReviewerGate({
      evidence: makeEvidence(),
      reviewerOutput: makeReviewerOutput(),
    });
    assert.strictEqual(result.status, 'accepted');
    assert.strictEqual(result.source, 'reviewer');
    assert.strictEqual(result.nextAction, 'continue');
  });

  test('maps reject to status fix_required', () => {
    const result = evaluateReviewerGate({
      evidence: makeEvidence(),
      reviewerOutput: makeReviewerOutput({
        decision: 'reject',
        nextAction: 'fix',
        blockingIssues: ['bug'],
        fixTask: 'fix the bug',
      }),
    });
    assert.strictEqual(result.status, 'fix_required');
    assert.strictEqual(result.source, 'reviewer');
    assert.strictEqual(result.nextAction, 'fix');
  });

  test('maps block_for_human to status blocked', () => {
    const result = evaluateReviewerGate({
      evidence: makeEvidence(),
      reviewerOutput: makeReviewerOutput({
        decision: 'block_for_human',
        nextAction: 'block',
        blockingIssues: ['needs review'],
      }),
    });
    assert.strictEqual(result.status, 'blocked');
    assert.strictEqual(result.source, 'reviewer');
    assert.strictEqual(result.nextAction, 'block');
  });

  test('preserves reviewer decision when parsed successfully', () => {
    const result = evaluateReviewerGate({
      evidence: makeEvidence(),
      reviewerOutput: makeReviewerOutput(),
    });
    assert(result.reviewerDecision);
    assert.strictEqual(result.reviewerDecision.decision, 'accept');
  });

  test('preserves blocking issues', () => {
    const result = evaluateReviewerGate({
      evidence: makeEvidence(),
      reviewerOutput: makeReviewerOutput({
        decision: 'reject',
        nextAction: 'fix',
        blockingIssues: ['bug', 'test failure'],
        fixTask: 'fix it',
      }),
    });
    assert.deepStrictEqual(result.blockingIssues, ['bug', 'test failure']);
  });

  test('preserves non-blocking issues', () => {
    const result = evaluateReviewerGate({
      evidence: makeEvidence(),
      reviewerOutput: makeReviewerOutput({
        nonBlockingIssues: ['nitpick'],
      }),
    });
    assert.deepStrictEqual(result.nonBlockingIssues, ['nitpick']);
  });

  test('preserves review summary', () => {
    const result = evaluateReviewerGate({
      evidence: makeEvidence(),
      reviewerOutput: makeReviewerOutput({
        reviewSummary: 'Great work',
      }),
    });
    assert.strictEqual(result.reviewSummary, 'Great work');
  });

  test('preserves fix task for reject', () => {
    const result = evaluateReviewerGate({
      evidence: makeEvidence(),
      reviewerOutput: makeReviewerOutput({
        decision: 'reject',
        nextAction: 'fix',
        blockingIssues: ['bug'],
        fixTask: 'fix the bug',
      }),
    });
    assert.strictEqual(result.fixTask, 'fix the bug');
  });

  test('parser failure returns blocked result', () => {
    const result = evaluateReviewerGate({
      evidence: makeEvidence(),
      reviewerOutput: 'not json',
    });
    assert.strictEqual(result.status, 'blocked');
    assert.strictEqual(result.nextAction, 'block');
  });

  test('parser failure includes parser error in blocking issues', () => {
    const result = evaluateReviewerGate({
      evidence: makeEvidence(),
      reviewerOutput: 'not json',
    });
    assert(result.blockingIssues.length > 0);
    assert(result.blockingIssues[0].includes('Invalid JSON'));
  });

  test('invalid JSON does not throw', () => {
    assert.doesNotThrow(() => {
      evaluateReviewerGate({
        evidence: makeEvidence(),
        reviewerOutput: '{ broken',
      });
    });
  });

  test('invalid schema does not throw', () => {
    assert.doesNotThrow(() => {
      evaluateReviewerGate({
        evidence: makeEvidence(),
        reviewerOutput: JSON.stringify({ decision: 'maybe' }),
      });
    });
  });

  test('non-full commit SHA blocks even if reviewer accepts', () => {
    const result = evaluateReviewerGate({
      evidence: makeEvidence({
        safety: {
          commitShaIsFullLength: false,
          branchIsNotMain: true,
          hasChangedFiles: true,
        },
      }),
      reviewerOutput: makeReviewerOutput(),
    });
    assert.strictEqual(result.status, 'blocked');
    assert.strictEqual(result.source, 'deterministic_safety');
    assert(result.blockingIssues.some((i) => i.includes('Commit SHA')));
  });

  test('no changed files blocks even if reviewer accepts', () => {
    const result = evaluateReviewerGate({
      evidence: makeEvidence({
        safety: {
          commitShaIsFullLength: true,
          branchIsNotMain: true,
          hasChangedFiles: false,
        },
      }),
      reviewerOutput: makeReviewerOutput(),
    });
    assert.strictEqual(result.status, 'blocked');
    assert.strictEqual(result.source, 'deterministic_safety');
    assert(result.blockingIssues.some((i) => i.includes('changed files')));
  });

  test('main branch blocks even if reviewer accepts', () => {
    const result = evaluateReviewerGate({
      evidence: makeEvidence({
        safety: {
          commitShaIsFullLength: true,
          branchIsNotMain: false,
          hasChangedFiles: true,
        },
      }),
      reviewerOutput: makeReviewerOutput(),
    });
    assert.strictEqual(result.status, 'blocked');
    assert.strictEqual(result.source, 'deterministic_safety');
    assert(result.blockingIssues.some((i) => i.includes('main')));
  });

  test('multiple failed safety flags produce multiple blocking issues', () => {
    const result = evaluateReviewerGate({
      evidence: makeEvidence({
        safety: {
          commitShaIsFullLength: false,
          branchIsNotMain: false,
          hasChangedFiles: false,
        },
      }),
      reviewerOutput: makeReviewerOutput(),
    });
    assert.strictEqual(result.blockingIssues.length, 3);
  });

  test('safety override source is deterministic_safety', () => {
    const result = evaluateReviewerGate({
      evidence: makeEvidence({
        safety: {
          commitShaIsFullLength: false,
          branchIsNotMain: true,
          hasChangedFiles: true,
        },
      }),
      reviewerOutput: makeReviewerOutput(),
    });
    assert.strictEqual(result.source, 'deterministic_safety');
  });

  test('parser failure source is parser', () => {
    const result = evaluateReviewerGate({
      evidence: makeEvidence(),
      reviewerOutput: 'bad json',
    });
    assert.strictEqual(result.source, 'parser');
  });

  test('valid reviewer source is reviewer', () => {
    const result = evaluateReviewerGate({
      evidence: makeEvidence(),
      reviewerOutput: makeReviewerOutput(),
    });
    assert.strictEqual(result.source, 'reviewer');
  });

  test('deterministic safety checks run before trusting reviewer accept', () => {
    const result = evaluateReviewerGate({
      evidence: makeEvidence({
        safety: {
          commitShaIsFullLength: false,
          branchIsNotMain: true,
          hasChangedFiles: true,
        },
      }),
      reviewerOutput: makeReviewerOutput(),
    });
    assert.strictEqual(result.status, 'blocked');
    assert.strictEqual(result.source, 'deterministic_safety');
    assert.strictEqual(result.reviewerDecision, undefined);
  });

  test('evaluator does not mutate evidence input', () => {
    const evidence = makeEvidence();
    const original = JSON.stringify(evidence);
    evaluateReviewerGate({
      evidence,
      reviewerOutput: makeReviewerOutput(),
    });
    assert.strictEqual(JSON.stringify(evidence), original, 'Evidence should not be mutated');
  });

  test('evaluator does not call git or provider APIs', () => {
    const result = evaluateReviewerGate({
      evidence: makeEvidence(),
      reviewerOutput: makeReviewerOutput(),
    });
    assert.strictEqual(result.status, 'accepted');
  });

  test('evaluator does not include full diff', () => {
    const result = evaluateReviewerGate({
      evidence: makeEvidence(),
      reviewerOutput: makeReviewerOutput(),
    });
    assert.strictEqual(result.reviewerInput.diffStat, ' README.md | 1 +');
    assert(!('fullDiff' in result.reviewerInput));
  });

  test('deterministic acceptance criteria override reviewer accept and return fix_required', () => {
    const repoPath = createTempRepo();
    try {
      addCommitFile(repoPath, 'docs/part2.md', 'Wrong content\n');
      const commitSha = getCommitSha(repoPath);
      const result = evaluateReviewerGate({
        evidence: makeEvidence({
          repoPath,
          commitSha,
          changedFiles: ['docs/part2.md'],
          acceptance_criteria: [
            `docs/part2.md must end with the exact sentence: "Expected ending."`,
          ],
          allowedFiles: ['docs/part2.md'],
        }),
        reviewerOutput: makeReviewerOutput(),
      });
      assert.strictEqual(result.status, 'fix_required');
      assert.strictEqual(result.source, 'deterministic_acceptance');
      assert.strictEqual(result.nextAction, 'fix');
      assert(result.blockingIssues.some((i) => i.includes('does not end with the exact sentence')));
      assert.strictEqual(result.reviewerDecision, undefined);
      assert(result.fixTask && result.fixTask.includes('Expected ending.'));
    } finally {
      rmSync(repoPath, { recursive: true, force: true });
    }
  });

  test('deterministic acceptance criteria pass and reviewer accept remains accepted', () => {
    const repoPath = createTempRepo();
    try {
      addCommitFile(repoPath, 'docs/part2.md', 'Some content\nExpected ending.\n');
      const commitSha = getCommitSha(repoPath);
      const result = evaluateReviewerGate({
        evidence: makeEvidence({
          repoPath,
          commitSha,
          changedFiles: ['docs/part2.md'],
          acceptance_criteria: [
            `docs/part2.md must end with the exact sentence: "Expected ending."`,
          ],
          allowedFiles: ['docs/part2.md'],
        }),
        reviewerOutput: makeReviewerOutput(),
      });
      assert.strictEqual(result.status, 'accepted');
      assert.strictEqual(result.source, 'reviewer');
    } finally {
      rmSync(repoPath, { recursive: true, force: true });
    }
  });
});
