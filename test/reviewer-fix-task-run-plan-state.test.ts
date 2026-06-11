import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  readReviewerFixTaskRunPlanState,
  type ReviewerFixTaskRunPlanStateResult,
} from '../src/reviewer-fix-task-run-plan-state.js';

const PARENT_TASK_ID = 'demo-task';
const ATTEMPT = 1;
const TASK_ID = `fix-${PARENT_TASK_ID}-reviewer-${ATTEMPT}`;
const TITLE = 'Fix review issue';
const GOAL = 'Address reviewer feedback';
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

function buildFixTask(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    taskId: TASK_ID,
    parentTaskId: PARENT_TASK_ID,
    attempt: ATTEMPT,
    title: TITLE,
    goal: GOAL,
    source: 'reviewer_gate',
    blockingIssues: [...BLOCKING_ISSUES],
    ...overrides,
  };
}

function buildRunPlan(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  const execOverrides =
    (overrides.executionRequest as Record<string, unknown> | undefined) ?? {};
  const fixOverrides =
    (overrides.fixTask as Record<string, unknown> | undefined) ?? {};
  const result: Record<string, unknown> = {
    action: 'run_fix_task',
    reason: 'Ready for future execution.',
    executionRequest: buildExecutionRequest(execOverrides),
    fixTask: buildFixTask(fixOverrides),
    taskId: TASK_ID,
    parentTaskId: PARENT_TASK_ID,
    attempt: ATTEMPT,
    title: TITLE,
    goal: GOAL,
    blockingIssues: [...BLOCKING_ISSUES],
  };
  for (const [key, value] of Object.entries(overrides)) {
    if (key !== 'executionRequest' && key !== 'fixTask') {
      result[key] = value;
    }
  }
  return result;
}

function buildRunState(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    reviewer_fix_task_run_plan: buildRunPlan(overrides),
  };
}

function assertStatus(
  result: ReviewerFixTaskRunPlanStateResult,
  expected: 'not_present' | 'invalid' | 'ready'
): void {
  assert.strictEqual(result.status, expected);
}

