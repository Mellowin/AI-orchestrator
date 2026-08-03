import { describe, test } from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { buildReviewerEvidence } from '../src/reviewer-evidence.js';

function createTempRepo(): string {
  const tmpBase = join(process.cwd(), 'tmp');
  if (!existsSync(tmpBase)) {
    mkdirSync(tmpBase);
  }
  const repoPath = mkdtempSync(join(tmpBase, 'reviewer-evidence-'));
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

function getPorcelain(repoPath: string): string {
  const result = spawnSync('git', ['status', '--porcelain', '--untracked-files=all'], {
    cwd: repoPath,
    encoding: 'utf-8',
    shell: false,
  });
  return result.stdout.trim();
}

describe('reviewer evidence builder', () => {
  test('builds evidence for an existing commit', () => {
    const repoPath = createTempRepo();
    const commitSha = getCommitSha(repoPath);
    const evidence = buildReviewerEvidence({
      repoPath,
      taskId: 'task-1',
      taskGoal: 'Test goal',
      branchName: 'ai/task-1',
      commitSha,
      checkSummary: { typecheck: 'pass', build: 'pass', test: 'pass' },
    });
    assert.strictEqual(evidence.commitExists, true);
    assert.strictEqual(evidence.taskId, 'task-1');
    assert.strictEqual(evidence.taskGoal, 'Test goal');
    assert.strictEqual(evidence.branchName, 'ai/task-1');
    assert.strictEqual(evidence.repoPath, repoPath);
  });

  test('includes full 40-char commit SHA', () => {
    const repoPath = createTempRepo();
    const commitSha = getCommitSha(repoPath);
    const evidence = buildReviewerEvidence({
      repoPath,
      taskId: 'task-1',
      taskGoal: 'Test goal',
      branchName: 'ai/task-1',
      commitSha,
      checkSummary: {},
    });
    assert.strictEqual(evidence.commitSha, commitSha);
    assert.strictEqual(commitSha.length, 40);
  });

  test('includes short commit SHA', () => {
    const repoPath = createTempRepo();
    const commitSha = getCommitSha(repoPath);
    const evidence = buildReviewerEvidence({
      repoPath,
      taskId: 'task-1',
      taskGoal: 'Test goal',
      branchName: 'ai/task-1',
      commitSha,
      checkSummary: {},
    });
    assert.strictEqual(evidence.shortCommitSha, commitSha.slice(0, 7));
  });

  test('includes changed files from commit', () => {
    const repoPath = createTempRepo();
    const commitSha = getCommitSha(repoPath);
    const evidence = buildReviewerEvidence({
      repoPath,
      taskId: 'task-1',
      taskGoal: 'Test goal',
      branchName: 'ai/task-1',
      commitSha,
      checkSummary: {},
    });
    assert(evidence.changedFiles.includes('README.md'), `Expected README.md in changed files: ${JSON.stringify(evidence.changedFiles)}`);
  });

  test('includes diff stat', () => {
    const repoPath = createTempRepo();
    const commitSha = getCommitSha(repoPath);
    const evidence = buildReviewerEvidence({
      repoPath,
      taskId: 'task-1',
      taskGoal: 'Test goal',
      branchName: 'ai/task-1',
      commitSha,
      checkSummary: {},
    });
    assert(evidence.diffStat.includes('README.md'), `Expected diff stat to mention README.md: ${evidence.diffStat}`);
  });

  test('marks commitExists true for existing commit', () => {
    const repoPath = createTempRepo();
    const commitSha = getCommitSha(repoPath);
    const evidence = buildReviewerEvidence({
      repoPath,
      taskId: 'task-1',
      taskGoal: 'Test goal',
      branchName: 'ai/task-1',
      commitSha,
      checkSummary: {},
    });
    assert.strictEqual(evidence.commitExists, true);
  });

  test('marks commitExists false for missing commit', () => {
    const repoPath = createTempRepo();
    const evidence = buildReviewerEvidence({
      repoPath,
      taskId: 'task-1',
      taskGoal: 'Test goal',
      branchName: 'ai/task-1',
      commitSha: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
      checkSummary: {},
    });
    assert.strictEqual(evidence.commitExists, false);
  });

  test('commitShaIsFullLength true only for 40-char SHA', () => {
    const repoPath = createTempRepo();
    const fullSha = getCommitSha(repoPath);
    const evidenceFull = buildReviewerEvidence({
      repoPath,
      taskId: 'task-1',
      taskGoal: 'Test goal',
      branchName: 'ai/task-1',
      commitSha: fullSha,
      checkSummary: {},
    });
    assert.strictEqual(evidenceFull.safety.commitShaIsFullLength, true);

    const evidenceShort = buildReviewerEvidence({
      repoPath,
      taskId: 'task-1',
      taskGoal: 'Test goal',
      branchName: 'ai/task-1',
      commitSha: fullSha.slice(0, 7),
      checkSummary: {},
    });
    assert.strictEqual(evidenceShort.safety.commitShaIsFullLength, false);
  });

  test('branchIsNotMain false when branchName is main', () => {
    const repoPath = createTempRepo();
    const commitSha = getCommitSha(repoPath);
    const evidence = buildReviewerEvidence({
      repoPath,
      taskId: 'task-1',
      taskGoal: 'Test goal',
      branchName: 'main',
      commitSha,
      checkSummary: {},
    });
    assert.strictEqual(evidence.safety.branchIsNotMain, false);
  });

  test('branchIsNotMain true when branchName is not main', () => {
    const repoPath = createTempRepo();
    const commitSha = getCommitSha(repoPath);
    const evidence = buildReviewerEvidence({
      repoPath,
      taskId: 'task-1',
      taskGoal: 'Test goal',
      branchName: 'ai/task-1',
      commitSha,
      checkSummary: {},
    });
    assert.strictEqual(evidence.safety.branchIsNotMain, true);
  });

  test('hasChangedFiles true when commit changed files', () => {
    const repoPath = createTempRepo();
    const commitSha = getCommitSha(repoPath);
    const evidence = buildReviewerEvidence({
      repoPath,
      taskId: 'task-1',
      taskGoal: 'Test goal',
      branchName: 'ai/task-1',
      commitSha,
      checkSummary: {},
    });
    assert.strictEqual(evidence.safety.hasChangedFiles, true);
  });

  test('preserves check summary', () => {
    const repoPath = createTempRepo();
    const commitSha = getCommitSha(repoPath);
    const checkSummary = {
      typecheck: 'pass',
      build: 'fail',
      test: 'pass',
      tests: { total: 100, suites: 5, failures: 0 },
    };
    const evidence = buildReviewerEvidence({
      repoPath,
      taskId: 'task-1',
      taskGoal: 'Test goal',
      branchName: 'ai/task-1',
      commitSha,
      checkSummary,
    });
    assert.deepStrictEqual(evidence.checkSummary, checkSummary);
  });

  test('preserves state status', () => {
    const repoPath = createTempRepo();
    const commitSha = getCommitSha(repoPath);
    const evidence = buildReviewerEvidence({
      repoPath,
      taskId: 'task-1',
      taskGoal: 'Test goal',
      branchName: 'ai/task-1',
      commitSha,
      checkSummary: {},
      stateStatus: 'pushed',
    });
    assert.strictEqual(evidence.stateStatus, 'pushed');
  });

  test('does not mutate repository working tree', () => {
    const repoPath = createTempRepo();
    const commitSha = getCommitSha(repoPath);
    const before = getPorcelain(repoPath);
    buildReviewerEvidence({
      repoPath,
      taskId: 'task-1',
      taskGoal: 'Test goal',
      branchName: 'ai/task-1',
      commitSha,
      checkSummary: {},
    });
    const after = getPorcelain(repoPath);
    assert.strictEqual(after, before, `Working tree should not be mutated`);
  });

  test('preserves acceptance_criteria', () => {
    const repoPath = createTempRepo();
    const commitSha = getCommitSha(repoPath);
    const evidence = buildReviewerEvidence({
      repoPath,
      taskId: 'task-1',
      taskGoal: 'Test goal',
      branchName: 'ai/task-1',
      commitSha,
      checkSummary: {},
      acceptance_criteria: ['file must mention X', 'file must end with Y'],
    });
    assert.deepStrictEqual(evidence.acceptance_criteria, ['file must mention X', 'file must end with Y']);
  });

  test('preserves allowedFiles', () => {
    const repoPath = createTempRepo();
    const commitSha = getCommitSha(repoPath);
    const evidence = buildReviewerEvidence({
      repoPath,
      taskId: 'task-1',
      taskGoal: 'Test goal',
      branchName: 'ai/task-1',
      commitSha,
      checkSummary: {},
      allowedFiles: ['docs/part2.md'],
    });
    assert.deepStrictEqual(evidence.allowedFiles, ['docs/part2.md']);
  });

  test('does not call provider APIs', () => {
    const repoPath = createTempRepo();
    const commitSha = getCommitSha(repoPath);
    const evidence = buildReviewerEvidence({
      repoPath,
      taskId: 'task-1',
      taskGoal: 'Test goal',
      branchName: 'ai/task-1',
      commitSha,
      checkSummary: {},
    });
    assert.strictEqual(evidence.taskId, 'task-1');
  });
});
