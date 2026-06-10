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
import { runPipelineLoop } from '../src/pipeline-loop.js';
import { join } from 'node:path';

let fixtureCounter = 0;

function createTempFixtureRepo(): {
  taskFilePath: string;
  repoPath: string;
  taskId: string;
  cleanup: () => void;
} {
  const id = `${Date.now()}-${fixtureCounter++}`;
  const taskId = `pipeline-task-${id}`;
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
    work_branch: "ai/pipeline-test"
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

function readState(taskId: string): {
  status: string;
  current_attempt: number;
  last_review?: { verdict: string };
} {
  const statePath = join(process.cwd(), 'runs', taskId, 'state.json');
  return JSON.parse(readFileSync(statePath, 'utf-8'));
}

function approveVerdict(): string {
  return JSON.stringify({
    verdict: 'approve',
    critical_issues: [],
    requested_changes: [],
    summary_for_human: 'Looks good',
  });
}

function needsChangesVerdict(): string {
  return JSON.stringify({
    verdict: 'needs_changes',
    critical_issues: ['Missing error handling'],
    requested_changes: ['Add try/catch around file writes'],
    summary_for_human: 'Needs fixes',
  });
}

function rejectVerdict(): string {
  return JSON.stringify({
    verdict: 'reject',
    critical_issues: ['Security vulnerability'],
    requested_changes: [],
    summary_for_human: 'Cannot approve due to security issue',
  });
}

describe('pipeline-loop', () => {
  test('approve path: patch applied, state approved, review saved', () => {
    const { taskFilePath, taskId, repoPath, cleanup } = createTempFixtureRepo();
    try {
      const task = loadTask(taskFilePath, taskId);
      const originalPackage = readFileSync(join(repoPath, 'package.json'), 'utf-8');

      const coderOutput = JSON.stringify({
        mode: 'file_update',
        files: [{ path: 'src/hello.ts', content: "export const hello = 'world';\n" }],
      });

      const result = runPipelineLoop(task, coderOutput, approveVerdict());

      assert.strictEqual(result.success, true, `Expected success, got logs: ${result.logs}`);
      assert(result.logs.includes('Review approved'), `Got logs: ${result.logs}`);

      const state = readState(taskId);
      assert.strictEqual(state.status, 'approved');
      assert.strictEqual(state.current_attempt, 1);
      assert.ok(state.last_review, 'last_review should be saved');
      assert.strictEqual(state.last_review?.verdict, 'approve');

      // Patch should remain applied
      assert(
        existsSync(join(repoPath, 'src', 'hello.ts')),
        'hello.ts should exist after approved patch'
      );

      // Original package.json should be untouched
      assert.strictEqual(readFileSync(join(repoPath, 'package.json'), 'utf-8'), originalPackage);
    } finally {
      cleanup();
    }
  });

  test('needs_changes path: patch rolled back, state reviewing, review saved', () => {
    const { taskFilePath, taskId, repoPath, cleanup } = createTempFixtureRepo();
    try {
      const task = loadTask(taskFilePath, taskId);
      const originalPackage = readFileSync(join(repoPath, 'package.json'), 'utf-8');

      const coderOutput = JSON.stringify({
        mode: 'file_update',
        files: [{ path: 'src/hello.ts', content: "export const hello = 'world';\n" }],
      });

      const result = runPipelineLoop(task, coderOutput, needsChangesVerdict());

      assert.strictEqual(result.success, false, `Expected failure, got logs: ${result.logs}`);
      assert(result.logs.includes('Review requested changes'), `Got logs: ${result.logs}`);
      assert(result.logs.includes('Rollback completed'), `Got logs: ${result.logs}`);

      const state = readState(taskId);
      // 'reviewing' is the closest existing safe status for "review completed, more work needed"
      assert.strictEqual(state.status, 'reviewing');
      assert.strictEqual(state.current_attempt, 1);
      assert.ok(state.last_review, 'last_review should be saved');
      assert.strictEqual(state.last_review?.verdict, 'needs_changes');

      // Patch should be rolled back
      assert(!existsSync(join(repoPath, 'src', 'hello.ts')), 'hello.ts should not exist after rollback');

      // Original package.json should be untouched
      assert.strictEqual(readFileSync(join(repoPath, 'package.json'), 'utf-8'), originalPackage);
    } finally {
      cleanup();
    }
  });

  test('reject path: patch rolled back, state rejected, review saved', () => {
    const { taskFilePath, taskId, repoPath, cleanup } = createTempFixtureRepo();
    try {
      const task = loadTask(taskFilePath, taskId);
      const originalPackage = readFileSync(join(repoPath, 'package.json'), 'utf-8');

      const coderOutput = JSON.stringify({
        mode: 'file_update',
        files: [{ path: 'src/hello.ts', content: "export const hello = 'world';\n" }],
      });

      const result = runPipelineLoop(task, coderOutput, rejectVerdict());

      assert.strictEqual(result.success, false, `Expected failure, got logs: ${result.logs}`);
      assert(result.logs.includes('Review rejected'), `Got logs: ${result.logs}`);
      assert(result.logs.includes('Rollback completed'), `Got logs: ${result.logs}`);

      const state = readState(taskId);
      assert.strictEqual(state.status, 'rejected');
      assert.strictEqual(state.current_attempt, 1);
      assert.ok(state.last_review, 'last_review should be saved');
      assert.strictEqual(state.last_review?.verdict, 'reject');

      // Patch should be rolled back
      assert(!existsSync(join(repoPath, 'src', 'hello.ts')), 'hello.ts should not exist after rollback');

      // Original package.json should be untouched
      assert.strictEqual(readFileSync(join(repoPath, 'package.json'), 'utf-8'), originalPackage);
    } finally {
      cleanup();
    }
  });

  test('invalid reviewer JSON fails clearly and rolls back', () => {
    const { taskFilePath, taskId, repoPath, cleanup } = createTempFixtureRepo();
    try {
      const task = loadTask(taskFilePath, taskId);
      const originalPackage = readFileSync(join(repoPath, 'package.json'), 'utf-8');

      const coderOutput = JSON.stringify({
        mode: 'file_update',
        files: [{ path: 'src/hello.ts', content: "export const hello = 'world';\n" }],
      });

      const result = runPipelineLoop(task, coderOutput, 'not-valid-json');

      assert.strictEqual(result.success, false);
      assert(result.logs.includes('Invalid reviewer JSON output'), `Got logs: ${result.logs}`);
      assert(result.logs.includes('Rollback completed'), `Got logs: ${result.logs}`);

      const state = readState(taskId);
      assert.strictEqual(state.status, 'failed_guardrails');

      // Patch should be rolled back
      assert(!existsSync(join(repoPath, 'src', 'hello.ts')), 'hello.ts should not exist after rollback');
      assert.strictEqual(readFileSync(join(repoPath, 'package.json'), 'utf-8'), originalPackage);
    } finally {
      cleanup();
    }
  });
});
