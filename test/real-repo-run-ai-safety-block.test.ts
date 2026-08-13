import { describe, test } from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..');

function runGit(cwd: string, args: string[]): void {
  const result = spawnSync('git', args, { cwd, encoding: 'utf-8', shell: false });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  }
}

function setupRepo(): string {
  const parent = mkdtempSync(join(tmpdir(), 'safety-block-repo-'));
  const bare = join(parent, 'remote.git');
  const repo = join(parent, 'repo');
  mkdirSync(bare);
  mkdirSync(repo);
  runGit(bare, ['init', '--bare']);
  runGit(repo, ['init', '-b', 'main']);
  runGit(repo, ['config', 'core.autocrlf', 'false']);
  runGit(repo, ['remote', 'add', 'origin', bare]);
  runGit(repo, ['config', 'user.email', 'test@example.com']);
  runGit(repo, ['config', 'user.name', 'Test']);
  writeFileSync(join(repo, 'README.md'), '# base\n', 'utf-8');
  runGit(repo, ['add', 'README.md']);
  runGit(repo, ['commit', '-m', 'base']);
  runGit(repo, ['push', '-u', 'origin', 'main']);
  runGit(repo, ['checkout', '-b', 'work-branch']);
  return repo;
}

function fakeAcceptedReviewerResponse(): string {
  return JSON.stringify({
    decision: 'accepted',
    confidence: 'high',
    blocking_issues: [],
    non_blocking_issues: [],
    review_summary: 'ok',
    fix_task: null,
    next_action: 'advance_to_next_task',
  });
}

function fakeCoderResponse(path: string, content: string): string {
  return JSON.stringify({
    mode: 'file_update',
    files: [{ path, content }],
  });
}

