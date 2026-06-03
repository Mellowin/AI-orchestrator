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
  delete env.AI_PROVIDER;
  delete env.MOCK_AI_RESPONSE;
  delete env.MOCK_REVIEWER_RESPONSE;
  delete env.MOCK_PROVIDER_RESPONSE;
  env.KIMI_API_KEY = '';
  delete env.KIMI_MODEL;
  env.KIMI_BASE_URL = '';
  delete env.KIMI_USER_AGENT;
  delete env.KIMI_FAKE_RESPONSE;
  delete env.KIMI_FAKE_RESPONSES;
  delete env.OPENAI_API_KEY;
  delete env.MOCK_AI;
  delete env.ALLOW_REAL_PROVIDER_RUN;
  delete env.ALLOW_REAL_PROVIDER;
  delete env.ALLOW_SANDBOX_APPLY_PREVIEW;
  delete env.ALLOW_REAL_REPO_APPLY;
  delete env.ALLOW_REAL_REPO_COMMIT;
  delete env.ALLOW_REAL_REPO_PUSH;
  delete env.SANDBOX_PROVIDER_RESPONSE;
  delete env.SANDBOX_ROOT;
  delete env.REAL_REPO_PROVIDER_RESPONSE;
  delete env.RUNS_DIR;
  delete env.REAL_REPO_AI_MAX_ATTEMPTS;
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

function createTempEnv(checkObjects?: Array<{ command: string; args: string[] }>): {
  taskId: string;
  tasksFilePath: string;
  repoPath: string;
  originPath: string;
  runsDir: string;
  cleanup: () => void;
} {
  const id = `${Date.now()}-${counter++}`;
  const taskId = `rai-r-${id}`;
  const tmpBase = join(process.cwd(), 'tmp');
  if (!existsSync(tmpBase)) {
    mkdirSync(tmpBase);
  }
  const tmpDir = mkdtempSync(join(tmpBase, `rai-r-${id}-`));
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

  const checkLines = checkObjects && checkObjects.length > 0
    ? checkObjects.map((c) => `    - command: "${c.command}"\n      args: [${c.args.map((a) => `"${a}"`).join(', ')}]`).join('\n')
    : '    - command: "node"\n      args: ["-e", "process.exit(0)"]';

  const tasksFilePath = join(tmpDir, 'tasks.yaml');
  writeFileSync(
    tasksFilePath,
    `tasks:
  - id: ${taskId}
    title: "Run AI test"
    repo_path: "${repoPath.replace(/\\/g, '/')}"
    base_branch: "main"
    work_branch: "ai/${taskId}"
    goal: "Test goal"
    context_files: []
    checks:
${checkLines}
    guardrails:
      deny_modify:
        - ".env"
        - ".env.*"
        - "node_modules/**"
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
    originPath,
    runsDir,
    cleanup: () => {
      rmSync(tmpDir, { recursive: true, force: true });
    },
  };
}

function createTempEnvNoCommit(): {
  taskId: string;
  tasksFilePath: string;
  repoPath: string;
  originPath: string;
  runsDir: string;
  cleanup: () => void;
} {
  const id = `${Date.now()}-${counter++}`;
  const taskId = `rai-r-nc-${id}`;
  const tmpBase = join(process.cwd(), 'tmp');
  if (!existsSync(tmpBase)) {
    mkdirSync(tmpBase);
  }
  const tmpDir = mkdtempSync(join(tmpBase, `rai-r-nc-${id}-`));
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

  const tasksFilePath = join(tmpDir, 'tasks.yaml');
  writeFileSync(
    tasksFilePath,
    `tasks:
  - id: ${taskId}
    title: "Run AI test"
    repo_path: "${repoPath.replace(/\\/g, '/')}"
    base_branch: "main"
    work_branch: "ai/${taskId}"
    goal: "Test goal"
    context_files: []
    checks:
    - command: "node"
      args: ["-e", "process.exit(0)"]
    guardrails:
      deny_modify:
        - ".env"
        - ".env.*"
        - "node_modules/**"
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
    originPath,
    runsDir,
    cleanup: () => {
      rmSync(tmpDir, { recursive: true, force: true });
    },
  };
}

