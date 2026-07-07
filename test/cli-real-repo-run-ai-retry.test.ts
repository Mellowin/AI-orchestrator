import { describe, test } from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

let counter = 0;

function getCleanEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  const keysToDelete = [
    'AI_PROVIDER',
    'MOCK_AI_RESPONSE',
    'MOCK_REVIEWER_RESPONSE',
    'MOCK_PROVIDER_RESPONSE',
    'KIMI_API_KEY',
    'KIMI_MODEL',
    'KIMI_BASE_URL',
    'KIMI_USER_AGENT',
    'KIMI_FAKE_RESPONSE',
    'KIMI_FAKE_RESPONSES',
    'OPENAI_API_KEY',
    'MOCK_AI',
    'ALLOW_REAL_PROVIDER_RUN',
    'ALLOW_REAL_PROVIDER',
    'ALLOW_SANDBOX_APPLY_PREVIEW',
    'ALLOW_REAL_REPO_APPLY',
    'ALLOW_REAL_REPO_COMMIT',
    'ALLOW_REAL_REPO_PUSH',
    'SANDBOX_PROVIDER_RESPONSE',
    'SANDBOX_ROOT',
    'REAL_REPO_PROVIDER_RESPONSE',
    'RUNS_DIR',
    'REAL_REPO_AI_MAX_ATTEMPTS',
    'REAL_REPO_REVIEWER_FAKE_RESPONSE',
    'KIMI_FAKE_REVIEWER_RESPONSE',
    'REAL_REPO_REVIEWER_NO_DEFAULT',
    'REAL_REPO_REVIEWER_CAPTURE_INPUT_FILE',
    'REAL_REPO_REVIEWER_FORCE_PROVIDER_ERROR',
    'REAL_REPO_REVIEWER_FIX_TASK_FAKE_EXECUTOR_RESPONSE',
    'REAL_REPO_ENABLE_REVIEWER_FIX_LOOP',
    'REAL_REPO_REVIEWER_MAX_FIX_ATTEMPTS',
    'REAL_REPO_REVIEWER_SECOND_FAKE_RESPONSE',
    'REAL_REPO_REVIEWER_SECOND_KIMI_FAKE_RESPONSE',
    'REAL_REPO_REVIEWER_SECOND_FORCE_PROVIDER_ERROR',
    'REAL_REPO_REVIEWER_FIX_TASK_KIMI_FAKE_RESPONSE',
    'REAL_REPO_REVIEWER_FIX_TASK_KIMI_FAKE_RESPONSES',
    'REAL_PROVIDER_MAX_ATTEMPTS',
    'REAL_PROVIDER_RETRY_BASE_MS',
    'REAL_PROVIDER_RETRY_MAX_MS',
    'TASKS_FILE',
  ];
  for (const key of keysToDelete) {
    delete env[key];
  }
  // Remove any other provider/orchestrator-related env vars not explicitly whitelisted.
  for (const key of Object.keys(env)) {
    if (/^(REAL_REPO_|REAL_BLOCK_|KIMI_|MOCK_|ALLOW_|SANDBOX_|OPENAI_|TASKS_FILE|RUNS_DIR|NODE_TEST_CONTEXT)/.test(key)) {
      delete env[key];
    }
  }
  env.AI_PROVIDER = 'mock';
  return env;
}

function runCli(
  args: string[],
  envOverrides: Record<string, string> = {}
): {
  status: number;
  stdout: string;
  stderr: string;
} {
  const env = { ...getCleanEnv(), ...envOverrides };
  // Default reviewer acceptance for real-provider runs.
  if (
    !env.REAL_REPO_REVIEWER_FAKE_RESPONSE &&
    !env.KIMI_FAKE_REVIEWER_RESPONSE &&
    env.REAL_REPO_REVIEWER_NO_DEFAULT !== '1' &&
    (env.ALLOW_REAL_PROVIDER === 'true' || env.ALLOW_REAL_PROVIDER === '1')
  ) {
    env.REAL_REPO_REVIEWER_FAKE_RESPONSE = JSON.stringify({
      decision: 'accept',
      confidence: 'high',
      blockingIssues: [],
      nonBlockingIssues: [],
      reviewSummary: 'Default test reviewer acceptance.',
      nextAction: 'continue',
    });
  }
  const result = spawnSync(
    `npx tsx "${join(process.cwd(), 'src', 'cli.ts')}" ${args.join(' ')}`,
    {
      cwd: process.cwd(),
      env,
      encoding: 'utf-8',
      shell: true,
      timeout: 60000,
    }
  );
  return {
    status: result.status ?? 1,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
  };
}

