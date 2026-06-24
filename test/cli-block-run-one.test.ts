import { describe, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

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
  return env;
}

function runCli(args: string[], envOverrides: Record<string, string> = {}): {
  status: number;
  stdout: string;
  stderr: string;
} {
  const env = { ...getCleanEnv(), ...envOverrides };
  const cliPath = join(process.cwd(), 'src', 'cli.ts');
  const tsxPath = join(process.cwd(), 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const result = spawnSync(process.execPath, [tsxPath, cliPath, ...args], {
    cwd: process.cwd(),
    env,
    encoding: 'utf-8',
    shell: false,
    timeout: 30000,
  });
  return {
    status: result.status ?? 1,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
  };
}

describe('cli block-run-one', () => {
  let blockJsonPath: string;
  let blockId: string;

  beforeEach(() => {
    const id = `${Date.now()}-${counter++}`;
    blockId = `cli-br1-${id}`;

    const content = {
      block_id: blockId,
      title: 'CLI Block Run One Test',
      repo_path: '/nonexistent/repo-path-fake-mode',
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
          task_id: 'task-1',
          title: 'Add greeting file',
          goal: 'Create a greeting file',
          allowed_files: ['greeting.txt', 'src/fake.ts'],
          denied_files: ['secret.txt'],
          max_lines_changed: 50,
          checks: ['node -e "require(\'fs\').existsSync(\'greeting.txt\')||process.exit(1)"'],
        },
      ],
    };

    blockJsonPath = join(tmpdir(), `block-${blockId}.json`);
    writeFileSync(blockJsonPath, JSON.stringify(content, null, 2));
  });

  afterEach(() => {
    try {
      if (existsSync(blockJsonPath)) {
        rmSync(blockJsonPath, { force: true });
      }
      const runDir = join(process.cwd(), 'runs', 'blocks', blockId);
      if (existsSync(runDir)) {
        rmSync(runDir, { recursive: true, force: true });
      }
    } catch {
      // ignore cleanup errors
    }
  });

  test('block-run-one requires block JSON path', () => {
    const result = runCli(['block-run-one']);
    assert.strictEqual(result.status, 1, `Expected exit 1, got ${result.status}. stderr: ${result.stderr}`);
    assert.ok(
      result.stderr.includes('Usage:') || result.stderr.includes('block JSON path is required'),
      result.stderr
    );
  });

  test('fake mode runs without git mutation', () => {
    const result = runCli(['block-run-one', blockJsonPath], {
      BLOCK_RUN_ONE_MODE: 'fake',
    });
    assert.strictEqual(result.status, 0, `Expected exit 0, got ${result.status}. stderr: ${result.stderr}`);
    assert.ok(result.stdout.includes('Block:'), result.stdout);
    assert.ok(result.stdout.includes('Task:'), result.stdout);
    assert.ok(result.stdout.includes('Status:'), result.stdout);
    assert.ok(result.stdout.includes('No merge was performed'), result.stdout);
    assert.ok(result.stdout.includes('No checkout was performed'), result.stdout);
    assert.ok(result.stdout.includes('No main touch was performed'), result.stdout);
    // Fake mode should not mention real git commands
    assert.ok(!result.stdout.includes('git add'), result.stdout);
    assert.ok(!result.stdout.includes('git commit'), result.stdout);
    assert.ok(!result.stdout.includes('git push'), result.stdout);
    assert.ok(!result.stdout.includes('git reset'), result.stdout);
  });

  test('fake mode output includes fake commit SHA', () => {
    const result = runCli(['block-run-one', blockJsonPath], {
      BLOCK_RUN_ONE_MODE: 'fake',
    });
    assert.strictEqual(result.status, 0, result.stderr);
    const shaMatch = result.stdout.match(/Commit SHA: (f{40})/);
    assert.ok(shaMatch, `Expected fake 40-char f-SHA in stdout: ${result.stdout}`);
    assert.strictEqual(shaMatch![1].length, 40);
  });

  test('real mode without ALLOW_BLOCK_RUN_ONE fails safely', () => {
    const result = runCli(['block-run-one', blockJsonPath], {
      BLOCK_RUN_ONE_MODE: 'real_kimi_coder_fake_reviewer',
      ALLOW_REAL_PROVIDER: 'true',
      ALLOW_REAL_REPO_APPLY: 'true',
      ALLOW_REAL_REPO_COMMIT: 'true',
    });
    assert.strictEqual(result.status, 1, `Expected exit 1, got ${result.status}`);
    assert.ok(
      result.stderr.includes('ALLOW_BLOCK_RUN_ONE') || result.stderr.includes('not implemented safely yet'),
      result.stderr
    );
  });

  test('real mode missing flags fails safely', () => {
    const result = runCli(['block-run-one', blockJsonPath], {
      BLOCK_RUN_ONE_MODE: 'real_kimi_coder_fake_reviewer',
      ALLOW_BLOCK_RUN_ONE: 'true',
    });
    assert.strictEqual(result.status, 1, `Expected exit 1, got ${result.status}`);
    assert.ok(
      result.stderr.includes('ALLOW_REAL_PROVIDER') || result.stderr.includes('not implemented safely yet'),
      result.stderr
    );
  });

  test('real mode missing ALLOW_REAL_REPO_COMMIT fails safely', () => {
    const result = runCli(['block-run-one', blockJsonPath], {
      BLOCK_RUN_ONE_MODE: 'real_kimi_coder_fake_reviewer',
      ALLOW_BLOCK_RUN_ONE: 'true',
      ALLOW_REAL_PROVIDER: 'true',
      ALLOW_REAL_REPO_APPLY: 'true',
    });
    assert.strictEqual(result.status, 1, `Expected exit 1, got ${result.status}`);
    assert.ok(
      result.stderr.includes('ALLOW_REAL_REPO_COMMIT') || result.stderr.includes('not implemented safely yet'),
      result.stderr
    );
  });

  test('real_kimi_coder_kimi_reviewer missing ALLOW_KIMI_REVIEWER fails safely', () => {
    const result = runCli(['block-run-one', blockJsonPath], {
      BLOCK_RUN_ONE_MODE: 'real_kimi_coder_kimi_reviewer',
      ALLOW_BLOCK_RUN_ONE: 'true',
      ALLOW_REAL_PROVIDER: 'true',
      ALLOW_REAL_REPO_APPLY: 'true',
      ALLOW_REAL_REPO_COMMIT: 'true',
      REVIEWER_PROVIDER: 'kimi',
      CODER_PROVIDER: 'kimi',
      KIMI_API_KEY: 'fake-key',
      KIMI_BASE_URL: 'https://api.moonshot.cn/v1',
    });
    assert.strictEqual(result.status, 1, `Expected exit 1, got ${result.status}`);
    assert.ok(
      result.stderr.includes('ALLOW_KIMI_REVIEWER') || result.stderr.includes('not implemented safely yet'),
      result.stderr
    );
  });

  test('real mode missing KIMI_API_KEY fails safely', () => {
    const result = runCli(['block-run-one', blockJsonPath], {
      BLOCK_RUN_ONE_MODE: 'real_kimi_coder_fake_reviewer',
      ALLOW_BLOCK_RUN_ONE: 'true',
      ALLOW_REAL_PROVIDER: 'true',
      ALLOW_REAL_REPO_APPLY: 'true',
      ALLOW_REAL_REPO_COMMIT: 'true',
      KIMI_API_KEY: '',
    });
    assert.strictEqual(result.status, 1, `Expected exit 1, got ${result.status}`);
    assert.ok(
      result.stderr.includes('KIMI_API_KEY') || result.stderr.includes('not implemented safely yet'),
      result.stderr
    );
  });

  test('real_kimi_coder_kimi_reviewer missing KIMI_API_KEY fails safely', () => {
    const result = runCli(['block-run-one', blockJsonPath], {
      BLOCK_RUN_ONE_MODE: 'real_kimi_coder_kimi_reviewer',
      ALLOW_BLOCK_RUN_ONE: 'true',
      ALLOW_REAL_PROVIDER: 'true',
      ALLOW_REAL_REPO_APPLY: 'true',
      ALLOW_REAL_REPO_COMMIT: 'true',
      ALLOW_KIMI_REVIEWER: 'true',
      REVIEWER_PROVIDER: 'kimi',
      CODER_PROVIDER: 'kimi',
      KIMI_API_KEY: '',
    });
    assert.strictEqual(result.status, 1, `Expected exit 1, got ${result.status}`);
    assert.ok(
      result.stderr.includes('KIMI_API_KEY') || result.stderr.includes('not implemented safely yet'),
      result.stderr
    );
  });

  test('no API key leak', () => {
    const result = runCli(['block-run-one', blockJsonPath], {
      BLOCK_RUN_ONE_MODE: 'fake',
      KIMI_API_KEY: 'sk-test12345',
    });
    assert.strictEqual(result.status, 0, result.stderr);
    assert.ok(!result.stdout.includes('sk-test12345'), 'API key leaked in stdout');
    assert.ok(!result.stderr.includes('sk-test12345'), 'API key leaked in stderr');
  });

  test('no stack trace', () => {
    const result = runCli(['block-run-one', blockJsonPath], {
      BLOCK_RUN_ONE_MODE: 'fake',
    });
    assert.strictEqual(result.status, 0, result.stderr);
    assert.ok(!result.stderr.includes('at '), 'Stack trace leaked in stderr');
  });

  test('no merge/main/checkout/push in fake mode', () => {
    const result = runCli(['block-run-one', blockJsonPath], {
      BLOCK_RUN_ONE_MODE: 'fake',
    });
    assert.strictEqual(result.status, 0, result.stderr);
    assert.ok(result.stdout.includes('No merge was performed'), result.stdout);
    assert.ok(result.stdout.includes('No checkout was performed'), result.stdout);
    assert.ok(result.stdout.includes('No main touch was performed'), result.stdout);
    assert.ok(result.stdout.includes('Pushed: false'), result.stdout);
  });
});