function createTempEnvNoOrigin(): {
  taskId: string;
  tasksFilePath: string;
  repoPath: string;
  runsDir: string;
  cleanup: () => void;
} {
  const id = `${Date.now()}-${counter++}`;
  const taskId = `rai-r-no-${id}`;
  const tmpBase = join(process.cwd(), 'tmp');
  if (!existsSync(tmpBase)) {
    mkdirSync(tmpBase);
  }
  const tmpDir = mkdtempSync(join(tmpBase, `rai-r-no-${id}-`));
  const repoPath = join(tmpDir, 'repo');
  const runsDir = join(tmpDir, 'runs');
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
    title: "Run AI test"
    repo_path: "${repoPath.replace(/\\/g, '/')}"
    base_branch: "main"
    work_branch: "ai/${taskId}"
    goal: "Test goal"
    context_files: []
    checks:
    - command: "node"
      args: ["-e", "process.exit(0)"]
    guardrails:
      deny_modify:
        - ".env"
        - ".env.*"
        - "node_modules/**"
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
    runsDir,
    cleanup: () => {
      rmSync(tmpDir, { recursive: true, force: true });
    },
  };
}

function getCurrentBranch(repoPath: string): string {
  const result = spawnSync('git', ['branch', '--show-current'], {
    cwd: repoPath,
    encoding: 'utf-8',
    shell: false,
  });
  return result.stdout.trim();
}

function getBareRefs(originPath: string): string[] {
  const result = spawnSync('git', ['--git-dir', originPath, 'show-ref'], {
    encoding: 'utf-8',
    shell: false,
  });
  return result.stdout.trim().split('\n').filter((l) => l.length > 0);
}

function getGitPorcelain(repoPath: string): string {
  const result = spawnSync('git', ['status', '--porcelain', '--untracked-files=all'], {
    cwd: repoPath,
    encoding: 'utf-8',
    shell: false,
  });
  return result.stdout.trim();
}

function getGitLogCount(repoPath: string): number {
  const result = spawnSync('git', ['log', '--oneline'], {
    cwd: repoPath,
    encoding: 'utf-8',
    shell: false,
  });
  return result.stdout.trim().split('\n').filter((l) => l.length > 0).length;
}

function loadStateFromPath(runsDir: string, taskId: string): unknown {
  const statePath = join(runsDir, taskId, 'state.json');
  if (!existsSync(statePath)) {
    return null;
  }
  return JSON.parse(readFileSync(statePath, 'utf-8'));
}

