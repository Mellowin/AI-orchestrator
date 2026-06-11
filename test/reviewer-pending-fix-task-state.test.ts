import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  readPendingReviewerFixTaskState,
  type PendingReviewerFixTaskStateResult,
} from '../src/reviewer-pending-fix-task-state.js';

function buildValidPendingFixTask(parentTaskId: string, attempt: number) {
  return {
    status: 'pending' as const,
    source: 'reviewer_gate' as const,
    task: {
      taskId: `fix-${parentTaskId}-reviewer-${attempt}`,
      parentTaskId,
      title: 'Fix title',
      goal: 'Fix goal',
      attempt,
      blockingIssues: ['issue one', 'issue two'],
      source: 'reviewer_gate' as const,
    },
    parentTaskId,
    attempt,
    createdFromResolutionAction: 'append_fix_task' as const,
  };
}

function buildRunState(pending: unknown) {
  return { status: 'pushed', pending_reviewer_fix_task: pending };
}

function assertNotPresent(result: PendingReviewerFixTaskStateResult) {
  assert.strictEqual(result.status, 'not_present');
  assert.strictEqual(result.pendingFixTask, undefined);
}

function assertInvalid(result: PendingReviewerFixTaskStateResult) {
  assert.strictEqual(result.status, 'invalid');
  assert.strictEqual(result.pendingFixTask, undefined);
  assert.ok(result.blockingIssues.length > 0, 'Invalid result should include blocking issue');
}

function assertReady(result: PendingReviewerFixTaskStateResult) {
  assert.strictEqual(result.status, 'ready');
  assert.ok(result.pendingFixTask, 'Ready result should include pendingFixTask');
}

