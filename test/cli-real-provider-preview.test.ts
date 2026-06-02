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
  // Explicitly set to empty strings/mock so dotenv in the child process does not
  // override them from the local .env file.
  env.AI_PROVIDER = 'mock';
  env.KIMI_API_KEY = '';
  env.KIMI_BASE_URL = '';
  env.KIMI_MODEL = '';
  delete env.KIMI_USER_AGENT;
  delete env.KIMI_FAKE_RESPONSE;
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
  const taskId = `rpp-${id}`;
  const tmpBase = join(process.cwd(), 'tmp');
  if (!existsSync(tmpBase)) {
    mkdirSync(tmpBase);
  }
  const tmpDir = mkdtempSync(join(tmpBase, `rpp-${id}-`));
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
    title: "Real provider preview test"
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

describe('cli real-provider-preview', () => {
  test('without opt-in refuses before task load', () => {
    const result = runCli(['real-provider-preview', 'any-task'], {
      TASKS_FILE: 'nonexistent-tasks.yaml',
    });

    assert.strictEqual(result.status, 1, `Expected failure, got stdout: ${result.stdout}`);
    assert(result.stderr.includes('ALLOW_REAL_PROVIDER_RUN'), `Expected opt-in error, got stderr: ${result.stderr}`);
    assert(!result.stderr.includes('nonexistent-tasks'), `Should not reach task loading, got stderr: ${result.stderr}`);
  });

  test('missing KIMI_API_KEY fails safely before API', () => {
    const { taskId, tasksFilePath, cleanup } = createTempEnv();
    try {
      const result = runCli(['real-provider-preview', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_PROVIDER_RUN: 'true',
        KIMI_BASE_URL: 'https://api.example.com',
      });

      assert.strictEqual(result.status, 1, `Expected failure, got stdout: ${result.stdout}`);
      assert(result.stderr.includes('KIMI_API_KEY'), `Expected API key error, got stderr: ${result.stderr}`);
      assert(result.stderr.includes('No API call was made'), `Expected API safety message, got stderr: ${result.stderr}`);
      assert(result.stderr.includes('No patch was applied'), `Expected patch safety message, got stderr: ${result.stderr}`);
      assert(result.stderr.includes('No git mutation was performed'), `Expected git safety message, got stderr: ${result.stderr}`);
      assert(result.stderr.includes('No state mutation was performed'), `Expected state safety message, got stderr: ${result.stderr}`);
    } finally {
      cleanup();
    }
  });

  test('missing KIMI_BASE_URL fails safely before API', () => {
    const { taskId, tasksFilePath, cleanup } = createTempEnv();
    try {
      const result = runCli(['real-provider-preview', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_PROVIDER_RUN: 'true',
        KIMI_API_KEY: 'sk-test',
      });

      assert.strictEqual(result.status, 1, `Expected failure, got stdout: ${result.stdout}`);
      assert(result.stderr.includes('KIMI_BASE_URL'), `Expected base URL error, got stderr: ${result.stderr}`);
      assert(result.stderr.includes('No API call was made'), `Expected API safety message, got stderr: ${result.stderr}`);
      assert(result.stderr.includes('No patch was applied'), `Expected patch safety message, got stderr: ${result.stderr}`);
      assert(result.stderr.includes('No git mutation was performed'), `Expected git safety message, got stderr: ${result.stderr}`);
      assert(result.stderr.includes('No state mutation was performed'), `Expected state safety message, got stderr: ${result.stderr}`);
    } finally {
      cleanup();
    }
  });

  test('with opt-in and KIMI_FAKE_RESPONSE succeeds and prints normalized fake response', () => {
    const { taskId, tasksFilePath, cleanup } = createTempEnv();
    try {
      const fakeResponse = 'Hello from fake provider';
      const result = runCli(['real-provider-preview', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_PROVIDER_RUN: 'true',
        KIMI_API_KEY: 'sk-test',
        KIMI_BASE_URL: 'https://api.example.com',
        KIMI_FAKE_RESPONSE: fakeResponse,
      });

      assert.strictEqual(result.status, 0, `Expected success, got stderr: ${result.stderr}`);
      assert(result.stdout.includes(`[real-provider-preview] Task: ${taskId}`), `Expected task id, got stdout: ${result.stdout}`);
      assert(result.stdout.includes('[real-provider-preview] Provider: kimi'), `Expected provider kimi, got stdout: ${result.stdout}`);
      assert(result.stdout.includes('[real-provider-preview] Model: kimi-k2.6'), `Expected model, got stdout: ${result.stdout}`);
      assert(result.stdout.includes('[real-provider-preview] Role: coder'), `Expected role coder, got stdout: ${result.stdout}`);
      assert(result.stdout.includes(fakeResponse), `Expected fake response text, got stdout: ${result.stdout}`);
    } finally {
      cleanup();
    }
  });

  test('fake response with leading and trailing whitespace is trimmed', () => {
    const { taskId, tasksFilePath, cleanup } = createTempEnv();
    try {
      const fakeResponse = '  trimmed response  ';
      const result = runCli(['real-provider-preview', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_PROVIDER_RUN: 'true',
        KIMI_API_KEY: 'sk-test',
        KIMI_BASE_URL: 'https://api.example.com',
        KIMI_FAKE_RESPONSE: fakeResponse,
      });

      assert.strictEqual(result.status, 0, `Expected success, got stderr: ${result.stderr}`);
      assert(result.stdout.includes('trimmed response'), `Expected trimmed text, got stdout: ${result.stdout}`);
      assert(!result.stdout.includes('  trimmed response  '), `Expected trimmed text without surrounding spaces, got stdout: ${result.stdout}`);
    } finally {
      cleanup();
    }
  });

  test('success prints no patch no git no state safety messages', () => {
    const { taskId, tasksFilePath, cleanup } = createTempEnv();
    try {
      const result = runCli(['real-provider-preview', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_PROVIDER_RUN: 'true',
        KIMI_API_KEY: 'sk-test',
        KIMI_BASE_URL: 'https://api.example.com',
        KIMI_FAKE_RESPONSE: 'ok',
      });

      assert.strictEqual(result.status, 0, `Expected success, got stderr: ${result.stderr}`);
      assert(result.stdout.includes('No patch was applied'), `Expected patch safety message, got stdout: ${result.stdout}`);
      assert(result.stdout.includes('No git mutation was performed'), `Expected git safety message, got stdout: ${result.stdout}`);
      assert(result.stdout.includes('No state mutation was performed'), `Expected state safety message, got stdout: ${result.stdout}`);
    } finally {
      cleanup();
    }
  });

  test('missing task with opt-in and env fails safely without stack trace leak', () => {
    const { tasksFilePath, cleanup } = createTempEnv();
    try {
      const result = runCli(['real-provider-preview', 'nonexistent-task'], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_PROVIDER_RUN: 'true',
        KIMI_API_KEY: 'sk-test',
        KIMI_BASE_URL: 'https://api.example.com',
        KIMI_FAKE_RESPONSE: 'mock',
      });

      assert.strictEqual(result.status, 1, `Expected failure, got stdout: ${result.stdout}`);
      assert(result.stderr.includes('[real-provider-preview] Error:'), `Expected error prefix, got stderr: ${result.stderr}`);
      assert(!result.stderr.includes('at '), `Stderr should not contain stack trace, got: ${result.stderr}`);
      assert(result.stderr.includes('No patch was applied'), `Expected patch safety message, got stderr: ${result.stderr}`);
      assert(result.stderr.includes('No git mutation was performed'), `Expected git safety message, got stderr: ${result.stderr}`);
      assert(result.stderr.includes('No state mutation was performed'), `Expected state safety message, got stderr: ${result.stderr}`);
    } finally {
      cleanup();
    }
  });

  test('error output does not leak KIMI_API_KEY', () => {
    const { tasksFilePath, cleanup } = createTempEnv();
    try {
      const secretKey = 'sk-super-secret-key-12345';
      const result = runCli(['real-provider-preview', 'nonexistent-task'], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_PROVIDER_RUN: 'true',
        KIMI_API_KEY: secretKey,
        KIMI_BASE_URL: 'https://api.example.com',
        KIMI_FAKE_RESPONSE: 'mock',
      });

      assert.strictEqual(result.status, 1, `Expected failure, got stdout: ${result.stdout}`);
      const combinedOutput = result.stdout + result.stderr;
      assert(!combinedOutput.includes(secretKey), `Output should not leak API key, got: ${combinedOutput}`);
    } finally {
      cleanup();
    }
  });

  test('does not mutate files in repo', () => {
    const { taskId, tasksFilePath, repoPath, cleanup } = createTempEnv();
    try {
      const originalContent = readFileSync(join(repoPath, 'README.md'), 'utf-8');
      const result = runCli(['real-provider-preview', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_PROVIDER_RUN: 'true',
        KIMI_API_KEY: 'sk-test',
        KIMI_BASE_URL: 'https://api.example.com',
        KIMI_FAKE_RESPONSE: 'Hello from fake provider',
      });

      assert.strictEqual(result.status, 0, `Expected success, got stderr: ${result.stderr}`);
      const afterContent = readFileSync(join(repoPath, 'README.md'), 'utf-8');
      assert.strictEqual(afterContent, originalContent, 'README.md should not be mutated');
    } finally {
      cleanup();
    }
  });

  test('uses KIMI_MODEL env when provided', () => {
    const { taskId, tasksFilePath, cleanup } = createTempEnv();
    try {
      const result = runCli(['real-provider-preview', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_PROVIDER_RUN: 'true',
        KIMI_API_KEY: 'sk-test',
        KIMI_BASE_URL: 'https://api.example.com',
        KIMI_MODEL: 'custom-model-v1',
        KIMI_FAKE_RESPONSE: 'ok',
      });

      assert.strictEqual(result.status, 0, `Expected success, got stderr: ${result.stderr}`);
      assert(result.stdout.includes('[real-provider-preview] Model: custom-model-v1'), `Expected custom model, got stdout: ${result.stdout}`);
    } finally {
      cleanup();
    }
  });
});
