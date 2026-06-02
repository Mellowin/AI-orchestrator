import { describe, test } from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

let counter = 0;

function getCleanEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.AI_PROVIDER;
  delete env.MOCK_AI_RESPONSE;
  delete env.MOCK_REVIEWER_RESPONSE;
  delete env.MOCK_PROVIDER_RESPONSE;
  delete env.KIMI_API_KEY;
  delete env.KIMI_MODEL;
  delete env.KIMI_BASE_URL;
  delete env.KIMI_USER_AGENT;
  delete env.OPENAI_API_KEY;
  delete env.MOCK_AI;
  delete env.ALLOW_REAL_PROVIDER_RUN;
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

function createTempEnv(): {
  taskId: string;
  tasksFilePath: string;
  repoPath: string;
  cleanup: () => void;
} {
  const id = `${Date.now()}-${counter++}`;
  const taskId = `pp-${id}`;
  const tmpBase = join(process.cwd(), 'tmp');
  if (!existsSync(tmpBase)) {
    mkdirSync(tmpBase);
  }
  const tmpDir = mkdtempSync(join(tmpBase, `pp-${id}-`));
  const repoPath = join(tmpDir, 'repo');
  mkdirSync(repoPath);

  writeFileSync(join(repoPath, 'README.md'), '# test\n', 'utf-8');

  spawnSync('git', ['init'], { cwd: repoPath, encoding: 'utf-8', shell: false });
  spawnSync('git', ['add', '.'], { cwd: repoPath, encoding: 'utf-8', shell: false });
  spawnSync('git', ['commit', '-m', 'init', '--no-gpg-sign'], {
    cwd: repoPath,
    encoding: 'utf-8',
    shell: false,
  });
  spawnSync('git', ['branch', '-m', 'main'], { cwd: repoPath, encoding: 'utf-8', shell: false });

  const tasksFilePath = join(tmpDir, 'tasks.yaml');
  writeFileSync(
    tasksFilePath,
    `tasks:
  - id: ${taskId}
    title: "Provider preview test"
    repo_path: "${repoPath.replace(/\\/g, '/')}"
    base_branch: "main"
    work_branch: "ai/${taskId}"
    goal: "Test goal"
    context_files:
      - "README.md"
    checks:
      - command: "echo"
        args: ["ok"]
    guardrails:
      deny_modify:
        - ".env"
        - ".env.*"
        - "node_modules/**"
        - ".git/**"
      max_lines_changed: 150
      require_tests: false
      auto_commit: false
      auto_push: false
      auto_merge: false
`,
    'utf-8'
  );

  return {
    taskId,
    tasksFilePath,
    repoPath,
    cleanup: () => {
      rmSync(tmpDir, { recursive: true, force: true });
    },
  };
}

