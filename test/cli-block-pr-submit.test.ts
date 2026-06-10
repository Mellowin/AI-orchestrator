import { describe, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import { existsSync, writeFileSync, rmSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { saveBlockState, getBlockRunDir } from '../src/block/block-state-manager.js';
import type { BlockDefinition, BlockState } from '../src/block/block-types.js';

let counter = 0;

function getCleanEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.AI_PROVIDER;
  delete env.MOCK_AI_RESPONSE;
  delete env.MOCK_REVIEWER_RESPONSE;
  delete env.KIMI_API_KEY;
  delete env.KIMI_MODEL;
  delete env.KIMI_BASE_URL;
  delete env.KIMI_USER_AGENT;
  delete env.KIMI_FAKE_REVIEWER_RESPONSE;
  delete env.REVIEWER_PROVIDER;
  delete env.ALLOW_KIMI_REVIEWER;
  delete env.OPENAI_API_KEY;
  delete env.MOCK_AI;
  delete env.DRY_RUN_TYPECHECK_RESULT;
  delete env.DRY_RUN_BUILD_RESULT;
  delete env.DRY_RUN_TEST_RESULT;
  delete env.ALLOW_REAL_PROVIDER;
  delete env.ALLOW_REAL_REPO_APPLY;
  delete env.ALLOW_REAL_REPO_COMMIT;
  delete env.ALLOW_REAL_REPO_PUSH;
  delete env.ALLOW_BLOCK_RUN_ONE;
  delete env.BLOCK_RUN_ONE_MODE;
  delete env.BLOCK_RUN_MODE;
  delete env.BLOCK_RUN_MAX_TASKS;
  delete env.BLOCK_RUN_STOP_ON_REJECTED;
  delete env.BLOCK_RUN_STOP_ON_BLOCKED;
  delete env.BLOCK_APPROVAL_REPORT_OUTPUT;
  delete env.BLOCK_APPROVAL_INCLUDE_DIFF_SUMMARY;
  delete env.BLOCK_PR_DRAFT_OUTPUT_DIR;
  delete env.BLOCK_PR_DRAFT_INCLUDE_DIFF_STAT;
  delete env.ALLOW_BLOCK_PR_CREATE;
  delete env.ALLOW_GITHUB_PR_CREATE;
  delete env.GITHUB_TOKEN;
  delete env.GITHUB_REPOSITORY;
  delete env.ALLOW_PR_CREATE_WITHOUT_APPROVAL_REPORT;
  delete env.ALLOW_BLOCK_PR_CREATE_DUPLICATE;
  delete env.BLOCK_PR_CREATE_DRY_RUN;
  delete env.ALLOW_GITHUB_PR_STATUS;
  delete env.ALLOW_BLOCK_PR_SUBMIT;
  delete env.BLOCK_PR_SUBMIT_DRY_RUN;
  delete env.BLOCK_PR_SUBMIT_REQUIRE_PR_READY;
  return env;
}

function runCli(args: string[], envOverrides: Record<string, string> = {}): {
  status: number;
  stdout: string;
  stderr: string;
} {
  const env = { ...getCleanEnv(), ...envOverrides };
  const quotedArgs = args.map((a) => (a.includes(' ') || a.includes('\\') ? `"${a}"` : a));
  const result = spawnSync(
    `npx tsx "${join(process.cwd(), 'src', 'cli.ts')}" ${quotedArgs.join(' ')}`,
    {
      cwd: process.cwd(),
      env,
      encoding: 'utf-8',
      shell: true,
      timeout: 30000,
    }
  );
  return {
    status: result.status ?? 1,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
  };
}

function createTempRepoWithBareOrigin(workBranch: string): { repoPath: string; barePath: string } {
  const repoPath = join(tmpdir(), `repo-${Date.now()}-${counter++}`);
  const barePath = join(tmpdir(), `bare-${Date.now()}-${counter++}.git`);
  mkdirSync(repoPath, { recursive: true });
  mkdirSync(barePath, { recursive: true });

  spawnSync('git', ['init', '--bare'], { cwd: barePath, shell: false, encoding: 'utf-8' });
  spawnSync('git', ['init'], { cwd: repoPath, shell: false, encoding: 'utf-8' });
  spawnSync('git', ['config', 'user.email', 'test@test.com'], { cwd: repoPath, shell: false, encoding: 'utf-8' });
  spawnSync('git', ['config', 'user.name', 'Test'], { cwd: repoPath, shell: false, encoding: 'utf-8' });
  spawnSync('git', ['remote', 'add', 'origin', barePath], { cwd: repoPath, shell: false, encoding: 'utf-8' });
  writeFileSync(join(repoPath, 'readme.txt'), 'hello');
  spawnSync('git', ['add', 'readme.txt'], { cwd: repoPath, shell: false, encoding: 'utf-8' });
  spawnSync('git', ['commit', '-m', 'init', '--no-gpg-sign'], { cwd: repoPath, shell: false, encoding: 'utf-8' });
  spawnSync('git', ['checkout', '-b', workBranch], { cwd: repoPath, shell: false, encoding: 'utf-8' });
  spawnSync('git', ['push', '-u', 'origin', workBranch], { cwd: repoPath, shell: false, encoding: 'utf-8' });

  return { repoPath, barePath };
}

describe('cli block-pr-submit', () => {
  let blockJsonPath: string;
  let blockId: string;
  let repoPath: string;
  let barePath: string;

  beforeEach(() => {
    blockId = `cli-pr-submit-${Date.now()}-${counter++}`;
  });

  afterEach(() => {
    try {
      const runDir = getBlockRunDir(blockId);
      if (existsSync(runDir)) {
        rmSync(runDir, { recursive: true, force: true });
      }
      if (existsSync(blockJsonPath)) {
        rmSync(blockJsonPath, { force: true });
      }
      if (existsSync(repoPath)) {
        rmSync(repoPath, { recursive: true, force: true });
      }
      if (existsSync(barePath)) {
        rmSync(barePath, { recursive: true, force: true });
      }
    } catch {
      // ignore
    }
  });

  function createDefinition(tasks: BlockDefinition['tasks']): BlockDefinition {
    return {
      block_id: blockId,
      title: 'CLI PR Submit Test Block',
      repo_path: repoPath,
      base_branch: 'main',
      work_branch: 'feature/test',
      providers: {
        coder: { provider: 'fake', model: 'default' },
        reviewer: { provider: 'fake', model: 'default' },
      },
      review_policy: {
        require_deterministic_checks: true,
        max_fix_attempts: 3,
        reviewer_mode: 'single',
      },
      tasks,
    };
  }

  function completedState(): BlockState {
    return {
      block_id: blockId,
      title: 'CLI PR Submit Test Block',
      base_branch: 'main',
      work_branch: 'feature/test',
      status: 'completed',
      current_task_id: null,
      tasks: [
        {
          task_id: 'task-1',
          status: 'accepted',
          commit_sha: 'a'.repeat(40),
          pushed_ref: 'origin/feature/test',
          reviewer_decision: 'accepted',
          reviewer_summary: 'Looks good',
          fix_attempts: 0,
          blocking_issues: [],
          check_failure_summary: '',
        },
      ],
      review_policy: {
        require_deterministic_checks: true,
        max_fix_attempts: 3,
        reviewer_mode: 'single',
      },
    };
  }

  function setupBlock(def: BlockDefinition, state: BlockState) {
    blockJsonPath = join(tmpdir(), `${blockId}.json`);
    writeFileSync(blockJsonPath, JSON.stringify(def), 'utf-8');
    saveBlockState(state);
  }

  test('missing block path shows usage/safe error', () => {
    const result = runCli(['block-pr-submit'], {
      ALLOW_BLOCK_PR_SUBMIT: 'true',
    });
    assert.notStrictEqual(result.status, 0);
    const out = result.stdout + result.stderr;
    assert.ok(out.includes('block JSON path is required') || out.includes('Usage:'), out);
  });

  test('missing ALLOW_BLOCK_PR_SUBMIT safe error', () => {
    const { repoPath: rp, barePath: bp } = createTempRepoWithBareOrigin('feature/test');
    repoPath = rp;
    barePath = bp;
    const def = createDefinition([
      { task_id: 'task-1', title: 'T1', goal: 'g', allowed_files: ['readme.txt'], denied_files: [], max_lines_changed: 100, checks: [] },
    ]);
    setupBlock(def, completedState());

    const result = runCli(['block-pr-submit', blockJsonPath], {});
    assert.notStrictEqual(result.status, 0);
    assert.ok(result.stderr.includes('ALLOW_BLOCK_PR_SUBMIT=true is required'));
  });

  test('dry-run prints expected summary', () => {
    const { repoPath: rp, barePath: bp } = createTempRepoWithBareOrigin('feature/test');
    repoPath = rp;
    barePath = bp;
    const def = createDefinition([
      { task_id: 'task-1', title: 'T1', goal: 'g', allowed_files: ['readme.txt'], denied_files: [], max_lines_changed: 100, checks: [] },
    ]);
    setupBlock(def, completedState());

    const result = runCli(['block-pr-submit', blockJsonPath], {
      ALLOW_BLOCK_PR_SUBMIT: 'true',
      BLOCK_PR_SUBMIT_DRY_RUN: 'true',
      ALLOW_BLOCK_PR_CREATE: 'true',
      ALLOW_GITHUB_PR_CREATE: 'true',
      GITHUB_TOKEN: 'ghp_testtoken123',
      GITHUB_REPOSITORY: 'test-owner/test-repo',
    });
    assert.strictEqual(result.status, 0);
    assert.ok(result.stdout.includes('[block-pr-submit] Block:'));
    assert.ok(result.stdout.includes('[block-pr-submit] Dry run: yes'));
    assert.ok(result.stdout.includes('[block-pr-submit] Report:'));
    assert.ok(result.stdout.includes('No merge was performed'));
    assert.ok(result.stdout.includes('No provider call was made'));
  });

  test('real mode missing PR create gates safe error', () => {
    const { repoPath: rp, barePath: bp } = createTempRepoWithBareOrigin('feature/test');
    repoPath = rp;
    barePath = bp;
    const def = createDefinition([
      { task_id: 'task-1', title: 'T1', goal: 'g', allowed_files: ['readme.txt'], denied_files: [], max_lines_changed: 100, checks: [] },
    ]);
    setupBlock(def, completedState());

    const result = runCli(['block-pr-submit', blockJsonPath], {
      ALLOW_BLOCK_PR_SUBMIT: 'true',
      BLOCK_PR_SUBMIT_DRY_RUN: 'false',
      // missing ALLOW_BLOCK_PR_CREATE and ALLOW_GITHUB_PR_CREATE
    });
    assert.notStrictEqual(result.status, 0);
    assert.ok(result.stderr.includes('ALLOW_BLOCK_PR_CREATE=true is required') || result.stderr.includes('Dry-run PR create validation failed'));
  });

  test('no token leak in output', () => {
    const { repoPath: rp, barePath: bp } = createTempRepoWithBareOrigin('feature/test');
    repoPath = rp;
    barePath = bp;
    const def = createDefinition([
      { task_id: 'task-1', title: 'T1', goal: 'g', allowed_files: ['readme.txt'], denied_files: [], max_lines_changed: 100, checks: [] },
    ]);
    setupBlock(def, completedState());

    const result = runCli(['block-pr-submit', blockJsonPath], {
      ALLOW_BLOCK_PR_SUBMIT: 'true',
      GITHUB_TOKEN: 'ghp_secrettoken1234567890',
      ALLOW_BLOCK_PR_CREATE: 'true',
      ALLOW_GITHUB_PR_CREATE: 'true',
      GITHUB_REPOSITORY: 'test-owner/test-repo',
    });
    assert.strictEqual(result.status, 0);
    assert.strictEqual(result.stdout.includes('ghp_secrettoken'), false);
    assert.strictEqual(result.stderr.includes('ghp_secrettoken'), false);
  });

  test('no stack trace in failure paths', () => {
    const result = runCli(['block-pr-submit'], {
      ALLOW_BLOCK_PR_SUBMIT: 'true',
    });
    assert.notStrictEqual(result.status, 0);
    assert.strictEqual(result.stderr.includes('at '), false);
    assert.strictEqual(result.stderr.includes('src/block/block-pr-submit'), false);
  });

  test('non-completed block safe error', () => {
    const { repoPath: rp, barePath: bp } = createTempRepoWithBareOrigin('feature/test');
    repoPath = rp;
    barePath = bp;
    const def = createDefinition([
      { task_id: 'task-1', title: 'T1', goal: 'g', allowed_files: ['readme.txt'], denied_files: [], max_lines_changed: 100, checks: [] },
    ]);
    const state = completedState();
    state.status = 'fixing';
    setupBlock(def, state);

    const result = runCli(['block-pr-submit', blockJsonPath], {
      ALLOW_BLOCK_PR_SUBMIT: 'true',
    });
    assert.notStrictEqual(result.status, 0);
    assert.ok(result.stderr.includes('Block status must be completed'));
  });

  test('main branch safe error', () => {
    const def = createDefinition([
      { task_id: 'task-1', title: 'T1', goal: 'g', allowed_files: ['readme.txt'], denied_files: [], max_lines_changed: 100, checks: [] },
    ]);
    def.work_branch = 'main';
    const state = completedState();
    state.work_branch = 'main';
    setupBlock(def, state);

    const result = runCli(['block-pr-submit', blockJsonPath], {
      ALLOW_BLOCK_PR_SUBMIT: 'true',
    });
    assert.notStrictEqual(result.status, 0);
    assert.ok(result.stderr.includes('work_branch must not be "main"'));
  });
});
