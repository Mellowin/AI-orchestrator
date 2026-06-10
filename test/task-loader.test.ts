import { describe, test } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import YAML from 'yaml';
import { parseTaskObject, loadTask } from '../src/task-loader.js';
import type { Task } from '../src/types.js';

function makeValidTask(): Record<string, unknown> {
  return {
    id: 'demo-task',
    title: 'Demo Task',
    repo_path: './demo-repo',
    base_branch: 'main',
    work_branch: 'ai/demo-task',
    goal: 'Add demo feature',
    context_files: ['src/index.ts'],
    checks: [{ command: 'npm', args: ['run', 'lint'] }],
    guardrails: {
      deny_modify: ['.env'],
      auto_commit: false,
      auto_push: false,
      auto_merge: false,
    },
  };
}

describe('parseTaskObject', () => {
  test('valid full task parses correctly', () => {
    const raw = makeValidTask();
    const task = parseTaskObject(raw);
    assert.strictEqual(task.id, 'demo-task');
    assert.strictEqual(task.title, 'Demo Task');
    assert.strictEqual(task.repo_path, './demo-repo');
    assert.strictEqual(task.base_branch, 'main');
    assert.strictEqual(task.work_branch, 'ai/demo-task');
    assert.strictEqual(task.goal, 'Add demo feature');
    assert.deepStrictEqual(task.context_files, ['src/index.ts']);
    assert.strictEqual(task.checks.length, 1);
    assert.strictEqual(task.checks[0].command, 'npm');
    assert.deepStrictEqual(task.checks[0].args, ['run', 'lint']);
    assert.strictEqual(task.guardrails.deny_modify[0], '.env');
    assert.strictEqual(task.guardrails.auto_commit, false);
    assert.strictEqual(task.guardrails.auto_push, false);
    assert.strictEqual(task.guardrails.auto_merge, false);
  });

  test('missing base_branch defaults to "main"', () => {
    const raw = makeValidTask();
    delete raw.base_branch;
    const task = parseTaskObject(raw);
    assert.strictEqual(task.base_branch, 'main');
  });

  test('missing deny_modify gets safe defaults', () => {
    const raw = makeValidTask();
    delete (raw.guardrails as Record<string, unknown>).deny_modify;
    const task = parseTaskObject(raw);
    assert.deepStrictEqual(task.guardrails.deny_modify, [
      '.env',
      '.env.*',
      'node_modules/**',
      '.git/**',
    ]);
  });

  test('missing auto flags default to false', () => {
    const raw = makeValidTask();
    const g = raw.guardrails as Record<string, unknown>;
    delete g.auto_commit;
    delete g.auto_push;
    delete g.auto_merge;
    const task = parseTaskObject(raw);
    assert.strictEqual(task.guardrails.auto_commit, false);
    assert.strictEqual(task.guardrails.auto_push, false);
    assert.strictEqual(task.guardrails.auto_merge, false);
  });

  test('require_tests remains optional', () => {
    const raw = makeValidTask();
    delete (raw.guardrails as Record<string, unknown>).require_tests;
    const task = parseTaskObject(raw);
    assert.strictEqual(task.guardrails.require_tests, undefined);
  });

  test('invalid input object throws', () => {
    assert.throws(() => parseTaskObject(null), /Expected task input to be an object/);
    assert.throws(() => parseTaskObject('string'), /Expected task input to be an object/);
    assert.throws(() => parseTaskObject(42), /Expected task input to be an object/);
  });

  test('invalid checks shape throws', () => {
    const raw = makeValidTask();
    raw.checks = [{ command: 'npm' }] as unknown[];
    assert.throws(() => parseTaskObject(raw), /Expected "args" to be an array of strings/);
  });

  test('invalid context_files shape throws', () => {
    const raw = makeValidTask();
    raw.context_files = ['src/index.ts', 42] as unknown[];
    assert.throws(() => parseTaskObject(raw), /Expected "context_files" to be an array of strings/);
  });

  test('missing required field throws', () => {
    const raw = makeValidTask();
    delete raw.id;
    assert.throws(() => parseTaskObject(raw), /Expected "id" to be a string/);
  });
});

