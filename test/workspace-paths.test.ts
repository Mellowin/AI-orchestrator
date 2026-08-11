import { describe, test } from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  AI_ORCHESTRATOR_WORKSPACE_ROOT_ENV,
  getDefaultWorkspaceRoot,
  makeCandidatePath,
  makeMissionRepoPath,
  makeMissionWorkspaceRoot,
  makeShortRunId,
  makeShortTaskId,
} from '../src/workspace-paths.js';
import { createCandidateWorkspace } from '../src/candidate-workspace.js';

let counter = 0;

function makeTmpDir(): string {
  const base = join(process.cwd(), 'tmp');
  if (!existsSync(base)) mkdirSync(base);
  return mkdtempSync(join(base, `wp-${Date.now()}-${counter++}-`));
}

function initGitRepo(path: string): void {
  mkdirSync(path, { recursive: true });
  spawnSync('git', ['init'], { cwd: path, shell: false, encoding: 'utf-8' });
  spawnSync('git', ['config', 'user.email', 'ci@example.com'], { cwd: path, shell: false, encoding: 'utf-8' });
  spawnSync('git', ['config', 'user.name', 'CI User'], { cwd: path, shell: false, encoding: 'utf-8' });
  writeFileSync(join(path, 'README.md'), '# init\n', 'utf-8');
  spawnSync('git', ['add', '.'], { cwd: path, shell: false, encoding: 'utf-8' });
  spawnSync('git', ['commit', '-m', 'init', '--no-gpg-sign'], { cwd: path, shell: false, encoding: 'utf-8' });
}

function getHeadSha(repoPath: string): string {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repoPath, shell: false, encoding: 'utf-8' });
  return result.stdout.trim();
}

describe('workspace-paths helpers', () => {
  test('makeShortRunId is deterministic and bounded', () => {
    const id = 'mission-20260811-170537-multitask-workflow-a';
    const short = makeShortRunId(id);
    assert.strictEqual(makeShortRunId(id), short);
    assert.strictEqual(short.length, 12);
  });

  test('makeShortTaskId is deterministic and bounded', () => {
    const taskId = 'task-1-create-docs-autonomous-workflow-01-one-click-md';
    const short = makeShortTaskId(taskId);
    assert.strictEqual(makeShortTaskId(taskId), short);
    assert.ok(short.length <= 11, `short task id too long: ${short.length}`);
  });

  test('mission workspace paths are short and deterministic', () => {
    const top = '/tmp/aio-w';
    const runId = 'mission-20260811-170537-multitask-workflow-a';
    const missionRoot = makeMissionWorkspaceRoot(top, makeShortRunId(runId));
    const repoPath = makeMissionRepoPath(missionRoot);
    const candidatePath = makeCandidatePath(missionRoot, makeShortTaskId('task-1'));

    assert.ok(repoPath.length < 100, `repo path too long: ${repoPath}`);
    assert.ok(candidatePath.length < 100, `candidate path too long: ${candidatePath}`);
    assert.ok(repoPath.endsWith('/repo') || repoPath.endsWith('\\repo'), repoPath);
    assert.ok(candidatePath.includes('/t/') || candidatePath.includes('\\t\\'), candidatePath);
  });

  test('very long report output dir does not affect execution workspace length', () => {
    const longReportDir = join(
      process.cwd(),
      'reports',
      'autopilot-plans',
      'mission-20260811-170537-multitask-workflow-a'
    );
    const top = getDefaultWorkspaceRoot();
    const runId = longReportDir;
    const missionRoot = makeMissionWorkspaceRoot(top, makeShortRunId(runId));
    const candidatePath = makeCandidatePath(missionRoot, makeShortTaskId('task-1'));

    assert.ok(longReportDir.length > 80);
    assert.ok(
      candidatePath.length < 120,
      `candidate path should be short even with long report dir: ${candidatePath}`
    );
    assert.ok(!candidatePath.includes('autopilot-plans'), 'candidate path should not contain report dir');
  });

  test('getDefaultWorkspaceRoot honors environment override', () => {
    const tmpDir = makeTmpDir();
    const original = process.env[AI_ORCHESTRATOR_WORKSPACE_ROOT_ENV];
    process.env[AI_ORCHESTRATOR_WORKSPACE_ROOT_ENV] = tmpDir;
    try {
      assert.strictEqual(resolve(getDefaultWorkspaceRoot()), resolve(tmpDir));
    } finally {
      if (original !== undefined) {
        process.env[AI_ORCHESTRATOR_WORKSPACE_ROOT_ENV] = original;
      } else {
        delete process.env[AI_ORCHESTRATOR_WORKSPACE_ROOT_ENV];
      }
    }
    rmSync(tmpDir, { recursive: true, force: true });
  });
});

describe('candidate workspace path preflight', () => {
  test('path traversal is rejected before clone', () => {
    const tmpDir = makeTmpDir();
    const repoPath = join(tmpDir, 'repo');
    initGitRepo(repoPath);
    const baseSha = getHeadSha(repoPath);
    const result = createCandidateWorkspace(`${tmpDir}/../evil`, repoPath, baseSha, 'main', 't1');
    assert.strictEqual(result.ok, false);
    assert.ok(result.reason?.includes('path traversal'), result.reason);
  });

  test('path inside .git is rejected before clone', () => {
    const tmpDir = makeTmpDir();
    const repoPath = join(tmpDir, 'repo');
    initGitRepo(repoPath);
    const baseSha = getHeadSha(repoPath);
    const result = createCandidateWorkspace(
      join(repoPath, '.git', 'workspaces', 't1'),
      repoPath,
      baseSha,
      'main',
      't1'
    );
    assert.strictEqual(result.ok, false);
    assert.ok(result.reason?.includes('.git'), result.reason);
  });

  test('overly long candidate path is rejected before clone', () => {
    const tmpDir = makeTmpDir();
    const repoPath = join(tmpDir, 'repo');
    initGitRepo(repoPath);
    const baseSha = getHeadSha(repoPath);
    const longPath = join(tmpDir, 'a'.repeat(260), 'workspace');
    const result = createCandidateWorkspace(longPath, repoPath, baseSha, 'main', 't1');
    assert.strictEqual(result.ok, false);
    assert.ok(result.reason?.includes('too long'), result.reason);
  });
});
