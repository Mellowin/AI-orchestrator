import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const projectRoot = resolve(import.meta.dirname, '..');
const tsxPath = join(projectRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const cliPath = join(projectRoot, 'src', 'cli.ts');

function runGit(cwd: string, args: string[]): { ok: boolean; stdout: string; stderr: string } {
  const result = spawnSync('git', args, { cwd, encoding: 'utf-8', shell: false });
  return { ok: result.status === 0, stdout: result.stdout || '', stderr: result.stderr || '' };
}

function createTempRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'stale-state-test-'));
  runGit(dir, ['init', '--initial-branch=main']);
  runGit(dir, ['config', 'user.email', 'test@example.com']);
  runGit(dir, ['config', 'user.name', 'Test']);
  writeFileSync(join(dir, 'base.txt'), 'base');
  runGit(dir, ['add', 'base.txt']);
  runGit(dir, ['commit', '-m', 'base']);
  return dir;
}

function runCli(args: string[], env: NodeJS.ProcessEnv = {}): { exitCode: number; stdout: string; stderr: string } {
  const result = spawnSync(
    process.execPath,
    [tsxPath, cliPath, ...args],
    {
      cwd: projectRoot,
      encoding: 'utf-8',
      shell: false,
      env: { ...process.env, ...env },
    }
  );
  return {
    exitCode: result.status ?? 1,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
  };
}

interface SetupOptions {
  staleCommit?: string;
  fresh?: boolean;
}

function setupBlockRun(options: SetupOptions = {}): { repo: string; runsDir: string; blockPath: string } {
  const repo = createTempRepo();
  const baseSha = runGit(repo, ['rev-parse', 'HEAD']).stdout.trim();

  // Create an orphan commit that will be the "stale" accepted commit
  runGit(repo, ['checkout', '--orphan', 'stale']);
  writeFileSync(join(repo, 'stale.txt'), 'stale');
  runGit(repo, ['add', 'stale.txt']);
  runGit(repo, ['commit', '-m', 'stale task commit']);
  const staleSha = runGit(repo, ['rev-parse', 'HEAD']).stdout.trim();

  // Set work branch back to base
  runGit(repo, ['checkout', '-b', 'work', baseSha]);

  const runsDir = mkdtempSync(join(tmpdir(), 'stale-runs-'));
  const blockId = 'stale_test_block';
  const taskId = 'task_stale';

  const blockPath = join(runsDir, 'block.json');
  writeFileSync(
    blockPath,
    JSON.stringify(
      {
        block_id: blockId,
        title: 'Stale test',
        repo_path: repo,
        base_branch: 'main',
        work_branch: 'work',
        providers: {
          coder: { provider: 'kimi', model: 'kimi-k2.6' },
          reviewer: { provider: 'kimi', model: 'kimi-k2.6' },
        },
        review_policy: {
          require_deterministic_checks: true,
          max_fix_attempts: 1,
          reviewer_mode: 'single',
        },
        tasks: [
          {
            task_id: taskId,
            title: 'Stale task',
            goal: 'do nothing',
            allowed_files: ['base.txt'],
            denied_files: [],
            max_lines_changed: 10,
            checks: [],
          },
        ],
      },
      null,
      2
    )
  );

  const taskCommit = options.staleCommit === 'missing' ? '0'.repeat(40) : staleSha;

  // Child task state
  const taskStateDir = join(runsDir, taskId);
  mkdirSync(taskStateDir, { recursive: true });
  writeFileSync(
    join(taskStateDir, 'state.json'),
    JSON.stringify({
      task_id: taskId,
      status: 'pushed',
      branch: 'work',
      repo_path: repo,
      commit_sha: taskCommit,
      reviewer_gate: { status: 'accepted', reviewSummary: 'accepted', nextAction: 'continue' },
    })
  );

  // Block state
  const blockStateDir = join(runsDir, 'block', blockId);
  mkdirSync(blockStateDir, { recursive: true });
  writeFileSync(
    join(blockStateDir, 'state.json'),
    JSON.stringify({
      block_id: blockId,
      title: 'Stale test',
      status: 'blocked',
      currentTaskId: taskId,
      statePath: join(blockStateDir, 'state.json'),
      taskResults: [
        {
          taskId,
          title: 'Stale task',
          status: 'accepted',
          fixAttempted: false,
          finalStatus: 'accepted',
          nextAction: 'continue',
          childStateTaskId: taskId,
          codeApplied: true,
          pushed: true,
          checksResult: 'pass',
          originalCommitSha: taskCommit,
          reviewerGateStatus: 'accepted',
          reviewerSummary: 'accepted',
          reason: 'accepted',
        },
      ],
      summary: { totalTasks: 1, acceptedTasks: 0, fixedTasks: 0, completedTasks: 0 },
      startedAt: new Date().toISOString(),
      safetyNote: 'test',
    })
  );

  return { repo, runsDir, blockPath };
}

