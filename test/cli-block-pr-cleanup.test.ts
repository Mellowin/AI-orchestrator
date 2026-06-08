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
  delete env.BLOCK_PR_STATUS_OUTPUT;
  delete env.BLOCK_PR_NUMBER;
  delete env.MOCK_GITHUB_PR_STATUS_RESPONSE;
  delete env.MOCK_GITHUB_PR_STATUS_CHECKS_RESPONSE;
  delete env.ALLOW_BLOCK_PR_CLEANUP;
  delete env.ALLOW_GITHUB_PR_CLOSE;
  delete env.ALLOW_GITHUB_BRANCH_DELETE;
  delete env.BLOCK_PR_CLEANUP_DRY_RUN;
  delete env.BLOCK_PR_CLEANUP_CLOSE_PR;
  delete env.BLOCK_PR_CLEANUP_DELETE_BRANCH;
  delete env.BLOCK_PR_CLEANUP_OUTPUT;
  delete env.MOCK_GITHUB_PR_CLEANUP_RESPONSE;
  delete env.MOCK_GITHUB_PR_CLEANUP_CLOSE_RESPONSE;
  delete env.MOCK_GITHUB_PR_CLEANUP_DELETE_RESPONSE;
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

describe('cli block-pr-cleanup', () => {
  let blockJsonPath: string;
  let blockId: string;
  let repoPath: string;

  function makeDefinition(): BlockDefinition {
    return {
      block_id: blockId,
      title: 'CLI PR Cleanup Test',
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

  function writePrCreatedJson(runDir: string) {
    writeFileSync(
      join(runDir, 'pr-created.json'),
      JSON.stringify(
        {
          block_id: blockId,
          pr_number: 2,
          pr_url: 'https://github.com/Mellowin/AI-orchestrator/pull/2',
          base: 'feature/mvp-skeleton',
          head: 'stage-6-11-pr-create-proof',
          title: 'Test PR',
          commit_shas: ['a9e967128918e908e62e3ca452dd93baec8b5488'],
          created_at: new Date().toISOString(),
          no_merge_performed: true,
          no_push_performed: true,
          no_checkout_performed: true,
          no_main_touch_performed: true,
        },
        null,
        2
      )
    );
  }

  beforeEach(() => {
    const id = `${Date.now()}-${counter++}`;
    blockId = `cli-bpc-${id}`;
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

  test('missing block path safe error', () => {
    const result = runCli(['block-pr-cleanup']);
    assert.strictEqual(result.status, 1, `Expected exit 1, got ${result.status}. stderr: ${result.stderr}`);
    const out = result.stdout + result.stderr;
    assert.ok(out.includes('block JSON path is required') || out.includes('Usage:'), out);
  });

  test('dry-run prints Dry run yes', () => {
    const def = makeDefinition();
    writeFileSync(blockJsonPath, JSON.stringify(def, null, 2));
    const state = makeCompletedState(def);
    saveBlockState(state);
    const runDir = getBlockRunDir(blockId);
    mkdirSync(runDir, { recursive: true });
    writePrCreatedJson(runDir);

    const mockPr = JSON.stringify({
      state: 'open',
      draft: true,
      merged: false,
      base: { ref: 'feature/mvp-skeleton' },
      head: { ref: 'stage-6-11-pr-create-proof' },
      html_url: 'https://github.com/Mellowin/AI-orchestrator/pull/2',
    });

    const result = runCli(['block-pr-cleanup', blockJsonPath], {
      ALLOW_BLOCK_PR_CLEANUP: 'true',
      GITHUB_REPOSITORY: 'Mellowin/AI-orchestrator',
      MOCK_GITHUB_PR_CLEANUP_RESPONSE: mockPr,
    });
    assert.strictEqual(result.status, 0, `Expected exit 0, got ${result.status}. stderr: ${result.stderr}`);
    assert.ok(result.stdout.includes('Dry run: yes'), result.stdout);
  });

  test('close request without allow flag prints safe error', () => {
    const def = makeDefinition();
    writeFileSync(blockJsonPath, JSON.stringify(def, null, 2));
    const state = makeCompletedState(def);
    saveBlockState(state);
    const runDir = getBlockRunDir(blockId);
    mkdirSync(runDir, { recursive: true });
    writePrCreatedJson(runDir);

    const mockPr = JSON.stringify({
      state: 'open',
      draft: true,
      merged: false,
      base: { ref: 'feature/mvp-skeleton' },
      head: { ref: 'stage-6-11-pr-create-proof' },
      html_url: 'https://github.com/Mellowin/AI-orchestrator/pull/2',
    });

    const result = runCli(['block-pr-cleanup', blockJsonPath], {
      ALLOW_BLOCK_PR_CLEANUP: 'true',
      GITHUB_REPOSITORY: 'Mellowin/AI-orchestrator',
      BLOCK_PR_CLEANUP_CLOSE_PR: 'true',
      BLOCK_PR_CLEANUP_DRY_RUN: 'false',
      MOCK_GITHUB_PR_CLEANUP_RESPONSE: mockPr,
    });
    assert.strictEqual(result.status, 0, result.stderr);
    assert.ok(result.stdout.includes('Cleanup safe: no') || result.stdout.includes('ALLOW_GITHUB_PR_CLOSE'), result.stdout);
  });

  test('delete request without allow flag prints safe error', () => {
    const def = makeDefinition();
    writeFileSync(blockJsonPath, JSON.stringify(def, null, 2));
    const state = makeCompletedState(def);
    saveBlockState(state);
    const runDir = getBlockRunDir(blockId);
    mkdirSync(runDir, { recursive: true });
    writePrCreatedJson(runDir);

    const mockPr = JSON.stringify({
      state: 'open',
      draft: true,
      merged: false,
      base: { ref: 'feature/mvp-skeleton' },
      head: { ref: 'stage-6-11-pr-create-proof' },
      html_url: 'https://github.com/Mellowin/AI-orchestrator/pull/2',
    });

    const result = runCli(['block-pr-cleanup', blockJsonPath], {
      ALLOW_BLOCK_PR_CLEANUP: 'true',
      GITHUB_REPOSITORY: 'Mellowin/AI-orchestrator',
      BLOCK_PR_CLEANUP_DELETE_BRANCH: 'true',
      BLOCK_PR_CLEANUP_DRY_RUN: 'false',
      MOCK_GITHUB_PR_CLEANUP_RESPONSE: mockPr,
    });
    assert.strictEqual(result.status, 0, result.stderr);
    assert.ok(result.stdout.includes('Cleanup safe: no') || result.stdout.includes('ALLOW_GITHUB_BRANCH_DELETE'), result.stdout);
  });

  test('close+delete dry-run does not call write endpoints', () => {
    const def = makeDefinition();
    writeFileSync(blockJsonPath, JSON.stringify(def, null, 2));
    const state = makeCompletedState(def);
    saveBlockState(state);
    const runDir = getBlockRunDir(blockId);
    mkdirSync(runDir, { recursive: true });
    writePrCreatedJson(runDir);

    const mockPr = JSON.stringify({
      state: 'open',
      draft: true,
      merged: false,
      base: { ref: 'feature/mvp-skeleton' },
      head: { ref: 'stage-6-11-pr-create-proof' },
      html_url: 'https://github.com/Mellowin/AI-orchestrator/pull/2',
    });

    const result = runCli(['block-pr-cleanup', blockJsonPath], {
      ALLOW_BLOCK_PR_CLEANUP: 'true',
      GITHUB_REPOSITORY: 'Mellowin/AI-orchestrator',
      BLOCK_PR_CLEANUP_CLOSE_PR: 'true',
      BLOCK_PR_CLEANUP_DELETE_BRANCH: 'true',
      MOCK_GITHUB_PR_CLEANUP_RESPONSE: mockPr,
    });
    assert.strictEqual(result.status, 0, result.stderr);
    assert.ok(result.stdout.includes('PR closed: no'), result.stdout);
    assert.ok(result.stdout.includes('Branch deleted: no'), result.stdout);
    assert.ok(result.stdout.includes('Dry run: yes'), result.stdout);
  });

  test('real close with fake fetch prints PR closed yes', () => {
    const def = makeDefinition();
    writeFileSync(blockJsonPath, JSON.stringify(def, null, 2));
    const state = makeCompletedState(def);
    saveBlockState(state);
    const runDir = getBlockRunDir(blockId);
    mkdirSync(runDir, { recursive: true });
    writePrCreatedJson(runDir);

    const mockPr = JSON.stringify({
      state: 'open',
      draft: true,
      merged: false,
      base: { ref: 'feature/mvp-skeleton' },
      head: { ref: 'stage-6-11-pr-create-proof' },
      html_url: 'https://github.com/Mellowin/AI-orchestrator/pull/2',
    });
    const mockClose = JSON.stringify({ ok: true, status: 200 });

    const result = runCli(['block-pr-cleanup', blockJsonPath], {
      ALLOW_BLOCK_PR_CLEANUP: 'true',
      ALLOW_GITHUB_PR_CLOSE: 'true',
      GITHUB_REPOSITORY: 'Mellowin/AI-orchestrator',
      GITHUB_TOKEN: 'ghp_testtoken1234567890',
      BLOCK_PR_CLEANUP_CLOSE_PR: 'true',
      BLOCK_PR_CLEANUP_DRY_RUN: 'false',
      MOCK_GITHUB_PR_CLEANUP_RESPONSE: mockPr,
      MOCK_GITHUB_PR_CLEANUP_CLOSE_RESPONSE: mockClose,
    });
    assert.strictEqual(result.status, 0, result.stderr);
    assert.ok(result.stdout.includes('PR closed: yes'), result.stdout);
  });

  test('real delete with fake fetch prints Branch deleted yes', () => {
    const def = makeDefinition();
    writeFileSync(blockJsonPath, JSON.stringify(def, null, 2));
    const state = makeCompletedState(def);
    saveBlockState(state);
    const runDir = getBlockRunDir(blockId);
    mkdirSync(runDir, { recursive: true });
    writePrCreatedJson(runDir);

    const mockPr = JSON.stringify({
      state: 'closed',
      draft: true,
      merged: false,
      base: { ref: 'feature/mvp-skeleton' },
      head: { ref: 'stage-6-11-pr-create-proof' },
      html_url: 'https://github.com/Mellowin/AI-orchestrator/pull/2',
    });
    const mockDelete = JSON.stringify({ ok: true, status: 204 });

    const result = runCli(['block-pr-cleanup', blockJsonPath], {
      ALLOW_BLOCK_PR_CLEANUP: 'true',
      ALLOW_GITHUB_BRANCH_DELETE: 'true',
      GITHUB_REPOSITORY: 'Mellowin/AI-orchestrator',
      GITHUB_TOKEN: 'ghp_testtoken1234567890',
      BLOCK_PR_CLEANUP_DELETE_BRANCH: 'true',
      BLOCK_PR_CLEANUP_DRY_RUN: 'false',
      MOCK_GITHUB_PR_CLEANUP_RESPONSE: mockPr,
      MOCK_GITHUB_PR_CLEANUP_DELETE_RESPONSE: mockDelete,
    });
    assert.strictEqual(result.status, 0, result.stderr);
    assert.ok(result.stdout.includes('Branch deleted: yes'), result.stdout);
  });

  test('output path override works', () => {
    const def = makeDefinition();
    writeFileSync(blockJsonPath, JSON.stringify(def, null, 2));
    const state = makeCompletedState(def);
    saveBlockState(state);
    const runDir = getBlockRunDir(blockId);
    mkdirSync(runDir, { recursive: true });
    writePrCreatedJson(runDir);

    const customOutput = join(tmpdir(), `pr-cleanup-${blockId}.md`);
    const mockPr = JSON.stringify({
      state: 'open',
      draft: true,
      merged: false,
      base: { ref: 'feature/mvp-skeleton' },
      head: { ref: 'stage-6-11-pr-create-proof' },
      html_url: 'https://github.com/Mellowin/AI-orchestrator/pull/2',
    });

    const result = runCli(['block-pr-cleanup', blockJsonPath], {
      ALLOW_BLOCK_PR_CLEANUP: 'true',
      GITHUB_REPOSITORY: 'Mellowin/AI-orchestrator',
      BLOCK_PR_CLEANUP_OUTPUT: customOutput,
      MOCK_GITHUB_PR_CLEANUP_RESPONSE: mockPr,
    });
    assert.strictEqual(result.status, 0, result.stderr);
    assert.ok(result.stdout.includes(customOutput) || result.stdout.includes('Report:'), result.stdout);
    assert.ok(existsSync(customOutput), `Custom output not found at ${customOutput}`);
    const report = readFileSync(customOutput, 'utf-8');
    assert.ok(report.includes('PR Cleanup Report'), report);
    rmSync(customOutput, { force: true });
  });

  test('token not leaked', () => {
    const def = makeDefinition();
    writeFileSync(blockJsonPath, JSON.stringify(def, null, 2));
    const state = makeCompletedState(def);
    saveBlockState(state);
    const runDir = getBlockRunDir(blockId);
    mkdirSync(runDir, { recursive: true });
    writePrCreatedJson(runDir);

    const mockPr = JSON.stringify({
      state: 'open',
      draft: true,
      merged: false,
      base: { ref: 'feature/mvp-skeleton' },
      head: { ref: 'stage-6-11-pr-create-proof' },
      html_url: 'https://github.com/Mellowin/AI-orchestrator/pull/2',
    });

    const result = runCli(['block-pr-cleanup', blockJsonPath], {
      ALLOW_BLOCK_PR_CLEANUP: 'true',
      GITHUB_REPOSITORY: 'Mellowin/AI-orchestrator',
      GITHUB_TOKEN: 'ghp_testtoken1234567890',
      MOCK_GITHUB_PR_CLEANUP_RESPONSE: mockPr,
    });
    assert.strictEqual(result.status, 0, result.stderr);
    const out = result.stdout + result.stderr;
    assert.ok(!out.includes('ghp_testtoken1234567890'), 'token leaked in output');
  });

  test('no stack trace', () => {
    const def = makeDefinition();
    writeFileSync(blockJsonPath, JSON.stringify(def, null, 2));
    const result = runCli(['block-pr-cleanup', blockJsonPath]);
    assert.strictEqual(result.status, 1, result.stderr);
    const out = result.stdout + result.stderr;
    assert.ok(!out.includes('at '), `Stack trace leaked: ${out}`);
    assert.ok(!out.includes('src/'), `Source path leaked: ${out}`);
  });

  test('no merge', () => {
    const def = makeDefinition();
    writeFileSync(blockJsonPath, JSON.stringify(def, null, 2));
    const state = makeCompletedState(def);
    saveBlockState(state);
    const runDir = getBlockRunDir(blockId);
    mkdirSync(runDir, { recursive: true });
    writePrCreatedJson(runDir);

    const mockPr = JSON.stringify({
      state: 'open',
      draft: true,
      merged: false,
      base: { ref: 'feature/mvp-skeleton' },
      head: { ref: 'stage-6-11-pr-create-proof' },
      html_url: 'https://github.com/Mellowin/AI-orchestrator/pull/2',
    });

    const result = runCli(['block-pr-cleanup', blockJsonPath], {
      ALLOW_BLOCK_PR_CLEANUP: 'true',
      GITHUB_REPOSITORY: 'Mellowin/AI-orchestrator',
      MOCK_GITHUB_PR_CLEANUP_RESPONSE: mockPr,
    });
    assert.strictEqual(result.status, 0, result.stderr);
    assert.ok(result.stdout.includes('No merge was performed'), result.stdout);
  });

  test('no auto-merge', () => {
    const def = makeDefinition();
    writeFileSync(blockJsonPath, JSON.stringify(def, null, 2));
    const state = makeCompletedState(def);
    saveBlockState(state);
    const runDir = getBlockRunDir(blockId);
    mkdirSync(runDir, { recursive: true });
    writePrCreatedJson(runDir);

    const mockPr = JSON.stringify({
      state: 'open',
      draft: true,
      merged: false,
      base: { ref: 'feature/mvp-skeleton' },
      head: { ref: 'stage-6-11-pr-create-proof' },
      html_url: 'https://github.com/Mellowin/AI-orchestrator/pull/2',
    });

    const result = runCli(['block-pr-cleanup', blockJsonPath], {
      ALLOW_BLOCK_PR_CLEANUP: 'true',
      GITHUB_REPOSITORY: 'Mellowin/AI-orchestrator',
      MOCK_GITHUB_PR_CLEANUP_RESPONSE: mockPr,
    });
    assert.strictEqual(result.status, 0, result.stderr);
    assert.ok(result.stdout.includes('No auto-merge was performed'), result.stdout);
  });

  test('no push', () => {
    const def = makeDefinition();
    writeFileSync(blockJsonPath, JSON.stringify(def, null, 2));
    const state = makeCompletedState(def);
    saveBlockState(state);
    const runDir = getBlockRunDir(blockId);
    mkdirSync(runDir, { recursive: true });
    writePrCreatedJson(runDir);

    const mockPr = JSON.stringify({
      state: 'open',
      draft: true,
      merged: false,
      base: { ref: 'feature/mvp-skeleton' },
      head: { ref: 'stage-6-11-pr-create-proof' },
      html_url: 'https://github.com/Mellowin/AI-orchestrator/pull/2',
    });

    const result = runCli(['block-pr-cleanup', blockJsonPath], {
      ALLOW_BLOCK_PR_CLEANUP: 'true',
      GITHUB_REPOSITORY: 'Mellowin/AI-orchestrator',
      MOCK_GITHUB_PR_CLEANUP_RESPONSE: mockPr,
    });
    assert.strictEqual(result.status, 0, result.stderr);
    assert.ok(result.stdout.includes('No push was performed'), result.stdout);
  });

  test('no checkout', () => {
    const def = makeDefinition();
    writeFileSync(blockJsonPath, JSON.stringify(def, null, 2));
    const state = makeCompletedState(def);
    saveBlockState(state);
    const runDir = getBlockRunDir(blockId);
    mkdirSync(runDir, { recursive: true });
    writePrCreatedJson(runDir);

    const mockPr = JSON.stringify({
      state: 'open',
      draft: true,
      merged: false,
      base: { ref: 'feature/mvp-skeleton' },
      head: { ref: 'stage-6-11-pr-create-proof' },
      html_url: 'https://github.com/Mellowin/AI-orchestrator/pull/2',
    });

    const result = runCli(['block-pr-cleanup', blockJsonPath], {
      ALLOW_BLOCK_PR_CLEANUP: 'true',
      GITHUB_REPOSITORY: 'Mellowin/AI-orchestrator',
      MOCK_GITHUB_PR_CLEANUP_RESPONSE: mockPr,
    });
    assert.strictEqual(result.status, 0, result.stderr);
    assert.ok(result.stdout.includes('No checkout was performed'), result.stdout);
  });

  test('no main touch', () => {
    const def = makeDefinition();
    writeFileSync(blockJsonPath, JSON.stringify(def, null, 2));
    const state = makeCompletedState(def);
    saveBlockState(state);
    const runDir = getBlockRunDir(blockId);
    mkdirSync(runDir, { recursive: true });
    writePrCreatedJson(runDir);

    const mockPr = JSON.stringify({
      state: 'open',
      draft: true,
      merged: false,
      base: { ref: 'feature/mvp-skeleton' },
      head: { ref: 'stage-6-11-pr-create-proof' },
      html_url: 'https://github.com/Mellowin/AI-orchestrator/pull/2',
    });

    const result = runCli(['block-pr-cleanup', blockJsonPath], {
      ALLOW_BLOCK_PR_CLEANUP: 'true',
      GITHUB_REPOSITORY: 'Mellowin/AI-orchestrator',
      MOCK_GITHUB_PR_CLEANUP_RESPONSE: mockPr,
    });
    assert.strictEqual(result.status, 0, result.stderr);
    assert.ok(result.stdout.includes('No main touch was performed'), result.stdout);
  });

  test('no provider call', () => {
    const def = makeDefinition();
    writeFileSync(blockJsonPath, JSON.stringify(def, null, 2));
    const state = makeCompletedState(def);
    saveBlockState(state);
    const runDir = getBlockRunDir(blockId);
    mkdirSync(runDir, { recursive: true });
    writePrCreatedJson(runDir);

    const mockPr = JSON.stringify({
      state: 'open',
      draft: true,
      merged: false,
      base: { ref: 'feature/mvp-skeleton' },
      head: { ref: 'stage-6-11-pr-create-proof' },
      html_url: 'https://github.com/Mellowin/AI-orchestrator/pull/2',
    });

    const result = runCli(['block-pr-cleanup', blockJsonPath], {
      ALLOW_BLOCK_PR_CLEANUP: 'true',
      GITHUB_REPOSITORY: 'Mellowin/AI-orchestrator',
      MOCK_GITHUB_PR_CLEANUP_RESPONSE: mockPr,
    });
    assert.strictEqual(result.status, 0, result.stderr);
    assert.ok(result.stdout.includes('No provider call was made'), result.stdout);
  });
});
