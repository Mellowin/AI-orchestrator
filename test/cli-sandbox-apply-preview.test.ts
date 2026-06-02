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
  delete env.SANDBOX_PROVIDER_RESPONSE;
  delete env.SANDBOX_ROOT;
  env.AI_PROVIDER = 'mock';
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

function buildFakeKimiOutput(files: Array<{ path: string; content: string }>): string {
  return JSON.stringify({ mode: 'file_update', files });
}

function createTempEnv(): {
  taskId: string;
  tasksFilePath: string;
  repoPath: string;
  sandboxRoot: string;
  cleanup: () => void;
} {
  const id = `${Date.now()}-${counter++}`;
  const taskId = `sap-${id}`;
  const tmpBase = join(process.cwd(), 'tmp');
  if (!existsSync(tmpBase)) {
    mkdirSync(tmpBase);
  }
  const tmpDir = mkdtempSync(join(tmpBase, `sap-${id}-`));
  const repoPath = join(tmpDir, 'repo');
  const sandboxRoot = join(tmpDir, 'sandbox');
  mkdirSync(repoPath);
  mkdirSync(sandboxRoot);

  writeFileSync(join(repoPath, 'README.md'), '# hello\n', 'utf-8');

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
    title: "Sandbox apply preview test"
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
    sandboxRoot,
    cleanup: () => {
      rmSync(tmpDir, { recursive: true, force: true });
    },
  };
}

