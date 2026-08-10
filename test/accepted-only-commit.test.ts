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
  if (!env.REAL_REPO_REVIEWER_FAKE_RESPONSE && env.ALLOW_REAL_PROVIDER === 'true') {
    env.REAL_REPO_REVIEWER_FAKE_RESPONSE = JSON.stringify({
      decision: 'accept',
      confidence: 'high',
      blockingIssues: [],
      nonBlockingIssues: [],
      reviewSummary: 'Default test acceptance.',
      nextAction: 'continue',
    });
  }
  const result = spawnSync(
    `npx tsx "${join(process.cwd(), 'src', 'cli.ts')}" ${args.join(' ')}`,
    { cwd: process.cwd(), env, encoding: 'utf-8', shell: true, timeout: 30000 }
  );
  return { status: result.status ?? 1, stdout: result.stdout || '', stderr: result.stderr || '' };
}

function createTempEnv() {
  const id = `${Date.now()}-${counter++}`;
  const taskId = `aoc-${id}`;
  const tmpBase = join(process.cwd(), 'tmp');
  if (!existsSync(tmpBase)) mkdirSync(tmpBase);
  const tmpDir = mkdtempSync(join(tmpBase, `aoc-${id}-`));
  const repoPath = join(tmpDir, 'repo');
  const originPath = join(tmpDir, 'origin.git');
  const runsDir = join(tmpDir, 'runs');
  mkdirSync(repoPath);
  writeFileSync(join(repoPath, 'README.md'), '# hello\n', 'utf-8');
  spawnSync('git', ['init'], { cwd: repoPath, shell: false, encoding: 'utf-8' });
  spawnSync('git', ['config', 'user.email', 'ci@example.com'], { cwd: repoPath, shell: false, encoding: 'utf-8' });
  spawnSync('git', ['config', 'user.name', 'CI User'], { cwd: repoPath, shell: false, encoding: 'utf-8' });
  spawnSync('git', ['add', '.'], { cwd: repoPath, shell: false, encoding: 'utf-8' });
  spawnSync('git', ['commit', '-m', 'init', '--no-gpg-sign'], { cwd: repoPath, shell: false, encoding: 'utf-8' });
  spawnSync('git', ['branch', '-m', 'main'], { cwd: repoPath, shell: false, encoding: 'utf-8' });
  spawnSync('git', ['checkout', '-b', `ai/${taskId}`], { cwd: repoPath, shell: false, encoding: 'utf-8' });
  spawnSync('git', ['init', '--bare', originPath], { shell: false, encoding: 'utf-8' });
  spawnSync('git', ['remote', 'add', 'origin', originPath], { cwd: repoPath, shell: false, encoding: 'utf-8' });
  spawnSync('git', ['push', 'origin', 'main'], { cwd: repoPath, shell: false, encoding: 'utf-8' });

  const tasksFilePath = join(tmpDir, 'tasks.yaml');
  writeFileSync(
    tasksFilePath,
    `tasks:
  - id: ${taskId}
    title: "Accepted-only commit test"
    repo_path: "${repoPath.replace(/\\/g, '/')}"
    base_branch: "main"
    work_branch: "ai/${taskId}"
    goal: "Modify README"
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
  return { taskId, tasksFilePath, repoPath, originPath, runsDir, cleanup: () => rmSync(tmpDir, { recursive: true, force: true }) };
}

function getGitLogCount(repoPath: string): number {
  const result = spawnSync('git', ['log', '--oneline'], { cwd: repoPath, shell: false, encoding: 'utf-8' });
  return result.stdout.trim().split('\n').filter((l) => l.length > 0).length;
}

function getLastCommitMessage(repoPath: string): string {
  const result = spawnSync('git', ['log', '-1', '--pretty=%B'], { cwd: repoPath, shell: false, encoding: 'utf-8' });
  return result.stdout.trim();
}

function buildFakeKimiOutput(files: Array<{ path: string; content: string }>): string {
  return JSON.stringify({ mode: 'file_update', files, notes: '' });
}

describe('accepted-only commit', () => {
  test('acceptance creates a commit on the main repo mission branch', () => {
    const { taskId, tasksFilePath, repoPath, cleanup } = createTempEnv();
    try {
      const before = getGitLogCount(repoPath);
      const result = runCli(['real-repo-run-ai', taskId], {
        TASKS_FILE: tasksFilePath,
        RUNS_DIR: 'tmp/runs', // use a neutral directory to avoid collisions
        ALLOW_REAL_PROVIDER: 'true',
        ALLOW_REAL_REPO_APPLY: 'true',
        ALLOW_REAL_REPO_COMMIT: 'true',
        ALLOW_REAL_REPO_PUSH: 'true',
        KIMI_API_KEY: 'fake',
        KIMI_BASE_URL: 'http://localhost:9999',
        KIMI_FAKE_RESPONSE: buildFakeKimiOutput([{ path: 'README.md', content: '# modified\n' }]),
      });
      assert.strictEqual(result.status, 0, `Expected success: ${result.stderr}`);
      assert.strictEqual(getGitLogCount(repoPath), before + 1, 'main repo should gain exactly one commit');
      assert.strictEqual(getLastCommitMessage(repoPath), `ai-orchestrator: ${taskId}`, 'commit message should match task id');
      const content = readFileSync(join(repoPath, 'README.md'), 'utf-8').replace(/\r\n/g, '\n');
      assert.strictEqual(content, '# modified\n', 'README should be updated on main repo');
    } finally {
      cleanup();
    }
  });

  test('reviewer rejection does not create or push a commit', () => {
    const { taskId, tasksFilePath, repoPath, originPath, cleanup } = createTempEnv();
    try {
      const before = getGitLogCount(repoPath);
      const result = runCli(['real-repo-run-ai', taskId], {
        TASKS_FILE: tasksFilePath,
        RUNS_DIR: 'tmp/runs',
        ALLOW_REAL_PROVIDER: 'true',
        ALLOW_REAL_REPO_APPLY: 'true',
        ALLOW_REAL_REPO_COMMIT: 'true',
        ALLOW_REAL_REPO_PUSH: 'true',
        KIMI_API_KEY: 'fake',
        KIMI_BASE_URL: 'http://localhost:9999',
        KIMI_FAKE_RESPONSE: buildFakeKimiOutput([{ path: 'README.md', content: '# modified\n' }]),
        REAL_REPO_REVIEWER_FAKE_RESPONSE: JSON.stringify({
          decision: 'reject',
          confidence: 'high',
          blockingIssues: ['missing tests'],
          nonBlockingIssues: [],
          reviewSummary: 'Needs changes',
          nextAction: 'fix',
          fixTask: 'Add tests',
        }),
      });
      assert.notStrictEqual(result.status, 0, `Expected rejection: ${result.stderr}`);
      assert.strictEqual(getGitLogCount(repoPath), before, 'main repo should not gain a commit');
      const refs = spawnSync('git', ['--git-dir', originPath, 'show-ref'], { shell: false, encoding: 'utf-8' }).stdout.trim();
      assert(!refs.includes(`ai/${taskId}`) || !refs.includes('ai/'), `origin should not have work branch: ${refs}`);
      const content = readFileSync(join(repoPath, 'README.md'), 'utf-8');
      assert.strictEqual(content, '# hello\n', 'README should remain unchanged on main repo');
    } finally {
      cleanup();
    }
  });
});