describe('real-block-run-ai stale state detection', () => {
  it('fails resume when accepted task commit is not ancestor of work branch', () => {
    const { blockPath, runsDir } = setupBlockRun();
    const result = runCli(['real-block-run-ai', blockPath, '--resume'], {
      RUNS_DIR: runsDir,
      ALLOW_REAL_PROVIDER: 'true',
      ALLOW_REAL_REPO_APPLY: 'true',
      ALLOW_REAL_REPO_COMMIT: 'true',
      ALLOW_REAL_REPO_PUSH: 'true',
      ALLOW_REAL_BLOCK_RUN_AI: 'true',
      KIMI_API_KEY: 'sk-test',
      KIMI_BASE_URL: 'https://api.kimi.com/coding/v1',
    });
    assert.notEqual(result.exitCode, 0, `expected non-zero exit, got stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    assert.match(result.stderr + result.stdout, /stale|not an ancestor/i);
  });

  it('fails resume when accepted task commit is missing', () => {
    const { blockPath, runsDir } = setupBlockRun({ staleCommit: 'missing' });
    const result = runCli(['real-block-run-ai', blockPath, '--resume'], {
      RUNS_DIR: runsDir,
      ALLOW_REAL_PROVIDER: 'true',
      ALLOW_REAL_REPO_APPLY: 'true',
      ALLOW_REAL_REPO_COMMIT: 'true',
      ALLOW_REAL_REPO_PUSH: 'true',
      ALLOW_REAL_BLOCK_RUN_AI: 'true',
      KIMI_API_KEY: 'sk-test',
      KIMI_BASE_URL: 'https://api.kimi.com/coding/v1',
    });
    assert.notEqual(result.exitCode, 0);
    assert.match(result.stderr + result.stdout, /does not exist|stale/i);
  });

  it('--fresh removes stale state and starts from scratch', () => {
    const { blockPath, runsDir } = setupBlockRun();
    const blockStatePath = join(runsDir, 'block', 'stale_test_block', 'state.json');
    const taskStatePath = join(runsDir, 'task_stale', 'state.json');
    assert.equal(existsSync(blockStatePath), true);
    assert.equal(existsSync(taskStatePath), true);

    const result = runCli(['real-block-run-ai', blockPath, '--fresh'], {
      RUNS_DIR: runsDir,
      ALLOW_REAL_PROVIDER: 'true',
      ALLOW_REAL_REPO_APPLY: 'true',
      ALLOW_REAL_REPO_COMMIT: 'true',
      ALLOW_REAL_REPO_PUSH: 'true',
      ALLOW_REAL_BLOCK_RUN_AI: 'true',
      KIMI_API_KEY: 'sk-test',
      KIMI_BASE_URL: 'https://api.kimi.com/coding/v1',
    });

    // --fresh must delete the stale task state. Block state may be recreated by the run.
    assert.equal(existsSync(taskStatePath), false);
    assert.match(result.stderr + result.stdout, /Fresh mode/i);
    // A new block state should be written (even if the run later fails without API key).
    if (existsSync(blockStatePath)) {
      const newState = JSON.parse(readFileSync(blockStatePath, 'utf-8')) as Record<string, unknown>;
      assert.equal(newState.block_id, 'stale_test_block');
    }
  });
});