describe('readPendingReviewerFixTaskState', () => {
  test('null runState returns not_present', () => {
    assertNotPresent(readPendingReviewerFixTaskState({ runState: null }));
  });

  test('undefined runState returns not_present', () => {
    assertNotPresent(readPendingReviewerFixTaskState({ runState: undefined }));
  });

  test('non-object runState returns not_present', () => {
    assertNotPresent(readPendingReviewerFixTaskState({ runState: 'state' }));
  });

  test('missing pending_reviewer_fix_task returns not_present', () => {
    assertNotPresent(readPendingReviewerFixTaskState({ runState: { status: 'pushed' } }));
  });

  test('non-object pending_reviewer_fix_task returns invalid', () => {
    assertInvalid(readPendingReviewerFixTaskState({ runState: buildRunState('not-an-object') }));
  });

  test('wrong status returns invalid', () => {
    const pending = buildValidPendingFixTask('task-1', 1);
    assertInvalid(
      readPendingReviewerFixTaskState({
        runState: buildRunState({ ...pending, status: 'running' }),
      })
    );
  });

  test('wrong source returns invalid', () => {
    const pending = buildValidPendingFixTask('task-1', 1);
    assertInvalid(
      readPendingReviewerFixTaskState({
        runState: buildRunState({ ...pending, source: 'manual' }),
      })
    );
  });

  test('wrong createdFromResolutionAction returns invalid', () => {
    const pending = buildValidPendingFixTask('task-1', 1);
    assertInvalid(
      readPendingReviewerFixTaskState({
        runState: buildRunState({ ...pending, createdFromResolutionAction: 'unknown' }),
      })
    );
  });

  test('missing parentTaskId returns invalid', () => {
    const pending = buildValidPendingFixTask('task-1', 1);
    const { parentTaskId: _, ...withoutParent } = pending;
    assertInvalid(
      readPendingReviewerFixTaskState({ runState: buildRunState(withoutParent) })
    );
  });

  test('invalid attempt returns invalid', () => {
    const pending = buildValidPendingFixTask('task-1', 1);
    assertInvalid(
      readPendingReviewerFixTaskState({
        runState: buildRunState({ ...pending, attempt: 0 }),
      })
    );
  });

  test('missing task returns invalid', () => {
    const pending = buildValidPendingFixTask('task-1', 1);
    const { task: _, ...withoutTask } = pending;
    assertInvalid(
      readPendingReviewerFixTaskState({ runState: buildRunState(withoutTask) })
    );
  });

  test('missing taskId returns invalid', () => {
    const pending = buildValidPendingFixTask('task-1', 1);
    const task = { ...pending.task };
    delete (task as Record<string, unknown>).taskId;
    assertInvalid(
      readPendingReviewerFixTaskState({
        runState: buildRunState({ ...pending, task }),
      })
    );
  });

  test('task parentTaskId mismatch returns invalid', () => {
    const pending = buildValidPendingFixTask('task-1', 1);
    assertInvalid(
      readPendingReviewerFixTaskState({
        runState: buildRunState({
          ...pending,
          task: { ...pending.task, parentTaskId: 'task-2' },
        }),
      })
    );
  });

  test('task attempt mismatch returns invalid', () => {
    const pending = buildValidPendingFixTask('task-1', 1);
    assertInvalid(
      readPendingReviewerFixTaskState({
        runState: buildRunState({
          ...pending,
          task: { ...pending.task, attempt: 2 },
        }),
      })
    );
  });

  test('task source mismatch returns invalid', () => {
    const pending = buildValidPendingFixTask('task-1', 1);
    assertInvalid(
      readPendingReviewerFixTaskState({
        runState: buildRunState({
          ...pending,
          task: { ...pending.task, source: 'manual' },
        }),
      })
    );
  });

  test('empty title returns invalid', () => {
    const pending = buildValidPendingFixTask('task-1', 1);
    assertInvalid(
      readPendingReviewerFixTaskState({
        runState: buildRunState({
          ...pending,
          task: { ...pending.task, title: '' },
        }),
      })
    );
  });

  test('empty goal returns invalid', () => {
    const pending = buildValidPendingFixTask('task-1', 1);
    assertInvalid(
      readPendingReviewerFixTaskState({
        runState: buildRunState({
          ...pending,
          task: { ...pending.task, goal: '' },
        }),
      })
    );
  });

  test('non-array blockingIssues returns invalid', () => {
    const pending = buildValidPendingFixTask('task-1', 1);
    assertInvalid(
      readPendingReviewerFixTaskState({
        runState: buildRunState({
          ...pending,
          task: { ...pending.task, blockingIssues: 'issue' },
        }),
      })
    );
  });

  test('non-string blockingIssues item returns invalid', () => {
    const pending = buildValidPendingFixTask('task-1', 1);
    assertInvalid(
      readPendingReviewerFixTaskState({
        runState: buildRunState({
          ...pending,
          task: { ...pending.task, blockingIssues: ['issue', 123] },
        }),
      })
    );
  });

  test('non-deterministic taskId returns invalid', () => {
    const pending = buildValidPendingFixTask('task-1', 1);
    assertInvalid(
      readPendingReviewerFixTaskState({
        runState: buildRunState({
          ...pending,
          task: { ...pending.task, taskId: 'fix-task-1-manual-1' },
        }),
      })
    );
  });

  test('valid pending task returns ready', () => {
    const result = readPendingReviewerFixTaskState({
      runState: buildRunState(buildValidPendingFixTask('task-1', 1)),
    });
    assertReady(result);
    assert.strictEqual(result.reason, 'Pending reviewer fix task is valid and ready.');
  });

  test('ready result preserves parentTaskId', () => {
    const result = readPendingReviewerFixTaskState({
      runState: buildRunState(buildValidPendingFixTask('task-1', 1)),
    });
    assertReady(result);
    assert.strictEqual(result.pendingFixTask.parentTaskId, 'task-1');
  });

  test('ready result preserves attempt', () => {
    const result = readPendingReviewerFixTaskState({
      runState: buildRunState(buildValidPendingFixTask('task-1', 2)),
    });
    assertReady(result);
    assert.strictEqual(result.pendingFixTask.attempt, 2);
  });

  test('ready result preserves task fields', () => {
    const result = readPendingReviewerFixTaskState({
      runState: buildRunState(buildValidPendingFixTask('task-1', 1)),
    });
    assertReady(result);
    const task = result.pendingFixTask.task;
    assert.strictEqual(task.taskId, 'fix-task-1-reviewer-1');
    assert.strictEqual(task.parentTaskId, 'task-1');
    assert.strictEqual(task.title, 'Fix title');
    assert.strictEqual(task.goal, 'Fix goal');
    assert.strictEqual(task.attempt, 1);
    assert.strictEqual(task.source, 'reviewer_gate');
  });

  test('ready result preserves blockingIssues', () => {
    const result = readPendingReviewerFixTaskState({
      runState: buildRunState(buildValidPendingFixTask('task-1', 1)),
    });
    assertReady(result);
    assert.deepStrictEqual(result.pendingFixTask.task.blockingIssues, [
      'issue one',
      'issue two',
    ]);
  });

  test('ready result clones returned pending task', () => {
    const pending = buildValidPendingFixTask('task-1', 1);
    const result = readPendingReviewerFixTaskState({
      runState: buildRunState(pending),
    });
    assertReady(result);
    assert.notStrictEqual(result.pendingFixTask, pending);
    assert.notStrictEqual(result.pendingFixTask.task, pending.task);
    assert.notStrictEqual(
      result.pendingFixTask.task.blockingIssues,
      pending.task.blockingIssues
    );
  });

  test('helper does not mutate input', () => {
    const pending = buildValidPendingFixTask('task-1', 1);
    const runState = buildRunState(pending);
    const original = JSON.stringify(runState);
    readPendingReviewerFixTaskState({ runState });
    assert.strictEqual(JSON.stringify(runState), original);
  });

  test('helper does not perform redaction or alter already-redacted text', () => {
    const pending = buildValidPendingFixTask('task-1', 1);
    pending.task.goal = 'Fix sk-fake-secret and Bearer fake-token';
    pending.task.blockingIssues = ['sk-fake-secret', 'Bearer fake-token'];
    const result = readPendingReviewerFixTaskState({
      runState: buildRunState(pending),
    });
    assertReady(result);
    assert.strictEqual(
      result.pendingFixTask.task.goal,
      'Fix sk-fake-secret and Bearer fake-token'
    );
    assert.deepStrictEqual(result.pendingFixTask.task.blockingIssues, [
      'sk-fake-secret',
      'Bearer fake-token',
    ]);
  });

  test('helper does not call git/provider/network/filesystem APIs', () => {
    const result = readPendingReviewerFixTaskState({
      runState: buildRunState(buildValidPendingFixTask('task-1', 1)),
    });
    assertReady(result);
  });
});
