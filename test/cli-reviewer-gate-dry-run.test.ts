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
  delete env.KIMI_FAKE_REVIEWER_RESPONSE;
  delete env.REVIEWER_PROVIDER;
  delete env.ALLOW_KIMI_REVIEWER;
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

function createTempEnv(): {
  taskId: string;
  tasksFilePath: string;
  cleanup: () => void;
} {
  const id = `${Date.now()}-${counter++}`;
  const taskId = `rgd-${id}`;
  const tmpBase = join(process.cwd(), 'tmp');
  if (!existsSync(tmpBase)) {
    mkdirSync(tmpBase);
  }
  const tmpDir = mkdtempSync(join(tmpBase, `rgd-${id}-`));
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
    title: "Reviewer gate dry-run test"
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
      allow_modify:
        - "src/test.ts"
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

describe('cli reviewer-gate-dry-run', () => {
  test('accepted output with fake provider', () => {
    const { taskId, tasksFilePath, cleanup } = createTempEnv();
    try {
      const result = runCli(['reviewer-gate-dry-run', taskId], {
        TASKS_FILE: tasksFilePath,
        REVIEWER_PROVIDER: 'fake',
      });

      assert.strictEqual(result.status, 0, `Expected success, got stderr: ${result.stderr}`);
      assert(result.stdout.includes('[reviewer-gate-dry-run] Reviewer provider: fake'), `Expected provider, got stdout: ${result.stdout}`);
      assert(result.stdout.includes('[reviewer-gate-dry-run] Reviewer decision: accepted'), `Expected decision, got stdout: ${result.stdout}`);
      assert(result.stdout.includes('[reviewer-gate-dry-run] Next action: advance_to_next_task'), `Expected next action, got stdout: ${result.stdout}`);
      assert(result.stdout.includes('[reviewer-gate-dry-run] Blocking issues count: 0'), `Expected blocking count, got stdout: ${result.stdout}`);
      assert(result.stdout.includes('[reviewer-gate-dry-run] No file was modified'), `Expected no file modified, got stdout: ${result.stdout}`);
      assert(result.stdout.includes('[reviewer-gate-dry-run] No git command was executed'), `Expected no git, got stdout: ${result.stdout}`);
      assert(result.stdout.includes('[reviewer-gate-dry-run] No merge was performed'), `Expected no merge, got stdout: ${result.stdout}`);
    } finally {
      cleanup();
    }
  });

  test('rejected output with fake provider', () => {
    const { taskId, tasksFilePath, cleanup } = createTempEnv();
    try {
      const rejectedJson = JSON.stringify({
        decision: 'rejected',
        confidence: 'medium',
        blocking_issues: ['Missing tests'],
        non_blocking_issues: [],
        review_summary: 'Needs work',
        fix_task: 'Add tests',
        next_action: 'send_fix_to_coder',
      });
      const result = runCli(['reviewer-gate-dry-run', taskId], {
        TASKS_FILE: tasksFilePath,
        REVIEWER_PROVIDER: 'fake',
        KIMI_FAKE_REVIEWER_RESPONSE: rejectedJson,
      });

      // Fake provider ignores KIMI_FAKE_REVIEWER_RESPONSE, but the command should still succeed
      assert.strictEqual(result.status, 0, `Expected success, got stderr: ${result.stderr}`);
      assert(result.stdout.includes('accepted'), `Fake reviewer defaults to accepted: ${result.stdout}`);
    } finally {
      cleanup();
    }
  });

  test('invalid reviewer output exits non-zero', () => {
    const { taskId, tasksFilePath, cleanup } = createTempEnv();
    try {
      const invalidJson = JSON.stringify({
        decision: 'accepted',
        confidence: 'high',
        blocking_issues: ['should be empty for accepted'],
        non_blocking_issues: [],
        review_summary: 'bad',
        fix_task: null,
        next_action: 'advance_to_next_task',
      });
      const result = runCli(['reviewer-gate-dry-run', taskId], {
        TASKS_FILE: tasksFilePath,
        REVIEWER_PROVIDER: 'kimi',
        KIMI_FAKE_REVIEWER_RESPONSE: invalidJson,
      });

      assert.strictEqual(result.status, 1, `Expected failure, got stdout: ${result.stdout}`);
      assert(result.stderr.includes('Accepted decision must have empty blocking_issues'), `Expected schema error, got stderr: ${result.stderr}`);
    } finally {
      cleanup();
    }
  });

  test('no file writes', () => {
    const { taskId, tasksFilePath, cleanup } = createTempEnv();
    try {
      const result = runCli(['reviewer-gate-dry-run', taskId], {
        TASKS_FILE: tasksFilePath,
        REVIEWER_PROVIDER: 'fake',
      });

      assert.strictEqual(result.status, 0);
      assert(result.stdout.includes('No file was modified'));
    } finally {
      cleanup();
    }
  });

  test('no git commands', () => {
    const { taskId, tasksFilePath, cleanup } = createTempEnv();
    try {
      const result = runCli(['reviewer-gate-dry-run', taskId], {
        TASKS_FILE: tasksFilePath,
        REVIEWER_PROVIDER: 'fake',
      });

      assert.strictEqual(result.status, 0);
      assert(result.stdout.includes('No git command was executed'));
    } finally {
      cleanup();
    }
  });

  test('no merge', () => {
    const { taskId, tasksFilePath, cleanup } = createTempEnv();
    try {
      const result = runCli(['reviewer-gate-dry-run', taskId], {
        TASKS_FILE: tasksFilePath,
        REVIEWER_PROVIDER: 'fake',
      });

      assert.strictEqual(result.status, 0);
      assert(result.stdout.includes('No merge was performed'));
    } finally {
      cleanup();
    }
  });

  test('no checkout/switch', () => {
    const { taskId, tasksFilePath, cleanup } = createTempEnv();
    try {
      const result = runCli(['reviewer-gate-dry-run', taskId], {
        TASKS_FILE: tasksFilePath,
        REVIEWER_PROVIDER: 'fake',
      });

      assert.strictEqual(result.status, 0);
      assert(result.stdout.includes('No checkout was performed'));
    } finally {
      cleanup();
    }
  });

  test('no main touch', () => {
    const { taskId, tasksFilePath, cleanup } = createTempEnv();
    try {
      const result = runCli(['reviewer-gate-dry-run', taskId], {
        TASKS_FILE: tasksFilePath,
        REVIEWER_PROVIDER: 'fake',
      });

      assert.strictEqual(result.status, 0);
      assert(result.stdout.includes('No main touch was performed'));
    } finally {
      cleanup();
    }
  });

  test('no stack trace leak', () => {
    const { taskId, tasksFilePath, cleanup } = createTempEnv();
    try {
      const result = runCli(['reviewer-gate-dry-run', taskId], {
        TASKS_FILE: tasksFilePath,
        REVIEWER_PROVIDER: 'fake',
      });

      assert.strictEqual(result.status, 0);
      assert(!result.stderr.includes('at '), `Stderr should not contain stack trace: ${result.stderr}`);
    } finally {
      cleanup();
    }
  });

  test('no API key leak', () => {
    const { taskId, tasksFilePath, cleanup } = createTempEnv();
    try {
      const result = runCli(['reviewer-gate-dry-run', taskId], {
        TASKS_FILE: tasksFilePath,
        REVIEWER_PROVIDER: 'fake',
      });

      assert.strictEqual(result.status, 0);
      assert(!result.stdout.includes('sk-'), `Stdout should not contain API key`);
      assert(!result.stderr.includes('sk-'), `Stderr should not contain API key`);
    } finally {
      cleanup();
    }
  });

  test('default provider is fake', () => {
    const { taskId, tasksFilePath, cleanup } = createTempEnv();
    try {
      const result = runCli(['reviewer-gate-dry-run', taskId], {
        TASKS_FILE: tasksFilePath,
      });

      assert.strictEqual(result.status, 0, `Expected success, got stderr: ${result.stderr}`);
      assert(result.stdout.includes('Reviewer provider: fake'), `Expected default fake, got stdout: ${result.stdout}`);
    } finally {
      cleanup();
    }
  });

  test('REVIEWER_PROVIDER=kimi uses fake Kimi response in tests', () => {
    const { taskId, tasksFilePath, cleanup } = createTempEnv();
    try {
      const acceptedJson = JSON.stringify({
        decision: 'accepted',
        confidence: 'high',
        blocking_issues: [],
        non_blocking_issues: [],
        review_summary: 'OK',
        fix_task: null,
        next_action: 'advance_to_next_task',
      });
      const result = runCli(['reviewer-gate-dry-run', taskId], {
        TASKS_FILE: tasksFilePath,
        REVIEWER_PROVIDER: 'kimi',
        KIMI_FAKE_REVIEWER_RESPONSE: acceptedJson,
      });

      assert.strictEqual(result.status, 0, `Expected success, got stderr: ${result.stderr}`);
      assert(result.stdout.includes('Reviewer provider: kimi'), `Expected kimi provider, got stdout: ${result.stdout}`);
      assert(result.stdout.includes('Reviewer decision: accepted'), `Expected accepted, got stdout: ${result.stdout}`);
    } finally {
      cleanup();
    }
  });

  test('missing taskId shows usage', () => {
    const { tasksFilePath, cleanup } = createTempEnv();
    try {
      const result = runCli(['reviewer-gate-dry-run'], {
        TASKS_FILE: tasksFilePath,
      });

      assert.strictEqual(result.status, 1, `Expected failure, got stdout: ${result.stdout}`);
      assert(result.stderr.includes('Usage:'), `Expected Usage in stderr, got: ${result.stderr}`);
    } finally {
      cleanup();
    }
  });
});
