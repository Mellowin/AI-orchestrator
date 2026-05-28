import { describe, test } from 'node:test';
import assert from 'node:assert';
import {
  existsSync,
  rmSync,
  readFileSync,
  writeFileSync,
  cpSync,
  mkdirSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { loadTask } from '../src/task-loader.js';
import { runMockApplyFlow } from '../src/mock-apply-flow.js';
import { join } from 'node:path';

let fixtureCounter = 0;

function createTempFixtureRepo(): {
  taskFilePath: string;
  repoPath: string;
  taskId: string;
  cleanup: () => void;
} {
  const id = `${Date.now()}-${fixtureCounter++}`;
  const taskId = `test-task-${id}`;
  const tmpDir = join(process.cwd(), 'tmp', `fixture-${id}`);
  const repoPath = join(tmpDir, 'repo');
  const tasksFilePath = join(tmpDir, 'tasks.yaml');

  mkdirSync(tmpDir, { recursive: true });
  cpSync(join(process.cwd(), 'fixtures', 'repo'), repoPath, { recursive: true });

  spawnSync('git', ['init'], { cwd: repoPath, encoding: 'utf-8', shell: false });
  spawnSync('git', ['add', '.'], { cwd: repoPath, encoding: 'utf-8', shell: false });
  spawnSync('git', ['commit', '-m', 'init', '--no-gpg-sign'], {
    cwd: repoPath,
    encoding: 'utf-8',
    shell: false,
  });
  spawnSync('git', ['branch', '-m', 'main'], { cwd: repoPath, encoding: 'utf-8', shell: false });

  const originPath = join(tmpDir, 'origin.git');
  spawnSync('git', ['init', '--bare', originPath], {
    encoding: 'utf-8',
    shell: false,
  });
  spawnSync('git', ['remote', 'add', 'origin', originPath], {
    cwd: repoPath,
    encoding: 'utf-8',
    shell: false,
  });
  spawnSync('git', ['push', '-u', 'origin', 'main'], {
    cwd: repoPath,
    encoding: 'utf-8',
    shell: false,
  });

  const tasksYaml = `tasks:
  - id: ${taskId}
    title: "Test task"
    repo_path: "${repoPath.replace(/\\/g, '/')}"
    base_branch: "main"
    work_branch: "ai/test-task"
    goal: "Test goal"
    context_files:
      - "src/index.ts"
    checks:
      - command: "npm"
        args: ["run", "build"]
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
`;
  writeFileSync(tasksFilePath, tasksYaml, 'utf-8');

  return {
    taskFilePath: tasksFilePath,
    repoPath,
    taskId,
    cleanup: () => {
      rmSync(tmpDir, { recursive: true, force: true });
      const runDir = join(process.cwd(), 'runs', taskId);
      if (existsSync(runDir)) {
        rmSync(runDir, { recursive: true, force: true });
      }
    },
  };
}

function commitAll(repoPath: string, message: string): void {
  spawnSync('git', ['add', '.'], { cwd: repoPath, encoding: 'utf-8', shell: false });
  spawnSync('git', ['commit', '-m', message, '--no-gpg-sign'], {
    cwd: repoPath,
    encoding: 'utf-8',
    shell: false,
  });
}

function readState(taskId: string): { status: string; current_attempt: number } {
  const statePath = join(process.cwd(), 'runs', taskId, 'state.json');
  return JSON.parse(readFileSync(statePath, 'utf-8'));
}

function readLogs(taskId: string, attempt: number): string {
  const logsPath = join(process.cwd(), 'runs', taskId, `attempt-${attempt}`, 'logs.txt');
  return readFileSync(logsPath, 'utf-8');
}

describe('mock-apply-flow', () => {
  test('invalid JSON fails before side effects', () => {
    const { taskFilePath, taskId, cleanup } = createTempFixtureRepo();
    const task = loadTask(taskFilePath, taskId);
    const result = runMockApplyFlow(task, 'not-json-at-all');

    assert.strictEqual(result.success, false);
    assert(result.logs.includes('Invalid Kimi JSON output'), `Got logs: ${result.logs}`);

    const state = readState(taskId);
    assert.strictEqual(state.status, 'failed');
    assert.strictEqual(state.current_attempt, 1);

    cleanup();
  });

  test('guardrails fail blocks patch before mutation', () => {
    const { taskFilePath, taskId, repoPath, cleanup } = createTempFixtureRepo();
    const task = loadTask(taskFilePath, taskId);
    const rawJson = JSON.stringify({
      mode: 'file_update',
      files: [{ path: '.env', content: 'x' }],
    });
    const originalPackage = readFileSync(join(repoPath, 'package.json'), 'utf-8');
    const result = runMockApplyFlow(task, rawJson);

    assert.strictEqual(result.success, false);
    assert(result.logs.includes('Pre-apply guardrails failed'), `Got logs: ${result.logs}`);

    const state = readState(taskId);
    assert.strictEqual(state.status, 'failed');

    // Ensure no repo mutation happened
    assert.strictEqual(
      readFileSync(join(repoPath, 'package.json'), 'utf-8'),
      originalPackage
    );

    cleanup();
  });

  test('rollback restores files when checks fail', () => {
    const { taskFilePath, taskId, repoPath, cleanup } = createTempFixtureRepo();
    const task = loadTask(taskFilePath, taskId);
    const originalPackage = readFileSync(join(repoPath, 'package.json'), 'utf-8');
    const rawJson = JSON.stringify({
      mode: 'file_update',
      files: [{ path: 'package.json', content: 'this is not valid json' }],
    });
    const result = runMockApplyFlow(task, rawJson);

    assert.strictEqual(result.success, false);
    assert(result.logs.includes('Checks failed'), `Got logs: ${result.logs}`);
    assert(result.logs.includes('Rollback completed'), `Got logs: ${result.logs}`);

    const state = readState(taskId);
    assert.strictEqual(state.status, 'failed');
    assert.strictEqual(state.current_attempt, 1);

    assert.strictEqual(
      readFileSync(join(repoPath, 'package.json'), 'utf-8'),
      originalPackage,
      'package.json should be rolled back'
    );

    cleanup();
  });

  test('max attempts returns failed_max_attempts', () => {
    const { taskFilePath, taskId, cleanup } = createTempFixtureRepo();
    const task = loadTask(taskFilePath, taskId);

    // Pre-seed state with max attempts reached
    const runDir = join(process.cwd(), 'runs', taskId);
    mkdirSync(runDir, { recursive: true });
    writeFileSync(
      join(runDir, 'state.json'),
      JSON.stringify({
        task_id: taskId,
        status: 'failed',
        current_attempt: 3,
        branch: 'ai/test-task',
        repo_path: task.repo_path,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }),
      'utf-8'
    );

    const rawJson = JSON.stringify({
      mode: 'file_update',
      files: [{ path: 'src/hello.ts', content: "export const hello = 'world';" }],
    });
    const result = runMockApplyFlow(task, rawJson);

    assert.strictEqual(result.success, false);
    assert(result.logs.includes('Max attempts reached'), `Got logs: ${result.logs}`);

    const state = readState(taskId);
    assert.strictEqual(state.status, 'failed_max_attempts');

    cleanup();
  });

  test('resumes on existing work branch', () => {
    const { taskFilePath, taskId, repoPath, cleanup } = createTempFixtureRepo();
    const task = loadTask(taskFilePath, taskId);

    // First run: success
    const rawJson = JSON.stringify({
      mode: 'file_update',
      files: [{ path: 'src/hello.ts', content: "export const hello = 'world';" }],
    });
    const result1 = runMockApplyFlow(task, rawJson);
    assert.strictEqual(result1.success, true, `Run 1 failed: ${result1.logs}`);
    assert.strictEqual(readState(taskId).current_attempt, 1);

    // Commit changes so work branch is clean for resume
    commitAll(repoPath, 'add hello');

    // Second run: should resume on existing branch
    const result2 = runMockApplyFlow(task, rawJson);
    assert.strictEqual(result2.success, true, `Run 2 failed: ${result2.logs}`);
    assert.strictEqual(readState(taskId).current_attempt, 2);

    cleanup();
  });

  test('dirty working tree fails before apply', () => {
    const { taskFilePath, taskId, repoPath, cleanup } = createTempFixtureRepo();
    const task = loadTask(taskFilePath, taskId);

    // Dirty the working tree
    writeFileSync(join(repoPath, 'dirty.txt'), 'dirty', 'utf-8');

    const rawJson = JSON.stringify({
      mode: 'file_update',
      files: [{ path: 'src/hello.ts', content: "export const hello = 'world';" }],
    });
    const result = runMockApplyFlow(task, rawJson);

    assert.strictEqual(result.success, false);
    assert(result.logs.includes('Working tree is not clean'), `Got logs: ${result.logs}`);

    const state = readState(taskId);
    assert.strictEqual(state.status, 'failed');

    cleanup();
  });

  test('rejects destructive proposed file shrink before apply', () => {
    const { taskFilePath, taskId, repoPath, cleanup } = createTempFixtureRepo();

    // Create a committed file with 200 lines
    const largeContent = Array.from({ length: 200 }, (_, i) => `line ${i + 1}`).join('\n') + '\n';
    writeFileSync(join(repoPath, 'src', 'large-file.ts'), largeContent, 'utf-8');
    commitAll(repoPath, 'add large file');

    const task = loadTask(taskFilePath, taskId);
    const rawJson = JSON.stringify({
      mode: 'file_update',
      files: [{ path: 'src/large-file.ts', content: 'console.log("x");\n' }],
    });
    const originalContent = readFileSync(join(repoPath, 'src', 'large-file.ts'), 'utf-8');
    const result = runMockApplyFlow(task, rawJson);

    assert.strictEqual(result.success, false);
    assert(result.logs.includes('Proposed file line delta too large'), `Got logs: ${result.logs}`);
    assert.strictEqual(
      readFileSync(join(repoPath, 'src', 'large-file.ts'), 'utf-8'),
      originalContent,
      'large-file.ts should not be modified'
    );

    const state = readState(taskId);
    assert.strictEqual(state.status, 'failed');

    cleanup();
  });
});
