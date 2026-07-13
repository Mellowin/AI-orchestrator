import { describe, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import { existsSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
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
  env.GITHUB_TOKEN = '';
  env.GITHUB_REPOSITORY = '';
  delete env.ALLOW_PR_CREATE_WITHOUT_APPROVAL_REPORT;
  delete env.ALLOW_BLOCK_PR_CREATE_DUPLICATE;
  delete env.BLOCK_PR_CREATE_DRY_RUN;
  delete env.ALLOW_GITHUB_PR_STATUS;
  delete env.BLOCK_PR_STATUS_OUTPUT;
  delete env.BLOCK_PR_NUMBER;
  delete env.MOCK_GITHUB_PR_STATUS_RESPONSE;
  delete env.MOCK_GITHUB_PR_STATUS_CHECKS_RESPONSE;
  delete env.ALLOW_BLOCK_PR_READINESS;
  delete env.ALLOW_GITHUB_MARK_READY;
  delete env.BLOCK_PR_READINESS_DRY_RUN;
  delete env.BLOCK_PR_READINESS_REQUIRE_CI;
  delete env.BLOCK_PR_READINESS_OUTPUT;
  delete env.BLOCK_PR_READINESS_OUTPUT_DIR;
  delete env.MOCK_GITHUB_PR_READINESS_RESPONSE;
  delete env.MOCK_GITHUB_PR_READINESS_CHECKS_RESPONSE;
  delete env.MOCK_GITHUB_PR_READINESS_MARK_RESPONSE;
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

describe('cli block-pr-readiness', () => {
  let blockJsonPath: string;
  let blockId: string;
  let repoPath: string;

  function makeDefinition(): BlockDefinition {
    return {
      block_id: blockId,
      title: 'CLI PR Readiness Test',
      repo_path: repoPath,
      base_branch: 'feature/mvp-skeleton',
      work_branch: 'stage-6-11-pr-create-proof',
      providers: {
        coder: { provider: 'fake', model: 'default' },
        reviewer: { provider: 'fake', model: 'default' },
      },
      review_policy: {
        require_deterministic_checks: true,
        max_fix_attempts: 2,
        reviewer_mode: 'single',
      },
      tasks: [
        {
          task_id: 'doc-1',
          title: 'T1',
          goal: 'G1',
          allowed_files: ['a.txt'],
          denied_files: [],
          max_lines_changed: 50,
          checks: [],
        },
      ],
    };
  }

  function makeCompletedState(def: BlockDefinition): BlockState {
    const now = new Date().toISOString();
    return {
      block_id: def.block_id,
      title: def.title,
      status: 'completed',
      repo_path: def.repo_path,
      base_branch: def.base_branch,
      work_branch: def.work_branch,
      current_task_id: null,
      created_at: now,
      updated_at: now,
      tasks: [
        {
          task_id: 'doc-1',
          status: 'accepted',
          current_attempt: 1,
          fix_attempts: 0,
          commit_sha: 'abc123def456abc123def456abc123def456abcd',
          pushed_ref: 'origin/stage-6-11-pr-create-proof',
          reviewer_decision: 'accepted',
          reviewer_summary: null,
          blocking_issues: [],
          updated_at: now,
        },
      ],
      safety_note: 'safe',
      review_policy: def.review_policy,
    };
  }

  beforeEach(() => {
    const id = `${Date.now()}-${counter++}`;
    blockId = `cli-bpr-${id}`;
    repoPath = join(tmpdir(), `repo-${blockId}`);
    mkdirSync(repoPath, { recursive: true });
    blockJsonPath = join(tmpdir(), `block-${blockId}.json`);
  });

  afterEach(() => {
    try {
      if (existsSync(blockJsonPath)) {
        rmSync(blockJsonPath, { force: true });
      }
      const runDir = getBlockRunDir(blockId);
      if (existsSync(runDir)) {
        rmSync(runDir, { recursive: true, force: true });
      }
      if (existsSync(repoPath)) {
        rmSync(repoPath, { recursive: true, force: true });
      }
    } catch {
      // ignore cleanup errors
    }
  });

  test('missing block path shows usage/safe error', () => {
    const result = runCli(['block-pr-readiness']);
    assert.strictEqual(result.status, 1, `Expected exit 1, got ${result.status}. stderr: ${result.stderr}`);
    const out = result.stdout + result.stderr;
    assert.ok(out.includes('block JSON path is required') || out.includes('Usage:'), out);
  });

  test('missing ALLOW_BLOCK_PR_READINESS safe error', () => {
    const def = makeDefinition();
    writeFileSync(blockJsonPath, JSON.stringify(def, null, 2));
    const state = makeCompletedState(def);
    saveBlockState(state);

    const result = runCli(['block-pr-readiness', blockJsonPath], {
      GITHUB_REPOSITORY: 'test-owner/test-repo',
    });
    assert.strictEqual(result.status, 1, result.stderr);
    assert.ok(result.stderr.includes('ALLOW_BLOCK_PR_READINESS'), result.stderr);
  });

  test('dry-run prints expected summary', () => {
    const def = makeDefinition();
    writeFileSync(blockJsonPath, JSON.stringify(def, null, 2));
    const state = makeCompletedState(def);
    saveBlockState(state);

    const mockPr = JSON.stringify({
      state: 'open',
      draft: true,
      merged: false,
      base: { ref: 'feature/mvp-skeleton' },
      head: { ref: 'stage-6-11-pr-create-proof', sha: 'abc123def456abc123def456abc123def456abcd' },
      html_url: 'https://github.com/test-owner/test-repo/pull/2',
      commits: 1,
      changed_files: 1,
    });
    const mockChecks = JSON.stringify({ check_runs: [{ name: 'CI', status: 'completed', conclusion: 'success' }] });

    const result = runCli(['block-pr-readiness', blockJsonPath], {
      ALLOW_BLOCK_PR_READINESS: 'true',
      GITHUB_REPOSITORY: 'test-owner/test-repo',
      BLOCK_PR_NUMBER: '2',
      MOCK_GITHUB_PR_READINESS_RESPONSE: mockPr,
      MOCK_GITHUB_PR_READINESS_CHECKS_RESPONSE: mockChecks,
    });
    assert.strictEqual(result.status, 0, `Expected exit 0, got ${result.status}. stderr: ${result.stderr}`);
    assert.ok(result.stdout.includes('Readiness: ready'), result.stdout);
    assert.ok(result.stdout.includes('Dry run: yes'), result.stdout);
    assert.ok(result.stdout.includes('Would mark ready: no'), result.stdout);
  });

  test('real mode missing mark-ready gates does not error', () => {
    const def = makeDefinition();
    writeFileSync(blockJsonPath, JSON.stringify(def, null, 2));
    const state = makeCompletedState(def);
    saveBlockState(state);

    const mockPr = JSON.stringify({
      state: 'open',
      draft: true,
      merged: false,
      base: { ref: 'feature/mvp-skeleton' },
      head: { ref: 'stage-6-11-pr-create-proof', sha: 'abc123def456abc123def456abc123def456abcd' },
      html_url: 'https://github.com/test-owner/test-repo/pull/2',
      commits: 1,
      changed_files: 1,
    });
    const mockChecks = JSON.stringify({ check_runs: [{ name: 'CI', status: 'completed', conclusion: 'success' }] });

    const result = runCli(['block-pr-readiness', blockJsonPath], {
      ALLOW_BLOCK_PR_READINESS: 'true',
      GITHUB_REPOSITORY: 'test-owner/test-repo',
      BLOCK_PR_NUMBER: '2',
      BLOCK_PR_READINESS_DRY_RUN: 'false',
      GITHUB_TOKEN: 'ghp_testtoken1234567890',
      MOCK_GITHUB_PR_READINESS_RESPONSE: mockPr,
      MOCK_GITHUB_PR_READINESS_CHECKS_RESPONSE: mockChecks,
    });
    assert.strictEqual(result.status, 0, result.stderr);
    assert.ok(result.stdout.includes('Readiness: ready'), result.stdout);
    assert.ok(result.stdout.includes('Would mark ready: no'), result.stdout);
    assert.ok(result.stdout.includes('Marked ready: no'), result.stdout);
  });

  test('no token leak in output', () => {
    const def = makeDefinition();
    writeFileSync(blockJsonPath, JSON.stringify(def, null, 2));
    const state = makeCompletedState(def);
    saveBlockState(state);

    const mockPr = JSON.stringify({
      state: 'open',
      draft: true,
      merged: false,
      base: { ref: 'feature/mvp-skeleton' },
      head: { ref: 'stage-6-11-pr-create-proof', sha: 'abc123def456abc123def456abc123def456abcd' },
      html_url: 'https://github.com/test-owner/test-repo/pull/2',
      commits: 1,
      changed_files: 1,
    });
    const mockChecks = JSON.stringify({ check_runs: [{ name: 'CI', status: 'completed', conclusion: 'success' }] });

    const result = runCli(['block-pr-readiness', blockJsonPath], {
      ALLOW_BLOCK_PR_READINESS: 'true',
      GITHUB_REPOSITORY: 'test-owner/test-repo',
      BLOCK_PR_NUMBER: '2',
      GITHUB_TOKEN: 'github_pat_1234567890abcdef1234567890abcdef12345678',
      MOCK_GITHUB_PR_READINESS_RESPONSE: mockPr,
      MOCK_GITHUB_PR_READINESS_CHECKS_RESPONSE: mockChecks,
    });
    assert.strictEqual(result.status, 0, result.stderr);
    const out = result.stdout + result.stderr;
    assert.ok(!out.includes('github_pat_1234567890abcdef1234567890abcdef12345678'), 'token leaked in output');
  });

  test('no stack trace in failure paths', () => {
    const def = makeDefinition();
    writeFileSync(blockJsonPath, JSON.stringify(def, null, 2));
    const state = makeCompletedState(def);
    saveBlockState(state);

    const mockPr = JSON.stringify({
      state: 'closed',
      draft: true,
      merged: false,
      base: { ref: 'feature/mvp-skeleton' },
      head: { ref: 'stage-6-11-pr-create-proof', sha: 'abc123def456abc123def456abc123def456abcd' },
      html_url: 'https://github.com/test-owner/test-repo/pull/2',
      commits: 1,
      changed_files: 1,
    });
    const mockChecks = JSON.stringify({ check_runs: [{ name: 'CI', status: 'completed', conclusion: 'success' }] });

    const result = runCli(['block-pr-readiness', blockJsonPath], {
      ALLOW_BLOCK_PR_READINESS: 'true',
      GITHUB_REPOSITORY: 'test-owner/test-repo',
      BLOCK_PR_NUMBER: '2',
      MOCK_GITHUB_PR_READINESS_RESPONSE: mockPr,
      MOCK_GITHUB_PR_READINESS_CHECKS_RESPONSE: mockChecks,
    });
    assert.strictEqual(result.status, 0, `Expected exit 0, got ${result.status}. stderr: ${result.stderr}`);
    const out = result.stdout + result.stderr;
    assert.ok(!out.includes('at '), `Stack trace leaked: ${out}`);
    assert.ok(!out.includes('src/'), `Source path leaked: ${out}`);
  });

  test('non-draft PR safe error', () => {
    const def = makeDefinition();
    writeFileSync(blockJsonPath, JSON.stringify(def, null, 2));
    const state = makeCompletedState(def);
    saveBlockState(state);

    const mockPr = JSON.stringify({
      state: 'open',
      draft: false,
      merged: false,
      base: { ref: 'feature/mvp-skeleton' },
      head: { ref: 'stage-6-11-pr-create-proof', sha: 'abc123def456abc123def456abc123def456abcd' },
      html_url: 'https://github.com/test-owner/test-repo/pull/2',
      commits: 1,
      changed_files: 1,
    });
    const mockChecks = JSON.stringify({ check_runs: [{ name: 'CI', status: 'completed', conclusion: 'success' }] });

    const result = runCli(['block-pr-readiness', blockJsonPath], {
      ALLOW_BLOCK_PR_READINESS: 'true',
      GITHUB_REPOSITORY: 'test-owner/test-repo',
      BLOCK_PR_NUMBER: '2',
      MOCK_GITHUB_PR_READINESS_RESPONSE: mockPr,
      MOCK_GITHUB_PR_READINESS_CHECKS_RESPONSE: mockChecks,
    });
    assert.strictEqual(result.status, 0, result.stderr);
    assert.ok(result.stdout.includes('not draft') || result.stdout.includes('Blocking issues'), result.stdout);
  });

  test('main branch safe error', () => {
    const def = makeDefinition();
    writeFileSync(blockJsonPath, JSON.stringify(def, null, 2));
    const state = makeCompletedState(def);
    saveBlockState(state);

    const mockPr = JSON.stringify({
      state: 'open',
      draft: true,
      merged: false,
      base: { ref: 'feature/mvp-skeleton' },
      head: { ref: 'main', sha: 'abc123def456abc123def456abc123def456abcd' },
      html_url: 'https://github.com/test-owner/test-repo/pull/2',
      commits: 1,
      changed_files: 1,
    });
    const mockChecks = JSON.stringify({ check_runs: [{ name: 'CI', status: 'completed', conclusion: 'success' }] });

    const result = runCli(['block-pr-readiness', blockJsonPath], {
      ALLOW_BLOCK_PR_READINESS: 'true',
      GITHUB_REPOSITORY: 'test-owner/test-repo',
      BLOCK_PR_NUMBER: '2',
      MOCK_GITHUB_PR_READINESS_RESPONSE: mockPr,
      MOCK_GITHUB_PR_READINESS_CHECKS_RESPONSE: mockChecks,
    });
    assert.strictEqual(result.status, 0, result.stderr);
    assert.ok(result.stdout.includes('main/master') || result.stdout.includes('Blocking issues'), result.stdout);
  });
});