function createTempSetup(taskOverrides?: Partial<Record<string, unknown>>): {
  tasksFile: string;
  repoDir: string;
  cleanup: () => void;
} {
  const tempDir = mkdtempSync(join(tmpdir(), 'task-loader-test-'));
  const repoDir = join(tempDir, 'repo');
  mkdirSync(repoDir, { recursive: true });
  mkdirSync(join(repoDir, '.git'), { recursive: true });
  mkdirSync(join(repoDir, 'src'), { recursive: true });
  writeFileSync(join(repoDir, 'src', 'index.ts'), 'export const x = 1;', 'utf-8');

  const task = {
    id: 'test-task',
    title: 'Test Task',
    repo_path: repoDir,
    work_branch: 'ai/test-task',
    goal: 'Test goal',
    context_files: ['src/index.ts'],
    checks: [{ command: 'npm', args: ['run', 'lint'] }],
    guardrails: {
      deny_modify: ['.env'],
      auto_commit: false,
      auto_push: false,
      auto_merge: false,
    },
    ...taskOverrides,
  };

  const tasksFile = join(tempDir, 'tasks.yaml');
  writeFileSync(tasksFile, YAML.stringify({ tasks: [task] }), 'utf-8');

  return {
    tasksFile,
    repoDir,
    cleanup: () => rmSync(tempDir, { recursive: true }),
  };
}

