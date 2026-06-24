import { describe, test } from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

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
  cleanup: () => void;
} {
  const id = `${Date.now()}-${counter++}`;
  const taskId = `rpr-${id}`;
  const tmpBase = join(process.cwd(), 'tmp');
  if (!existsSync(tmpBase)) {
    mkdirSync(tmpBase);
  }
  const tmpDir = mkdtempSync(join(tmpBase, `rpr-${id}-`));
  const repoPath = join(tmpDir, 'repo');
  mkdirSync(repoPath);

  writeFileSync(join(repoPath, 'README.md'), '# test\n', 'utf-8');

  spawnSync('git', ['init'], { cwd: repoPath, encoding: 'utf-8', shell: false });
  spawnSync('git', ['config', 'user.email', 'ci@example.com'], { cwd: repoPath, encoding: 'utf-8', shell: false });
  spawnSync('git', ['config', 'user.name', 'CI User'], { cwd: repoPath, encoding: 'utf-8', shell: false });
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
    title: "Real provider run test"
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
    cleanup: () => {
      rmSync(tmpDir, { recursive: true, force: true });
    },
  };
}

describe('cli real-provider-run', () => {
  test('refuses without ALLOW_REAL_PROVIDER_RUN opt-in', () => {
    const { taskId, tasksFilePath, cleanup } = createTempEnv();
    try {
      const result = runCli(['real-provider-run', taskId], {
        TASKS_FILE: tasksFilePath,
      });

      assert.strictEqual(result.status, 1, `Expected failure, got stdout: ${result.stdout}`);
      assert(result.stderr.includes('ALLOW_REAL_PROVIDER_RUN=true'), `Expected opt-in error, got stderr: ${result.stderr}`);
      assert(result.stderr.includes('No API call was made'), `Expected API safety message, got stderr: ${result.stderr}`);
      assert(result.stderr.includes('No patch was applied'), `Expected patch safety message, got stderr: ${result.stderr}`);
      assert(result.stderr.includes('No push / no merge / no main touch'), `Expected git safety message, got stderr: ${result.stderr}`);
    } finally {
      cleanup();
    }
  });

  test('refuses even with opt-in because execution is not implemented yet', () => {
    const { taskId, tasksFilePath, cleanup } = createTempEnv();
    try {
      const result = runCli(['real-provider-run', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_PROVIDER_RUN: 'true',
      });

      assert.strictEqual(result.status, 1, `Expected failure, got stdout: ${result.stdout}`);
      assert(result.stderr.includes('not implemented yet'), `Expected not-implemented error, got stderr: ${result.stderr}`);
      assert(result.stderr.includes('No API call was made'), `Expected API safety message, got stderr: ${result.stderr}`);
      assert(result.stderr.includes('No patch was applied'), `Expected patch safety message, got stderr: ${result.stderr}`);
      assert(result.stderr.includes('No push / no merge / no main touch'), `Expected git safety message, got stderr: ${result.stderr}`);
    } finally {
      cleanup();
    }
  });

  test('fails clearly with opt-in when task does not exist', () => {
    const { tasksFilePath, cleanup } = createTempEnv();
    try {
      const result = runCli(['real-provider-run', 'nonexistent-task'], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_PROVIDER_RUN: 'true',
      });

      assert.strictEqual(result.status, 1, `Expected failure, got stdout: ${result.stdout}`);
      assert(result.stderr.includes('[real-provider-run] Error:'), `Expected error prefix, got stderr: ${result.stderr}`);
    } finally {
      cleanup();
    }
  });
});