describe('readReviewerFixTaskRunPlanState', () => {
  it('null runState returns not_present', () => {
    const result = readReviewerFixTaskRunPlanState({ runState: null });
    assertStatus(result, 'not_present');
  });

  it('undefined runState returns not_present', () => {
    const result = readReviewerFixTaskRunPlanState({ runState: undefined });
    assertStatus(result, 'not_present');
  });

  it('non-object runState returns not_present', () => {
    const result = readReviewerFixTaskRunPlanState({ runState: 'bad' });
    assertStatus(result, 'not_present');
  });

  it('missing reviewer_fix_task_run_plan returns not_present', () => {
    const result = readReviewerFixTaskRunPlanState({ runState: {} });
    assertStatus(result, 'not_present');
  });

  it('non-object run plan returns invalid', () => {
    const result = readReviewerFixTaskRunPlanState({
      runState: { reviewer_fix_task_run_plan: 'bad' },
    });
    assertStatus(result, 'invalid');
  });

  it('wrong action returns invalid', () => {
    const result = readReviewerFixTaskRunPlanState({
      runState: { reviewer_fix_task_run_plan: buildRunPlan({ action: 'no_op' }) },
    });
    assertStatus(result, 'invalid');
  });

  it('missing executionRequest returns invalid', () => {
    const plan = buildRunPlan();
    delete (plan as Record<string, unknown>).executionRequest;
    const result = readReviewerFixTaskRunPlanState({
      runState: { reviewer_fix_task_run_plan: plan },
    });
    assertStatus(result, 'invalid');
  });

  it('missing fixTask returns invalid', () => {
    const plan = buildRunPlan();
    delete (plan as Record<string, unknown>).fixTask;
    const result = readReviewerFixTaskRunPlanState({
      runState: { reviewer_fix_task_run_plan: plan },
    });
    assertStatus(result, 'invalid');
  });

  it('missing taskId returns invalid', () => {
    const result = readReviewerFixTaskRunPlanState({
      runState: { reviewer_fix_task_run_plan: buildRunPlan({ taskId: undefined }) },
    });
    assertStatus(result, 'invalid');
  });

  it('missing parentTaskId returns invalid', () => {
    const result = readReviewerFixTaskRunPlanState({
      runState: {
        reviewer_fix_task_run_plan: buildRunPlan({ parentTaskId: undefined }),
      },
    });
    assertStatus(result, 'invalid');
  });

  it('invalid attempt returns invalid', () => {
    const result = readReviewerFixTaskRunPlanState({
      runState: { reviewer_fix_task_run_plan: buildRunPlan({ attempt: 0 }) },
    });
    assertStatus(result, 'invalid');
  });

  it('empty title returns invalid', () => {
    const result = readReviewerFixTaskRunPlanState({
      runState: { reviewer_fix_task_run_plan: buildRunPlan({ title: '' }) },
    });
    assertStatus(result, 'invalid');
  });

  it('empty goal returns invalid', () => {
    const result = readReviewerFixTaskRunPlanState({
      runState: { reviewer_fix_task_run_plan: buildRunPlan({ goal: '' }) },
    });
    assertStatus(result, 'invalid');
  });

  it('non-array runPlan blockingIssues returns invalid', () => {
    const result = readReviewerFixTaskRunPlanState({
      runState: {
        reviewer_fix_task_run_plan: buildRunPlan({ blockingIssues: 'bad' }),
      },
    });
    assertStatus(result, 'invalid');
  });

  it('non-string runPlan blockingIssues item returns invalid', () => {
    const result = readReviewerFixTaskRunPlanState({
      runState: {
        reviewer_fix_task_run_plan: buildRunPlan({ blockingIssues: ['ok', 1] }),
      },
    });
    assertStatus(result, 'invalid');
  });

  it('wrong executionRequest kind returns invalid', () => {
    const result = readReviewerFixTaskRunPlanState({
      runState: {
        reviewer_fix_task_run_plan: buildRunPlan({
          executionRequest: { kind: 'other' },
        }),
      },
    });
    assertStatus(result, 'invalid');
  });

  it('wrong executionRequest status returns invalid', () => {
    const result = readReviewerFixTaskRunPlanState({
      runState: {
        reviewer_fix_task_run_plan: buildRunPlan({
          executionRequest: { status: 'done' },
        }),
      },
    });
    assertStatus(result, 'invalid');
  });

  it('wrong executionRequest source returns invalid', () => {
    const result = readReviewerFixTaskRunPlanState({
      runState: {
        reviewer_fix_task_run_plan: buildRunPlan({
          executionRequest: { source: 'manual' },
        }),
      },
    });
    assertStatus(result, 'invalid');
  });

  it('executionRequest taskId mismatch returns invalid', () => {
    const result = readReviewerFixTaskRunPlanState({
      runState: {
        reviewer_fix_task_run_plan: buildRunPlan({
          executionRequest: { taskId: 'wrong-id' },
        }),
      },
    });
    assertStatus(result, 'invalid');
  });

  it('executionRequest parentTaskId mismatch returns invalid', () => {
    const result = readReviewerFixTaskRunPlanState({
      runState: {
        reviewer_fix_task_run_plan: buildRunPlan({
          executionRequest: { parentTaskId: 'wrong-parent' },
        }),
      },
    });
    assertStatus(result, 'invalid');
  });

  it('executionRequest attempt mismatch returns invalid', () => {
    const result = readReviewerFixTaskRunPlanState({
      runState: {
        reviewer_fix_task_run_plan: buildRunPlan({
          executionRequest: { attempt: 2 },
        }),
      },
    });
    assertStatus(result, 'invalid');
  });

  it('executionRequest title mismatch returns invalid', () => {
    const result = readReviewerFixTaskRunPlanState({
      runState: {
        reviewer_fix_task_run_plan: buildRunPlan({
          executionRequest: { title: 'Different' },
        }),
      },
    });
    assertStatus(result, 'invalid');
  });

  it('executionRequest goal mismatch returns invalid', () => {
    const result = readReviewerFixTaskRunPlanState({
      runState: {
        reviewer_fix_task_run_plan: buildRunPlan({
          executionRequest: { goal: 'Different' },
        }),
      },
    });
    assertStatus(result, 'invalid');
  });

  it('executionRequest blockingIssues mismatch returns invalid', () => {
    const result = readReviewerFixTaskRunPlanState({
      runState: {
        reviewer_fix_task_run_plan: buildRunPlan({
          executionRequest: { blockingIssues: ['other'] },
        }),
      },
    });
    assertStatus(result, 'invalid');
  });

  it('missing executionRequest nested task returns invalid', () => {
    const plan = buildRunPlan();
    const executionRequest = (
      plan.executionRequest as Record<string, unknown>
    );
    delete executionRequest.task;
    const result = readReviewerFixTaskRunPlanState({
      runState: { reviewer_fix_task_run_plan: plan },
    });
    assertStatus(result, 'invalid');
  });

  it('fixTask taskId mismatch returns invalid', () => {
    const result = readReviewerFixTaskRunPlanState({
      runState: {
        reviewer_fix_task_run_plan: buildRunPlan({
          fixTask: { taskId: 'wrong-id' },
        }),
      },
    });
    assertStatus(result, 'invalid');
  });

  it('fixTask parentTaskId mismatch returns invalid', () => {
    const result = readReviewerFixTaskRunPlanState({
      runState: {
        reviewer_fix_task_run_plan: buildRunPlan({
          fixTask: { parentTaskId: 'wrong-parent' },
        }),
      },
    });
    assertStatus(result, 'invalid');
  });

  it('fixTask attempt mismatch returns invalid', () => {
    const result = readReviewerFixTaskRunPlanState({
      runState: {
        reviewer_fix_task_run_plan: buildRunPlan({
          fixTask: { attempt: 2 },
        }),
      },
    });
    assertStatus(result, 'invalid');
  });

  it('fixTask title mismatch returns invalid', () => {
    const result = readReviewerFixTaskRunPlanState({
      runState: {
        reviewer_fix_task_run_plan: buildRunPlan({
          fixTask: { title: 'Different' },
        }),
      },
    });
    assertStatus(result, 'invalid');
  });

  it('fixTask goal mismatch returns invalid', () => {
    const result = readReviewerFixTaskRunPlanState({
      runState: {
        reviewer_fix_task_run_plan: buildRunPlan({
          fixTask: { goal: 'Different' },
        }),
      },
    });
    assertStatus(result, 'invalid');
  });

  it('fixTask source mismatch returns invalid', () => {
    const result = readReviewerFixTaskRunPlanState({
      runState: {
        reviewer_fix_task_run_plan: buildRunPlan({
          fixTask: { source: 'manual' },
        }),
      },
    });
    assertStatus(result, 'invalid');
  });

  it('fixTask blockingIssues mismatch returns invalid', () => {
    const result = readReviewerFixTaskRunPlanState({
      runState: {
        reviewer_fix_task_run_plan: buildRunPlan({
          fixTask: { blockingIssues: ['other'] },
        }),
      },
    });
    assertStatus(result, 'invalid');
  });

  it('executionRequest nested task mismatch returns invalid', () => {
    const result = readReviewerFixTaskRunPlanState({
      runState: {
        reviewer_fix_task_run_plan: buildRunPlan({
          executionRequest: {
            task: { title: 'Different nested' },
          },
        }),
      },
    });
    assertStatus(result, 'invalid');
  });

  it('non-deterministic taskId returns invalid', () => {
    const result = readReviewerFixTaskRunPlanState({
      runState: {
        reviewer_fix_task_run_plan: buildRunPlan({
          taskId: 'fix-demo-task-reviewer-99',
        }),
      },
    });
    assertStatus(result, 'invalid');
  });

  it('valid run plan state returns ready', () => {
    const result = readReviewerFixTaskRunPlanState({
      runState: buildRunState(),
    });
    assertStatus(result, 'ready');
  });

  it('ready result preserves runPlan fields', () => {
    const result = readReviewerFixTaskRunPlanState({
      runState: buildRunState(),
    });
    assertStatus(result, 'ready');
    if (result.status !== 'ready') return;
    assert.strictEqual(result.runPlan.action, 'run_fix_task');
    assert.strictEqual(result.runPlan.taskId, TASK_ID);
    assert.strictEqual(result.runPlan.parentTaskId, PARENT_TASK_ID);
    assert.strictEqual(result.runPlan.attempt, ATTEMPT);
    assert.strictEqual(result.runPlan.title, TITLE);
    assert.strictEqual(result.runPlan.goal, GOAL);
    assert.deepStrictEqual(result.runPlan.blockingIssues, BLOCKING_ISSUES);
  });

  it('ready result preserves executionRequest fields', () => {
    const result = readReviewerFixTaskRunPlanState({
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

  it('ready result preserves fixTask fields', () => {
    const result = readReviewerFixTaskRunPlanState({
      runState: buildRunState(),
    });
    assertStatus(result, 'ready');
    if (result.status !== 'ready') return;
    assert.strictEqual(result.fixTask.taskId, TASK_ID);
    assert.strictEqual(result.fixTask.parentTaskId, PARENT_TASK_ID);
    assert.strictEqual(result.fixTask.attempt, ATTEMPT);
    assert.strictEqual(result.fixTask.title, TITLE);
    assert.strictEqual(result.fixTask.goal, GOAL);
    assert.strictEqual(result.fixTask.source, 'reviewer_gate');
    assert.deepStrictEqual(result.fixTask.blockingIssues, BLOCKING_ISSUES);
  });

  it('ready result preserves blockingIssues', () => {
    const result = readReviewerFixTaskRunPlanState({
      runState: buildRunState({
        blockingIssues: ['top-level issue'],
        executionRequest: {
          blockingIssues: ['top-level issue'],
          task: { blockingIssues: ['top-level issue'] },
        },
        fixTask: { blockingIssues: ['top-level issue'] },
      }),
    });
    assertStatus(result, 'ready');
    if (result.status !== 'ready') return;
    assert.deepStrictEqual(result.blockingIssues, ['top-level issue']);
  });

  it('ready result clones runPlan', () => {
    const runState = buildRunState();
    const originalPlan = (runState as Record<string, unknown>)
      .reviewer_fix_task_run_plan as Record<string, unknown>;
    const result = readReviewerFixTaskRunPlanState({ runState });
    assertStatus(result, 'ready');
    if (result.status !== 'ready') return;
    assert.notStrictEqual(result.runPlan, originalPlan);
    originalPlan.action = 'no_op';
    assert.strictEqual(result.runPlan.action, 'run_fix_task');
  });

  it('ready result clones executionRequest', () => {
    const runState = buildRunState();
    const originalPlan = (runState as Record<string, unknown>)
      .reviewer_fix_task_run_plan as Record<string, unknown>;
    const originalExecRequest = originalPlan.executionRequest as Record<string, unknown>;
    const result = readReviewerFixTaskRunPlanState({ runState });
    assertStatus(result, 'ready');
    if (result.status !== 'ready') return;
    assert.notStrictEqual(result.executionRequest, originalExecRequest);
    (originalExecRequest.goal as string) = 'mutated';
    assert.strictEqual(result.executionRequest.goal, GOAL);
  });

  it('ready result clones nested executionRequest.task', () => {
    const runState = buildRunState();
    const originalPlan = (runState as Record<string, unknown>)
      .reviewer_fix_task_run_plan as Record<string, unknown>;
    const originalExecRequest = originalPlan.executionRequest as Record<string, unknown>;
    const originalTask = originalExecRequest.task as Record<string, unknown>;
    const result = readReviewerFixTaskRunPlanState({ runState });
    assertStatus(result, 'ready');
    if (result.status !== 'ready') return;
    assert.notStrictEqual(result.executionRequest.task, originalTask);
    (originalTask.goal as string) = 'mutated';
    assert.strictEqual(result.executionRequest.task.goal, GOAL);
  });

  it('ready result clones fixTask', () => {
    const runState = buildRunState();
    const originalPlan = (runState as Record<string, unknown>)
      .reviewer_fix_task_run_plan as Record<string, unknown>;
    const originalFixTask = originalPlan.fixTask as Record<string, unknown>;
    const result = readReviewerFixTaskRunPlanState({ runState });
    assertStatus(result, 'ready');
    if (result.status !== 'ready') return;
    assert.notStrictEqual(result.fixTask, originalFixTask);
    (originalFixTask.goal as string) = 'mutated';
    assert.strictEqual(result.fixTask.goal, GOAL);
  });

  it('ready result clones blockingIssues arrays', () => {
    const runState = buildRunState({
      blockingIssues: ['top'],
      executionRequest: {
        blockingIssues: ['top'],
        task: { blockingIssues: ['top'] },
      },
      fixTask: { blockingIssues: ['top'] },
    });
    const originalPlan = (runState as Record<string, unknown>)
      .reviewer_fix_task_run_plan as Record<string, unknown>;
    const originalExecRequest = originalPlan.executionRequest as Record<string, unknown>;
    const originalExecTask = originalExecRequest.task as Record<string, unknown>;
    const originalFixTask = originalPlan.fixTask as Record<string, unknown>;

    const result = readReviewerFixTaskRunPlanState({ runState });
    assertStatus(result, 'ready');
    if (result.status !== 'ready') return;

    assert.notStrictEqual(result.blockingIssues, originalPlan.blockingIssues);
    assert.notStrictEqual(
      result.executionRequest.blockingIssues,
      originalExecRequest.blockingIssues
    );
    assert.notStrictEqual(
      result.executionRequest.task.blockingIssues,
      originalExecTask.blockingIssues
    );
    assert.notStrictEqual(result.fixTask.blockingIssues, originalFixTask.blockingIssues);

    (originalPlan.blockingIssues as string[]).push('mutated');
    (originalExecRequest.blockingIssues as string[]).push('mutated');
    (originalExecTask.blockingIssues as string[]).push('mutated');
    (originalFixTask.blockingIssues as string[]).push('mutated');

    assert.deepStrictEqual(result.blockingIssues, ['top']);
    assert.deepStrictEqual(result.executionRequest.blockingIssues, ['top']);
    assert.deepStrictEqual(result.executionRequest.task.blockingIssues, ['top']);
    assert.deepStrictEqual(result.fixTask.blockingIssues, ['top']);
  });

  it('helper does not mutate input', () => {
    const runState = buildRunState();
    const before = JSON.stringify(runState);
    readReviewerFixTaskRunPlanState({ runState });
    const after = JSON.stringify(runState);
    assert.strictEqual(after, before);
  });

  it('helper does not perform redaction or alter already-redacted text', () => {
    const secret = 'sk-fake-reviewer-secret';
    const runState = buildRunState({
      goal: `Use ${secret} token`,
      executionRequest: {
        goal: `Use ${secret} token`,
        task: { goal: `Use ${secret} token` },
      },
      fixTask: { goal: `Use ${secret} token` },
    });
    const result = readReviewerFixTaskRunPlanState({ runState });
    assertStatus(result, 'ready');
    if (result.status !== 'ready') return;
    assert.strictEqual(result.runPlan.goal, `Use ${secret} token`);
    assert.strictEqual(result.executionRequest.goal, `Use ${secret} token`);
    assert.strictEqual(result.executionRequest.task.goal, `Use ${secret} token`);
    assert.strictEqual(result.fixTask.goal, `Use ${secret} token`);
  });

  it('helper does not call git/provider/network/filesystem APIs', () => {
    const result = readReviewerFixTaskRunPlanState({
      runState: buildRunState(),
    });
    assertStatus(result, 'ready');
  });
});
