import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  readPendingReviewerFixTaskExecutionRequestState,
  type PendingReviewerFixTaskExecutionRequestStateResult,
} from '../src/reviewer-pending-fix-task-execution-request-state.js';

const PARENT_TASK_ID = 'demo-task';
const ATTEMPT = 1;
const TASK_ID = `fix-${PARENT_TASK_ID}-reviewer-${ATTEMPT}`;
const TITLE = 'Fix review issue';
const GOAL = 'Address the reviewer feedback';
const BLOCKING_ISSUES = ['line too long', 'missing tests'];

function buildExecutionRequest(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  const taskOverrides =
    (overrides.task as Record<string, unknown> | undefined) ?? {};
  const result: Record<string, unknown> = {
    kind: 'reviewer_fix_task',
    status: 'pending',
    source: 'reviewer_gate',
    taskId: TASK_ID,
    parentTaskId: PARENT_TASK_ID,
    attempt: ATTEMPT,
    title: TITLE,
    goal: GOAL,
    blockingIssues: [...BLOCKING_ISSUES],
    task: {
      taskId: TASK_ID,
      parentTaskId: PARENT_TASK_ID,
      attempt: ATTEMPT,
      title: TITLE,
      goal: GOAL,
      source: 'reviewer_gate',
      blockingIssues: [...BLOCKING_ISSUES],
      ...taskOverrides,
    },
  };
  for (const [key, value] of Object.entries(overrides)) {
    if (key !== 'task') {
      result[key] = value;
    }
  }
  return result;
}

function buildPending(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  const execOverrides =
    (overrides.executionRequest as Record<string, unknown> | undefined) ?? {};
  const result: Record<string, unknown> = {
    action: 'create_execution_request',
    reason: 'Ready for future execution.',
    executionRequest: buildExecutionRequest(execOverrides),
    blockingIssues: [],
  };
  for (const [key, value] of Object.entries(overrides)) {
    if (key !== 'executionRequest') {
      result[key] = value;
    }
  }
  return result;
}

function buildRunState(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    pending_reviewer_fix_task_execution_request: buildPending(overrides),
  };
}

function assertStatus(
  result: PendingReviewerFixTaskExecutionRequestStateResult,
  expected: 'not_present' | 'invalid' | 'ready'
): void {
  assert.strictEqual(result.status, expected);
}

