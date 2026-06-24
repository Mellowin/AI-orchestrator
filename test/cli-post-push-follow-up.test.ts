import { describe, test, afterEach } from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import YAML from 'yaml';
import { saveState } from '../src/state-manager.js';
import type { RunState } from '../src/types.js';

let counter = 0;

function getCleanEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.AI_PROVIDER;
  delete env.KIMI_API_KEY;
  delete env.KIMI_BASE_URL;
  delete env.KIMI_MODEL;
  delete env.OPENAI_API_KEY;
  delete env.MOCK_AI;
  delete env.ALLOW_REAL_PROVIDER;
  delete env.ALLOW_REAL_REPO_APPLY;
  delete env.ALLOW_REAL_REPO_COMMIT;
  delete env.ALLOW_REAL_REPO_PUSH;
  delete env.RUNS_DIR;
  delete env.TASKS_FILE;
  env.AI_PROVIDER = 'mock';
  return env;
}

function runCli(args: string[], envOverrides: Record<string, string> = {}): {
  status: number;
  stdout: string;
  stderr: string;
} {
  const env = { ...getCleanEnv(), ...envOverrides };
  const result = spawnSync(
    `npx tsx "${join(process.cwd(), 'src', 'cli.ts')}" ${args.join(' ')}`,
    {
      cwd: process.cwd(),
      env,
      encoding: 'utf-8',
      shell: true,
      timeout: 15000,
    }
  );
  return {
    status: result.status ?? 1,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
  };
}

function createTempRepo(branch = 'ai/task-x'): { repoPath: string; tmpDir: string; cleanup: () => void; headSha: string } {
  const id = `${Date.now()}-${counter++}`;
  const tmpBase = join(process.cwd(), 'tmp');
  if (!existsSync(tmpBase)) {
    mkdirSync(tmpBase);
  }
  const tmpDir = mkdtempSync(join(tmpBase, `clippfu-${id}-`));
  const repoPath = join(tmpDir, 'repo');
  mkdirSync(repoPath);
  writeFileSync(join(repoPath, 'README.md'), '# hello\n', 'utf-8');
  spawnSync('git', ['init'], { cwd: repoPath, encoding: 'utf-8', shell: false });
  spawnSync('git', ['config', 'user.email', 'ci@example.com'], { cwd: repoPath, encoding: 'utf-8', shell: false });
  spawnSync('git', ['config', 'user.name', 'CI User'], { cwd: repoPath, encoding: 'utf-8', shell: false });
  spawnSync('git', ['add', '.'], { cwd: repoPath, encoding: 'utf-8', shell: false });
  spawnSync('git', ['commit', '-m', 'init', '--no-gpg-sign'], { cwd: repoPath, encoding: 'utf-8', shell: false });
  spawnSync('git', ['branch', '-m', 'main'], { cwd: repoPath, encoding: 'utf-8', shell: false });
  spawnSync('git', ['checkout', '-b', branch], { cwd: repoPath, encoding: 'utf-8', shell: false });
  const headResult = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repoPath, encoding: 'utf-8', shell: false });
  const headSha = headResult.stdout.trim();
  return {
    repoPath,
    tmpDir,
    cleanup: () => rmSync(tmpDir, { recursive: true, force: true }),
    headSha,
  };
}

function buildValidState(
  taskId: string,
  repoPath: string,
  branch: string,
  commitSha: string,
  reviewerStatus: 'blocked' | 'fix_required' = 'blocked'
): RunState {
  const now = new Date().toISOString();
  const state: RunState = {
    task_id: taskId,
    status: 'pushed',
    current_attempt: 1,
    branch,
    repo_path: repoPath,
    created_at: now,
    updated_at: now,
    pushed_remote: 'origin',
    pushed_ref: branch,
    commit_sha: commitSha,
    safety_note: 'Human review required before merge',
    rollback: {
      attempted: false,
      status: 'skipped',
      checkpointHead: commitSha,
      policy: 'post_push_preserve_for_human',
      reason: 'Commit was already pushed; rollback skipped. Human follow-up required.',
    },
  };
  const s = state as unknown as Record<string, unknown>;
  s.reviewer_gate = {
    status: reviewerStatus,
    source: 'reviewer',
    nextAction: reviewerStatus === 'fix_required' ? 'fix' : 'block',
    blockingIssues: ['token sk-reviewer-secret-123456 must be redacted'],
    nonBlockingIssues: [],
    reviewSummary: 'Blocked for human review',
    fixTask: reviewerStatus === 'fix_required' ? 'Add detail' : undefined,
  };
  return state;
}

