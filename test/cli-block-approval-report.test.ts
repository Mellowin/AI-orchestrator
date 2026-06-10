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

describe('cli block-approval-report', () => {
  let blockJsonPath: string;
  let blockId: string;
  let repoPath: string;
  let customOutputPath: string;

  function makeDefinition(): BlockDefinition {
    return {
      block_id: blockId,
      title: 'CLI Approval Report Test',
      repo_path: repoPath,
      base_branch: 'main',
      work_branch: 'feature/test',
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
          pushed_ref: null,
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

  function makeIncompleteState(def: BlockDefinition): BlockState {
    const now = new Date().toISOString();
    return {
      block_id: def.block_id,
      title: def.title,
      status: 'running',
      repo_path: def.repo_path,
      base_branch: def.base_branch,
      work_branch: def.work_branch,
      current_task_id: 'doc-1',
      created_at: now,
      updated_at: now,
      tasks: [
        {
          task_id: 'doc-1',
          status: 'pending',
          current_attempt: 0,
          fix_attempts: 0,
          commit_sha: null,
          pushed_ref: null,
          reviewer_decision: null,
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
    blockId = `cli-bar-${id}`;
    repoPath = join(tmpdir(), `repo-${blockId}`);
    mkdirSync(repoPath, { recursive: true });
    blockJsonPath = join(tmpdir(), `block-${blockId}.json`);
    customOutputPath = join(tmpdir(), `report-${blockId}.md`);
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
      if (existsSync(customOutputPath)) {
        rmSync(customOutputPath, { force: true });
      }
      if (existsSync(repoPath)) {
        rmSync(repoPath, { recursive: true, force: true });
      }
    } catch {
      // ignore cleanup errors
    }
  });

  test('missing block path shows usage/safe error', () => {
    const result = runCli(['block-approval-report']);
    assert.strictEqual(result.status, 1, `Expected exit 1, got ${result.status}. stderr: ${result.stderr}`);
    const out = result.stdout + result.stderr;
    assert.ok(out.includes('block JSON path is required') || out.includes('Usage:'), out);
  });

  test('missing block state fails safely', () => {
    const def = makeDefinition();
    writeFileSync(blockJsonPath, JSON.stringify(def, null, 2));
    const result = runCli(['block-approval-report', blockJsonPath]);
    assert.strictEqual(result.status, 1, `Expected exit 1, got ${result.status}. stderr: ${result.stderr}`);
    const out = result.stdout + result.stderr;
    assert.ok(out.includes('Block state not found'), out);
  });

  test('completed block prints PR-ready yes', () => {
    const def = makeDefinition();
    writeFileSync(blockJsonPath, JSON.stringify(def, null, 2));
    const state = makeCompletedState(def);
    saveBlockState(state);
    const result = runCli(['block-approval-report', blockJsonPath]);
    assert.strictEqual(result.status, 0, `Expected exit 0, got ${result.status}. stderr: ${result.stderr}`);
    assert.ok(result.stdout.includes('PR-ready: yes'), result.stdout);
  });

  test('incomplete block prints PR-ready no', () => {
    const def = makeDefinition();
    writeFileSync(blockJsonPath, JSON.stringify(def, null, 2));
    const state = makeIncompleteState(def);
    saveBlockState(state);
    const result = runCli(['block-approval-report', blockJsonPath]);
    assert.strictEqual(result.status, 0, `Expected exit 0, got ${result.status}. stderr: ${result.stderr}`);
    assert.ok(result.stdout.includes('PR-ready: no'), result.stdout);
  });

  test('output includes report path', () => {
    const def = makeDefinition();
    writeFileSync(blockJsonPath, JSON.stringify(def, null, 2));
    const state = makeCompletedState(def);
    saveBlockState(state);
    const result = runCli(['block-approval-report', blockJsonPath]);
    assert.strictEqual(result.status, 0, result.stderr);
    assert.ok(result.stdout.includes('Report:'), result.stdout);
    assert.ok(result.stdout.includes('approval-report.md'), result.stdout);
  });

  test('output includes accepted count', () => {
    const def = makeDefinition();
    writeFileSync(blockJsonPath, JSON.stringify(def, null, 2));
    const state = makeCompletedState(def);
    saveBlockState(state);
    const result = runCli(['block-approval-report', blockJsonPath]);
    assert.strictEqual(result.status, 0, result.stderr);
    assert.ok(result.stdout.includes('Tasks accepted: 1/1'), result.stdout);
  });

  test('output includes blocking issues count', () => {
    const def = makeDefinition();
    writeFileSync(blockJsonPath, JSON.stringify(def, null, 2));
    const state = makeCompletedState(def);
    saveBlockState(state);
    const result = runCli(['block-approval-report', blockJsonPath]);
    assert.strictEqual(result.status, 0, result.stderr);
    assert.ok(result.stdout.includes('Blocking issues: 0'), result.stdout);
  });

  test('custom output env works', () => {
    const def = makeDefinition();
    writeFileSync(blockJsonPath, JSON.stringify(def, null, 2));
    const state = makeCompletedState(def);
    saveBlockState(state);
    const result = runCli(['block-approval-report', blockJsonPath], {
      BLOCK_APPROVAL_REPORT_OUTPUT: customOutputPath,
    });
    assert.strictEqual(result.status, 0, `Expected exit 0, got ${result.status}. stderr: ${result.stderr}`);
    assert.ok(result.stdout.includes(`Report: ${customOutputPath}`) || result.stdout.includes(customOutputPath), result.stdout);
    assert.ok(existsSync(customOutputPath), 'Custom output file should exist');
    const report = readFileSync(customOutputPath, 'utf-8');
    assert.ok(report.includes('PR-ready Human Approval Package'), report);
  });

  test('no API key leak', () => {
    const def = makeDefinition();
    writeFileSync(blockJsonPath, JSON.stringify(def, null, 2));
    const state = makeCompletedState(def);
    saveBlockState(state);
    const result = runCli(['block-approval-report', blockJsonPath], {
      KIMI_API_KEY: 'sk-test1234567890abcdef',
    });
    assert.strictEqual(result.status, 0, result.stderr);
    const out = result.stdout + result.stderr;
    assert.ok(!out.includes('sk-test1234567890abcdef'), 'API key leaked in output');
  });

  test('no stack trace', () => {
    const def = makeDefinition();
    writeFileSync(blockJsonPath, JSON.stringify(def, null, 2));
    // No state => error path
    const result = runCli(['block-approval-report', blockJsonPath]);
    assert.strictEqual(result.status, 1, result.stderr);
    const out = result.stdout + result.stderr;
    assert.ok(!out.includes('at '), `Stack trace leaked: ${out}`);
    assert.ok(!out.includes('src/'), `Source path leaked: ${out}`);
  });

  test('no provider call', () => {
    const def = makeDefinition();
    writeFileSync(blockJsonPath, JSON.stringify(def, null, 2));
    const state = makeCompletedState(def);
    saveBlockState(state);
    const result = runCli(['block-approval-report', blockJsonPath]);
    assert.strictEqual(result.status, 0, result.stderr);
    assert.ok(result.stdout.includes('No provider call was made'), result.stdout);
  });

  test('no GitHub API call', () => {
    const def = makeDefinition();
    writeFileSync(blockJsonPath, JSON.stringify(def, null, 2));
    const state = makeCompletedState(def);
    saveBlockState(state);
    const result = runCli(['block-approval-report', blockJsonPath]);
    assert.strictEqual(result.status, 0, result.stderr);
    assert.ok(result.stdout.includes('No GitHub API call was made'), result.stdout);
  });

  test('no PR creation', () => {
    const def = makeDefinition();
    writeFileSync(blockJsonPath, JSON.stringify(def, null, 2));
    const state = makeCompletedState(def);
    saveBlockState(state);
    const result = runCli(['block-approval-report', blockJsonPath]);
    assert.strictEqual(result.status, 0, result.stderr);
    assert.ok(result.stdout.includes('No PR was created'), result.stdout);
  });

  test('no push', () => {
    const def = makeDefinition();
    writeFileSync(blockJsonPath, JSON.stringify(def, null, 2));
    const state = makeCompletedState(def);
    saveBlockState(state);
    const result = runCli(['block-approval-report', blockJsonPath]);
    assert.strictEqual(result.status, 0, result.stderr);
    assert.ok(result.stdout.includes('No push was performed'), result.stdout);
  });

  test('no merge', () => {
    const def = makeDefinition();
    writeFileSync(blockJsonPath, JSON.stringify(def, null, 2));
    const state = makeCompletedState(def);
    saveBlockState(state);
    const result = runCli(['block-approval-report', blockJsonPath]);
    assert.strictEqual(result.status, 0, result.stderr);
    assert.ok(result.stdout.includes('No merge was performed'), result.stdout);
  });

  test('no checkout/switch', () => {
    const def = makeDefinition();
    writeFileSync(blockJsonPath, JSON.stringify(def, null, 2));
    const state = makeCompletedState(def);
    saveBlockState(state);
    const result = runCli(['block-approval-report', blockJsonPath]);
    assert.strictEqual(result.status, 0, result.stderr);
    assert.ok(result.stdout.includes('No checkout was performed'), result.stdout);
  });

  test('no main touch', () => {
    const def = makeDefinition();
    writeFileSync(blockJsonPath, JSON.stringify(def, null, 2));
    const state = makeCompletedState(def);
    saveBlockState(state);
    const result = runCli(['block-approval-report', blockJsonPath]);
    assert.strictEqual(result.status, 0, result.stderr);
    assert.ok(result.stdout.includes('No main touch was performed'), result.stdout);
  });
});