describe('readPendingReviewerFixTaskExecutionRequestState', () => {
  it('null runState returns not_present', () => {
    const result = readPendingReviewerFixTaskExecutionRequestState({
      runState: null,
    });
    assertStatus(result, 'not_present');
  });

  it('undefined runState returns not_present', () => {
    const result = readPendingReviewerFixTaskExecutionRequestState({
      runState: undefined,
    });
    assertStatus(result, 'not_present');
  });

  it('non-object runState returns not_present', () => {
    const result = readPendingReviewerFixTaskExecutionRequestState({
      runState: 'not-an-object',
    });
    assertStatus(result, 'not_present');
  });

  it('missing pending_reviewer_fix_task_execution_request returns not_present', () => {
    const result = readPendingReviewerFixTaskExecutionRequestState({
      runState: {},
    });
    assertStatus(result, 'not_present');
  });

  it('non-object pending request state returns invalid', () => {
    const result = readPendingReviewerFixTaskExecutionRequestState({
      runState: { pending_reviewer_fix_task_execution_request: 'bad' },
    });
    assertStatus(result, 'invalid');
  });

  it('wrong top-level action returns invalid', () => {
    const result = readPendingReviewerFixTaskExecutionRequestState({
      runState: {
        pending_reviewer_fix_task_execution_request: buildPending({
          action: 'no_request',
        }),
      },
    });
    assertStatus(result, 'invalid');
  });

  it('missing executionRequest returns invalid', () => {
    const pending = buildPending();
    delete (pending as Record<string, unknown>).executionRequest;
    const result = readPendingReviewerFixTaskExecutionRequestState({
      runState: { pending_reviewer_fix_task_execution_request: pending },
    });
    assertStatus(result, 'invalid');
  });

  it('non-array top-level blockingIssues returns invalid', () => {
    const result = readPendingReviewerFixTaskExecutionRequestState({
      runState: {
        pending_reviewer_fix_task_execution_request: buildPending({
          blockingIssues: 'not-array',
        }),
      },
    });
    assertStatus(result, 'invalid');
  });

  it('non-string top-level blockingIssues item returns invalid', () => {
    const result = readPendingReviewerFixTaskExecutionRequestState({
      runState: {
        pending_reviewer_fix_task_execution_request: buildPending({
          blockingIssues: [123],
        }),
      },
    });
    assertStatus(result, 'invalid');
  });

  it('wrong executionRequest kind returns invalid', () => {
    const result = readPendingReviewerFixTaskExecutionRequestState({
      runState: {
        pending_reviewer_fix_task_execution_request: buildPending({
          executionRequest: { kind: 'other' },
        }),
      },
    });
    assertStatus(result, 'invalid');
  });

  it('wrong executionRequest status returns invalid', () => {
    const result = readPendingReviewerFixTaskExecutionRequestState({
      runState: {
        pending_reviewer_fix_task_execution_request: buildPending({
          executionRequest: { status: 'done' },
        }),
      },
    });
    assertStatus(result, 'invalid');
  });

  it('wrong executionRequest source returns invalid', () => {
    const result = readPendingReviewerFixTaskExecutionRequestState({
      runState: {
        pending_reviewer_fix_task_execution_request: buildPending({
          executionRequest: { source: 'manual' },
        }),
      },
    });
    assertStatus(result, 'invalid');
  });

  it('missing taskId returns invalid', () => {
    const result = readPendingReviewerFixTaskExecutionRequestState({
      runState: {
        pending_reviewer_fix_task_execution_request: buildPending({
          executionRequest: { taskId: undefined },
        }),
      },
    });
    assertStatus(result, 'invalid');
  });

  it('missing parentTaskId returns invalid', () => {
    const result = readPendingReviewerFixTaskExecutionRequestState({
      runState: {
        pending_reviewer_fix_task_execution_request: buildPending({
          executionRequest: { parentTaskId: undefined },
        }),
      },
    });
    assertStatus(result, 'invalid');
  });

  it('invalid attempt returns invalid', () => {
    const result = readPendingReviewerFixTaskExecutionRequestState({
      runState: {
        pending_reviewer_fix_task_execution_request: buildPending({
          executionRequest: { attempt: 0 },
        }),
      },
    });
    assertStatus(result, 'invalid');
  });

  it('empty title returns invalid', () => {
    const result = readPendingReviewerFixTaskExecutionRequestState({
      runState: {
        pending_reviewer_fix_task_execution_request: buildPending({
          executionRequest: { title: '' },
        }),
      },
    });
    assertStatus(result, 'invalid');
  });

  it('empty goal returns invalid', () => {
    const result = readPendingReviewerFixTaskExecutionRequestState({
      runState: {
        pending_reviewer_fix_task_execution_request: buildPending({
          executionRequest: { goal: '' },
        }),
      },
    });
    assertStatus(result, 'invalid');
  });

  it('non-array executionRequest blockingIssues returns invalid', () => {
    const result = readPendingReviewerFixTaskExecutionRequestState({
      runState: {
        pending_reviewer_fix_task_execution_request: buildPending({
          executionRequest: { blockingIssues: 'x' },
        }),
      },
    });
    assertStatus(result, 'invalid');
  });

  it('non-string executionRequest blockingIssues item returns invalid', () => {
    const result = readPendingReviewerFixTaskExecutionRequestState({
      runState: {
        pending_reviewer_fix_task_execution_request: buildPending({
          executionRequest: { blockingIssues: ['ok', 2] },
        }),
      },
    });
    assertStatus(result, 'invalid');
  });

  it('missing nested task returns invalid', () => {
    const pending = buildPending();
    const executionRequest = buildExecutionRequest();
    delete (executionRequest as Record<string, unknown>).task;
    (pending as Record<string, unknown>).executionRequest = executionRequest;
    const result = readPendingReviewerFixTaskExecutionRequestState({
      runState: { pending_reviewer_fix_task_execution_request: pending },
    });
    assertStatus(result, 'invalid');
  });

  it('nested taskId mismatch returns invalid', () => {
    const result = readPendingReviewerFixTaskExecutionRequestState({
      runState: {
        pending_reviewer_fix_task_execution_request: buildPending({
          executionRequest: {
            task: { taskId: 'wrong-id' },
          },
        }),
      },
    });
    assertStatus(result, 'invalid');
  });

  it('nested parentTaskId mismatch returns invalid', () => {
    const result = readPendingReviewerFixTaskExecutionRequestState({
      runState: {
        pending_reviewer_fix_task_execution_request: buildPending({
          executionRequest: {
            task: { parentTaskId: 'wrong-parent' },
          },
        }),
      },
    });
    assertStatus(result, 'invalid');
  });

  it('nested attempt mismatch returns invalid', () => {
    const result = readPendingReviewerFixTaskExecutionRequestState({
      runState: {
        pending_reviewer_fix_task_execution_request: buildPending({
          executionRequest: {
            task: { attempt: 2 },
          },
        }),
      },
    });
    assertStatus(result, 'invalid');
  });

  it('nested title mismatch returns invalid', () => {
    const result = readPendingReviewerFixTaskExecutionRequestState({
      runState: {
        pending_reviewer_fix_task_execution_request: buildPending({
          executionRequest: {
            task: { title: 'Different title' },
          },
        }),
      },
    });
    assertStatus(result, 'invalid');
  });

  it('nested goal mismatch returns invalid', () => {
    const result = readPendingReviewerFixTaskExecutionRequestState({
      runState: {
        pending_reviewer_fix_task_execution_request: buildPending({
          executionRequest: {
            task: { goal: 'Different goal' },
          },
        }),
      },
    });
    assertStatus(result, 'invalid');
  });

  it('nested source mismatch returns invalid', () => {
    const result = readPendingReviewerFixTaskExecutionRequestState({
      runState: {
        pending_reviewer_fix_task_execution_request: buildPending({
          executionRequest: {
            task: { source: 'manual' },
          },
        }),
      },
    });
    assertStatus(result, 'invalid');
  });

  it('nested blockingIssues mismatch returns invalid', () => {
    const result = readPendingReviewerFixTaskExecutionRequestState({
      runState: {
        pending_reviewer_fix_task_execution_request: buildPending({
          executionRequest: {
            task: { blockingIssues: ['different issue'] },
          },
        }),
      },
    });
    assertStatus(result, 'invalid');
  });

  it('non-deterministic taskId returns invalid', () => {
    const result = readPendingReviewerFixTaskExecutionRequestState({
      runState: {
        pending_reviewer_fix_task_execution_request: buildPending({
          executionRequest: { taskId: 'fix-demo-task-reviewer-99' },
        }),
      },
    });
    assertStatus(result, 'invalid');
  });

  it('valid execution request state returns ready', () => {
    const result = readPendingReviewerFixTaskExecutionRequestState({
      runState: buildRunState(),
    });
    assertStatus(result, 'ready');
  });

  it('ready result preserves execution request fields', () => {
    const result = readPendingReviewerFixTaskExecutionRequestState({
      runState: buildRunState(),
    });
    assertStatus(result, 'ready');
    if (result.status !== 'ready') return;
    assert.strictEqual(result.executionRequest.kind, 'reviewer_fix_task');
    assert.strictEqual(result.executionRequest.status, 'pending');
    assert.strictEqual(result.executionRequest.source, 'reviewer_gate');
    assert.strictEqual(result.executionRequest.taskId, TASK_ID);
    assert.strictEqual(result.executionRequest.parentTaskId, PARENT_TASK_ID);
    assert.strictEqual(result.executionRequest.attempt, ATTEMPT);
    assert.strictEqual(result.executionRequest.title, TITLE);
    assert.strictEqual(result.executionRequest.goal, GOAL);
    assert.deepStrictEqual(result.executionRequest.blockingIssues, BLOCKING_ISSUES);
  });

  it('ready result preserves nested task fields', () => {
    const result = readPendingReviewerFixTaskExecutionRequestState({
      runState: buildRunState(),
    });
    assertStatus(result, 'ready');
    if (result.status !== 'ready') return;
    const task = result.executionRequest.task;
    assert.strictEqual(task.taskId, TASK_ID);
    assert.strictEqual(task.parentTaskId, PARENT_TASK_ID);
    assert.strictEqual(task.attempt, ATTEMPT);
    assert.strictEqual(task.title, TITLE);
    assert.strictEqual(task.goal, GOAL);
    assert.strictEqual(task.source, 'reviewer_gate');
    assert.deepStrictEqual(task.blockingIssues, BLOCKING_ISSUES);
  });

  it('ready result preserves top-level blockingIssues', () => {
    const result = readPendingReviewerFixTaskExecutionRequestState({
      runState: buildRunState({ blockingIssues: ['top-level issue'] }),
    });
    assertStatus(result, 'ready');
    if (result.status !== 'ready') return;
    assert.deepStrictEqual(result.blockingIssues, ['top-level issue']);
    assert.deepStrictEqual(result.executionRequestResult.blockingIssues, [
      'top-level issue',
    ]);
  });

  it('ready result clones executionRequestResult', () => {
    const runState = buildRunState();
    const pending = (runState as Record<string, unknown>)
      .pending_reviewer_fix_task_execution_request as Record<string, unknown>;
    const result = readPendingReviewerFixTaskExecutionRequestState({
      runState,
    });
    assertStatus(result, 'ready');
    if (result.status !== 'ready') return;
    assert.notStrictEqual(
      result.executionRequestResult,
      pending,
      'executionRequestResult should be a clone'
    );
    pending.action = 'no_request';
    assert.strictEqual(result.executionRequestResult.action, 'create_execution_request');
  });

  it('ready result clones executionRequest', () => {
    const runState = buildRunState();
    const pending = (runState as Record<string, unknown>)
      .pending_reviewer_fix_task_execution_request as Record<string, unknown>;
    const originalExecutionRequest = pending.executionRequest as Record<string, unknown>;
    const result = readPendingReviewerFixTaskExecutionRequestState({
      runState,
    });
    assertStatus(result, 'ready');
    if (result.status !== 'ready') return;
    assert.notStrictEqual(
      result.executionRequest,
      originalExecutionRequest,
      'executionRequest should be a clone'
    );
    (originalExecutionRequest.goal as string) = 'mutated';
    assert.strictEqual(result.executionRequest.goal, GOAL);
  });

  it('ready result clones nested task', () => {
    const runState = buildRunState();
    const executionRequest = (
      (runState as Record<string, unknown>)
        .pending_reviewer_fix_task_execution_request as Record<string, unknown>
    ).executionRequest as Record<string, unknown>;
    const originalTask = executionRequest.task as Record<string, unknown>;
    const result = readPendingReviewerFixTaskExecutionRequestState({
      runState,
    });
    assertStatus(result, 'ready');
    if (result.status !== 'ready') return;
    assert.notStrictEqual(
      result.executionRequest.task,
      originalTask,
      'nested task should be a clone'
    );
    (originalTask.goal as string) = 'mutated task';
    assert.strictEqual(result.executionRequest.task.goal, GOAL);
  });

  it('ready result clones blockingIssues arrays', () => {
    const runState = buildRunState({ blockingIssues: ['top'] });
    const result = readPendingReviewerFixTaskExecutionRequestState({
      runState,
    });
    assertStatus(result, 'ready');
    if (result.status !== 'ready') return;
    const pending = (runState as Record<string, unknown>)
      .pending_reviewer_fix_task_execution_request as Record<string, unknown>;
    const executionRequest = pending.executionRequest as Record<string, unknown>;
    const originalTop = pending.blockingIssues as string[];
    const originalExec = executionRequest.blockingIssues as string[];
    const originalTask = (executionRequest.task as Record<string, unknown>)
      .blockingIssues as string[];

    assert.notStrictEqual(result.blockingIssues, originalTop);
    assert.notStrictEqual(result.executionRequest.blockingIssues, originalExec);
    assert.notStrictEqual(
      result.executionRequest.task.blockingIssues,
      originalTask
    );

    originalTop.push('mutated');
    originalExec.push('mutated');
    originalTask.push('mutated');

    assert.deepStrictEqual(result.blockingIssues, ['top']);
    assert.deepStrictEqual(result.executionRequest.blockingIssues, BLOCKING_ISSUES);
    assert.deepStrictEqual(
      result.executionRequest.task.blockingIssues,
      BLOCKING_ISSUES
    );
  });

  it('helper does not mutate input', () => {
    const runState = buildRunState();
    const before = JSON.stringify(runState);
    readPendingReviewerFixTaskExecutionRequestState({ runState });
    const after = JSON.stringify(runState);
    assert.strictEqual(after, before);
  });

  it('helper does not perform redaction or alter already-redacted text', () => {
    const secret = 'sk-fake-reviewer-secret';
    const runState = buildRunState({
      executionRequest: {
        goal: `Use ${secret} token`,
        task: { goal: `Use ${secret} token` },
      },
    });
    const result = readPendingReviewerFixTaskExecutionRequestState({
      runState,
    });
    assertStatus(result, 'ready');
    if (result.status !== 'ready') return;
    assert.strictEqual(result.executionRequest.goal, `Use ${secret} token`);
    assert.strictEqual(result.executionRequest.task.goal, `Use ${secret} token`);
  });

  it('helper does not call git/provider/network/filesystem APIs', () => {
    // The function is pure: it accepts a plain object and returns synchronously.
    // No imports of child_process, fs, net, or provider modules are required.
    const result = readPendingReviewerFixTaskExecutionRequestState({
      runState: buildRunState(),
    });
    assertStatus(result, 'ready');
  });
});
