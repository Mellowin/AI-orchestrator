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

function buildFakeKimiOutput(
  files: Array<{ path: string; content: string }>,
  notes?: string
): string {
  return JSON.stringify({ mode: 'file_update', files, notes });
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
  test('missing ALLOW_REAL_REPO_APPLY refuses before provider response is required', () => {
    const { taskId, tasksFilePath, cleanup } = createTempEnv();
    try {
      const result = runCli(['real-repo-apply', taskId], {
        TASKS_FILE: tasksFilePath,
      });
      assert.notStrictEqual(result.status, 0, 'should exit non-zero');
      assert(
        result.stderr.includes('ALLOW_REAL_REPO_APPLY=true is required'),
        `Expected opt-in message, got: ${result.stderr}`
      );
      assert(
        !result.stderr.includes('REAL_REPO_PROVIDER_RESPONSE'),
        'Should not mention provider response before opt-in'
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

  test('with opt-in, missing REAL_REPO_PROVIDER_RESPONSE refuses safely', () => {
    const { taskId, tasksFilePath, cleanup } = createTempEnv();
    try {
      const result = runCli(['real-repo-apply', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_REPO_APPLY: 'true',
      });
      assert.notStrictEqual(result.status, 0, 'should exit non-zero');
      assert(result.stderr.includes('REAL_REPO_PROVIDER_RESPONSE'));
      assert(result.stderr.includes('No files were modified'));
    } finally {
      cleanup();
    }
  });

  test('with opt-in, empty REAL_REPO_PROVIDER_RESPONSE refuses safely', () => {
    const { taskId, tasksFilePath, cleanup } = createTempEnv();
    try {
      const result = runCli(['real-repo-apply', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_REPO_APPLY: 'true',
        REAL_REPO_PROVIDER_RESPONSE: '',
      });
      assert.notStrictEqual(result.status, 0, 'should exit non-zero');
      assert(result.stderr.includes('REAL_REPO_PROVIDER_RESPONSE'));
      assert(result.stderr.includes('No files were modified'));
    } finally {
      cleanup();
    }
  });

  test('with opt-in, malformed provider response refuses safely', () => {
    const { taskId, tasksFilePath, cleanup } = createTempEnv();
    try {
      const result = runCli(['real-repo-apply', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_REPO_APPLY: 'true',
        REAL_REPO_PROVIDER_RESPONSE: 'not-json-at-all',
      });
      assert.notStrictEqual(result.status, 0, 'should exit non-zero');
      assert(result.stderr.includes('[real-repo-apply] Error:'));
      assert(result.stderr.includes('No files were modified'));
    } finally {
      cleanup();
    }
  });

  test('with opt-in, file guardrails violation refuses safely', () => {
    const { taskId, tasksFilePath, cleanup } = createTempEnv();
    try {
      const result = runCli(['real-repo-apply', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_REPO_APPLY: 'true',
        REAL_REPO_PROVIDER_RESPONSE: buildFakeKimiOutput([
          { path: '.env', content: 'SECRET=1\n' },
        ]),
      });
      assert.notStrictEqual(result.status, 0, 'should exit non-zero');
      assert(result.stderr.includes('Guardrails failed:'));
      assert(result.stderr.includes('No files were modified'));
    } finally {
      cleanup();
    }
  });

  test('with opt-in, line delta violation refuses safely', () => {
    const { taskId, tasksFilePath, cleanup } = createTempEnv();
    try {
      const longContent = Array(152).fill('x').join('\n') + '\n';
      const result = runCli(['real-repo-apply', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_REPO_APPLY: 'true',
        REAL_REPO_PROVIDER_RESPONSE: buildFakeKimiOutput([
          { path: 'README.md', content: longContent },
        ]),
      });
      assert.notStrictEqual(result.status, 0, 'should exit non-zero');
      assert(result.stderr.includes('Error:'));
      assert(result.stderr.includes('No files were modified'));
    } finally {
      cleanup();
    }
  });

  test('with opt-in, dirty working tree refuses safely', () => {
    const { taskId, tasksFilePath, repoPath, cleanup } = createTempEnv();
    try {
      writeFileSync(join(repoPath, 'dirty.txt'), 'dirty', 'utf-8');
      const result = runCli(['real-repo-apply', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_REPO_APPLY: 'true',
        REAL_REPO_PROVIDER_RESPONSE: buildFakeKimiOutput([
          { path: 'README.md', content: '# updated\n' },
        ]),
      });
      assert.notStrictEqual(result.status, 0, 'should exit non-zero');
      assert(result.stderr.includes('Safety check failed:'));
      assert(result.stderr.includes('Working tree is not clean'));
      assert(result.stderr.includes('No files were modified'));
    } finally {
      cleanup();
    }
  });

  test('with opt-in, current branch main refuses safely', () => {
    const { taskId, tasksFilePath, repoPath, cleanup } = createTempEnv();
    try {
      spawnSync('git', ['checkout', 'main'], {
        cwd: repoPath,
        encoding: 'utf-8',
        shell: false,
      });
      const result = runCli(['real-repo-apply', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_REPO_APPLY: 'true',
        REAL_REPO_PROVIDER_RESPONSE: buildFakeKimiOutput([
          { path: 'README.md', content: '# updated\n' },
        ]),
      });
      assert.notStrictEqual(result.status, 0, 'should exit non-zero');
      assert(result.stderr.includes('Safety check failed:'));
      assert(result.stderr.includes('Current branch is main'));
      assert(result.stderr.includes('No files were modified'));
    } finally {
      cleanup();
    }
  });

  test('with opt-in, task.work_branch main refuses safely', () => {
    const { taskId, tasksFilePath, repoPath, cleanup } = createTempEnv();
    try {
      const modifiedTasksPath = join(repoPath, '..', 'tasks-main.yaml');
      writeFileSync(
        modifiedTasksPath,
        `tasks:
  - id: ${taskId}
    title: "Apply test"
    repo_path: "${repoPath.replace(/\\/g, '/')}"
    base_branch: "main"
    work_branch: "main"
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
      const result = runCli(['real-repo-apply', taskId], {
        TASKS_FILE: modifiedTasksPath,
        ALLOW_REAL_REPO_APPLY: 'true',
        REAL_REPO_PROVIDER_RESPONSE: buildFakeKimiOutput([
          { path: 'README.md', content: '# updated\n' },
        ]),
      });
      assert.notStrictEqual(result.status, 0, 'should exit non-zero');
      assert(result.stderr.includes('Safety check failed:'));
      assert(result.stderr.includes('work_branch is main'));
      assert(result.stderr.includes('No files were modified'));
    } finally {
      cleanup();
    }
  });

  test('with opt-in, branch mismatch refuses safely', () => {
    const { taskId, tasksFilePath, repoPath, cleanup } = createTempEnv();
    try {
      spawnSync('git', ['checkout', '-b', 'other-branch'], {
        cwd: repoPath,
        encoding: 'utf-8',
        shell: false,
      });
      const result = runCli(['real-repo-apply', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_REPO_APPLY: 'true',
        REAL_REPO_PROVIDER_RESPONSE: buildFakeKimiOutput([
          { path: 'README.md', content: '# updated\n' },
        ]),
      });
      assert.notStrictEqual(result.status, 0, 'should exit non-zero');
      assert(result.stderr.includes('Safety check failed:'));
      assert(result.stderr.includes('does not equal work_branch'));
      assert(result.stderr.includes('No files were modified'));
    } finally {
      cleanup();
    }
  });

  test('with opt-in and valid response/safety, prints plan summary and then refuses before write', () => {
    const { taskId, tasksFilePath, cleanup } = createTempEnv();
    try {
      const result = runCli(['real-repo-apply', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_REPO_APPLY: 'true',
        REAL_REPO_PROVIDER_RESPONSE: buildFakeKimiOutput([
          { path: 'README.md', content: '# updated\n' },
        ]),
      });
      assert.notStrictEqual(result.status, 0, 'should exit non-zero');
      assert(
        result.stdout.includes('[real-repo-apply] Task:'),
        `Expected Task header, got: ${result.stdout}`
      );
      assert(
        result.stdout.includes('[real-repo-apply] Current branch:'),
        `Expected current branch, got: ${result.stdout}`
      );
      assert(
        result.stdout.includes('[real-repo-apply] Work branch:'),
        `Expected work branch, got: ${result.stdout}`
      );
      assert(
        result.stdout.includes('[real-repo-apply] Files:'),
        `Expected Files header, got: ${result.stdout}`
      );
      assert(
        result.stdout.includes('action=overwrite'),
        `Expected action=overwrite, got: ${result.stdout}`
      );
      assert(
        result.stdout.includes('backupPath='),
        `Expected backupPath, got: ${result.stdout}`
      );
      assert(
        result.stderr.includes('pre-write validation passed, but file apply is not implemented yet'),
        `Expected pre-write stop message, got: ${result.stderr}`
      );
    } finally {
      cleanup();
    }
  });

  test('valid pre-write path does not modify repo files', () => {
    const { taskId, tasksFilePath, repoPath, cleanup } = createTempEnv();
    try {
      const original = readFileSync(join(repoPath, 'README.md'), 'utf-8');
      runCli(['real-repo-apply', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_REPO_APPLY: 'true',
        REAL_REPO_PROVIDER_RESPONSE: buildFakeKimiOutput([
          { path: 'README.md', content: '# updated\n' },
        ]),
      });
      assert.strictEqual(
        readFileSync(join(repoPath, 'README.md'), 'utf-8'),
        original
      );
    } finally {
      cleanup();
    }
  });

  test('valid pre-write path does not create runs/state files', () => {
    const { taskId, tasksFilePath, repoPath, cleanup } = createTempEnv();
    try {
      runCli(['real-repo-apply', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_REPO_APPLY: 'true',
        REAL_REPO_PROVIDER_RESPONSE: buildFakeKimiOutput([
          { path: 'README.md', content: '# updated\n' },
        ]),
      });
      assert(
        !existsSync(join(repoPath, 'runs', 'state.json')),
        'state.json should not be written to repo'
      );
    } finally {
      cleanup();
    }
  });

  test('valid pre-write path does not commit', () => {
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
        ALLOW_REAL_REPO_APPLY: 'true',
        REAL_REPO_PROVIDER_RESPONSE: buildFakeKimiOutput([
          { path: 'README.md', content: '# updated\n' },
        ]),
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

  test('valid pre-write path does not push', () => {
    const { taskId, tasksFilePath, cleanup } = createTempEnv();
    try {
      const result = runCli(['real-repo-apply', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_REPO_APPLY: 'true',
        REAL_REPO_PROVIDER_RESPONSE: buildFakeKimiOutput([
          { path: 'README.md', content: '# updated\n' },
        ]),
      });
      assert.notStrictEqual(result.status, 0);
      assert(!result.stdout.includes('git push'));
      assert(!result.stderr.includes('git push'));
    } finally {
      cleanup();
    }
  });

  test('valid pre-write path does not merge', () => {
    const { taskId, tasksFilePath, cleanup } = createTempEnv();
    try {
      const result = runCli(['real-repo-apply', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_REPO_APPLY: 'true',
        REAL_REPO_PROVIDER_RESPONSE: buildFakeKimiOutput([
          { path: 'README.md', content: '# updated\n' },
        ]),
      });
      assert.notStrictEqual(result.status, 0);
      assert(!result.stdout.includes('git merge'));
      assert(!result.stderr.includes('git merge'));
    } finally {
      cleanup();
    }
  });

  test('valid pre-write path does not checkout or switch branch', () => {
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
        ALLOW_REAL_REPO_APPLY: 'true',
        REAL_REPO_PROVIDER_RESPONSE: buildFakeKimiOutput([
          { path: 'README.md', content: '# updated\n' },
        ]),
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

  test('does not require API keys', () => {
    const { taskId, tasksFilePath, cleanup } = createTempEnv();
    try {
      const result = runCli(['real-repo-apply', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_REPO_APPLY: 'true',
        REAL_REPO_PROVIDER_RESPONSE: buildFakeKimiOutput([
          { path: 'README.md', content: '# updated\n' },
        ]),
      });
      assert.notStrictEqual(result.status, 0);
      assert(!result.stderr.includes('KIMI_API_KEY'));
      assert(!result.stderr.includes('OPENAI_API_KEY'));
    } finally {
      cleanup();
    }
  });

  test('does not call provider/network', () => {
    const { taskId, tasksFilePath, cleanup } = createTempEnv();
    try {
      const result = runCli(['real-repo-apply', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_REPO_APPLY: 'true',
        REAL_REPO_PROVIDER_RESPONSE: buildFakeKimiOutput([
          { path: 'README.md', content: '# updated\n' },
        ]),
      });
      assert.notStrictEqual(result.status, 0);
      // No API keys required and response comes from env, so no provider call happened
      assert(!result.stderr.includes('KIMI_API_KEY'));
      assert(!result.stderr.includes('fetch'));
    } finally {
      cleanup();
    }
  });

  test('output contains all safety messages', () => {
    const { taskId, tasksFilePath, cleanup } = createTempEnv();
    try {
      const result = runCli(['real-repo-apply', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_REPO_APPLY: 'true',
        REAL_REPO_PROVIDER_RESPONSE: buildFakeKimiOutput([
          { path: 'README.md', content: '# updated\n' },
        ]),
      });
      assert.notStrictEqual(result.status, 0);
      const combined = result.stdout + result.stderr;
      assert(combined.includes('No files were modified'));
      assert(combined.includes('No commit was made'));
      assert(combined.includes('No push was performed'));
      assert(combined.includes('No merge was performed'));
    } finally {
      cleanup();
    }
  });

  test('output contains no stack trace', () => {
    const { taskId, tasksFilePath, cleanup } = createTempEnv();
    try {
      const result = runCli(['real-repo-apply', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_REPO_APPLY: 'true',
        REAL_REPO_PROVIDER_RESPONSE: buildFakeKimiOutput([
          { path: 'README.md', content: '# updated\n' },
        ]),
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
        ALLOW_REAL_REPO_APPLY: 'true',
        REAL_REPO_PROVIDER_RESPONSE: buildFakeKimiOutput([
          { path: 'README.md', content: '# updated\n' },
        ]),
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
