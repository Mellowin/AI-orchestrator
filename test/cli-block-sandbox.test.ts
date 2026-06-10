import { describe, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import { existsSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getBlockRunDir } from '../src/block/block-state-manager.js';
import type { BlockDefinition } from '../src/block/block-types.js';

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
  delete env.ALLOW_BLOCK_PR_READINESS;
  delete env.ALLOW_GITHUB_MARK_READY;
  delete env.BLOCK_PR_READINESS_DRY_RUN;
  delete env.BLOCK_PR_READINESS_REQUIRE_CI;
  delete env.BLOCK_PR_READINESS_OUTPUT;
  delete env.BLOCK_PR_READINESS_OUTPUT_DIR;
  delete env.MOCK_GITHUB_PR_READINESS_RESPONSE;
  delete env.MOCK_GITHUB_PR_READINESS_CHECKS_RESPONSE;
  delete env.MOCK_GITHUB_PR_READINESS_MARK_RESPONSE;
  delete env.ALLOW_BLOCK_PR_CLEANUP;
  delete env.ALLOW_BLOCK_PR_SUBMIT;
  delete env.ALLOW_BLOCK_SANDBOX;
  delete env.BLOCK_SANDBOX_PATH;
  delete env.BLOCK_SANDBOX_BASE;
  delete env.BLOCK_SANDBOX_KEEP;
  delete env.BLOCK_SANDBOX_OUTPUT;
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

describe('cli block-sandbox', () => {
  let blockJsonPath: string;
  let blockId: string;
  let repoPath: string;

  function makeDefinition(): BlockDefinition {
    return {
      block_id: blockId,
      title: 'CLI Sandbox Test',
      repo_path: repoPath,
      base_branch: 'main',
      work_branch: 'sandbox-test',
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
          task_id: 'task-1',
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

  beforeEach(() => {
    const id = `${Date.now()}-${counter++}`;
    blockId = `cli-sandbox-${id}`;
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
    const result = runCli(['block-sandbox']);
    assert.strictEqual(result.status, 1, `Expected exit 1, got ${result.status}. stderr: ${result.stderr}`);
    const out = result.stdout + result.stderr;
    assert.ok(out.includes('block JSON path is required') || out.includes('Usage:'), out);
  });

  test('missing ALLOW_BLOCK_SANDBOX safe error', () => {
    const def = makeDefinition();
    writeFileSync(blockJsonPath, JSON.stringify(def, null, 2));

    const result = runCli(['block-sandbox', blockJsonPath]);
    assert.strictEqual(result.status, 1, result.stderr);
    assert.ok(result.stderr.includes('ALLOW_BLOCK_SANDBOX'), result.stderr);
  });

  test('prints concise summary with allow flag', () => {
    const def = makeDefinition();
    writeFileSync(blockJsonPath, JSON.stringify(def, null, 2));

    const result = runCli(['block-sandbox', blockJsonPath], {
      ALLOW_BLOCK_SANDBOX: 'true',
    });

    // Should fail because repoPath is not a real git repo, but should print block-sandbox header
    assert.strictEqual(result.status, 1, result.stderr);
    const out = result.stdout + result.stderr;
    assert.ok(out.includes('block-sandbox'), out);
    assert.ok(out.includes('No merge was performed'), out);
    assert.ok(out.includes('No checkout was performed'), out);
    assert.ok(out.includes('No provider call was made'), out);
  });
});