describe('cli post-push follow-up', () => {
  const cleanups: Array<() => void> = [];

  afterEach(() => {
    while (cleanups.length > 0) {
      cleanups.pop()?.();
    }
  });

  test('report-only succeeds and prints summary', () => {
    const { repoPath, cleanup, headSha } = createTempRepo('ai/cli-follow-up-report');
    cleanups.push(cleanup);
    const taskId = 'cli-follow-up-report';
    const runsDir = join(process.cwd(), 'tmp', `clippfu-runs-${Date.now()}`);
    mkdirSync(runsDir, { recursive: true });
    cleanups.push(() => rmSync(runsDir, { recursive: true, force: true }));
    const state = buildValidState(taskId, repoPath, 'ai/cli-follow-up-report', headSha);
    saveState(taskId, state, runsDir);

    const result = runCli(['real-repo-follow-up', taskId, '--report-only'], { RUNS_DIR: runsDir });
    assert.strictEqual(result.status, 0, result.stdout + result.stderr);
    const output = result.stdout + result.stderr;
    assert.ok(output.includes('Post-push manual follow-up summary'));
    assert.ok(output.includes(`Preserved original commit: ${headSha}`));
    assert.ok(output.includes('Human follow-up required before merge'));
    assert.ok(output.includes('No provider call was made'));
  });

  test('create-follow-up writes file and prints next command', () => {
    const { repoPath, cleanup, headSha } = createTempRepo('ai/cli-follow-up-create');
    cleanups.push(cleanup);
    const taskId = 'cli-follow-up-create';
    const newTaskId = 'cli-follow-up-create-next';
    const runsDir = join(process.cwd(), 'tmp', `clippfu-runs-${Date.now()}`);
    mkdirSync(runsDir, { recursive: true });
    cleanups.push(() => rmSync(runsDir, { recursive: true, force: true }));
    const state = buildValidState(taskId, repoPath, 'ai/cli-follow-up-create', headSha, 'fix_required');
    saveState(taskId, state, runsDir);

    const filePath = join(runsDir, taskId, `follow-up-${newTaskId}.yaml`);
    assert.strictEqual(existsSync(filePath), false);

    const result = runCli(['real-repo-follow-up', taskId, '--create-follow-up', newTaskId], { RUNS_DIR: runsDir });
    assert.strictEqual(result.status, 0, result.stdout + result.stderr);
    const output = result.stdout + result.stderr;
    assert.ok(existsSync(filePath), 'follow-up task file should be created');
    assert.ok(output.includes('Follow-up task file:'));
    assert.ok(output.includes('Next command:'));
    assert.ok(output.includes('real-repo-run-ai'));
    assert.ok(output.includes(newTaskId));

    const content = readFileSync(filePath, 'utf-8');
    const doc = YAML.parse(content);
    assert.strictEqual(doc.tasks[0].id, newTaskId);
    assert.strictEqual(doc.tasks[0].repo_path, repoPath);
    assert.strictEqual(doc.tasks[0].work_branch, 'ai/cli-follow-up-create');
    assert.strictEqual(doc.tasks[0].guardrails.auto_commit, false);
    assert.strictEqual(doc.tasks[0].guardrails.auto_push, false);
    assert.strictEqual(doc.tasks[0].guardrails.auto_merge, false);
  });

  test('refuses non-post-push state', () => {
    const { repoPath, cleanup, headSha } = createTempRepo('ai/cli-follow-up-wrong');
    cleanups.push(cleanup);
    const taskId = 'cli-follow-up-wrong';
    const runsDir = join(process.cwd(), 'tmp', `clippfu-runs-${Date.now()}`);
    mkdirSync(runsDir, { recursive: true });
    cleanups.push(() => rmSync(runsDir, { recursive: true, force: true }));
    const state = buildValidState(taskId, repoPath, 'ai/cli-follow-up-wrong', headSha);
    state.rollback = {
      attempted: true,
      status: 'succeeded',
      checkpointHead: headSha,
      policy: 'pre_push_failure',
      reason: 'Rolled back',
    };
    saveState(taskId, state, runsDir);

    const result = runCli(['real-repo-follow-up', taskId, '--report-only'], { RUNS_DIR: runsDir });
    assert.strictEqual(result.status, 1);
    assert.ok((result.stdout + result.stderr).includes('expected skipped') || (result.stdout + result.stderr).includes('post_push_preserve_for_human'));
  });

  test('refuses missing task id', () => {
    const result = runCli(['real-repo-follow-up']);
    assert.strictEqual(result.status, 1);
    assert.ok((result.stdout + result.stderr).includes('task id is required'));
  });

  test('refuses mismatched internal task_id', () => {
    const { repoPath, cleanup, headSha } = createTempRepo('ai/cli-follow-up-mismatch');
    cleanups.push(cleanup);
    const requestedTaskId = 'cli-follow-up-mismatch';
    const internalTaskId = 'cli-different-task';
    const runsDir = join(process.cwd(), 'tmp', `clippfu-runs-${Date.now()}`);
    mkdirSync(runsDir, { recursive: true });
    cleanups.push(() => rmSync(runsDir, { recursive: true, force: true }));
    const state = buildValidState(internalTaskId, repoPath, 'ai/cli-follow-up-mismatch', headSha);
    saveState(requestedTaskId, state, runsDir);

    const result = runCli(['real-repo-follow-up', requestedTaskId, '--report-only'], { RUNS_DIR: runsDir });
    assert.strictEqual(result.status, 1, result.stdout + result.stderr);
    const output = result.stdout + result.stderr;
    assert.ok(output.includes('task_id mismatch') || output.includes('mismatch'), output);
    assert.ok(output.includes('No provider call was made'));
    assert.ok(output.includes('No repository mutation was performed'));
  });

  test('report-only does not mutate repo', () => {
    const { repoPath, cleanup, headSha } = createTempRepo('ai/cli-follow-up-no-mutate');
    cleanups.push(cleanup);
    const taskId = 'cli-follow-up-no-mutate';
    const runsDir = join(process.cwd(), 'tmp', `clippfu-runs-${Date.now()}`);
    mkdirSync(runsDir, { recursive: true });
    cleanups.push(() => rmSync(runsDir, { recursive: true, force: true }));
    const state = buildValidState(taskId, repoPath, 'ai/cli-follow-up-no-mutate', headSha);
    saveState(taskId, state, runsDir);

    const statusBefore = spawnSync('git', ['status', '--porcelain'], { cwd: repoPath, encoding: 'utf-8', shell: false }).stdout;
    const headBefore = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repoPath, encoding: 'utf-8', shell: false }).stdout.trim();

    runCli(['real-repo-follow-up', taskId, '--report-only'], { RUNS_DIR: runsDir });

    const statusAfter = spawnSync('git', ['status', '--porcelain'], { cwd: repoPath, encoding: 'utf-8', shell: false }).stdout;
    const headAfter = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repoPath, encoding: 'utf-8', shell: false }).stdout.trim();

    assert.strictEqual(statusAfter, statusBefore);
    assert.strictEqual(headAfter, headBefore);
  });

  test('no real provider or reviewer calls are required', () => {
    const { repoPath, cleanup, headSha } = createTempRepo('ai/cli-follow-up-no-keys');
    cleanups.push(cleanup);
    const taskId = 'cli-follow-up-no-keys';
    const runsDir = join(process.cwd(), 'tmp', `clippfu-runs-${Date.now()}`);
    mkdirSync(runsDir, { recursive: true });
    cleanups.push(() => rmSync(runsDir, { recursive: true, force: true }));
    const state = buildValidState(taskId, repoPath, 'ai/cli-follow-up-no-keys', headSha);
    saveState(taskId, state, runsDir);

    const result = runCli(['real-repo-follow-up', taskId, '--report-only'], { RUNS_DIR: runsDir });
    assert.strictEqual(result.status, 0, result.stdout + result.stderr);
    assert.ok((result.stdout + result.stderr).includes('No provider call was made'));
  });
});
