import { describe, test } from 'node:test';
import assert from 'node:assert';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { BlockDefinition } from '../src/block/block-types.js';
import {
  getBlockStatePath,
  loadExistingBlockState,
} from '../src/real-block-run-ai-state.js';

function makeBlock(overrides?: Partial<BlockDefinition>): BlockDefinition {
  return {
    block_id: 'state-reload-block',
    title: 'State reload test',
    repo_path: '/tmp/repo',
    base_branch: 'main',
    work_branch: 'ai/block-work',
    providers: {
      coder: { provider: 'kimi', model: 'kimi-k2.6' },
      reviewer: { provider: 'fake', model: 'gpt-4o' },
    },
    review_policy: {
      require_deterministic_checks: false,
      max_fix_attempts: 1,
      reviewer_mode: 'single',
      on_blocked_task: 'stop',
      task_timeout_ms: 120000,
    },
    tasks: [
      {
        task_id: 'task-1',
        title: 'Task one',
        goal: 'Do one thing',
        allowed_files: ['README.md'],
        denied_files: [],
        max_lines_changed: 100,
        checks: [],
      },
    ],
    ...overrides,
  } as BlockDefinition;
}

function makeCompletedWithCaveatsState(statePath: string) {
  return {
    block_id: 'state-reload-block',
    title: 'State reload test',
    status: 'completed_with_caveats',
    currentTaskId: null,
    statePath,
    taskResults: [
      {
        taskId: 'task-1',
        title: 'Task one',
        status: 'accepted',
        originalCommitSha: 'a'.repeat(40),
        fixAttempted: false,
        finalStatus: 'accepted',
        nextAction: 'continue',
        childStateTaskId: 'task-1',
      },
    ],
    summary: {
      totalTasks: 1,
      acceptedTasks: 1,
      fixedTasks: 0,
      completedTasks: 1,
      skippedBlockedTasks: 1,
      stoppedReason: 'All tasks finished; 1 task(s) blocked/skipped.',
    },
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    safetyNote: 'Test state',
  };
}

describe('real-block-run-ai state persistence', () => {
  function createTempEnv(): { runsDir: string; cleanup: () => void } {
    const runsDir = mkdtempSync(join(tmpdir(), 'rbrai-state-test-'));
    return {
      runsDir,
      cleanup: () => {
        rmSync(runsDir, { recursive: true, force: true });
      },
    };
  }

  test('loadExistingBlockState accepts completed_with_caveats status', () => {
    const { runsDir, cleanup } = createTempEnv();
    const previousRunsDir = process.env.RUNS_DIR;
    process.env.RUNS_DIR = runsDir;
    try {
      const block = makeBlock();
      const statePath = getBlockStatePath(block);
      mkdirSync(join(runsDir, 'block', block.block_id), { recursive: true });
      writeFileSync(
        statePath,
        JSON.stringify(makeCompletedWithCaveatsState(statePath)),
        'utf-8'
      );

      const loaded = loadExistingBlockState(block);
      assert.notStrictEqual(loaded, null);
      assert.strictEqual(loaded?.status, 'completed_with_caveats');
      assert.strictEqual(loaded?.summary.skippedBlockedTasks, 1);
      assert.strictEqual(loaded?.taskResults[0].status, 'accepted');
    } finally {
      if (previousRunsDir === undefined) {
        delete process.env.RUNS_DIR;
      } else {
        process.env.RUNS_DIR = previousRunsDir;
      }
      cleanup();
    }
  });

  test('loadExistingBlockState still rejects unknown statuses', () => {
    const { runsDir, cleanup } = createTempEnv();
    const previousRunsDir = process.env.RUNS_DIR;
    process.env.RUNS_DIR = runsDir;
    try {
      const block = makeBlock();
      const statePath = getBlockStatePath(block);
      mkdirSync(join(runsDir, 'block', block.block_id), { recursive: true });
      const badState = makeCompletedWithCaveatsState(statePath);
      (badState as Record<string, unknown>).status = 'unknown_status';
      writeFileSync(statePath, JSON.stringify(badState), 'utf-8');

      assert.throws(
        () => loadExistingBlockState(block),
        /invalid status/
      );
    } finally {
      if (previousRunsDir === undefined) {
        delete process.env.RUNS_DIR;
      } else {
        process.env.RUNS_DIR = previousRunsDir;
      }
      cleanup();
    }
  });
});