describe('real-repo-run-ai safety policy recovery', () => {
  test('recovers from pre-apply safety violation with a new safe proposal', () => {
    const repo = setupRepo();
    const runDir = mkdtempSync(join(tmpdir(), 'safety-recovery-runs-'));

    const tasksFile = join(runDir, 'tasks.yaml');
    const tasks = {
      tasks: [
        {
          id: 'task_safety_recovery',
          title: 'Safety recovery test',
          repo_path: repo,
          base_branch: 'main',
          work_branch: 'work-branch',
          goal: 'Create a small source file',
          context_files: ['README.md'],
          checks: [{ command: 'node', args: ['-e', 'process.exit(0)'] }],
          guardrails: {
            allow_modify: ['src/x.js'],
            deny_modify: ['.env'],
            max_lines_changed: 20,
            auto_commit: false,
            auto_push: false,
            auto_merge: false,
          },
        },
      ],
    };
    writeFileSync(tasksFile, JSON.stringify(tasks, null, 2), 'utf-8');

    const unsafeResponse = fakeCoderResponse('src/x.js', 'console.log(process.env.KIMI_API_KEY);\n');
    const safeResponse = fakeCoderResponse('src/x.js', 'console.log("ok");\n');

    const env = {
      ...process.env,
      TASKS_FILE: tasksFile,
      RUNS_DIR: runDir,
      ALLOW_REAL_PROVIDER: 'true',
      ALLOW_REAL_REPO_APPLY: 'true',
      ALLOW_REAL_REPO_COMMIT: 'true',
      ALLOW_REAL_REPO_PUSH: 'true',
      KIMI_API_KEY: 'sk_test_key',
      KIMI_BASE_URL: 'https://api.moonshot.cn/v1',
      KIMI_FAKE_RESPONSES: JSON.stringify([unsafeResponse, safeResponse]),
      KIMI_FAKE_REVIEWER_RESPONSE: fakeAcceptedReviewerResponse(),
    };

    const result = spawnSync(
      process.execPath,
      [join(projectRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs'), join(projectRoot, 'src', 'cli.ts'), 'real-repo-run-ai', 'task_safety_recovery'],
      {
        cwd: projectRoot,
        env,
        encoding: 'utf-8',
        shell: false,
        timeout: 30000,
      }
    );

    assert.strictEqual(result.status, 0, `expected success, got ${result.status}\n${result.stdout}\n${result.stderr}`);

    const statePath = join(runDir, 'task_safety_recovery', 'state.json');
    const state = JSON.parse(readFileSync(statePath, 'utf-8'));
    assert.strictEqual(state.status, 'pushed');
    assert.strictEqual(state.pushed, true);
    assert.ok(state.provider_attempts.length >= 2, 'expected at least two provider attempts');

    const log = spawnSync('git', ['log', '--oneline'], { cwd: repo, encoding: 'utf-8' });
    const commitCount = log.stdout.trim().split('\n').length;
    assert.strictEqual(commitCount, 2, 'expected exactly one new commit on top of base');

    const workTree = spawnSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf-8' });
    assert.strictEqual(workTree.stdout.trim(), '', 'working tree should be clean');

    const srcContent = readFileSync(join(repo, 'src', 'x.js'), 'utf-8');
    assert.strictEqual(srcContent, 'console.log("ok");\n', 'final file should be safe proposal');
  });

  test('blocks after exhausting safety recovery attempts', () => {
    const repo = setupRepo();
    const runDir = mkdtempSync(join(tmpdir(), 'safety-recovery-exhaust-runs-'));

    const tasksFile = join(runDir, 'tasks.yaml');
    const tasks = {
      tasks: [
        {
          id: 'task_safety_exhaust',
          title: 'Safety exhaustion test',
          repo_path: repo,
          base_branch: 'main',
          work_branch: 'work-branch',
          goal: 'Create a small source file',
          context_files: ['README.md'],
          checks: [{ command: 'node', args: ['-e', 'process.exit(0)'] }],
          guardrails: {
            allow_modify: ['src/x.js'],
            deny_modify: ['.env'],
            max_lines_changed: 20,
            auto_commit: false,
            auto_push: false,
            auto_merge: false,
          },
        },
      ],
    };
    writeFileSync(tasksFile, JSON.stringify(tasks, null, 2), 'utf-8');

    const unsafeResponse = fakeCoderResponse('src/x.js', 'console.log(process.env.KIMI_API_KEY);\n');

    const env = {
      ...process.env,
      TASKS_FILE: tasksFile,
      RUNS_DIR: runDir,
      ALLOW_REAL_PROVIDER: 'true',
      ALLOW_REAL_REPO_APPLY: 'true',
      ALLOW_REAL_REPO_COMMIT: 'true',
      ALLOW_REAL_REPO_PUSH: 'true',
      KIMI_API_KEY: 'sk_test_key',
      KIMI_BASE_URL: 'https://api.moonshot.cn/v1',
      KIMI_FAKE_RESPONSES: JSON.stringify([unsafeResponse, unsafeResponse, unsafeResponse]),
    };

    const result = spawnSync(
      process.execPath,
      [join(projectRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs'), join(projectRoot, 'src', 'cli.ts'), 'real-repo-run-ai', 'task_safety_exhaust'],
      {
        cwd: projectRoot,
        env,
        encoding: 'utf-8',
        shell: false,
        timeout: 30000,
      }
    );

    assert.notStrictEqual(result.status, 0, `expected non-zero exit, got ${result.status}\n${result.stdout}\n${result.stderr}`);

    const statePath = join(runDir, 'task_safety_exhaust', 'state.json');
    const state = JSON.parse(readFileSync(statePath, 'utf-8'));
    assert.strictEqual(state.status, 'blocked');
    assert.strictEqual(state.blocked_by, 'safety_policy');
    assert.strictEqual(state.applied, false);
    assert.strictEqual(state.committed, false);
    assert.strictEqual(state.pushed, false);
    assert.ok(Array.isArray(state.safety_policy_reasons));

    const workTree = spawnSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf-8' });
    assert.strictEqual(workTree.stdout.trim(), '', 'working tree should be unchanged');
  });
});

describe('real-repo-run-ai safety policy early return', () => {
  test('blocks before apply and writes clear blocked state', () => {
    const repo = setupRepo();
    const runDir = mkdtempSync(join(tmpdir(), 'safety-block-runs-'));

    const tasksFile = join(runDir, 'tasks.yaml');
    const tasks = {
      tasks: [
        {
          id: 'task_safety_block',
          title: 'Safety block test',
          repo_path: repo,
          base_branch: 'main',
          work_branch: 'work-branch',
          goal: 'Test safety policy blocks before apply',
          context_files: ['README.md'],
          checks: [{ command: 'node', args: ['-e', 'process.exit(0)'] }],
          guardrails: {
            allow_modify: ['src/x.js'],
            deny_modify: ['.env'],
            max_lines_changed: 20,
            auto_commit: false,
            auto_push: false,
            auto_merge: false,
          },
        },
      ],
    };
    writeFileSync(tasksFile, JSON.stringify(tasks, null, 2), 'utf-8');

    const fakeResponse = JSON.stringify({
      mode: 'file_update',
      files: [
        {
          path: 'src/x.js',
          content: 'console.log(process.env.KIMI_API_KEY);\n',
        },
      ],
    });

    const env = {
      ...process.env,
      TASKS_FILE: tasksFile,
      RUNS_DIR: runDir,
      ALLOW_REAL_PROVIDER: 'true',
      ALLOW_REAL_REPO_APPLY: 'true',
      ALLOW_REAL_REPO_COMMIT: 'true',
      ALLOW_REAL_REPO_PUSH: 'true',
      KIMI_API_KEY: 'sk_test_key',
      KIMI_BASE_URL: 'https://api.moonshot.cn/v1',
      KIMI_FAKE_RESPONSE: fakeResponse,
    };

    const result = spawnSync(
      process.execPath,
      [join(projectRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs'), join(projectRoot, 'src', 'cli.ts'), 'real-repo-run-ai', 'task_safety_block'],
      {
        cwd: projectRoot,
        env,
        encoding: 'utf-8',
        shell: false,
        timeout: 30000,
      }
    );

    assert.notStrictEqual(result.status, 0, `expected non-zero exit, got ${result.status}\n${result.stdout}\n${result.stderr}`);
    assert.ok(
      (result.stderr || '').includes('Safety policy violation'),
      `expected safety violation in stderr, got ${result.stderr}`
    );
    assert.ok(
      (result.stderr || '').includes('Safety policy violation'),
      `expected safety policy violation in stderr, got ${result.stderr}`
    );

    const statePath = join(runDir, 'task_safety_block', 'state.json');
    const state = JSON.parse(readFileSync(statePath, 'utf-8'));
    assert.strictEqual(state.status, 'blocked');
    assert.strictEqual(state.blocked_by, 'safety_policy');
    assert.strictEqual(state.applied, false);
    assert.strictEqual(state.committed, false);
    assert.strictEqual(state.pushed, false);
    assert.ok(Array.isArray(state.safety_policy_reasons));
    assert.ok(state.safety_policy_reasons.some((r: string) => r.includes('Secret env var access')));

    const workTree = spawnSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf-8' });
    assert.strictEqual(workTree.stdout.trim(), '', 'working tree should be unchanged');
  });
});
