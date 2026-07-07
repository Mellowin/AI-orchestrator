import { describe, test } from 'node:test';
import assert from 'node:assert';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadState, getRunDir } from '../src/state-manager.js';

function makeBlockedState(taskId: string) {
  return {
    task_id: taskId,
    status: 'blocked',
    current_attempt: 0,
    branch: 'main',
    repo_path: '/tmp/repo',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    blocked_by: 'safety_policy',
    applied: false,
    committed: false,
    pushed: false,
    safety_policy_reasons: ['denied file touched'],
    safety_note: 'Blocked by deterministic safety policy before apply',
  };
}

describe('state-manager blocked status', () => {
  function createTempRunsDir(): string {
    return mkdtempSync(join(tmpdir(), 'state-manager-blocked-'));
  }

  test('loadState accepts RunState with status blocked', () => {
    const runsDir = createTempRunsDir();
    try {
      const taskId = 'blocked-task';
      const runDir = getRunDir(taskId, runsDir);
      mkdirSync(runDir, { recursive: true });
      writeFileSync(
        join(runDir, 'state.json'),
        JSON.stringify(makeBlockedState(taskId)),
        'utf-8'
      );

      const state = loadState(taskId, runsDir);
      assert(state !== null);
      assert.strictEqual(state.status, 'blocked');
      assert.strictEqual(state.blocked_by, 'safety_policy');
    } finally {
      rmSync(runsDir, { recursive: true, force: true });
    }
  });

  test('loadState still rejects unknown statuses', () => {
    const runsDir = createTempRunsDir();
    try {
      const taskId = 'weird-task';
      const runDir = getRunDir(taskId, runsDir);
      mkdirSync(runDir, { recursive: true });
      const badState = makeBlockedState(taskId);
      (badState as Record<string, unknown>).status = 'weird_status';
      writeFileSync(
        join(runDir, 'state.json'),
        JSON.stringify(badState),
        'utf-8'
      );

      assert.throws(() => loadState(taskId, runsDir), /unknown status/);
    } finally {
      rmSync(runsDir, { recursive: true, force: true });
    }
  });
});