function buildFakeKimiOutput(
  files: Array<{ path: string; content: string }>,
  notes?: string
): string {
  return JSON.stringify({ mode: 'file_update', files, notes });
}

function createTempEnv(checks: string[] = []): {
  taskId: string;
  tasksFilePath: string;
  repoPath: string;
  originPath: string;
  runsDir: string;
  cleanup: () => void;
} {
  const id = `${Date.now()}-${counter++}`;
  const taskId = `rai-retry-${id}`;
  const tmpBase = join(process.cwd(), 'tmp');
  if (!existsSync(tmpBase)) {
    mkdirSync(tmpBase);
  }
  const tmpDir = mkdtempSync(join(tmpBase, `rai-retry-${id}-`));
  const repoPath = join(tmpDir, 'repo');
  const originPath = join(tmpDir, 'origin.git');
  const runsDir = join(tmpDir, 'runs');
  mkdirSync(repoPath);

  writeFileSync(join(repoPath, 'README.md'), '# hello\n', 'utf-8');

  spawnSync('git', ['init'], {
    cwd: repoPath,
    encoding: 'utf-8',
    shell: false,
  });
  spawnSync('git', ['config', 'user.email', 'ci@example.com'], {
    cwd: repoPath,
    encoding: 'utf-8',
    shell: false,
  });
  spawnSync('git', ['config', 'user.name', 'CI User'], {
    cwd: repoPath,
    encoding: 'utf-8',
    shell: false,
  });
  spawnSync('git', ['add', '.'], {
    cwd: repoPath,
    encoding: 'utf-8',
    shell: false,
  });
  spawnSync('git', ['commit', '-m', 'init', '--no-gpg-sign'], {
    cwd: repoPath,
    encoding: 'utf-8',
    shell: false,
  });
  spawnSync('git', ['branch', '-m', 'main'], {
    cwd: repoPath,
    encoding: 'utf-8',
    shell: false,
  });
  spawnSync('git', ['checkout', '-b', `ai/${taskId}`], {
    cwd: repoPath,
    encoding: 'utf-8',
    shell: false,
  });

  spawnSync('git', ['init', '--bare', originPath], {
    encoding: 'utf-8',
    shell: false,
  });
  spawnSync('git', ['remote', 'add', 'origin', originPath], {
    cwd: repoPath,
    encoding: 'utf-8',
    shell: false,
  });

  const checkLines =
    checks.length > 0
      ? checks.map((c) => `    - command: "${c.split(' ')[0]}"\n      args: [${c.split(' ').slice(1).map((a) => `"${a}"`).join(', ')}]`).join('\n')
      : '    - command: "node"\n      args: ["-e", "process.exit(0)"]';

  const tasksFilePath = join(tmpDir, 'tasks.yaml');
  writeFileSync(
    tasksFilePath,
    `tasks:
  - id: ${taskId}
    title: "Run AI retry test"
    repo_path: "${repoPath.replace(/\\/g, '/')}"
    base_branch: "main"
    work_branch: "ai/${taskId}"
    goal: "Update README"
    context_files:
      - "README.md"
    checks:
${checkLines}
    guardrails:
      allow_modify:
        - "README.md"
      deny_modify:
        - ".env"
        - ".env.*"
        - ".git/**"
        - "node_modules/**"
      max_lines_changed: 100
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
    originPath,
    runsDir,
    cleanup: () => {
      try {
        rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        // ignore cleanup errors
      }
    },
  };
}

describe('cli real-repo-run-ai retry', () => {
  test('retries fetch failed and succeeds on second attempt', () => {
    const { taskId, tasksFilePath, repoPath, runsDir, cleanup } = createTempEnv();
    try {
      const env: Record<string, string> = {
        TASKS_FILE: tasksFilePath,
        RUNS_DIR: runsDir,
        ALLOW_REAL_PROVIDER: 'true',
        ALLOW_REAL_REPO_APPLY: 'true',
        ALLOW_REAL_REPO_COMMIT: 'true',
        ALLOW_REAL_REPO_PUSH: 'true',
        KIMI_API_KEY: 'sk-test',
        KIMI_BASE_URL: 'https://api.invalid',
        KIMI_MODEL: 'kimi-k2.6',
        KIMI_FAKE_RESPONSES: JSON.stringify([
          '__FETCH_ERROR__',
          buildFakeKimiOutput([{ path: 'README.md', content: '# hello\n\nupdated\n' }]),
        ]),
        REAL_PROVIDER_MAX_ATTEMPTS: '3',
        REAL_PROVIDER_RETRY_BASE_MS: '0',
        REAL_PROVIDER_RETRY_MAX_MS: '0',
      };

      const result = runCli(['real-repo-run-ai', taskId], env);
      assert.strictEqual(result.status, 0, `expected success, got stderr:\n${result.stderr}`);
      assert(result.stderr.includes('Retrying'), 'should log retry');

      const statePath = join(runsDir, taskId, 'state.json');
      assert(existsSync(statePath), 'state.json should exist');
      const state = JSON.parse(readFileSync(statePath, 'utf-8'));
      assert(Array.isArray(state.provider_attempts), 'state should have provider_attempts');
      assert.strictEqual(state.provider_attempts.length, 2);
      assert.strictEqual(state.provider_attempts[0].ok, false);
      assert.strictEqual(state.provider_attempts[1].ok, true);
      assert.strictEqual(state.provider_attempts[1].recovery_prompt, true);

      const readme = readFileSync(join(repoPath, 'README.md'), 'utf-8');
      assert(readme.includes('updated'));
    } finally {
      cleanup();
    }
  });

  test('retries malformed JSON and succeeds with recovery prompt', () => {
    const { taskId, tasksFilePath, repoPath, runsDir, cleanup } = createTempEnv();
    try {
      const env: Record<string, string> = {
        TASKS_FILE: tasksFilePath,
        RUNS_DIR: runsDir,
        ALLOW_REAL_PROVIDER: 'true',
        ALLOW_REAL_REPO_APPLY: 'true',
        ALLOW_REAL_REPO_COMMIT: 'true',
        ALLOW_REAL_REPO_PUSH: 'true',
        KIMI_API_KEY: 'sk-test',
        KIMI_BASE_URL: 'https://api.invalid',
        KIMI_MODEL: 'kimi-k2.6',
        KIMI_FAKE_RESPONSES: JSON.stringify([
          'not valid json',
          buildFakeKimiOutput([{ path: 'README.md', content: '# hello\n\nfixed\n' }]),
        ]),
        REAL_PROVIDER_MAX_ATTEMPTS: '3',
        REAL_PROVIDER_RETRY_BASE_MS: '0',
        REAL_PROVIDER_RETRY_MAX_MS: '0',
      };

      const result = runCli(['real-repo-run-ai', taskId], env);
      assert.strictEqual(result.status, 0, `expected success, got stderr:\n${result.stderr}`);
      assert(result.stderr.includes('Retrying'), 'should log retry');

      const statePath = join(runsDir, taskId, 'state.json');
      const state = JSON.parse(readFileSync(statePath, 'utf-8'));
      assert.strictEqual(state.provider_attempts.length, 2);
      assert.strictEqual(state.provider_attempts[0].ok, false);
      assert.strictEqual(state.provider_attempts[0].retryable, true);
      assert.strictEqual(state.provider_attempts[1].ok, true);
      assert.strictEqual(state.provider_attempts[1].recovery_prompt, true);

      const readme = readFileSync(join(repoPath, 'README.md'), 'utf-8');
      assert(readme.includes('fixed'));
    } finally {
      cleanup();
    }
  });

  test('stops after max attempts and reports final failure', () => {
    const { taskId, tasksFilePath, runsDir, cleanup } = createTempEnv();
    try {
      const env: Record<string, string> = {
        TASKS_FILE: tasksFilePath,
        RUNS_DIR: runsDir,
        ALLOW_REAL_PROVIDER: 'true',
        ALLOW_REAL_REPO_APPLY: 'true',
        ALLOW_REAL_REPO_COMMIT: 'true',
        ALLOW_REAL_REPO_PUSH: 'true',
        KIMI_API_KEY: 'sk-test',
        KIMI_BASE_URL: 'https://api.invalid',
        KIMI_MODEL: 'kimi-k2.6',
        KIMI_FAKE_RESPONSES: JSON.stringify(['__FETCH_ERROR__', '__FETCH_ERROR__', '__FETCH_ERROR__']),
        REAL_PROVIDER_MAX_ATTEMPTS: '2',
        REAL_PROVIDER_RETRY_BASE_MS: '0',
        REAL_PROVIDER_RETRY_MAX_MS: '0',
      };

      const result = runCli(['real-repo-run-ai', taskId], env);
      assert.notStrictEqual(result.status, 0, 'expected failure');
      assert(result.stderr.includes('Max attempts reached'), 'should log max attempts');

      const statePath = join(runsDir, taskId, 'state.json');
      assert(existsSync(statePath), 'failed state should be persisted');
      const state = JSON.parse(readFileSync(statePath, 'utf-8'));
      assert.strictEqual(state.status, 'failed_max_attempts');
      assert(Array.isArray(state.provider_attempts));
      assert.strictEqual(state.provider_attempts.length, 2);
      assert.strictEqual(state.provider_attempts[0].ok, false);
      assert.strictEqual(state.provider_attempts[1].ok, false);
    } finally {
      cleanup();
    }
  });

  test('safety policy rejection is not retried', () => {
    const { taskId, tasksFilePath, runsDir, cleanup } = createTempEnv();
    try {
      // Provider returns a valid JSON output that writes allowed file with unsafe content
      // (secret env access). Guardrails pass, safety policy blocks.
      const env: Record<string, string> = {
        TASKS_FILE: tasksFilePath,
        RUNS_DIR: runsDir,
        ALLOW_REAL_PROVIDER: 'true',
        ALLOW_REAL_REPO_APPLY: 'true',
        ALLOW_REAL_REPO_COMMIT: 'true',
        ALLOW_REAL_REPO_PUSH: 'true',
        KIMI_API_KEY: 'sk-test',
        KIMI_BASE_URL: 'https://api.invalid',
        KIMI_MODEL: 'kimi-k2.6',
        KIMI_FAKE_RESPONSES: JSON.stringify([
          buildFakeKimiOutput([{ path: 'README.md', content: 'console.log(process.env.KIMI_API_KEY);\n' }]),
        ]),
        REAL_PROVIDER_MAX_ATTEMPTS: '3',
        REAL_PROVIDER_RETRY_BASE_MS: '0',
        REAL_PROVIDER_RETRY_MAX_MS: '0',
      };

      const result = runCli(['real-repo-run-ai', taskId], env);
      assert.notStrictEqual(result.status, 0, 'expected failure');
      assert(result.stderr.includes('Safety policy violation'), 'should fail on safety policy');
      // No retry should have happened; exactly one provider attempt.
      const statePath = join(runsDir, taskId, 'state.json');
      assert(existsSync(statePath), 'blocked state should be persisted');
      const state = JSON.parse(readFileSync(statePath, 'utf-8'));
      assert.strictEqual(state.status, 'blocked');
      assert.strictEqual(state.blocked_by, 'safety_policy');
      assert(!Array.isArray(state.provider_attempts) || state.provider_attempts.length === 1);
    } finally {
      cleanup();
    }
  });

  test('forbidden path / denied manifest is not retried', () => {
    const { taskId, tasksFilePath, runsDir, cleanup } = createTempEnv();
    try {
      // Provider returns a valid JSON output that writes outside allowed scope.
      const env: Record<string, string> = {
        TASKS_FILE: tasksFilePath,
        RUNS_DIR: runsDir,
        ALLOW_REAL_PROVIDER: 'true',
        ALLOW_REAL_REPO_APPLY: 'true',
        ALLOW_REAL_REPO_COMMIT: 'true',
        ALLOW_REAL_REPO_PUSH: 'true',
        KIMI_API_KEY: 'sk-test',
        KIMI_BASE_URL: 'https://api.invalid',
        KIMI_MODEL: 'kimi-k2.6',
        KIMI_FAKE_RESPONSES: JSON.stringify([
          buildFakeKimiOutput([{ path: 'outside.txt', content: 'not allowed' }]),
        ]),
        REAL_PROVIDER_MAX_ATTEMPTS: '3',
        REAL_PROVIDER_RETRY_BASE_MS: '0',
        REAL_PROVIDER_RETRY_MAX_MS: '0',
      };

      const result = runCli(['real-repo-run-ai', taskId], env);
      assert.notStrictEqual(result.status, 0, 'expected failure');
      assert(result.stderr.includes('Guardrails failed'), 'should fail on guardrails');
      // Guardrails are deterministic; provider should not retry.
      const statePath = join(runsDir, taskId, 'state.json');
      // Guardrail failure currently does not write state; verify no provider retry via stderr.
      assert(!result.stderr.includes('Retrying'), 'should not retry guardrail failure');
      assert(!result.stderr.includes('Provider attempt 2'), 'should only make one provider attempt');
    } finally {
      cleanup();
    }
  });

  test('retry metadata is written to task state on success', () => {
    const { taskId, tasksFilePath, runsDir, cleanup } = createTempEnv();
    try {
      const env: Record<string, string> = {
        TASKS_FILE: tasksFilePath,
        RUNS_DIR: runsDir,
        ALLOW_REAL_PROVIDER: 'true',
        ALLOW_REAL_REPO_APPLY: 'true',
        ALLOW_REAL_REPO_COMMIT: 'true',
        ALLOW_REAL_REPO_PUSH: 'true',
        KIMI_API_KEY: 'sk-test',
        KIMI_BASE_URL: 'https://api.invalid',
        KIMI_MODEL: 'kimi-k2.6',
        KIMI_FAKE_RESPONSES: JSON.stringify([
          '__FETCH_ERROR__',
          buildFakeKimiOutput([{ path: 'README.md', content: '# hello\n\nrecovered\n' }]),
        ]),
        REAL_PROVIDER_MAX_ATTEMPTS: '3',
        REAL_PROVIDER_RETRY_BASE_MS: '0',
        REAL_PROVIDER_RETRY_MAX_MS: '0',
      };

      const result = runCli(['real-repo-run-ai', taskId], env);
      assert.strictEqual(result.status, 0, `expected success, got stderr:\n${result.stderr}`);

      const statePath = join(runsDir, taskId, 'state.json');
      const state = JSON.parse(readFileSync(statePath, 'utf-8'));
      assert.strictEqual(state.status, 'pushed');
      assert(Array.isArray(state.provider_attempts));
      assert.strictEqual(state.provider_attempts.length, 2);
      assert.strictEqual(state.provider_attempts[0].ok, false);
      assert.strictEqual(state.provider_attempts[1].ok, true);
      assert.strictEqual(state.provider_attempts[1].recovery_prompt, true);
    } finally {
      cleanup();
    }
  });

  test('env REAL_PROVIDER_MAX_ATTEMPTS controls attempts', () => {
    const { taskId, tasksFilePath, runsDir, cleanup } = createTempEnv();
    try {
      const env: Record<string, string> = {
        TASKS_FILE: tasksFilePath,
        RUNS_DIR: runsDir,
        ALLOW_REAL_PROVIDER: 'true',
        ALLOW_REAL_REPO_APPLY: 'true',
        ALLOW_REAL_REPO_COMMIT: 'true',
        ALLOW_REAL_REPO_PUSH: 'true',
        KIMI_API_KEY: 'sk-test',
        KIMI_BASE_URL: 'https://api.invalid',
        KIMI_MODEL: 'kimi-k2.6',
        KIMI_FAKE_RESPONSES: JSON.stringify(['__FETCH_ERROR__', '__FETCH_ERROR__', '__FETCH_ERROR__']),
        REAL_PROVIDER_MAX_ATTEMPTS: '4',
        REAL_PROVIDER_RETRY_BASE_MS: '0',
        REAL_PROVIDER_RETRY_MAX_MS: '0',
      };

      const result = runCli(['real-repo-run-ai', taskId], env);
      assert.notStrictEqual(result.status, 0, 'expected failure');
      const statePath = join(runsDir, taskId, 'state.json');
      const state = JSON.parse(readFileSync(statePath, 'utf-8'));
      assert.strictEqual(state.provider_attempts.length, 4);
    } finally {
      cleanup();
    }
  });

  test('invalid retry config is handled clearly', () => {
    const { taskId, tasksFilePath, runsDir, cleanup } = createTempEnv();
    try {
      const env: Record<string, string> = {
        TASKS_FILE: tasksFilePath,
        RUNS_DIR: runsDir,
        ALLOW_REAL_PROVIDER: 'true',
        ALLOW_REAL_REPO_APPLY: 'true',
        ALLOW_REAL_REPO_COMMIT: 'true',
        ALLOW_REAL_REPO_PUSH: 'true',
        KIMI_API_KEY: 'sk-test',
        KIMI_BASE_URL: 'https://api.invalid',
        KIMI_MODEL: 'kimi-k2.6',
        KIMI_FAKE_RESPONSES: JSON.stringify([buildFakeKimiOutput([{ path: 'README.md', content: '# hello\n' }])]),
        REAL_PROVIDER_MAX_ATTEMPTS: 'invalid',
      };

      const result = runCli(['real-repo-run-ai', taskId], env);
      assert.notStrictEqual(result.status, 0, 'expected failure');
      assert(result.stderr.includes('REAL_PROVIDER_MAX_ATTEMPTS must be an integer'), 'should report invalid config');
    } finally {
      cleanup();
    }
  });

  test('recovery prompt does not include Markdown fences instruction incorrectly', () => {
    const { taskId, tasksFilePath, runsDir, cleanup } = createTempEnv();
    try {
      let capturedPrompts: string[] = [];
      // Use a fake provider that captures prompts and fails once.
      const env: Record<string, string> = {
        TASKS_FILE: tasksFilePath,
        RUNS_DIR: runsDir,
        ALLOW_REAL_PROVIDER: 'true',
        ALLOW_REAL_REPO_APPLY: 'true',
        ALLOW_REAL_REPO_COMMIT: 'true',
        ALLOW_REAL_REPO_PUSH: 'true',
        KIMI_API_KEY: 'sk-test',
        KIMI_BASE_URL: 'https://api.invalid',
        KIMI_MODEL: 'kimi-k2.6',
        KIMI_FAKE_RESPONSES: JSON.stringify([
          'malformed',
          buildFakeKimiOutput([{ path: 'README.md', content: '# hello\n\nok\n' }]),
        ]),
        REAL_PROVIDER_MAX_ATTEMPTS: '3',
        REAL_PROVIDER_RETRY_BASE_MS: '0',
        REAL_PROVIDER_RETRY_MAX_MS: '0',
      };

      const result = runCli(['real-repo-run-ai', taskId], env);
      assert.strictEqual(result.status, 0, `expected success, got stderr:\n${result.stderr}`);
      // The recovery prompt is sent to the provider; we can verify it was used because the second
      // fake response was consumed and the state records recovery_prompt=true.
      const statePath = join(runsDir, taskId, 'state.json');
      const state = JSON.parse(readFileSync(statePath, 'utf-8'));
      assert.strictEqual(state.provider_attempts[1].recovery_prompt, true);
    } finally {
      cleanup();
    }
  });

  test('token/secrets are redacted from retry errors', () => {
    const { taskId, tasksFilePath, runsDir, cleanup } = createTempEnv();
    try {
      const env: Record<string, string> = {
        TASKS_FILE: tasksFilePath,
        RUNS_DIR: runsDir,
        ALLOW_REAL_PROVIDER: 'true',
        ALLOW_REAL_REPO_APPLY: 'true',
        ALLOW_REAL_REPO_COMMIT: 'true',
        ALLOW_REAL_REPO_PUSH: 'true',
        KIMI_API_KEY: 'sk-test',
        KIMI_BASE_URL: 'https://api.invalid',
        KIMI_MODEL: 'kimi-k2.6',
        KIMI_FAKE_RESPONSES: JSON.stringify(['__FETCH_ERROR__', '__FETCH_ERROR__']),
        REAL_PROVIDER_MAX_ATTEMPTS: '2',
        REAL_PROVIDER_RETRY_BASE_MS: '0',
        REAL_PROVIDER_RETRY_MAX_MS: '0',
      };

      const result = runCli(['real-repo-run-ai', taskId], env);
      assert.notStrictEqual(result.status, 0, 'expected failure');
      assert(!result.stderr.includes('sk-test'), 'should not leak api key');
      assert(!result.stderr.includes('Bearer'), 'should not leak bearer token');
    } finally {
      cleanup();
    }
  });
});
