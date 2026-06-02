import { describe, test } from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
} from 'node:fs';
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
  delete env.KIMI_FAKE_RESPONSE;
  delete env.OPENAI_API_KEY;
  delete env.MOCK_AI;
  delete env.ALLOW_REAL_PROVIDER_RUN;
  delete env.ALLOW_SANDBOX_APPLY_PREVIEW;
  delete env.ALLOW_REAL_REPO_APPLY;
  delete env.SANDBOX_PROVIDER_RESPONSE;
  delete env.SANDBOX_ROOT;
  delete env.REAL_REPO_PROVIDER_RESPONSE;
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
  const taskId = `apply-${id}`;
  const tmpBase = join(process.cwd(), 'tmp');
  if (!existsSync(tmpBase)) {
    mkdirSync(tmpBase);
  }
  const tmpDir = mkdtempSync(join(tmpBase, `apply-${id}-`));
  const repoPath = join(tmpDir, 'repo');
  mkdirSync(repoPath);

  writeFileSync(join(repoPath, 'README.md'), '# hello\n', 'utf-8');

  spawnSync('git', ['init'], {
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

  const tasksFilePath = join(tmpDir, 'tasks.yaml');
  writeFileSync(
    tasksFilePath,
    `tasks:
  - id: ${taskId}
    title: "Apply test"
    repo_path: "${repoPath.replace(/\\/g, '/')}"
    base_branch: "main"
    work_branch: "ai/${taskId}"
    goal: "Test goal"
    context_files:
      - "README.md"
    checks:
      - command: "node"
        args: ["-e", "process.exit(0)"]
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

describe('cli real-repo-apply', () => {
  test('command exists and refuses safely', () => {
    const { taskId, tasksFilePath, cleanup } = createTempEnv();
    try {
      const result = runCli(['real-repo-apply', taskId], {
        TASKS_FILE: tasksFilePath,
      });
      assert.notStrictEqual(result.status, 0, 'should exit non-zero');
      assert(
        result.stderr.includes('real-repo-apply is not implemented yet'),
        `Expected refusal message, got: ${result.stderr}`
      );
    } finally {
      cleanup();
    }
  });

  test('missing taskId shows usage / safe error', () => {
    const result = runCli(['real-repo-apply']);
    assert.notStrictEqual(result.status, 0, 'should exit non-zero');
    assert(
      result.stderr.includes('Usage:') || result.stderr.includes('Error'),
      `Expected usage or error, got: ${result.stderr}`
    );
  });

  test('does not require ALLOW_REAL_REPO_APPLY while still stubbed', () => {
    const { taskId, tasksFilePath, cleanup } = createTempEnv();
    try {
      const result = runCli(['real-repo-apply', taskId], {
        TASKS_FILE: tasksFilePath,
      });
      assert.notStrictEqual(result.status, 0);
      assert(!result.stderr.includes('ALLOW_REAL_REPO_APPLY'));
    } finally {
      cleanup();
    }
  });

  test('does not require provider response while still stubbed', () => {
    const { taskId, tasksFilePath, cleanup } = createTempEnv();
    try {
      const result = runCli(['real-repo-apply', taskId], {
        TASKS_FILE: tasksFilePath,
      });
      assert.notStrictEqual(result.status, 0);
      assert(!result.stderr.includes('REAL_REPO_PROVIDER_RESPONSE'));
    } finally {
      cleanup();
    }
  });

  test('does not require API keys', () => {
    const { taskId, tasksFilePath, cleanup } = createTempEnv();
    try {
      const result = runCli(['real-repo-apply', taskId], {
        TASKS_FILE: tasksFilePath,
      });
      assert.notStrictEqual(result.status, 0);
      assert(!result.stderr.includes('KIMI_API_KEY'));
      assert(!result.stderr.includes('OPENAI_API_KEY'));
    } finally {
      cleanup();
    }
  });

  test('does not modify repo files', () => {
    const { taskId, tasksFilePath, repoPath, cleanup } = createTempEnv();
    try {
      const original = readFileSync(join(repoPath, 'README.md'), 'utf-8');
      runCli(['real-repo-apply', taskId], {
        TASKS_FILE: tasksFilePath,
      });
      assert.strictEqual(
        readFileSync(join(repoPath, 'README.md'), 'utf-8'),
        original
      );
    } finally {
      cleanup();
    }
  });

  test('does not create runs/state files', () => {
    const { taskId, tasksFilePath, repoPath, cleanup } = createTempEnv();
    try {
      runCli(['real-repo-apply', taskId], {
        TASKS_FILE: tasksFilePath,
      });
      assert(
        !existsSync(join(repoPath, 'runs', 'state.json')),
        'state.json should not be written to repo'
      );
    } finally {
      cleanup();
    }
  });

  test('does not commit', () => {
    const { taskId, tasksFilePath, repoPath, cleanup } = createTempEnv();
    try {
      const before = spawnSync(
        'git',
        ['log', '--oneline'],
        { cwd: repoPath, encoding: 'utf-8', shell: false }
      );
      const beforeCount = before.stdout?.trim().split('\n').length ?? 0;
      runCli(['real-repo-apply', taskId], {
        TASKS_FILE: tasksFilePath,
      });
      const after = spawnSync(
        'git',
        ['log', '--oneline'],
        { cwd: repoPath, encoding: 'utf-8', shell: false }
      );
      const afterCount = after.stdout?.trim().split('\n').length ?? 0;
      assert.strictEqual(afterCount, beforeCount, 'commit count should not change');
    } finally {
      cleanup();
    }
  });

  test('does not push', () => {
    const { taskId, tasksFilePath, cleanup } = createTempEnv();
    try {
      const result = runCli(['real-repo-apply', taskId], {
        TASKS_FILE: tasksFilePath,
      });
      assert.notStrictEqual(result.status, 0);
      // Safety message mentions "No push was performed" but actual git push must not happen
      assert(!result.stdout.includes('git push'));
      assert(!result.stderr.includes('git push'));
    } finally {
      cleanup();
    }
  });

  test('does not merge', () => {
    const { taskId, tasksFilePath, cleanup } = createTempEnv();
    try {
      const result = runCli(['real-repo-apply', taskId], {
        TASKS_FILE: tasksFilePath,
      });
      assert.notStrictEqual(result.status, 0);
      assert(!result.stdout.includes('git merge'));
      assert(!result.stderr.includes('git merge'));
    } finally {
      cleanup();
    }
  });

  test('does not checkout or switch branch', () => {
    const { taskId, tasksFilePath, repoPath, cleanup } = createTempEnv();
    try {
      const before = spawnSync(
        'git',
        ['rev-parse', '--abbrev-ref', 'HEAD'],
        { cwd: repoPath, encoding: 'utf-8', shell: false }
      );
      const beforeBranch = before.stdout?.trim() ?? '';
      runCli(['real-repo-apply', taskId], {
        TASKS_FILE: tasksFilePath,
      });
      const after = spawnSync(
        'git',
        ['rev-parse', '--abbrev-ref', 'HEAD'],
        { cwd: repoPath, encoding: 'utf-8', shell: false }
      );
      const afterBranch = after.stdout?.trim() ?? '';
      assert.strictEqual(afterBranch, beforeBranch, 'branch should not change');
    } finally {
      cleanup();
    }
  });

  test('output contains all safety messages', () => {
    const { taskId, tasksFilePath, cleanup } = createTempEnv();
    try {
      const result = runCli(['real-repo-apply', taskId], {
        TASKS_FILE: tasksFilePath,
      });
      assert.notStrictEqual(result.status, 0);
      assert(result.stderr.includes('No files were modified'));
      assert(result.stderr.includes('No commit was made'));
      assert(result.stderr.includes('No push was performed'));
      assert(result.stderr.includes('No merge was performed'));
      assert(result.stderr.includes('Real repo apply remains disabled'));
    } finally {
      cleanup();
    }
  });

  test('output contains no stack trace', () => {
    const { taskId, tasksFilePath, cleanup } = createTempEnv();
    try {
      const result = runCli(['real-repo-apply', taskId], {
        TASKS_FILE: tasksFilePath,
      });
      assert.notStrictEqual(result.status, 0);
      const combined = result.stdout + result.stderr;
      assert(
        !combined.includes('    at '),
        `Expected no stack trace, got: ${combined}`
      );
    } finally {
      cleanup();
    }
  });

  test('output contains no API key value if env contains fake API key', () => {
    const { taskId, tasksFilePath, cleanup } = createTempEnv();
    try {
      const result = runCli(['real-repo-apply', taskId], {
        TASKS_FILE: tasksFilePath,
        OPENAI_API_KEY: 'sk-fake-key-12345',
      });
      assert.notStrictEqual(result.status, 0);
      const combined = result.stdout + result.stderr;
      assert(
        !combined.includes('sk-fake-key-12345'),
        `API key leaked in output: ${combined}`
      );
    } finally {
      cleanup();
    }
  });
});
