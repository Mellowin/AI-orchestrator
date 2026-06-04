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
  delete env.ALLOW_REAL_REPO_COMMIT;
  delete env.ALLOW_REAL_REPO_PUSH;
  delete env.BLOCK_RUN_ONE_MODE;
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

function createTempGitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cli-block-run-one-'));
  spawnSync('git', ['init'], { cwd: dir, shell: false, encoding: 'utf-8' });
  spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir, shell: false, encoding: 'utf-8' });
  spawnSync('git', ['config', 'user.name', 'Test'], { cwd: dir, shell: false, encoding: 'utf-8' });
  writeFileSync(join(dir, 'README.md'), '# Test repo\n');
  spawnSync('git', ['add', '-A'], { cwd: dir, shell: false, encoding: 'utf-8' });
  spawnSync('git', ['commit', '-m', 'init', '--no-gpg-sign'], { cwd: dir, shell: false, encoding: 'utf-8' });
  spawnSync('git', ['checkout', '-b', 'feature/test'], { cwd: dir, shell: false, encoding: 'utf-8' });
  return dir;
}

describe('cli block-run-one', () => {
  let repoPath: string;
  let blockJsonPath: string;
  let blockId: string;

  beforeEach(() => {
    repoPath = createTempGitRepo();
    const id = `${Date.now()}-${counter++}`;
    blockId = `cli-br1-${id}`;

    const content = {
      block_id: blockId,
      title: 'CLI Block Run One Test',
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
          task_id: 'task-1',
          title: 'Add greeting file',
          goal: 'Create a greeting file',
          allowed_files: ['greeting.txt'],
          denied_files: ['secret.txt'],
          max_lines_changed: 50,
          checks: ['node -e require("fs").existsSync("greeting.txt")||process.exit(1)'],
        },
      ],
    };

    blockJsonPath = join(tmpdir(), `block-${blockId}.json`);
    writeFileSync(blockJsonPath, JSON.stringify(content, null, 2));
  });

  afterEach(() => {
    try {
      rmSync(repoPath, { recursive: true, force: true });
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
    // Missing taskId triggers global usage before block-run-one handler
    assert.ok(
      result.stderr.includes('Usage:') || result.stderr.includes('block JSON path is required'),
      result.stderr
    );
  });

  test('block-run-one runs fake mode and outputs summary', () => {
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
  });
});