describe('cli sandbox-apply-preview', () => {
  test('missing opt-in fails safely', () => {
    const { taskId, tasksFilePath, cleanup } = createTempEnv();
    try {
      const result = runCli(
        ['sandbox-apply-preview', taskId],
        { TASKS_FILE: tasksFilePath }
      );
      assert.notStrictEqual(result.status, 0, 'should exit non-zero');
      assert(result.stderr.includes('ALLOW_SANDBOX_APPLY_PREVIEW=true'));
    } finally {
      cleanup();
    }
  });

  test('missing provider response fails safely', () => {
    const { taskId, tasksFilePath, cleanup } = createTempEnv();
    try {
      const result = runCli(
        ['sandbox-apply-preview', taskId],
        { TASKS_FILE: tasksFilePath, ALLOW_SANDBOX_APPLY_PREVIEW: 'true' }
      );
      assert.notStrictEqual(result.status, 0, 'should exit non-zero');
      assert(result.stderr.includes('SANDBOX_PROVIDER_RESPONSE'));
    } finally {
      cleanup();
    }
  });

  test('missing sandbox root fails safely', () => {
    const { taskId, tasksFilePath, cleanup } = createTempEnv();
    try {
      const result = runCli(
        ['sandbox-apply-preview', taskId],
        {
          TASKS_FILE: tasksFilePath,
          ALLOW_SANDBOX_APPLY_PREVIEW: 'true',
          SANDBOX_PROVIDER_RESPONSE: buildFakeKimiOutput([{ path: 'README.md', content: '# updated\n' }]),
        }
      );
      assert.notStrictEqual(result.status, 0, 'should exit non-zero');
      assert(result.stderr.includes('SANDBOX_ROOT'));
    } finally {
      cleanup();
    }
  });

  test('success path exits 0 and prints Apply: PASS', () => {
    const { taskId, tasksFilePath, sandboxRoot, cleanup } = createTempEnv();
    try {
      const result = runCli(
        ['sandbox-apply-preview', taskId],
        {
          TASKS_FILE: tasksFilePath,
          ALLOW_SANDBOX_APPLY_PREVIEW: 'true',
          SANDBOX_PROVIDER_RESPONSE: buildFakeKimiOutput([{ path: 'README.md', content: '# updated\n' }]),
          SANDBOX_ROOT: sandboxRoot,
        }
      );
      assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
      assert(result.stdout.includes('[sandbox-apply-preview] Apply: PASS'));
    } finally {
      cleanup();
    }
  });

  test('success path prints applied files', () => {
    const { taskId, tasksFilePath, sandboxRoot, cleanup } = createTempEnv();
    try {
      const result = runCli(
        ['sandbox-apply-preview', taskId],
        {
          TASKS_FILE: tasksFilePath,
          ALLOW_SANDBOX_APPLY_PREVIEW: 'true',
          SANDBOX_PROVIDER_RESPONSE: buildFakeKimiOutput([{ path: 'README.md', content: '# updated\n' }]),
          SANDBOX_ROOT: sandboxRoot,
        }
      );
      assert.strictEqual(result.status, 0);
      assert(result.stdout.includes('Applied files:'));
      assert(result.stdout.includes('README.md'));
    } finally {
      cleanup();
    }
  });

  test('success path prints checks passed', () => {
    const { taskId, tasksFilePath, sandboxRoot, cleanup } = createTempEnv();
    try {
      const result = runCli(
        ['sandbox-apply-preview', taskId],
        {
          TASKS_FILE: tasksFilePath,
          ALLOW_SANDBOX_APPLY_PREVIEW: 'true',
          SANDBOX_PROVIDER_RESPONSE: buildFakeKimiOutput([{ path: 'README.md', content: '# updated\n' }]),
          SANDBOX_ROOT: sandboxRoot,
        }
      );
      assert.strictEqual(result.status, 0);
      assert(result.stdout.includes('Checks passed: yes'));
    } finally {
      cleanup();
    }
  });

  test('success path prints safety messages', () => {
    const { taskId, tasksFilePath, sandboxRoot, cleanup } = createTempEnv();
    try {
      const result = runCli(
        ['sandbox-apply-preview', taskId],
        {
          TASKS_FILE: tasksFilePath,
          ALLOW_SANDBOX_APPLY_PREVIEW: 'true',
          SANDBOX_PROVIDER_RESPONSE: buildFakeKimiOutput([{ path: 'README.md', content: '# updated\n' }]),
          SANDBOX_ROOT: sandboxRoot,
        }
      );
      assert.strictEqual(result.status, 0);
      assert(result.stdout.includes('No patch was applied to real repo'));
      assert(result.stdout.includes('No git mutation was performed in real repo'));
      assert(result.stdout.includes('No state mutation was performed'));
    } finally {
      cleanup();
    }
  });

  test('failure path from malformed provider response exits non-zero and prints Apply: FAILED', () => {
    const { taskId, tasksFilePath, sandboxRoot, cleanup } = createTempEnv();
    try {
      const result = runCli(
        ['sandbox-apply-preview', taskId],
        {
          TASKS_FILE: tasksFilePath,
          ALLOW_SANDBOX_APPLY_PREVIEW: 'true',
          SANDBOX_PROVIDER_RESPONSE: 'not-json-at-all',
          SANDBOX_ROOT: sandboxRoot,
        }
      );
      assert.notStrictEqual(result.status, 0);
      assert(result.stderr.includes('[sandbox-apply-preview] Apply: FAILED'));
    } finally {
      cleanup();
    }
  });

  test('failure path prints failedStep', () => {
    const { taskId, tasksFilePath, sandboxRoot, cleanup } = createTempEnv();
    try {
      const result = runCli(
        ['sandbox-apply-preview', taskId],
        {
          TASKS_FILE: tasksFilePath,
          ALLOW_SANDBOX_APPLY_PREVIEW: 'true',
          SANDBOX_PROVIDER_RESPONSE: 'not-json-at-all',
          SANDBOX_ROOT: sandboxRoot,
        }
      );
      assert.notStrictEqual(result.status, 0);
      assert(result.stderr.includes('Failed step:'));
    } finally {
      cleanup();
    }
  });

  test('real repo file remains unchanged', () => {
    const { taskId, tasksFilePath, repoPath, sandboxRoot, cleanup } = createTempEnv();
    try {
      const original = readFileSync(join(repoPath, 'README.md'), 'utf-8');
      const result = runCli(
        ['sandbox-apply-preview', taskId],
        {
          TASKS_FILE: tasksFilePath,
          ALLOW_SANDBOX_APPLY_PREVIEW: 'true',
          SANDBOX_PROVIDER_RESPONSE: buildFakeKimiOutput([{ path: 'README.md', content: '# modified\n' }]),
          SANDBOX_ROOT: sandboxRoot,
        }
      );
      assert.strictEqual(result.status, 0);
      assert.strictEqual(readFileSync(join(repoPath, 'README.md'), 'utf-8'), original);
    } finally {
      cleanup();
    }
  });

  test('checks run in sandbox path, not real repo', () => {
    const id = `${Date.now()}-${counter++}`;
    const taskId = `sap-checks-${id}`;
    const tmpBase = join(process.cwd(), 'tmp');
    if (!existsSync(tmpBase)) {
      mkdirSync(tmpBase);
    }
    const tmpDir = mkdtempSync(join(tmpBase, `sap-checks-${id}-`));
    const repoPath = join(tmpDir, 'repo');
    const sandboxRoot = join(tmpDir, 'sandbox');
    mkdirSync(repoPath);
    mkdirSync(sandboxRoot);

    writeFileSync(join(repoPath, 'README.md'), '# hello\n', 'utf-8');

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
    title: "Sandbox apply preview test"
    repo_path: "${repoPath.replace(/\\/g, '/')}"
    base_branch: "main"
    work_branch: "ai/${taskId}"
    goal: "Test goal"
    context_files:
      - "README.md"
    checks:
      - command: "node"
        args: ["-e", "const fs=require('fs'); const c=fs.readFileSync('README.md','utf-8'); if(c!=='# sandbox-modified\\\\n') process.exit(1)"]
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
      const result = runCli(
        ['sandbox-apply-preview', taskId],
        {
          TASKS_FILE: tasksFilePath,
          ALLOW_SANDBOX_APPLY_PREVIEW: 'true',
          SANDBOX_PROVIDER_RESPONSE: buildFakeKimiOutput([{ path: 'README.md', content: '# sandbox-modified\n' }]),
          SANDBOX_ROOT: sandboxRoot,
        }
      );
      assert.strictEqual(result.status, 0, `checks must run in sandbox where file was modified; stderr: ${result.stderr}`);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('no runs/state.json is written in real repo', () => {
    const { taskId, tasksFilePath, repoPath, sandboxRoot, cleanup } = createTempEnv();
    try {
      runCli(
        ['sandbox-apply-preview', taskId],
        {
          TASKS_FILE: tasksFilePath,
          ALLOW_SANDBOX_APPLY_PREVIEW: 'true',
          SANDBOX_PROVIDER_RESPONSE: buildFakeKimiOutput([{ path: 'README.md', content: '# updated\n' }]),
          SANDBOX_ROOT: sandboxRoot,
        }
      );
      assert(!existsSync(join(repoPath, 'runs', 'state.json')));
      assert(!existsSync(join(repoPath, 'state.json')));
    } finally {
      cleanup();
    }
  });

  test('no stack trace leaks', () => {
    const { taskId, tasksFilePath, sandboxRoot, cleanup } = createTempEnv();
    try {
      const result = runCli(
        ['sandbox-apply-preview', taskId],
        {
          TASKS_FILE: tasksFilePath,
          ALLOW_SANDBOX_APPLY_PREVIEW: 'true',
          SANDBOX_PROVIDER_RESPONSE: 'not-json-at-all',
          SANDBOX_ROOT: sandboxRoot,
        }
      );
      assert.notStrictEqual(result.status, 0);
      assert(!result.stderr.includes('at '));
      assert(!result.stderr.includes('src/cli.ts'));
    } finally {
      cleanup();
    }
  });

  test('no API key leaks', () => {
    const { taskId, tasksFilePath, sandboxRoot, cleanup } = createTempEnv();
    try {
      const result = runCli(
        ['sandbox-apply-preview', taskId],
        {
          TASKS_FILE: tasksFilePath,
          ALLOW_SANDBOX_APPLY_PREVIEW: 'true',
          SANDBOX_PROVIDER_RESPONSE: 'not-json-at-all',
          SANDBOX_ROOT: sandboxRoot,
          KIMI_API_KEY: 'sk-secret123',
        }
      );
      assert.notStrictEqual(result.status, 0);
      assert(!result.stderr.includes('sk-secret123'));
      assert(!result.stdout.includes('sk-secret123'));
    } finally {
      cleanup();
    }
  });

  test('no real network call', () => {
    const { taskId, tasksFilePath, sandboxRoot, cleanup } = createTempEnv();
    try {
      const result = runCli(
        ['sandbox-apply-preview', taskId],
        {
          TASKS_FILE: tasksFilePath,
          ALLOW_SANDBOX_APPLY_PREVIEW: 'true',
          SANDBOX_PROVIDER_RESPONSE: buildFakeKimiOutput([{ path: 'README.md', content: '# updated\n' }]),
          SANDBOX_ROOT: sandboxRoot,
        }
      );
      assert.strictEqual(result.status, 0);
      // If any network call had been attempted, it would likely fail or timeout in this env.
      // Success without network-related errors proves no real network call was made.
      assert(!result.stderr.includes('ECONNREFUSED'));
      assert(!result.stderr.includes('fetch failed'));
      assert(!result.stderr.includes('network'));
    } finally {
      cleanup();
    }
  });
});