describe('cli provider-preview', () => {
  test('with MOCK_PROVIDER_RESPONSE prints mock response and safety messages', () => {
    const { taskId, tasksFilePath, cleanup } = createTempEnv();
    try {
      const mockResponse = 'Hello from mock provider';
      const result = runCli(['provider-preview', taskId], {
        TASKS_FILE: tasksFilePath,
        MOCK_PROVIDER_RESPONSE: mockResponse,
      });

      assert.strictEqual(result.status, 0, `Expected success, got stderr: ${result.stderr}`);
      assert(result.stdout.includes(`[provider-preview] Task: ${taskId}`), `Expected task id, got stdout: ${result.stdout}`);
      assert(result.stdout.includes('[provider-preview] Provider: mock'), `Expected provider mock, got stdout: ${result.stdout}`);
      assert(result.stdout.includes('[provider-preview] Model: mock-model'), `Expected model, got stdout: ${result.stdout}`);
      assert(result.stdout.includes('[provider-preview] Role: coder'), `Expected role coder, got stdout: ${result.stdout}`);
      assert(result.stdout.includes(mockResponse), `Expected mock response text, got stdout: ${result.stdout}`);
      assert(result.stdout.includes('No real API call was made'), `Expected API safety message, got stdout: ${result.stdout}`);
      assert(result.stdout.includes('No patch was applied'), `Expected patch safety message, got stdout: ${result.stdout}`);
      assert(result.stdout.includes('No git mutation was performed'), `Expected git safety message, got stdout: ${result.stdout}`);
    } finally {
      cleanup();
    }
  });

  test('trims leading and trailing whitespace from mock response', () => {
    const { taskId, tasksFilePath, cleanup } = createTempEnv();
    try {
      const mockResponse = '  trimmed response  ';
      const result = runCli(['provider-preview', taskId], {
        TASKS_FILE: tasksFilePath,
        MOCK_PROVIDER_RESPONSE: mockResponse,
      });

      assert.strictEqual(result.status, 0, `Expected success, got stderr: ${result.stderr}`);
      assert(result.stdout.includes('trimmed response'), `Expected trimmed text, got stdout: ${result.stdout}`);
      assert(!result.stdout.includes('  trimmed response  '), `Expected trimmed text without surrounding spaces, got stdout: ${result.stdout}`);
    } finally {
      cleanup();
    }
  });

  test('preserves internal newlines in mock response', () => {
    const { taskId, tasksFilePath, cleanup } = createTempEnv();
    try {
      const mockResponse = 'line1\nline2\nline3';
      const result = runCli(['provider-preview', taskId], {
        TASKS_FILE: tasksFilePath,
        MOCK_PROVIDER_RESPONSE: mockResponse,
      });

      assert.strictEqual(result.status, 0, `Expected success, got stderr: ${result.stderr}`);
      assert(result.stdout.includes('line1\nline2\nline3'), `Expected internal newlines preserved, got stdout: ${result.stdout}`);
    } finally {
      cleanup();
    }
  });

  test('missing MOCK_PROVIDER_RESPONSE fails clearly', () => {
    const { taskId, tasksFilePath, cleanup } = createTempEnv();
    try {
      const result = runCli(['provider-preview', taskId], {
        TASKS_FILE: tasksFilePath,
      });

      assert.strictEqual(result.status, 1, `Expected failure, got stdout: ${result.stdout}`);
      assert(result.stderr.includes('MOCK_PROVIDER_RESPONSE'), `Expected env var error, got stderr: ${result.stderr}`);
      assert(result.stderr.includes('No real API call was made'), `Expected API safety message, got stderr: ${result.stderr}`);
      assert(result.stderr.includes('No patch was applied'), `Expected patch safety message, got stderr: ${result.stderr}`);
      assert(result.stderr.includes('No git mutation was performed'), `Expected git safety message, got stderr: ${result.stderr}`);
    } finally {
      cleanup();
    }
  });

  test('missing task fails clearly', () => {
    const { tasksFilePath, cleanup } = createTempEnv();
    try {
      const result = runCli(['provider-preview', 'nonexistent-task'], {
        TASKS_FILE: tasksFilePath,
        MOCK_PROVIDER_RESPONSE: 'mock',
      });

      assert.strictEqual(result.status, 1, `Expected failure, got stdout: ${result.stdout}`);
      assert(result.stderr.includes('[provider-preview] Error:'), `Expected error prefix, got stderr: ${result.stderr}`);
    } finally {
      cleanup();
    }
  });

  test('does not mutate files in repo', () => {
    const { taskId, tasksFilePath, repoPath, cleanup } = createTempEnv();
    try {
      const originalContent = readFileSync(join(repoPath, 'README.md'), 'utf-8');
      const mockResponse = 'Hello from mock provider';
      const result = runCli(['provider-preview', taskId], {
        TASKS_FILE: tasksFilePath,
        MOCK_PROVIDER_RESPONSE: mockResponse,
      });

      assert.strictEqual(result.status, 0, `Expected success, got stderr: ${result.stderr}`);
      const afterContent = readFileSync(join(repoPath, 'README.md'), 'utf-8');
      assert.strictEqual(afterContent, originalContent, 'README.md should not be mutated');
    } finally {
      cleanup();
    }
  });
});
