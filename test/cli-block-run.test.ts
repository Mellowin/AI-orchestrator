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
  delete env.BLOCK_RUN_MODE;
  delete env.BLOCK_RUN_MAX_TASKS;
  delete env.BLOCK_RUN_STOP_ON_REJECTED;
  delete env.BLOCK_RUN_STOP_ON_BLOCKED;
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

describe('cli block-run', () => {
  let blockJsonPath: string;
  let blockId: string;

  beforeEach(() => {
    const id = `${Date.now()}-${counter++}`;
    blockId = `cli-br-${id}`;

    const content = {
      block_id: blockId,
      title: 'CLI Block Run Test',
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
          checks: [],
        },
        {
          task_id: 'task-2',
          title: 'Add second file',
          goal: 'Create second file',
          allowed_files: ['second.txt', 'src/fake.ts'],
          denied_files: [],
          max_lines_changed: 50,
          checks: [],
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

  test('missing block path fails safely', () => {
    const result = runCli(['block-run']);
    assert.strictEqual(result.status, 1, `Expected exit 1, got ${result.status}. stderr: ${result.stderr}`);
    assert.ok(
      result.stderr.includes('Usage:') || result.stderr.includes('block JSON path is required'),
      result.stderr
    );
  });

  test('invalid JSON fails safely', () => {
    const badPath = join(tmpdir(), `bad-${blockId}.json`);
    writeFileSync(badPath, 'not json');
    try {
      const result = runCli(['block-run', badPath]);
      assert.strictEqual(result.status, 1, `Expected exit 1, got ${result.status}`);
      assert.ok(
        result.stderr.includes('Failed to parse') || result.stderr.includes('Error'),
        result.stderr
      );
    } finally {
      rmSync(badPath, { force: true });
    }
  });

  test('fake mode runs block', () => {
    const result = runCli(['block-run', blockJsonPath], {
      BLOCK_RUN_MODE: 'fake',
    });
    assert.strictEqual(result.status, 0, `Expected exit 0, got ${result.status}. stderr: ${result.stderr}`);
    assert.ok(result.stdout.includes('Block:'), result.stdout);
    assert.ok(result.stdout.includes('Mode:'), result.stdout);
    assert.ok(result.stdout.includes('Tasks attempted:'), result.stdout);
  });

  test('output includes block id', () => {
    const result = runCli(['block-run', blockJsonPath], {
      BLOCK_RUN_MODE: 'fake',
    });
    assert.strictEqual(result.status, 0, result.stderr);
    assert.ok(result.stdout.includes(`Block: ${blockId}`), result.stdout);
  });

  test('output includes tasks attempted', () => {
    const result = runCli(['block-run', blockJsonPath], {
      BLOCK_RUN_MODE: 'fake',
    });
    assert.strictEqual(result.status, 0, result.stderr);
    assert.ok(result.stdout.includes('Tasks attempted:'), result.stdout);
    assert.ok(result.stdout.includes('Accepted:'), result.stdout);
  });

  test('output includes accepted count', () => {
    const result = runCli(['block-run', blockJsonPath], {
      BLOCK_RUN_MODE: 'fake',
    });
    assert.strictEqual(result.status, 0, result.stderr);
    const acceptedMatch = result.stdout.match(/Accepted: (\d+)/);
    assert.ok(acceptedMatch, `Expected Accepted count in stdout: ${result.stdout}`);
    assert.strictEqual(acceptedMatch![1], '2');
  });

  test('respects BLOCK_RUN_MAX_TASKS', () => {
    const result = runCli(['block-run', blockJsonPath], {
      BLOCK_RUN_MODE: 'fake',
      BLOCK_RUN_MAX_TASKS: '1',
    });
    assert.strictEqual(result.status, 0, result.stderr);
    const attemptedMatch = result.stdout.match(/Tasks attempted: (\d+)/);
    assert.ok(attemptedMatch, `Expected Tasks attempted count in stdout: ${result.stdout}`);
    assert.strictEqual(attemptedMatch![1], '1');
  });

  test('rejects non-fake BLOCK_RUN_MODE', () => {
    const result = runCli(['block-run', blockJsonPath], {
      BLOCK_RUN_MODE: 'real',
    });
    assert.strictEqual(result.status, 1, `Expected exit 1, got ${result.status}`);
    assert.ok(result.stderr.includes('only fake mode is supported'), result.stderr);
  });

  test('no provider real call', () => {
    const result = runCli(['block-run', blockJsonPath], {
      BLOCK_RUN_MODE: 'fake',
      ALLOW_REAL_PROVIDER: 'true',
      KIMI_API_KEY: 'sk-test12345',
    });
    assert.strictEqual(result.status, 0, result.stderr);
    assert.ok(!result.stdout.includes('sk-test12345'), 'API key leaked in stdout');
    assert.ok(!result.stderr.includes('sk-test12345'), 'API key leaked in stderr');
  });

  test('no git call', () => {
    const result = runCli(['block-run', blockJsonPath], {
      BLOCK_RUN_MODE: 'fake',
    });
    assert.strictEqual(result.status, 0, result.stderr);
    assert.ok(!result.stdout.includes('git '), result.stdout);
    assert.ok(!result.stderr.includes('git '), result.stderr);
  });

  test('no GitHub API', () => {
    const result = runCli(['block-run', blockJsonPath], {
      BLOCK_RUN_MODE: 'fake',
    });
    assert.strictEqual(result.status, 0, result.stderr);
    assert.ok(!result.stdout.includes('github.com'), result.stdout);
    assert.ok(!result.stdout.includes('api.github'), result.stdout);
  });

  test('no merge/main/checkout/push', () => {
    const result = runCli(['block-run', blockJsonPath], {
      BLOCK_RUN_MODE: 'fake',
    });
    assert.strictEqual(result.status, 0, result.stderr);
    assert.ok(result.stdout.includes('No merge was performed'), result.stdout);
    assert.ok(result.stdout.includes('No checkout was performed'), result.stdout);
    assert.ok(result.stdout.includes('No main touch was performed'), result.stdout);
  });

  test('no API key leak', () => {
    const result = runCli(['block-run', blockJsonPath], {
      BLOCK_RUN_MODE: 'fake',
      KIMI_API_KEY: 'sk-test12345',
    });
    assert.strictEqual(result.status, 0, result.stderr);
    assert.ok(!result.stdout.includes('sk-test12345'), 'API key leaked in stdout');
    assert.ok(!result.stderr.includes('sk-test12345'), 'API key leaked in stderr');
  });

  test('no stack trace', () => {
    const result = runCli(['block-run', blockJsonPath], {
      BLOCK_RUN_MODE: 'fake',
    });
    assert.strictEqual(result.status, 0, result.stderr);
    assert.ok(!result.stderr.includes('at '), 'Stack trace leaked in stderr');
  });
});
