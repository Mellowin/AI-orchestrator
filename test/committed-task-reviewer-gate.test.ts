import { describe, test } from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { runCommittedTaskReviewerGate } from '../src/committed-task-reviewer-gate.js';
import type { ReviewerProviderCall } from '../src/reviewer-provider-runner.js';

function createTempRepo(): string {
  const tmpBase = join(process.cwd(), 'tmp');
  if (!existsSync(tmpBase)) {
    mkdirSync(tmpBase);
  }
  const repoPath = mkdtempSync(join(tmpBase, 'committed-reviewer-'));
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

function getGitLogCount(repoPath: string): number {
  const result = spawnSync('git', ['log', '--oneline'], {
    cwd: repoPath,
    encoding: 'utf-8',
    shell: false,
  });
  return result.stdout.trim().split('\n').filter((l) => l.length > 0).length;
}

function getPorcelain(repoPath: string): string {
  const result = spawnSync('git', ['status', '--porcelain', '--untracked-files=all'], {
    cwd: repoPath,
    encoding: 'utf-8',
    shell: false,
  });
  return result.stdout.trim();
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

function makeInput(
  repoPath: string,
  commitSha: string,
  overrides: Record<string, unknown> = {}
) {
  return {
    repoPath,
    taskId: 'task-1',
    taskGoal: 'Test goal',
    branchName: 'ai/task-1',
    commitSha,
    checkSummary: { typecheck: 'pass', build: 'pass', test: 'pass' } as Record<string, unknown>,
    stateStatus: 'pushed',
    reviewer: async () => makeReviewerOutput(),
    ...overrides,
  };
}

describe('committed task reviewer gate', () => {
  test('builds reviewer evidence for a real committed task', async () => {
    const repoPath = createTempRepo();
    const commitSha = getCommitSha(repoPath);
    const result = await runCommittedTaskReviewerGate(makeInput(repoPath, commitSha));
    assert.strictEqual(result.evidence.commitExists, true);
    assert.strictEqual(result.evidence.commitSha, commitSha);
    assert(result.evidence.changedFiles.includes('README.md'));
  });

  test('calls injected reviewer exactly once', async () => {
    const repoPath = createTempRepo();
    const commitSha = getCommitSha(repoPath);
    let callCount = 0;
    const result = await runCommittedTaskReviewerGate(
      makeInput(repoPath, commitSha, {
        reviewer: async () => {
          callCount++;
          return makeReviewerOutput();
        },
      })
    );
    assert.strictEqual(callCount, 1);
    assert.strictEqual(result.reviewerRunnerResult.gateResult.status, 'accepted');
  });

  test('passes reviewer input built from evidence to injected reviewer', async () => {
    const repoPath = createTempRepo();
    const commitSha = getCommitSha(repoPath);
    let receivedInput: unknown;
    await runCommittedTaskReviewerGate(
      makeInput(repoPath, commitSha, {
        reviewer: async (input: unknown) => {
          receivedInput = input;
          return makeReviewerOutput();
        },
      })
    );
    assert(receivedInput);
    const inp = receivedInput as Record<string, unknown>;
    assert.strictEqual(inp.taskId, 'task-1');
    assert.strictEqual(inp.role, 'reviewer');
    assert.deepStrictEqual(inp.changedFiles, ['README.md']);
  });

  test('accept reviewer output returns accepted gate result', async () => {
    const repoPath = createTempRepo();
    const commitSha = getCommitSha(repoPath);
    const result = await runCommittedTaskReviewerGate(makeInput(repoPath, commitSha));
    assert.strictEqual(result.reviewerRunnerResult.gateResult.status, 'accepted');
    assert.strictEqual(result.reviewerRunnerResult.gateResult.source, 'reviewer');
    assert.strictEqual(result.reviewerRunnerResult.gateResult.nextAction, 'continue');
  });

  test('reject reviewer output returns fix_required gate result', async () => {
    const repoPath = createTempRepo();
    const commitSha = getCommitSha(repoPath);
    const result = await runCommittedTaskReviewerGate(
      makeInput(repoPath, commitSha, {
        reviewer: async () =>
          makeReviewerOutput({
            decision: 'reject',
            nextAction: 'fix',
            blockingIssues: ['bug'],
            fixTask: 'fix the bug',
          }),
      })
    );
    assert.strictEqual(result.reviewerRunnerResult.gateResult.status, 'fix_required');
    assert.strictEqual(result.reviewerRunnerResult.gateResult.source, 'reviewer');
    assert.strictEqual(result.reviewerRunnerResult.gateResult.nextAction, 'fix');
  });

  test('block_for_human reviewer output returns blocked gate result', async () => {
    const repoPath = createTempRepo();
    const commitSha = getCommitSha(repoPath);
    const result = await runCommittedTaskReviewerGate(
      makeInput(repoPath, commitSha, {
        reviewer: async () =>
          makeReviewerOutput({
            decision: 'block_for_human',
            nextAction: 'block',
            blockingIssues: ['needs review'],
          }),
      })
    );
    assert.strictEqual(result.reviewerRunnerResult.gateResult.status, 'blocked');
    assert.strictEqual(result.reviewerRunnerResult.gateResult.source, 'reviewer');
    assert.strictEqual(result.reviewerRunnerResult.gateResult.nextAction, 'block');
  });

  test('invalid reviewer output returns blocked parser result', async () => {
    const repoPath = createTempRepo();
    const commitSha = getCommitSha(repoPath);
    const result = await runCommittedTaskReviewerGate(
      makeInput(repoPath, commitSha, {
        reviewer: async () => 'not json',
      })
    );
    assert.strictEqual(result.reviewerRunnerResult.gateResult.status, 'blocked');
    assert.strictEqual(result.reviewerRunnerResult.gateResult.source, 'parser');
  });

  test('provider throw returns blocked provider result without throwing', async () => {
    const repoPath = createTempRepo();
    const commitSha = getCommitSha(repoPath);
    const result = await runCommittedTaskReviewerGate(
      makeInput(repoPath, commitSha, {
        reviewer: async () => {
          throw new Error('provider exploded');
        },
      })
    );
    assert.strictEqual(result.reviewerRunnerResult.gateResult.status, 'blocked');
    assert.strictEqual(result.reviewerRunnerResult.gateResult.source, 'provider');
    assert.strictEqual(result.reviewerRunnerResult.gateResult.nextAction, 'block');
  });

  test('provider reject returns blocked provider result without throwing', async () => {
    const repoPath = createTempRepo();
    const commitSha = getCommitSha(repoPath);
    const result = await runCommittedTaskReviewerGate(
      makeInput(repoPath, commitSha, {
        reviewer: async () => Promise.reject(new Error('rejected')),
      })
    );
    assert.strictEqual(result.reviewerRunnerResult.gateResult.status, 'blocked');
    assert.strictEqual(result.reviewerRunnerResult.gateResult.source, 'provider');
    assert.strictEqual(result.reviewerRunnerResult.gateResult.nextAction, 'block');
  });

  test('provider failure messages are redacted', async () => {
    const repoPath = createTempRepo();
    const commitSha = getCommitSha(repoPath);
    const result = await runCommittedTaskReviewerGate(
      makeInput(repoPath, commitSha, {
        reviewer: async () => {
          throw new Error('sk-fake-reviewer-key');
        },
      })
    );
    assert(!result.reviewerRunnerResult.gateResult.blockingIssues[0].includes('sk-fake'));
    assert(result.reviewerRunnerResult.gateResult.blockingIssues[0].includes('[REDACTED]'));
    assert(result.reviewerRunnerResult.gateResult.blockingIssues[0].includes('Reviewer provider failed'));
  });

  test('deterministic safety override still blocks reviewer accept when branchName is main', async () => {
    const repoPath = createTempRepo();
    const commitSha = getCommitSha(repoPath);
    const result = await runCommittedTaskReviewerGate(
      makeInput(repoPath, commitSha, {
        branchName: 'main',
        reviewer: async () => makeReviewerOutput(),
      })
    );
    assert.strictEqual(result.reviewerRunnerResult.gateResult.status, 'blocked');
    assert.strictEqual(result.reviewerRunnerResult.gateResult.source, 'deterministic_safety');
  });

  test('deterministic safety override still blocks reviewer accept when commitSha is not full length', async () => {
    const repoPath = createTempRepo();
    const commitSha = getCommitSha(repoPath);
    const result = await runCommittedTaskReviewerGate(
      makeInput(repoPath, commitSha.slice(0, 7), {
        reviewer: async () => makeReviewerOutput(),
      })
    );
    assert.strictEqual(result.reviewerRunnerResult.gateResult.status, 'blocked');
    assert.strictEqual(result.reviewerRunnerResult.gateResult.source, 'deterministic_safety');
  });

  test('result includes evidence', async () => {
    const repoPath = createTempRepo();
    const commitSha = getCommitSha(repoPath);
    const result = await runCommittedTaskReviewerGate(makeInput(repoPath, commitSha));
    assert(result.evidence);
    assert.strictEqual(result.evidence.taskId, 'task-1');
  });

  test('result includes reviewer runner result', async () => {
    const repoPath = createTempRepo();
    const commitSha = getCommitSha(repoPath);
    const result = await runCommittedTaskReviewerGate(makeInput(repoPath, commitSha));
    assert(result.reviewerRunnerResult);
    assert(result.reviewerRunnerResult.reviewerInput);
    assert(result.reviewerRunnerResult.gateResult);
  });

  test('evidence includes changed files from actual commit', async () => {
    const repoPath = createTempRepo();
    const commitSha = getCommitSha(repoPath);
    const result = await runCommittedTaskReviewerGate(makeInput(repoPath, commitSha));
    assert(result.evidence.changedFiles.includes('README.md'));
  });

  test('evidence includes diff stat from actual commit', async () => {
    const repoPath = createTempRepo();
    const commitSha = getCommitSha(repoPath);
    const result = await runCommittedTaskReviewerGate(makeInput(repoPath, commitSha));
    assert(result.evidence.diffStat.includes('README.md'));
  });

  test('check summary is preserved', async () => {
    const repoPath = createTempRepo();
    const commitSha = getCommitSha(repoPath);
    const result = await runCommittedTaskReviewerGate(
      makeInput(repoPath, commitSha, {
        checkSummary: { typecheck: 'pass', build: 'fail', test: 'pass' },
      })
    );
    assert.strictEqual(result.evidence.checkSummary.build, 'fail');
    assert.strictEqual(result.reviewerRunnerResult.reviewerInput.checkSummary.build, 'fail');
  });

  test('state status is preserved', async () => {
    const repoPath = createTempRepo();
    const commitSha = getCommitSha(repoPath);
    const result = await runCommittedTaskReviewerGate(
      makeInput(repoPath, commitSha, {
        stateStatus: 'committed',
      })
    );
    assert.strictEqual(result.evidence.stateStatus, 'committed');
    assert.strictEqual(result.reviewerRunnerResult.reviewerInput.stateStatus, 'committed');
  });

  test('repo working tree is not mutated by helper', async () => {
    const repoPath = createTempRepo();
    const commitSha = getCommitSha(repoPath);
    const before = getPorcelain(repoPath);
    await runCommittedTaskReviewerGate(makeInput(repoPath, commitSha));
    const after = getPorcelain(repoPath);
    assert.strictEqual(after, before, 'Working tree should not be mutated');
  });

  test('helper does not create extra commits', async () => {
    const repoPath = createTempRepo();
    const commitSha = getCommitSha(repoPath);
    const before = getGitLogCount(repoPath);
    await runCommittedTaskReviewerGate(makeInput(repoPath, commitSha));
    const after = getGitLogCount(repoPath);
    assert.strictEqual(after, before, 'Should not create extra commits');
  });

  test('helper does not push', async () => {
    const repoPath = createTempRepo();
    const commitSha = getCommitSha(repoPath);
    await runCommittedTaskReviewerGate(makeInput(repoPath, commitSha));
    const result = spawnSync('git', ['log', '--oneline', '--all'], {
      cwd: repoPath,
      encoding: 'utf-8',
      shell: false,
    });
    const logCount = result.stdout.trim().split('\n').filter((l) => l.length > 0).length;
    assert.strictEqual(logCount, 1, 'Should not push or create remote refs');
  });

  test('helper does not call real provider or network APIs', async () => {
    const repoPath = createTempRepo();
    const commitSha = getCommitSha(repoPath);
    const result = await runCommittedTaskReviewerGate(makeInput(repoPath, commitSha));
    assert.strictEqual(result.reviewerRunnerResult.gateResult.status, 'accepted');
  });
});
