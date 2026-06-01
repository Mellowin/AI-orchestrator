import { describe, test } from 'node:test';
import assert from 'node:assert';
import { existsSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  getRunDir,
  getStatePath,
  loadState,
  saveState,
  initState,
  initAttemptDir,
  writeAttemptFile,
} from '../src/state-manager.js';
import type { Task, RunState } from '../src/types.js';

const TASK_ID = 'state-manager-test-task';

function cleanRunDir(taskId: string): void {
  const dir = getRunDir(taskId);
  if (existsSync(dir)) {
    rmSync(dir, { recursive: true });
  }
}

function makeTask(): Task {
  return {
    id: TASK_ID,
    title: 'Test Task',
    repo_path: './demo-repo',
    base_branch: 'main',
    work_branch: 'ai/test-task',
    goal: 'Test goal',
    context_files: ['src/index.ts'],
    checks: [{ command: 'npm', args: ['run', 'lint'] }],
    guardrails: {
      deny_modify: ['.env'],
      require_tests: false,
      auto_commit: false,
      auto_push: false,
      auto_merge: false,
    },
  };
}

function makeState(overrides?: Partial<RunState>): RunState {
  return {
    task_id: TASK_ID,
    status: 'pending',
    current_attempt: 1,
    branch: 'ai/test-task',
    repo_path: './demo-repo',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

describe('state-manager', () => {
  test('getRunDir returns expected path', () => {
    const dir = getRunDir(TASK_ID);
    assert(dir.includes(TASK_ID), `Expected path to include taskId, got: ${dir}`);
  });

  test('getStatePath returns expected path', () => {
    const path = getStatePath(TASK_ID);
    assert(path.endsWith('state.json'), `Expected path to end with state.json, got: ${path}`);
  });

  test('loadState returns null when state file does not exist', () => {
    cleanRunDir(TASK_ID);
    const state = loadState(TASK_ID);
    assert.strictEqual(state, null);
  });

  test('saveState creates runs dir and state.json', () => {
    cleanRunDir(TASK_ID);
    try {
      const state = makeState();
      saveState(TASK_ID, state);
      assert(existsSync(getStatePath(TASK_ID)), 'Expected state.json to exist');
    } finally {
      cleanRunDir(TASK_ID);
    }
  });

  test('saved state can be read back exactly', () => {
    cleanRunDir(TASK_ID);
    try {
      const state = makeState({ status: 'coding', current_attempt: 2 });
      saveState(TASK_ID, state);
      const loaded = loadState(TASK_ID);
      assert.notStrictEqual(loaded, null);
      assert.strictEqual(loaded!.task_id, TASK_ID);
      assert.strictEqual(loaded!.status, 'coding');
      assert.strictEqual(loaded!.current_attempt, 2);
      assert.strictEqual(loaded!.branch, 'ai/test-task');
    } finally {
      cleanRunDir(TASK_ID);
    }
  });

  test('loadState throws on invalid JSON', () => {
    cleanRunDir(TASK_ID);
    try {
      const runDir = getRunDir(TASK_ID);
      mkdirSync(runDir, { recursive: true });
      writeFileSync(getStatePath(TASK_ID), 'not-json', 'utf-8');
      assert.throws(() => loadState(TASK_ID), /Unexpected token/);
    } finally {
      cleanRunDir(TASK_ID);
    }
  });

  test('loadState throws on invalid status', () => {
    cleanRunDir(TASK_ID);
    try {
      const state = makeState({ status: 'invalid_status' as unknown as RunState['status'] });
      saveState(TASK_ID, state);
      assert.throws(() => loadState(TASK_ID), /Invalid state\.json: unknown status "invalid_status"/);
    } finally {
      cleanRunDir(TASK_ID);
    }
  });

  test('loadState throws on missing required field', () => {
    cleanRunDir(TASK_ID);
    try {
      const runDir = getRunDir(TASK_ID);
      mkdirSync(runDir, { recursive: true });
      writeFileSync(
        getStatePath(TASK_ID),
        JSON.stringify({
          task_id: TASK_ID,
          status: 'pending',
          current_attempt: 0,
          // missing branch, repo_path, created_at, updated_at
        }),
        'utf-8'
      );
      assert.throws(() => loadState(TASK_ID), /Invalid state\.json: missing or invalid "branch"/);
    } finally {
      cleanRunDir(TASK_ID);
    }
  });

  test('loadState throws on task_id mismatch', () => {
    cleanRunDir(TASK_ID);
    try {
      const state = makeState({ task_id: 'other-task' });
      saveState(TASK_ID, state);
      assert.throws(() => loadState(TASK_ID), /task_id mismatch/);
    } finally {
      cleanRunDir(TASK_ID);
    }
  });

  test('initState creates correct default state', () => {
    const task = makeTask();
    const state = initState(task);
    assert.strictEqual(state.task_id, TASK_ID);
    assert.strictEqual(state.status, 'pending');
    assert.strictEqual(state.current_attempt, 0);
    assert.strictEqual(state.branch, 'ai/test-task');
    assert.strictEqual(state.repo_path, './demo-repo');
    assert(typeof state.created_at === 'string');
    assert(typeof state.updated_at === 'string');
  });

  test('initAttemptDir creates directory and returns path', () => {
    cleanRunDir(TASK_ID);
    try {
      const dir = initAttemptDir(TASK_ID, 1);
      assert(existsSync(dir), 'Expected attempt dir to exist');
      assert(dir.includes('attempt-1'), `Expected path to include attempt-1, got: ${dir}`);
    } finally {
      cleanRunDir(TASK_ID);
    }
  });

  test('writeAttemptFile writes file inside attempt dir', () => {
    cleanRunDir(TASK_ID);
    try {
      writeAttemptFile(TASK_ID, 1, 'test.txt', 'hello');
      const attemptDir = initAttemptDir(TASK_ID, 1);
      const filePath = join(attemptDir, 'test.txt');
      assert(existsSync(filePath), 'Expected file to exist');
      assert.strictEqual(readFileSync(filePath, 'utf-8'), 'hello');
    } finally {
      cleanRunDir(TASK_ID);
    }
  });

  test('writeAttemptFile rejects absolute filename', () => {
    cleanRunDir(TASK_ID);
    try {
      assert.throws(
        () => writeAttemptFile(TASK_ID, 1, '/etc/passwd', 'x'),
        /Absolute paths are not allowed/
      );
    } finally {
      cleanRunDir(TASK_ID);
    }
  });

  test('writeAttemptFile rejects path traversal in filename', () => {
    cleanRunDir(TASK_ID);
    try {
      assert.throws(
        () => writeAttemptFile(TASK_ID, 1, '../secret.txt', 'x'),
        /Invalid filename/
      );
    } finally {
      cleanRunDir(TASK_ID);
    }
  });
});