describe('loadTask', () => {
  test('reads tasks.yaml and returns matching task', () => {
    const { tasksFile, cleanup } = createTempSetup();
    try {
      const task = loadTask(tasksFile, 'test-task');
      assert.strictEqual(task.id, 'test-task');
      assert.strictEqual(task.title, 'Test Task');
      assert.strictEqual(task.goal, 'Test goal');
      assert.strictEqual(task.base_branch, 'main');
      assert.deepStrictEqual(task.context_files, ['src/index.ts']);
    } finally {
      cleanup();
    }
  });

  test('throws when tasks.yaml does not exist', () => {
    assert.throws(
      () => loadTask(join(tmpdir(), 'nonexistent-tasks.yaml'), 'test-task'),
      /tasks\.yaml not found/
    );
  });

  test('throws when YAML missing tasks array', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'task-loader-test-'));
    const tasksFile = join(tempDir, 'tasks.yaml');
    writeFileSync(tasksFile, 'foo: bar\n', 'utf-8');
    try {
      assert.throws(() => loadTask(tasksFile, 'test-task'), /Invalid tasks\.yaml: missing tasks array/);
    } finally {
      rmSync(tempDir, { recursive: true });
    }
  });

  test('throws when taskId not found', () => {
    const { tasksFile, cleanup } = createTempSetup();
    try {
      assert.throws(
        () => loadTask(tasksFile, 'missing-task'),
        /Task "missing-task" not found/
      );
    } finally {
      cleanup();
    }
  });

  test('validates repo_path exists', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'task-loader-test-'));
    const repoDir = join(tempDir, 'repo');
    mkdirSync(repoDir, { recursive: true });
    mkdirSync(join(repoDir, '.git'), { recursive: true });
    mkdirSync(join(repoDir, 'src'), { recursive: true });
    writeFileSync(join(repoDir, 'src', 'index.ts'), '', 'utf-8');

    const tasksFile = join(tempDir, 'tasks.yaml');
    const task = {
      id: 'test-task',
      title: 'Test',
      repo_path: join(tempDir, 'nonexistent'),
      work_branch: 'ai/test',
      goal: 'g',
      context_files: [],
      checks: [],
      guardrails: { deny_modify: [], auto_commit: false, auto_push: false, auto_merge: false },
    };
    writeFileSync(tasksFile, YAML.stringify({ tasks: [task] }), 'utf-8');
    try {
      assert.throws(() => loadTask(tasksFile, 'test-task'), /repo_path does not exist/);
    } finally {
      rmSync(tempDir, { recursive: true });
    }
  });

  test('validates repo_path is a git repository', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'task-loader-test-'));
    const repoDir = join(tempDir, 'repo');
    mkdirSync(repoDir, { recursive: true });
    // intentionally no .git folder
    mkdirSync(join(repoDir, 'src'), { recursive: true });
    writeFileSync(join(repoDir, 'src', 'index.ts'), '', 'utf-8');

    const tasksFile = join(tempDir, 'tasks.yaml');
    const task = {
      id: 'test-task',
      title: 'Test',
      repo_path: repoDir,
      work_branch: 'ai/test',
      goal: 'g',
      context_files: ['src/index.ts'],
      checks: [],
      guardrails: { deny_modify: [], auto_commit: false, auto_push: false, auto_merge: false },
    };
    writeFileSync(tasksFile, YAML.stringify({ tasks: [task] }), 'utf-8');
    try {
      assert.throws(() => loadTask(tasksFile, 'test-task'), /repo_path is not a git repository/);
    } finally {
      rmSync(tempDir, { recursive: true });
    }
  });

  test('validates context_files exist', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'task-loader-test-'));
    const repoDir = join(tempDir, 'repo');
    mkdirSync(repoDir, { recursive: true });
    mkdirSync(join(repoDir, '.git'), { recursive: true });
    // intentionally no src/index.ts

    const tasksFile = join(tempDir, 'tasks.yaml');
    writeFileSync(
      tasksFile,
      `tasks:\n  - id: test-task\n    title: Test\n    repo_path: ${repoDir}\n    work_branch: ai/test\n    goal: g\n    context_files: [src/index.ts]\n    checks: []\n    guardrails:\n      deny_modify: []\n      auto_commit: false\n      auto_push: false\n      auto_merge: false\n`,
      'utf-8'
    );
    try {
      assert.throws(() => loadTask(tasksFile, 'test-task'), /context_file does not exist/);
    } finally {
      rmSync(tempDir, { recursive: true });
    }
  });

  test('rejects absolute context_files', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'task-loader-test-'));
    const repoDir = join(tempDir, 'repo');
    mkdirSync(repoDir, { recursive: true });
    mkdirSync(join(repoDir, '.git'), { recursive: true });

    const tasksFile = join(tempDir, 'tasks.yaml');
    writeFileSync(
      tasksFile,
      `tasks:\n  - id: test-task\n    title: Test\n    repo_path: ${repoDir}\n    work_branch: ai/test\n    goal: g\n    context_files: ["/etc/passwd"]\n    checks: []\n    guardrails:\n      deny_modify: []\n      auto_commit: false\n      auto_push: false\n      auto_merge: false\n`,
      'utf-8'
    );
    try {
      assert.throws(() => loadTask(tasksFile, 'test-task'), /Absolute paths are not allowed/);
    } finally {
      rmSync(tempDir, { recursive: true });
    }
  });

  test('rejects path traversal in context_files', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'task-loader-test-'));
    const repoDir = join(tempDir, 'repo');
    mkdirSync(repoDir, { recursive: true });
    mkdirSync(join(repoDir, '.git'), { recursive: true });

    const tasksFile = join(tempDir, 'tasks.yaml');
    writeFileSync(
      tasksFile,
      `tasks:\n  - id: test-task\n    title: Test\n    repo_path: ${repoDir}\n    work_branch: ai/test\n    goal: g\n    context_files: ["../secret.ts"]\n    checks: []\n    guardrails:\n      deny_modify: []\n      auto_commit: false\n      auto_push: false\n      auto_merge: false\n`,
      'utf-8'
    );
    try {
      assert.throws(() => loadTask(tasksFile, 'test-task'), /Path traversal detected/);
    } finally {
      rmSync(tempDir, { recursive: true });
    }
  });
});
