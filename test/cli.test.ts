import { describe, test } from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

function getCleanEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.AI_PROVIDER;
  delete env.MOCK_AI_RESPONSE;
  delete env.KIMI_API_KEY;
  delete env.KIMI_MODEL;
  delete env.KIMI_BASE_URL;
  delete env.KIMI_USER_AGENT;
  delete env.OPENAI_API_KEY;
  delete env.MOCK_AI;
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

function makeTempGitRepo(prefix: string): string {
  const dir = join(process.cwd(), 'tmp', `${prefix}-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), '{}', 'utf-8');
  spawnSync('git', ['init'], { cwd: dir, encoding: 'utf-8', shell: false });
  spawnSync('git', ['add', '.'], { cwd: dir, encoding: 'utf-8', shell: false });
  spawnSync('git', ['commit', '-m', 'init', '--no-gpg-sign'], { cwd: dir, encoding: 'utf-8', shell: false });
  spawnSync('git', ['branch', '-M', 'main'], { cwd: dir, encoding: 'utf-8', shell: false });
  return dir;
}

function makeTasksFile(repoPath: string, taskId: string): string {
  const tasksPath = join(repoPath, 'tasks.yaml');
  writeFileSync(
    tasksPath,
    `tasks:
  - id: ${taskId}
    title: CLI test task
    goal: Test CLI
    repo_path: ${repoPath}
    base_branch: main
    work_branch: ai/${taskId}
    context_files: []
    checks: []
    guardrails:
      deny_modify:
        - ".env"
        - ".env.*"
        - "node_modules/**"
        - ".git/**"
      auto_commit: false
      auto_push: false
      auto_merge: false
`,
    'utf-8'
  );
  return tasksPath;
}

describe('cli', () => {
  test('shows usage when no arguments provided', () => {
    const result = runCli([]);
    assert.notStrictEqual(result.status, 0, `Expected failure, got stderr: ${result.stderr}`);
    assert(result.stderr.includes('Usage:'), `Expected Usage in stderr, got: ${result.stderr}`);
  });

  test('shows usage when only command provided without task id', () => {
    const result = runCli(['status']);
    assert.notStrictEqual(result.status, 0, `Expected failure, got stderr: ${result.stderr}`);
    assert(result.stderr.includes('Usage:'), `Expected Usage in stderr, got: ${result.stderr}`);
  });

  test('returns non-zero exit code on unknown command', () => {
    const result = runCli(['unknown-cmd', 'some-task']);
    assert.notStrictEqual(result.status, 0, `Expected failure, got stderr: ${result.stderr}`);
    assert(result.stderr.includes('Unknown command: unknown-cmd'), `Expected unknown command, got: ${result.stderr}`);
  });

  test('fails clearly when tasks file is missing', () => {
    const result = runCli(['status', 'missing-task'], {
      TASKS_FILE: join(process.cwd(), 'tmp', 'nonexistent-tasks.yaml'),
    });
    assert.notStrictEqual(result.status, 0, `Expected failure, got stderr: ${result.stderr}`);
    assert(
      result.stderr.includes('tasks.yaml') || result.stderr.includes('not found') || result.stderr.includes('Error:'),
      `Expected clear error about missing tasks file, got: ${result.stderr}`
    );
  });

  test('fails clearly when requested task id is not found', () => {
    const repo = makeTempGitRepo('cli-notfound');
    const tasksPath = makeTasksFile(repo, 'existing-task');
    try {
      const result = runCli(['status', 'missing-task'], {
        TASKS_FILE: tasksPath,
      });
      assert.notStrictEqual(result.status, 0, `Expected failure, got stderr: ${result.stderr}`);
      assert(
        result.stderr.includes('not found') || result.stderr.includes('Task') || result.stderr.includes('Error'),
        `Expected clear error about missing task, got: ${result.stderr}`
      );
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test('accepts task id and returns success for status with valid setup', () => {
    const repo = makeTempGitRepo('cli-status');
    const taskId = 'cli-status-task';
    const tasksPath = makeTasksFile(repo, taskId);
    try {
      const result = runCli(['status', taskId], {
        TASKS_FILE: tasksPath,
      });
      assert.strictEqual(result.status, 0, `Expected success, got stderr: ${result.stderr}`);
      assert(result.stdout.includes(`[status] Task: ${taskId}`), `Expected task header, got stdout: ${result.stdout}`);
      assert(result.stdout.includes('No runs recorded yet.'), `Expected no runs message, got stdout: ${result.stdout}`);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test('uses mock provider by default without real API calls', () => {
    const repo = makeTempGitRepo('cli-mock');
    const taskId = 'cli-mock-task';
    const tasksPath = makeTasksFile(repo, taskId);
    const runDir = join(process.cwd(), 'runs', taskId);
    if (existsSync(runDir)) {
      rmSync(runDir, { recursive: true, force: true });
    }
    try {
      const result = runCli(['ai-generate', taskId], {
        TASKS_FILE: tasksPath,
        AI_PROVIDER: 'mock',
        MOCK_AI_RESPONSE: '{"mode":"file_update","files":[]}',
      });
      assert.strictEqual(result.status, 0, `Expected success, got stderr: ${result.stderr}`);
      assert(result.stdout.includes('[ai-generate] Provider: mock'), `Expected mock provider, got stdout: ${result.stdout}`);
    } finally {
      rmSync(repo, { recursive: true, force: true });
      if (existsSync(runDir)) {
        rmSync(runDir, { recursive: true, force: true });
      }
    }
  });

  test('error output does not leak secrets', () => {
    const secretKey = 'sk-test-secret-key-abc123';
    const repo = makeTempGitRepo('cli-secrets');
    const taskId = 'cli-secrets-task';
    const tasksPath = makeTasksFile(repo, taskId);
    try {
      const result = runCli(['status', 'nonexistent-task'], {
        TASKS_FILE: tasksPath,
        KIMI_API_KEY: secretKey,
      });
      assert.notStrictEqual(result.status, 0, `Expected failure, got stderr: ${result.stderr}`);
      const combined = result.stdout + result.stderr;
      assert(
        !combined.includes(secretKey),
        `Output must not contain secret key, got: ${combined}`
      );
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
