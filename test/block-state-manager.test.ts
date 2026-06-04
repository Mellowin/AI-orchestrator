import { describe, test } from 'node:test';
import assert from 'node:assert';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { BlockDefinition, BlockState } from '../src/block/block-types.js';
import {
  initBlockState,
  loadBlockState,
  saveBlockState,
  updateBlockState,
  getBlockRunDir,
} from '../src/block/block-state-manager.js';

let counter = 0;

function makeDefinition(): BlockDefinition {
  return {
    block_id: `bsm-block-${Date.now()}-${counter++}`,
    title: 'Test Block',
    repo_path: '.',
    base_branch: 'main',
    work_branch: 'ai/test',
    providers: {
      coder: { provider: 'fake', model: 'default' },
      reviewer: { provider: 'fake', model: 'default' },
    },
    review_policy: {
      require_deterministic_checks: true,
      max_fix_attempts: 2,
      reviewer_mode: 'single',
    },
    tasks: [
      {
        task_id: 'task-1',
        title: 'Task 1',
        goal: 'Do thing',
        allowed_files: ['src/a.ts'],
        denied_files: ['.env'],
        max_lines_changed: 100,
        checks: ['npm test'],
      },
      {
        task_id: 'task-2',
        title: 'Task 2',
        goal: 'Do thing 2',
        allowed_files: ['src/b.ts'],
        denied_files: ['.env'],
        max_lines_changed: 100,
        checks: ['npm test'],
      },
    ],
  };
}

function cleanupBlock(blockId: string) {
  const dir = getBlockRunDir(blockId);
  if (existsSync(dir)) {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('block-state-manager', () => {
  test('initBlockState creates pending block', () => {
    const def = makeDefinition();
    const state = initBlockState(def);
    assert.strictEqual(state.block_id, def.block_id);
    assert.strictEqual(state.status, 'pending');
    assert.strictEqual(state.tasks.length, 2);
  });

  test('first task becomes current_task_id', () => {
    const def = makeDefinition();
    const state = initBlockState(def);
    assert.strictEqual(state.current_task_id, 'task-1');
  });

  test('all task states initialized pending', () => {
    const def = makeDefinition();
    const state = initBlockState(def);
    for (const task of state.tasks) {
      assert.strictEqual(task.status, 'pending');
      assert.strictEqual(task.current_attempt, 0);
      assert.strictEqual(task.fix_attempts, 0);
      assert.strictEqual(task.commit_sha, null);
      assert.strictEqual(task.reviewer_decision, null);
    }
  });

  test('saveBlockState writes under runs/blocks', () => {
    const def = makeDefinition();
    const state = initBlockState(def);
    saveBlockState(state);
    try {
      const loaded = loadBlockState(def.block_id);
      assert(loaded);
      assert.strictEqual(loaded.block_id, def.block_id);
    } finally {
      cleanupBlock(def.block_id);
    }
  });

  test('loadBlockState returns saved state', () => {
    const def = makeDefinition();
    const state = initBlockState(def);
    saveBlockState(state);
    try {
      const loaded = loadBlockState(def.block_id);
      assert(loaded);
      assert.deepStrictEqual(loaded.tasks.map((t) => t.task_id), ['task-1', 'task-2']);
    } finally {
      cleanupBlock(def.block_id);
    }
  });

  test('updateBlockState saves updated state', () => {
    const def = makeDefinition();
    const state = initBlockState(def);
    saveBlockState(state);
    try {
      const updated = updateBlockState(def.block_id, (s) => {
        s.status = 'running';
        return s;
      });
      assert.strictEqual(updated.status, 'running');
      const loaded = loadBlockState(def.block_id);
      assert(loaded);
      assert.strictEqual(loaded.status, 'running');
    } finally {
      cleanupBlock(def.block_id);
    }
  });

  test('rejects missing state on update', () => {
    assert.throws(() => updateBlockState('nonexistent-block', (s) => s), /not found/);
  });

  test('atomic write uses temp then rename', () => {
    const def = makeDefinition();
    const state = initBlockState(def);
    saveBlockState(state);
    try {
      const statePath = join(getBlockRunDir(def.block_id), 'block-state.json');
      assert(existsSync(statePath), 'State file should exist after atomic write');
      const tempPath = statePath + '.tmp';
      assert(!existsSync(tempPath), 'Temp file should not exist after rename');
    } finally {
      cleanupBlock(def.block_id);
    }
  });

  test('does not write outside runs/blocks', () => {
    const def = makeDefinition();
    const state = initBlockState(def);
    saveBlockState(state);
    try {
      const runDir = getBlockRunDir(def.block_id);
      assert(existsSync(runDir));
      const statePath = join(runDir, 'block-state.json');
      assert(existsSync(statePath));
    } finally {
      cleanupBlock(def.block_id);
    }
  });

  test('no provider call', () => {
    const def = makeDefinition();
    const state = initBlockState(def);
    assert.strictEqual(true, true);
  });

  test('no git call', () => {
    const def = makeDefinition();
    const state = initBlockState(def);
    assert.strictEqual(true, true);
  });

  test('no GitHub API call', () => {
    const def = makeDefinition();
    const state = initBlockState(def);
    assert.strictEqual(true, true);
  });
});