describe('cli real-repo-run-ai-readiness', () => {
  test('missing taskId refuses', () => {
    const result = runCli(['real-repo-run-ai-readiness']);
    assert.notStrictEqual(result.status, 0);
    assert(result.stderr.includes('task id is required'), `Expected task id required: ${result.stderr}`);
  });

  test('missing taskId prints No provider call was made', () => {
    const result = runCli(['real-repo-run-ai-readiness']);
    assert.notStrictEqual(result.status, 0);
    assert(result.stderr.includes('No provider call was made'), `Expected no provider call: ${result.stderr}`);
  });

  test('missing ALLOW_REAL_PROVIDER refuses', () => {
    const { taskId, tasksFilePath, cleanup } = createTempEnv();
    try {
      const result = runCli(['real-repo-run-ai-readiness', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_REPO_APPLY: 'true',
        ALLOW_REAL_REPO_COMMIT: 'true',
        ALLOW_REAL_REPO_PUSH: 'true',
      });
      assert.notStrictEqual(result.status, 0);
      assert(result.stderr.includes('ALLOW_REAL_PROVIDER=true is required'), `Expected provider opt-in: ${result.stderr}`);
    } finally {
      cleanup();
    }
  });

  test('missing ALLOW_REAL_REPO_APPLY refuses', () => {
    const { taskId, tasksFilePath, cleanup } = createTempEnv();
    try {
      const result = runCli(['real-repo-run-ai-readiness', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_PROVIDER: 'true',
        ALLOW_REAL_REPO_COMMIT: 'true',
        ALLOW_REAL_REPO_PUSH: 'true',
      });
      assert.notStrictEqual(result.status, 0);
      assert(result.stderr.includes('ALLOW_REAL_REPO_APPLY=true is required'), `Expected apply opt-in: ${result.stderr}`);
    } finally {
      cleanup();
    }
  });

  test('missing ALLOW_REAL_REPO_COMMIT refuses', () => {
    const { taskId, tasksFilePath, cleanup } = createTempEnv();
    try {
      const result = runCli(['real-repo-run-ai-readiness', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_PROVIDER: 'true',
        ALLOW_REAL_REPO_APPLY: 'true',
        ALLOW_REAL_REPO_PUSH: 'true',
      });
      assert.notStrictEqual(result.status, 0);
      assert(result.stderr.includes('ALLOW_REAL_REPO_COMMIT=true is required'), `Expected commit opt-in: ${result.stderr}`);
    } finally {
      cleanup();
    }
  });

  test('missing ALLOW_REAL_REPO_PUSH refuses', () => {
    const { taskId, tasksFilePath, cleanup } = createTempEnv();
    try {
      const result = runCli(['real-repo-run-ai-readiness', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_PROVIDER: 'true',
        ALLOW_REAL_REPO_APPLY: 'true',
        ALLOW_REAL_REPO_COMMIT: 'true',
      });
      assert.notStrictEqual(result.status, 0);
      assert(result.stderr.includes('ALLOW_REAL_REPO_PUSH=true is required'), `Expected push opt-in: ${result.stderr}`);
    } finally {
      cleanup();
    }
  });

  test('missing provider API key refuses safely', () => {
    const { taskId, tasksFilePath, cleanup } = createTempEnv();
    try {
      const result = runCli(['real-repo-run-ai-readiness', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_PROVIDER: 'true',
        ALLOW_REAL_REPO_APPLY: 'true',
        ALLOW_REAL_REPO_COMMIT: 'true',
        ALLOW_REAL_REPO_PUSH: 'true',
        KIMI_BASE_URL: 'http://localhost:9999',
      });
      assert.notStrictEqual(result.status, 0);
      assert(result.stderr.includes('KIMI_API_KEY'), `Expected API key required: ${result.stderr}`);
    } finally {
      cleanup();
    }
  });

  test('missing provider base URL refuses safely', () => {
    const { taskId, tasksFilePath, cleanup } = createTempEnv();
    try {
      const result = runCli(['real-repo-run-ai-readiness', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_PROVIDER: 'true',
        ALLOW_REAL_REPO_APPLY: 'true',
        ALLOW_REAL_REPO_COMMIT: 'true',
        ALLOW_REAL_REPO_PUSH: 'true',
        KIMI_API_KEY: 'fake',
      });
      assert.notStrictEqual(result.status, 0);
      assert(result.stderr.includes('KIMI_BASE_URL'), `Expected base URL required: ${result.stderr}`);
    } finally {
      cleanup();
    }
  });

  test('fake API key is not printed', () => {
    const { taskId, tasksFilePath, cleanup } = createTempEnv();
    try {
      const result = runCli(['real-repo-run-ai-readiness', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_PROVIDER: 'true',
        ALLOW_REAL_REPO_APPLY: 'true',
        ALLOW_REAL_REPO_COMMIT: 'true',
        ALLOW_REAL_REPO_PUSH: 'true',
        KIMI_API_KEY: 'sk-fake-readiness',
        KIMI_BASE_URL: 'http://localhost:9999',
      });
      assert(!result.stderr.includes('sk-fake'), `Should not leak API key: ${result.stderr}`);
      assert(!result.stdout.includes('sk-fake'), `Should not leak API key in stdout: ${result.stdout}`);
    } finally {
      cleanup();
    }
  });

  test('missing task refuses safely', () => {
    const { tasksFilePath, cleanup } = createTempEnv();
    try {
      const result = runCli(['real-repo-run-ai-readiness', 'nonexistent-task'], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_PROVIDER: 'true',
        ALLOW_REAL_REPO_APPLY: 'true',
        ALLOW_REAL_REPO_COMMIT: 'true',
        ALLOW_REAL_REPO_PUSH: 'true',
        KIMI_API_KEY: 'fake',
        KIMI_BASE_URL: 'http://localhost:9999',
      });
      assert.notStrictEqual(result.status, 0);
      assert(result.stderr.includes('not found') || result.stderr.includes('Error'), `Expected task not found: ${result.stderr}`);
    } finally {
      cleanup();
    }
  });

  test('missing repo_path refuses safely', () => {
    const { taskId, tasksFilePath, cleanup } = createTempEnv();
    try {
      const content = readFileSync(tasksFilePath, 'utf-8');
      writeFileSync(tasksFilePath, content.replace(/repo_path: "[^"]+"/, 'repo_path: "/nonexistent/path"'), 'utf-8');
      const result = runCli(['real-repo-run-ai-readiness', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_PROVIDER: 'true',
        ALLOW_REAL_REPO_APPLY: 'true',
        ALLOW_REAL_REPO_COMMIT: 'true',
        ALLOW_REAL_REPO_PUSH: 'true',
        KIMI_API_KEY: 'fake',
        KIMI_BASE_URL: 'http://localhost:9999',
      });
      assert.notStrictEqual(result.status, 0);
      assert(result.stderr.includes('repo_path'), `Expected repo_path error: ${result.stderr}`);
    } finally {
      cleanup();
    }
  });

  test('work_branch main refuses', () => {
    const { taskId, tasksFilePath, cleanup } = createTempEnv();
    try {
      const content = readFileSync(tasksFilePath, 'utf-8');
      writeFileSync(tasksFilePath, content.replace(`work_branch: "ai/${taskId}"`, 'work_branch: "main"'), 'utf-8');
      const result = runCli(['real-repo-run-ai-readiness', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_PROVIDER: 'true',
        ALLOW_REAL_REPO_APPLY: 'true',
        ALLOW_REAL_REPO_COMMIT: 'true',
        ALLOW_REAL_REPO_PUSH: 'true',
        KIMI_API_KEY: 'fake',
        KIMI_BASE_URL: 'http://localhost:9999',
      });
      assert.notStrictEqual(result.status, 0);
      assert(result.stderr.includes('work_branch is main'), `Expected work_branch main: ${result.stderr}`);
    } finally {
      cleanup();
    }
  });

  test('current branch main refuses', () => {
    const { taskId, tasksFilePath, repoPath, cleanup } = createTempEnv();
    try {
      spawnSync('git', ['checkout', 'main'], { cwd: repoPath, encoding: 'utf-8', shell: false });
      const result = runCli(['real-repo-run-ai-readiness', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_PROVIDER: 'true',
        ALLOW_REAL_REPO_APPLY: 'true',
        ALLOW_REAL_REPO_COMMIT: 'true',
        ALLOW_REAL_REPO_PUSH: 'true',
        KIMI_API_KEY: 'fake',
        KIMI_BASE_URL: 'http://localhost:9999',
      });
      assert.notStrictEqual(result.status, 0);
      assert(result.stderr.includes('Current branch is main'), `Expected current branch main: ${result.stderr}`);
    } finally {
      cleanup();
    }
  });

  test('branch mismatch refuses', () => {
    const { taskId, tasksFilePath, repoPath, cleanup } = createTempEnv();
    try {
      spawnSync('git', ['checkout', '-b', 'other-branch'], { cwd: repoPath, encoding: 'utf-8', shell: false });
      const result = runCli(['real-repo-run-ai-readiness', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_PROVIDER: 'true',
        ALLOW_REAL_REPO_APPLY: 'true',
        ALLOW_REAL_REPO_COMMIT: 'true',
        ALLOW_REAL_REPO_PUSH: 'true',
        KIMI_API_KEY: 'fake',
        KIMI_BASE_URL: 'http://localhost:9999',
      });
      assert.notStrictEqual(result.status, 0);
      assert(result.stderr.includes('Branch mismatch'), `Expected branch mismatch: ${result.stderr}`);
    } finally {
      cleanup();
    }
  });

  test('dirty working tree refuses', () => {
    const { taskId, tasksFilePath, repoPath, cleanup } = createTempEnv();
    try {
      writeFileSync(join(repoPath, 'dirty.txt'), 'dirty\n', 'utf-8');
      const result = runCli(['real-repo-run-ai-readiness', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_PROVIDER: 'true',
        ALLOW_REAL_REPO_APPLY: 'true',
        ALLOW_REAL_REPO_COMMIT: 'true',
        ALLOW_REAL_REPO_PUSH: 'true',
        KIMI_API_KEY: 'fake',
        KIMI_BASE_URL: 'http://localhost:9999',
      });
      assert.notStrictEqual(result.status, 0);
      assert(result.stderr.includes('Working tree is not clean'), `Expected dirty tree: ${result.stderr}`);
    } finally {
      cleanup();
    }
  });

  test('untracked file refuses', () => {
    const { taskId, tasksFilePath, repoPath, cleanup } = createTempEnv();
    try {
      writeFileSync(join(repoPath, 'untracked.txt'), 'untracked\n', 'utf-8');
      const result = runCli(['real-repo-run-ai-readiness', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_PROVIDER: 'true',
        ALLOW_REAL_REPO_APPLY: 'true',
        ALLOW_REAL_REPO_COMMIT: 'true',
        ALLOW_REAL_REPO_PUSH: 'true',
        KIMI_API_KEY: 'fake',
        KIMI_BASE_URL: 'http://localhost:9999',
      });
      assert.notStrictEqual(result.status, 0);
      assert(result.stderr.includes('Working tree is not clean'), `Expected untracked refusal: ${result.stderr}`);
    } finally {
      cleanup();
    }
  });

  test('staged file refuses', () => {
    const { taskId, tasksFilePath, repoPath, cleanup } = createTempEnv();
    try {
      writeFileSync(join(repoPath, 'staged.txt'), 'staged\n', 'utf-8');
      spawnSync('git', ['add', 'staged.txt'], { cwd: repoPath, encoding: 'utf-8', shell: false });
      const result = runCli(['real-repo-run-ai-readiness', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_PROVIDER: 'true',
        ALLOW_REAL_REPO_APPLY: 'true',
        ALLOW_REAL_REPO_COMMIT: 'true',
        ALLOW_REAL_REPO_PUSH: 'true',
        KIMI_API_KEY: 'fake',
        KIMI_BASE_URL: 'http://localhost:9999',
      });
      assert.notStrictEqual(result.status, 0);
      assert(result.stderr.includes('Working tree is not clean'), `Expected staged refusal: ${result.stderr}`);
    } finally {
      cleanup();
    }
  });

  test('missing HEAD refuses', () => {
    const { taskId, tasksFilePath, cleanup } = createTempEnvNoCommit();
    try {
      const result = runCli(['real-repo-run-ai-readiness', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_PROVIDER: 'true',
        ALLOW_REAL_REPO_APPLY: 'true',
        ALLOW_REAL_REPO_COMMIT: 'true',
        ALLOW_REAL_REPO_PUSH: 'true',
        KIMI_API_KEY: 'fake',
        KIMI_BASE_URL: 'http://localhost:9999',
      });
      assert.notStrictEqual(result.status, 0);
      assert(
        result.stderr.includes('No local HEAD commit exists') ||
        result.stderr.includes('Current branch is missing or detached HEAD') ||
        result.stderr.includes('ambiguous argument \'HEAD\''),
        `Expected missing HEAD or detached HEAD: ${result.stderr}`
      );
    } finally {
      cleanup();
    }
  });

  test('missing origin remote refuses', () => {
    const { taskId, tasksFilePath, cleanup } = createTempEnvNoOrigin();
    try {
      const result = runCli(['real-repo-run-ai-readiness', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_PROVIDER: 'true',
        ALLOW_REAL_REPO_APPLY: 'true',
        ALLOW_REAL_REPO_COMMIT: 'true',
        ALLOW_REAL_REPO_PUSH: 'true',
        KIMI_API_KEY: 'fake',
        KIMI_BASE_URL: 'http://localhost:9999',
      });
      assert.notStrictEqual(result.status, 0);
      assert(result.stderr.includes('Remote origin does not exist'), `Expected missing origin: ${result.stderr}`);
    } finally {
      cleanup();
    }
  });

  test('valid repo + env passes readiness', () => {
    const { taskId, tasksFilePath, cleanup } = createTempEnv();
    try {
      const result = runCli(['real-repo-run-ai-readiness', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_PROVIDER: 'true',
        ALLOW_REAL_REPO_APPLY: 'true',
        ALLOW_REAL_REPO_COMMIT: 'true',
        ALLOW_REAL_REPO_PUSH: 'true',
        KIMI_API_KEY: 'fake',
        KIMI_BASE_URL: 'http://localhost:9999',
      });
      assert.strictEqual(result.status, 0, `Expected success: ${result.stderr}`);
      assert(result.stderr.includes('Readiness check passed'), `Expected passed: ${result.stderr}`);
    } finally {
      cleanup();
    }
  });

  test('success output says provider call not performed', () => {
    const { taskId, tasksFilePath, cleanup } = createTempEnv();
    try {
      const result = runCli(['real-repo-run-ai-readiness', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_PROVIDER: 'true',
        ALLOW_REAL_REPO_APPLY: 'true',
        ALLOW_REAL_REPO_COMMIT: 'true',
        ALLOW_REAL_REPO_PUSH: 'true',
        KIMI_API_KEY: 'fake',
        KIMI_BASE_URL: 'http://localhost:9999',
      });
      assert.strictEqual(result.status, 0, `Expected success: ${result.stderr}`);
      assert(result.stderr.includes('Provider call: not performed'), `Expected provider call not performed: ${result.stderr}`);
    } finally {
      cleanup();
    }
  });

  test('success output says apply not performed', () => {
    const { taskId, tasksFilePath, cleanup } = createTempEnv();
    try {
      const result = runCli(['real-repo-run-ai-readiness', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_PROVIDER: 'true',
        ALLOW_REAL_REPO_APPLY: 'true',
        ALLOW_REAL_REPO_COMMIT: 'true',
        ALLOW_REAL_REPO_PUSH: 'true',
        KIMI_API_KEY: 'fake',
        KIMI_BASE_URL: 'http://localhost:9999',
      });
      assert.strictEqual(result.status, 0, `Expected success: ${result.stderr}`);
      assert(result.stderr.includes('Apply: not performed'), `Expected apply not performed: ${result.stderr}`);
    } finally {
      cleanup();
    }
  });

  test('success output says commit not performed', () => {
    const { taskId, tasksFilePath, cleanup } = createTempEnv();
    try {
      const result = runCli(['real-repo-run-ai-readiness', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_PROVIDER: 'true',
        ALLOW_REAL_REPO_APPLY: 'true',
        ALLOW_REAL_REPO_COMMIT: 'true',
        ALLOW_REAL_REPO_PUSH: 'true',
        KIMI_API_KEY: 'fake',
        KIMI_BASE_URL: 'http://localhost:9999',
      });
      assert.strictEqual(result.status, 0, `Expected success: ${result.stderr}`);
      assert(result.stderr.includes('Commit: not performed'), `Expected commit not performed: ${result.stderr}`);
    } finally {
      cleanup();
    }
  });

  test('success output says push not performed', () => {
    const { taskId, tasksFilePath, cleanup } = createTempEnv();
    try {
      const result = runCli(['real-repo-run-ai-readiness', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_PROVIDER: 'true',
        ALLOW_REAL_REPO_APPLY: 'true',
        ALLOW_REAL_REPO_COMMIT: 'true',
        ALLOW_REAL_REPO_PUSH: 'true',
        KIMI_API_KEY: 'fake',
        KIMI_BASE_URL: 'http://localhost:9999',
      });
      assert.strictEqual(result.status, 0, `Expected success: ${result.stderr}`);
      assert(result.stderr.includes('Push: not performed'), `Expected push not performed: ${result.stderr}`);
    } finally {
      cleanup();
    }
  });

  test('readiness does not modify files', () => {
    const { taskId, tasksFilePath, repoPath, cleanup } = createTempEnv();
    try {
      const before = getGitPorcelain(repoPath);
      runCli(['real-repo-run-ai-readiness', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_PROVIDER: 'true',
        ALLOW_REAL_REPO_APPLY: 'true',
        ALLOW_REAL_REPO_COMMIT: 'true',
        ALLOW_REAL_REPO_PUSH: 'true',
        KIMI_API_KEY: 'fake',
        KIMI_BASE_URL: 'http://localhost:9999',
      });
      const after = getGitPorcelain(repoPath);
      assert.strictEqual(after, before, `Working tree should not change`);
    } finally {
      cleanup();
    }
  });

  test('readiness does not create commit', () => {
    const { taskId, tasksFilePath, repoPath, cleanup } = createTempEnv();
    try {
      const before = getGitLogCount(repoPath);
      runCli(['real-repo-run-ai-readiness', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_PROVIDER: 'true',
        ALLOW_REAL_REPO_APPLY: 'true',
        ALLOW_REAL_REPO_COMMIT: 'true',
        ALLOW_REAL_REPO_PUSH: 'true',
        KIMI_API_KEY: 'fake',
        KIMI_BASE_URL: 'http://localhost:9999',
      });
      const after = getGitLogCount(repoPath);
      assert.strictEqual(after, before, `No commit should be created`);
    } finally {
      cleanup();
    }
  });

  test('readiness does not push to local bare remote', () => {
    const { taskId, tasksFilePath, originPath, cleanup } = createTempEnv();
    try {
      const before = getBareRefs(originPath);
      runCli(['real-repo-run-ai-readiness', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_PROVIDER: 'true',
        ALLOW_REAL_REPO_APPLY: 'true',
        ALLOW_REAL_REPO_COMMIT: 'true',
        ALLOW_REAL_REPO_PUSH: 'true',
        KIMI_API_KEY: 'fake',
        KIMI_BASE_URL: 'http://localhost:9999',
      });
      const after = getBareRefs(originPath);
      assert.deepStrictEqual(after, before, `Remote should not change`);
    } finally {
      cleanup();
    }
  });

  test('readiness does not write state', () => {
    const { taskId, tasksFilePath, runsDir, cleanup } = createTempEnv();
    try {
      runCli(['real-repo-run-ai-readiness', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_PROVIDER: 'true',
        ALLOW_REAL_REPO_APPLY: 'true',
        ALLOW_REAL_REPO_COMMIT: 'true',
        ALLOW_REAL_REPO_PUSH: 'true',
        KIMI_API_KEY: 'fake',
        KIMI_BASE_URL: 'http://localhost:9999',
        RUNS_DIR: runsDir,
      });
      assert.strictEqual(loadStateFromPath(runsDir, taskId), null, `No state should be written`);
    } finally {
      cleanup();
    }
  });

  test('readiness does not checkout/switch branch', () => {
    const { taskId, tasksFilePath, repoPath, cleanup } = createTempEnv();
    try {
      const before = getCurrentBranch(repoPath);
      runCli(['real-repo-run-ai-readiness', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_PROVIDER: 'true',
        ALLOW_REAL_REPO_APPLY: 'true',
        ALLOW_REAL_REPO_COMMIT: 'true',
        ALLOW_REAL_REPO_PUSH: 'true',
        KIMI_API_KEY: 'fake',
        KIMI_BASE_URL: 'http://localhost:9999',
      });
      const after = getCurrentBranch(repoPath);
      assert.strictEqual(after, before, `Branch should not change`);
    } finally {
      cleanup();
    }
  });

  test('readiness does not touch main', () => {
    const { taskId, tasksFilePath, repoPath, cleanup } = createTempEnv();
    try {
      const result = runCli(['real-repo-run-ai-readiness', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_PROVIDER: 'true',
        ALLOW_REAL_REPO_APPLY: 'true',
        ALLOW_REAL_REPO_COMMIT: 'true',
        ALLOW_REAL_REPO_PUSH: 'true',
        KIMI_API_KEY: 'fake',
        KIMI_BASE_URL: 'http://localhost:9999',
      });
      assert.strictEqual(result.status, 0, `Expected success: ${result.stderr}`);
      assert(!result.stderr.includes('main'), `Should not touch main in success: ${result.stderr}`);
    } finally {
      cleanup();
    }
  });

  test('no stack trace in failure paths', () => {
    const { taskId, tasksFilePath, cleanup } = createTempEnv();
    try {
      const result = runCli(['real-repo-run-ai-readiness', taskId], {
        TASKS_FILE: tasksFilePath,
      });
      assert.notStrictEqual(result.status, 0);
      assert(!result.stderr.includes('at '), `Should not contain stack trace: ${result.stderr}`);
    } finally {
      cleanup();
    }
  });

  test('existing real-repo-run-ai behavior unchanged', () => {
    const { taskId, tasksFilePath, cleanup } = createTempEnv();
    try {
      const result = runCli(['real-repo-run-ai', taskId], {
        TASKS_FILE: tasksFilePath,
        ALLOW_REAL_PROVIDER: 'true',
        ALLOW_REAL_REPO_APPLY: 'true',
        ALLOW_REAL_REPO_COMMIT: 'true',
        ALLOW_REAL_REPO_PUSH: 'true',
        KIMI_API_KEY: 'fake',
        KIMI_BASE_URL: 'http://localhost:9999',
        KIMI_FAKE_RESPONSE: JSON.stringify({ mode: 'file_update', files: [{ path: 'README.md', content: '# modified\n' }] }),
      });
      assert.strictEqual(result.status, 0, `Expected success: ${result.stderr}`);
    } finally {
      cleanup();
    }
  });
});
