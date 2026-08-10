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
  for (const key of Object.keys(env)) {
    if (/^(REAL_REPO_|REAL_BLOCK_|KIMI_|MOCK_|ALLOW_|SANDBOX_|OPENAI_|TASKS_FILE|RUNS_DIR|NODE_TEST_CONTEXT)/.test(key)) {
      delete env[key];
    }
  }
  env.AI_PROVIDER = 'mock';
  return env;
}

function runCli(args: string[], envOverrides: Record<string, string> = {}) {
  const env = { ...getCleanEnv(), ...envOverrides };
  const result = spawnSync(
    `npx tsx "${join(process.cwd(), 'src', 'cli.ts')}" ${args.join(' ')}`,
    { cwd: process.cwd(), env, encoding: 'utf-8', shell: true, timeout: 30000 }
  );
  return { status: result.status ?? 1, stdout: result.stdout || '', stderr: result.stderr || '' };
}

function createTempEnv() {
  const id = `${Date.now()}-${counter++}`;
  const taskId = `ucf-${id}`;
  const tmpBase = join(process.cwd(), 'tmp');
  if (!existsSync(tmpBase)) mkdirSync(tmpBase);
  const tmpDir = mkdtempSync(join(tmpBase, `ucf-${id}-`));
  const repoPath = join(tmpDir, 'repo');
  mkdirSync(repoPath);
  writeFileSync(join(repoPath, 'README.md'), '# hello\n', 'utf-8');
  spawnSync('git', ['init'], { cwd: repoPath, shell: false, encoding: 'utf-8' });
  spawnSync('git', ['config', 'user.email', 'ci@example.com'], { cwd: repoPath, shell: false, encoding: 'utf-8' });
  spawnSync('git', ['config', 'user.name', 'CI User'], { cwd: repoPath, shell: false, encoding: 'utf-8' });
  spawnSync('git', ['add', '.'], { cwd: repoPath, shell: false, encoding: 'utf-8' });
  spawnSync('git', ['commit', '-m', 'init', '--no-gpg-sign'], { cwd: repoPath, shell: false, encoding: 'utf-8' });
  spawnSync('git', ['branch', '-m', 'main'], { cwd: repoPath, shell: false, encoding: 'utf-8' });
  spawnSync('git', ['checkout', '-b', `ai/${taskId}`], { cwd: repoPath, shell: false, encoding: 'utf-8' });

  const tasksFilePath = join(tmpDir, 'tasks.yaml');
  writeFileSync(
    tasksFilePath,
    `tasks:
  - id: ${taskId}
    title: "Unauthorized candidate file test"
    repo_path: "${repoPath.replace(/\\/g, '/')}"
    base_branch: "main"
    work_branch: "ai/${taskId}"
    goal: "Only README may be modified"
    context_files: []
    checks:
      - command: "node"
        args: ["-e", "process.exit(0)"]
    guardrails:
      allow_modify:
        - "README.md"
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
  return { taskId, tasksFilePath, repoPath, cleanup: () => rmSync(tmpDir, { recursive: true, force: true }) };
}

function buildFakeKimiOutput(files: Array<{ path: string; content: string }>): string {
  return JSON.stringify({ mode: 'file_update', files, notes: '' });
}

describe('unauthorized candidate file', () => {
  test('a file outside allow_modify is rejected before commit', () => {
    const { taskId, tasksFilePath, repoPath, cleanup } = createTempEnv();
    try {
      const result = runCli(['real-repo-run-ai', taskId], {
        TASKS_FILE: tasksFilePath,
        RUNS_DIR: 'tmp/runs',
        ALLOW_REAL_PROVIDER: 'true',
        ALLOW_REAL_REPO_APPLY: 'true',
        ALLOW_REAL_REPO_COMMIT: 'true',
        ALLOW_REAL_REPO_PUSH: 'true',
        KIMI_API_KEY: 'fake',
        KIMI_BASE_URL: 'http://localhost:9999',
        KIMI_FAKE_RESPONSE: buildFakeKimiOutput([
          { path: 'README.md', content: '# modified\n' },
          { path: 'unauthorized.txt', content: 'x\n' },
        ]),
      });
      assert.notStrictEqual(result.status, 0, `Expected failure: ${result.stderr}`);
      assert(result.stderr.includes('Guardrails failed'), `Expected guardrails failure: ${result.stderr}`);
      assert(result.stderr.includes('outside allow_modify'), `Expected allow_modify reason: ${result.stderr}`);
      const content = readFileSync(join(repoPath, 'README.md'), 'utf-8');
      assert.strictEqual(content, '# hello\n', 'main repo should not be modified');
    } finally {
      cleanup();
    }
  });
});
