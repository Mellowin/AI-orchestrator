import { describe, test } from 'node:test';
import assert from 'node:assert';
import { existsSync, readFileSync, rmSync, writeFileSync, mkdirSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
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
  function createTempRunsDir(): string {
    return mkdtempSync(join(tmpdir(), 'state-manager-test-'));
  }

  test('getRunDir returns expected path', () => {
    const tempRuns = createTempRunsDir();
    const dir = getRunDir(TASK_ID, tempRuns);
    assert(dir.includes(TASK_ID), `Expected path to include taskId, got: ${dir}`);
    rmSync(tempRuns, { recursive: true });
  });

  test('getStatePath returns expected path', () => {
    const tempRuns = createTempRunsDir();
    const path = getStatePath(TASK_ID, tempRuns);
    assert(path.endsWith('state.json'), `Expected path to end with state.json, got: ${path}`);
    rmSync(tempRuns, { recursive: true });
  });

  test('loadState returns null when state file does not exist', () => {
    const tempRuns = createTempRunsDir();
    try {
      const state = loadState(TASK_ID, tempRuns);
      assert.strictEqual(state, null);
    } finally {
      rmSync(tempRuns, { recursive: true });
    }
  });

  test('saveState creates runs dir and state.json', () => {
    const tempRuns = createTempRunsDir();
    try {
      const state = makeState();
      saveState(TASK_ID, state, tempRuns);
      assert(existsSync(getStatePath(TASK_ID, tempRuns)), 'Expected state.json to exist');
    } finally {
      rmSync(tempRuns, { recursive: true });
    }
  });

  test('saved state can be read back exactly', () => {
    const tempRuns = createTempRunsDir();
    try {
      const state = makeState({ status: 'coding', current_attempt: 2 });
      saveState(TASK_ID, state, tempRuns);
      const loaded = loadState(TASK_ID, tempRuns);
      assert.notStrictEqual(loaded, null);
      assert.strictEqual(loaded!.task_id, TASK_ID);
      assert.strictEqual(loaded!.status, 'coding');
      assert.strictEqual(loaded!.current_attempt, 2);
      assert.strictEqual(loaded!.branch, 'ai/test-task');
    } finally {
      rmSync(tempRuns, { recursive: true });
    }
  });

  test('loadState throws on invalid JSON', () => {
    const tempRuns = createTempRunsDir();
    try {
      const runDir = getRunDir(TASK_ID, tempRuns);
      mkdirSync(runDir, { recursive: true });
      writeFileSync(getStatePath(TASK_ID, tempRuns), 'not-json', 'utf-8');
      assert.throws(() => loadState(TASK_ID, tempRuns), /Unexpected token/);
    } finally {
      rmSync(tempRuns, { recursive: true });
    }
  });

  test('loadState throws on invalid status', () => {
    const tempRuns = createTempRunsDir();
    try {
      const state = makeState({ status: 'invalid_status' as unknown as RunState['status'] });
      saveState(TASK_ID, state, tempRuns);
      assert.throws(() => loadState(TASK_ID, tempRuns), /Invalid state\.json: unknown status "invalid_status"/);
    } finally {
      rmSync(tempRuns, { recursive: true });
    }
  });

  test('saveState and loadState accept pushed status', () => {
    const tempRuns = createTempRunsDir();
    try {
      const state = makeState({
        status: 'pushed',
        pushed_remote: 'origin',
        pushed_ref: 'ai/test-branch',
        commit_sha: 'abc123',
        safety_note: 'Push completed; human review required',
      });
      saveState(TASK_ID, state, tempRuns);
      const loaded = loadState(TASK_ID, tempRuns);
      assert.notStrictEqual(loaded, null);
      assert.strictEqual(loaded!.status, 'pushed');
      assert.strictEqual(loaded!.pushed_remote, 'origin');
      assert.strictEqual(loaded!.pushed_ref, 'ai/test-branch');
      assert.strictEqual(loaded!.commit_sha, 'abc123');
      assert.strictEqual(loaded!.safety_note, 'Push completed; human review required');
    } finally {
      rmSync(tempRuns, { recursive: true });
    }
  });

  test('loadState throws on missing required field', () => {
    const tempRuns = createTempRunsDir();
    try {
      const runDir = getRunDir(TASK_ID, tempRuns);
      mkdirSync(runDir, { recursive: true });
      writeFileSync(
        getStatePath(TASK_ID, tempRuns),
        JSON.stringify({
          task_id: TASK_ID,
          status: 'pending',
          current_attempt: 0,
          // missing branch, repo_path, created_at, updated_at
        }),
        'utf-8'
      );
      assert.throws(() => loadState(TASK_ID, tempRuns), /Invalid state\.json: missing or invalid "branch"/);
    } finally {
      rmSync(tempRuns, { recursive: true });
    }
  });

  test('loadState throws on task_id mismatch', () => {
    const tempRuns = createTempRunsDir();
    try {
      const state = makeState({ task_id: 'other-task' });
      saveState(TASK_ID, state, tempRuns);
      assert.throws(() => loadState(TASK_ID, tempRuns), /task_id mismatch/);
    } finally {
      rmSync(tempRuns, { recursive: true });
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
    const tempRuns = createTempRunsDir();
    try {
      const dir = initAttemptDir(TASK_ID, 1, tempRuns);
      assert(existsSync(dir), 'Expected attempt dir to exist');
      assert(dir.includes('attempt-1'), `Expected path to include attempt-1, got: ${dir}`);
    } finally {
      rmSync(tempRuns, { recursive: true });
    }
  });

  test('writeAttemptFile writes file inside attempt dir', () => {
    const tempRuns = createTempRunsDir();
    try {
      writeAttemptFile(TASK_ID, 1, 'test.txt', 'hello', tempRuns);
      const attemptDir = initAttemptDir(TASK_ID, 1, tempRuns);
      const filePath = join(attemptDir, 'test.txt');
      assert(existsSync(filePath), 'Expected file to exist');
      assert.strictEqual(readFileSync(filePath, 'utf-8'), 'hello');
    } finally {
      rmSync(tempRuns, { recursive: true });
    }
  });

  test('writeAttemptFile rejects absolute filename', () => {
    const tempRuns = createTempRunsDir();
    try {
      assert.throws(
        () => writeAttemptFile(TASK_ID, 1, '/etc/passwd', 'x', tempRuns),
        /Absolute paths are not allowed/
      );
    } finally {
      rmSync(tempRuns, { recursive: true });
    }
  });

  test('writeAttemptFile rejects path traversal in filename', () => {
    const tempRuns = createTempRunsDir();
    try {
      assert.throws(
        () => writeAttemptFile(TASK_ID, 1, '../secret.txt', 'x', tempRuns),
        /Invalid filename/
      );
    } finally {
      rmSync(tempRuns, { recursive: true });
    }
  });
});
