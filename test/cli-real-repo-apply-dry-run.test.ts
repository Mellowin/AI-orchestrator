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
  const taskId = `dryrun-${id}`;
  const tmpBase = join(process.cwd(), 'tmp');
  if (!existsSync(tmpBase)) {
    mkdirSync(tmpBase);
  }
  const tmpDir = mkdtempSync(join(tmpBase, `dryrun-${id}-`));
  const repoPath = join(tmpDir, 'repo');
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

  const tasksFilePath = join(tmpDir, 'tasks.yaml');
  writeFileSync(
    tasksFilePath,
    `tasks:
  - id: ${taskId}
    title: "Dry run test"
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

describe('cli real-repo-apply-dry-run', () => {
  test('success path exits 0 and prints dry-run summary', () => {
    const { taskId, tasksFilePath, cleanup } = createTempEnv();
    try {
      const result = runCli(['real-repo-apply-dry-run', taskId], {
        TASKS_FILE: tasksFilePath,
        REAL_REPO_PROVIDER_RESPONSE: buildFakeKimiOutput([
          { path: 'README.md', content: '# updated\n' },
        ]),
      });
      assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
      assert(
        result.stdout.includes('[real-repo-apply-dry-run] Task:'),
        `Expected Task header, got: ${result.stdout}`
      );
      assert(
        result.stdout.includes('[real-repo-apply-dry-run] Guardrails: PASS'),
        `Expected Guardrails PASS, got: ${result.stdout}`
      );
      assert(
        result.stdout.includes('[real-repo-apply-dry-run] Safety: PASS'),
        `Expected Safety PASS, got: ${result.stdout}`
      );
      assert(
        result.stdout.includes('[real-repo-apply-dry-run] Safety messages:'),
        `Expected Safety messages, got: ${result.stdout}`
      );
    } finally {
      cleanup();
    }
  });

  test('missing REAL_REPO_PROVIDER_RESPONSE fails safely', () => {
    const { taskId, tasksFilePath, cleanup } = createTempEnv();
    try {
      const result = runCli(['real-repo-apply-dry-run', taskId], {
        TASKS_FILE: tasksFilePath,
      });
      assert.notStrictEqual(result.status, 0, 'should exit non-zero');
      assert(result.stderr.includes('REAL_REPO_PROVIDER_RESPONSE'));
    } finally {
      cleanup();
    }
  });

  test('malformed provider response fails safely', () => {
    const { taskId, tasksFilePath, cleanup } = createTempEnv();
    try {
      const result = runCli(['real-repo-apply-dry-run', taskId], {
        TASKS_FILE: tasksFilePath,
        REAL_REPO_PROVIDER_RESPONSE: 'not-json-at-all',
      });
      assert.notStrictEqual(result.status, 0, 'should exit non-zero');
      assert(result.stderr.includes('[real-repo-apply-dry-run] Error:'));
    } finally {
      cleanup();
    }
  });

  test('guardrails failure fails safely', () => {
    const { taskId, tasksFilePath, cleanup } = createTempEnv();
    try {
      const result = runCli(['real-repo-apply-dry-run', taskId], {
        TASKS_FILE: tasksFilePath,
        REAL_REPO_PROVIDER_RESPONSE: buildFakeKimiOutput([
          { path: '.env', content: 'SECRET=1\n' },
        ]),
      });
      assert.notStrictEqual(result.status, 0, 'should exit non-zero');
      assert(result.stderr.includes('Guardrails failed:'));
    } finally {
      cleanup();
    }
  });

  test('safety failure — dirty tree', () => {
    const { taskId, tasksFilePath, repoPath, cleanup } = createTempEnv();
    try {
      writeFileSync(join(repoPath, 'dirty.txt'), 'dirty', 'utf-8');
      const result = runCli(['real-repo-apply-dry-run', taskId], {
        TASKS_FILE: tasksFilePath,
        REAL_REPO_PROVIDER_RESPONSE: buildFakeKimiOutput([
          { path: 'README.md', content: '# updated\n' },
        ]),
      });
      assert.notStrictEqual(result.status, 0, 'should exit non-zero');
      assert(result.stderr.includes('Safety check failed:'));
      assert(result.stderr.includes('Working tree is not clean'));
    } finally {
      cleanup();
    }
  });

  test('safety failure — current branch is main', () => {
    const { taskId, tasksFilePath, repoPath, cleanup } = createTempEnv();
    try {
      spawnSync('git', ['checkout', 'main'], {
        cwd: repoPath,
        encoding: 'utf-8',
        shell: false,
      });
      const result = runCli(['real-repo-apply-dry-run', taskId], {
        TASKS_FILE: tasksFilePath,
        REAL_REPO_PROVIDER_RESPONSE: buildFakeKimiOutput([
          { path: 'README.md', content: '# updated\n' },
        ]),
      });
      assert.notStrictEqual(result.status, 0, 'should exit non-zero');
      assert(result.stderr.includes('Safety check failed:'));
      assert(result.stderr.includes('Current branch is main'));
    } finally {
      cleanup();
    }
  });

  test('safety failure — work_branch is main', () => {
    const { taskId, tasksFilePath, repoPath, cleanup } = createTempEnv();
    try {
      const modifiedTasksPath = join(repoPath, '..', 'tasks-main.yaml');
      writeFileSync(
        modifiedTasksPath,
        `tasks:
  - id: ${taskId}
    title: "Dry run test"
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
      const result = runCli(['real-repo-apply-dry-run', taskId], {
        TASKS_FILE: modifiedTasksPath,
        REAL_REPO_PROVIDER_RESPONSE: buildFakeKimiOutput([
          { path: 'README.md', content: '# updated\n' },
        ]),
      });
      assert.notStrictEqual(result.status, 0, 'should exit non-zero');
      assert(result.stderr.includes('Safety check failed:'));
      assert(result.stderr.includes('work_branch is main'));
    } finally {
      cleanup();
    }
  });

  test('safety failure — branch mismatch', () => {
    const { taskId, tasksFilePath, repoPath, cleanup } = createTempEnv();
    try {
      spawnSync('git', ['checkout', '-b', 'other-branch'], {
        cwd: repoPath,
        encoding: 'utf-8',
        shell: false,
      });
      const result = runCli(['real-repo-apply-dry-run', taskId], {
        TASKS_FILE: tasksFilePath,
        REAL_REPO_PROVIDER_RESPONSE: buildFakeKimiOutput([
          { path: 'README.md', content: '# updated\n' },
        ]),
      });
      assert.notStrictEqual(result.status, 0, 'should exit non-zero');
      assert(result.stderr.includes('Safety check failed:'));
      assert(result.stderr.includes('does not equal work_branch'));
    } finally {
      cleanup();
    }
  });

  test('safety failure — auto_commit not false', () => {
    const { taskId, tasksFilePath, repoPath, cleanup } = createTempEnv();
    try {
      const modifiedTasksPath = join(repoPath, '..', 'tasks-auto-commit.yaml');
      writeFileSync(
        modifiedTasksPath,
        `tasks:
  - id: ${taskId}
    title: "Dry run test"
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
      auto_commit: true
      auto_push: false
      auto_merge: false
`,
        'utf-8'
      );
      const result = runCli(['real-repo-apply-dry-run', taskId], {
        TASKS_FILE: modifiedTasksPath,
        REAL_REPO_PROVIDER_RESPONSE: buildFakeKimiOutput([
          { path: 'README.md', content: '# updated\n' },
        ]),
      });
      assert.notStrictEqual(result.status, 0, 'should exit non-zero');
      assert(result.stderr.includes('Safety check failed:'));
      assert(result.stderr.includes('auto_commit must be false'));
    } finally {
      cleanup();
    }
  });

  test('safety failure — auto_push not false', () => {
    const { taskId, tasksFilePath, repoPath, cleanup } = createTempEnv();
    try {
      const modifiedTasksPath = join(repoPath, '..', 'tasks-auto-push.yaml');
      writeFileSync(
        modifiedTasksPath,
        `tasks:
  - id: ${taskId}
    title: "Dry run test"
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
      auto_push: true
      auto_merge: false
`,
        'utf-8'
      );
      const result = runCli(['real-repo-apply-dry-run', taskId], {
        TASKS_FILE: modifiedTasksPath,
        REAL_REPO_PROVIDER_RESPONSE: buildFakeKimiOutput([
          { path: 'README.md', content: '# updated\n' },
        ]),
      });
      assert.notStrictEqual(result.status, 0, 'should exit non-zero');
      assert(result.stderr.includes('Safety check failed:'));
      assert(result.stderr.includes('auto_push must be false'));
    } finally {
      cleanup();
    }
  });

  test('safety failure — auto_merge not false', () => {
    const { taskId, tasksFilePath, repoPath, cleanup } = createTempEnv();
    try {
      const modifiedTasksPath = join(repoPath, '..', 'tasks-auto-merge.yaml');
      writeFileSync(
        modifiedTasksPath,
        `tasks:
  - id: ${taskId}
    title: "Dry run test"
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
      auto_merge: true
`,
        'utf-8'
      );
      const result = runCli(['real-repo-apply-dry-run', taskId], {
        TASKS_FILE: modifiedTasksPath,
        REAL_REPO_PROVIDER_RESPONSE: buildFakeKimiOutput([
          { path: 'README.md', content: '# updated\n' },
        ]),
      });
      assert.notStrictEqual(result.status, 0, 'should exit non-zero');
      assert(result.stderr.includes('Safety check failed:'));
      assert(result.stderr.includes('auto_merge must be false'));
    } finally {
      cleanup();
    }
  });

  test('no file mutation in repo', () => {
    const { taskId, tasksFilePath, repoPath, cleanup } = createTempEnv();
    try {
      const original = readFileSync(join(repoPath, 'README.md'), 'utf-8');
      const result = runCli(['real-repo-apply-dry-run', taskId], {
        TASKS_FILE: tasksFilePath,
        REAL_REPO_PROVIDER_RESPONSE: buildFakeKimiOutput([
          { path: 'README.md', content: '# modified\n' },
        ]),
      });
      assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
      assert.strictEqual(
        readFileSync(join(repoPath, 'README.md'), 'utf-8'),
        original
      );
    } finally {
      cleanup();
    }
  });

  test('no runs/state.json is written', () => {
    const { taskId, tasksFilePath, repoPath, cleanup } = createTempEnv();
    try {
      runCli(['real-repo-apply-dry-run', taskId], {
        TASKS_FILE: tasksFilePath,
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

  test('does not require ALLOW_REAL_REPO_APPLY', () => {
    const { taskId, tasksFilePath, cleanup } = createTempEnv();
    try {
      const result = runCli(['real-repo-apply-dry-run', taskId], {
        TASKS_FILE: tasksFilePath,
        REAL_REPO_PROVIDER_RESPONSE: buildFakeKimiOutput([
          { path: 'README.md', content: '# updated\n' },
        ]),
      });
      assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
      assert(!result.stderr.includes('ALLOW_REAL_REPO_APPLY'));
    } finally {
      cleanup();
    }
  });

  test('existing empty file shows isNew=false', () => {
    const id = `${Date.now()}-${counter++}`;
    const taskId = `dryrun-empty-${id}`;
    const tmpBase = join(process.cwd(), 'tmp');
    if (!existsSync(tmpBase)) {
      mkdirSync(tmpBase);
    }
    const tmpDir = mkdtempSync(join(tmpBase, `dryrun-empty-${id}-`));
    const repoPath = join(tmpDir, 'repo');
    mkdirSync(repoPath);

    writeFileSync(join(repoPath, 'README.md'), '# hello\n', 'utf-8');
    writeFileSync(join(repoPath, 'empty.md'), '', 'utf-8');

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

    const tasksFilePath = join(tmpDir, 'tasks.yaml');
    writeFileSync(
      tasksFilePath,
      `tasks:
  - id: ${taskId}
    title: "Dry run empty file test"
    repo_path: "${repoPath.replace(/\\/g, '/')}"
    base_branch: "main"
    work_branch: "ai/${taskId}"
    goal: "Test goal"
    context_files:
      - "README.md"
      - "empty.md"
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

    try {
      const result = runCli(['real-repo-apply-dry-run', taskId], {
        TASKS_FILE: tasksFilePath,
        REAL_REPO_PROVIDER_RESPONSE: buildFakeKimiOutput([
          { path: 'empty.md', content: 'now has content\n' },
        ]),
      });
      assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
      assert(
        result.stdout.includes('empty.md'),
        `Expected empty.md in stdout, got: ${result.stdout}`
      );
      assert(
        result.stdout.includes('isNew=false'),
        `Expected isNew=false for existing empty file, got: ${result.stdout}`
      );
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
