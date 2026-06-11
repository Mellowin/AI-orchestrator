import type { ReviewerFixTaskRunPlan } from './reviewer-fix-task-run-plan.js';
import type { ReviewerFixTaskExecutionRequest } from './reviewer-pending-fix-task-execution-request.js';
import type { ReviewerFixTaskDraft } from './reviewer-fix-task-plan.js';

export type ReviewerFixTaskRunPlanStateStatus =
  | 'not_present'
  | 'ready'
  | 'invalid';

export interface ReviewerFixTaskRunPlanStateInput {
  runState: unknown;
}

export interface ReviewerFixTaskRunPlanStateReady {
  status: 'ready';
  reason: string;
  runPlan: ReviewerFixTaskRunPlan & {
    action: 'run_fix_task';
    executionRequest: ReviewerFixTaskExecutionRequest;
    fixTask: ReviewerFixTaskDraft;
  };
  executionRequest: ReviewerFixTaskExecutionRequest;
  fixTask: ReviewerFixTaskDraft;
  blockingIssues: string[];
}

export interface ReviewerFixTaskRunPlanStateNotPresent {
  status: 'not_present';
  reason: string;
  runPlan?: undefined;
  executionRequest?: undefined;
  fixTask?: undefined;
  blockingIssues: string[];
}

export interface ReviewerFixTaskRunPlanStateInvalid {
  status: 'invalid';
  reason: string;
  runPlan?: undefined;
  executionRequest?: undefined;
  fixTask?: undefined;
  blockingIssues: string[];
}

export type ReviewerFixTaskRunPlanStateResult =
  | ReviewerFixTaskRunPlanStateReady
  | ReviewerFixTaskRunPlanStateNotPresent
  | ReviewerFixTaskRunPlanStateInvalid;

function notPresent(reason: string): ReviewerFixTaskRunPlanStateNotPresent {
  return { status: 'not_present', reason, blockingIssues: [] };
}

function invalid(reason: string): ReviewerFixTaskRunPlanStateInvalid {
  return { status: 'invalid', reason, blockingIssues: [reason] };
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function arraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) {
    return false;
  }
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) {
      return false;
    }
  }
  return true;
}

export function readReviewerFixTaskRunPlanState(
  input: ReviewerFixTaskRunPlanStateInput
): ReviewerFixTaskRunPlanStateResult {
  const { runState } = input;

  if (
    runState === null ||
    runState === undefined ||
    typeof runState !== 'object'
  ) {
    return notPresent('Run state is not an object.');
  }

  const runPlan = (runState as Record<string, unknown>).reviewer_fix_task_run_plan;

  if (runPlan === undefined) {
    return notPresent('reviewer_fix_task_run_plan is missing.');
  }

  if (runPlan === null || typeof runPlan !== 'object') {
    return invalid('reviewer_fix_task_run_plan is not an object.');
  }

  const p = runPlan as Record<string, unknown>;

  if (p.action !== 'run_fix_task') {
    return invalid(
      `reviewer_fix_task_run_plan.action is "${String(p.action)}", expected "run_fix_task".`
    );
  }

  if (p.executionRequest === null || typeof p.executionRequest !== 'object') {
    return invalid(
      'reviewer_fix_task_run_plan.executionRequest is not an object.'
    );
  }

  if (p.fixTask === null || typeof p.fixTask !== 'object') {
    return invalid('reviewer_fix_task_run_plan.fixTask is not an object.');
  }

  if (!isNonEmptyString(p.taskId)) {
    return invalid(
      'reviewer_fix_task_run_plan.taskId is not a non-empty string.'
    );
  }

  if (!isNonEmptyString(p.parentTaskId)) {
    return invalid(
      'reviewer_fix_task_run_plan.parentTaskId is not a non-empty string.'
    );
  }

  if (!isPositiveInteger(p.attempt)) {
    return invalid(
      'reviewer_fix_task_run_plan.attempt is not a positive integer.'
    );
  }

  if (!isNonEmptyString(p.title)) {
    return invalid(
      'reviewer_fix_task_run_plan.title is not a non-empty string.'
    );
  }

  if (!isNonEmptyString(p.goal)) {
    return invalid(
      'reviewer_fix_task_run_plan.goal is not a non-empty string.'
    );
  }

  if (!isStringArray(p.blockingIssues)) {
    return invalid(
      'reviewer_fix_task_run_plan.blockingIssues is not an array of strings.'
    );
  }

  const executionRequest = p.executionRequest as Record<string, unknown>;
  const fixTask = p.fixTask as Record<string, unknown>;
  const taskId = p.taskId;
  const parentTaskId = p.parentTaskId;
  const attempt = p.attempt;
  const title = p.title;
  const goal = p.goal;
  const blockingIssues = p.blockingIssues as string[];

  if (executionRequest.kind !== 'reviewer_fix_task') {
    return invalid(
      `reviewer_fix_task_run_plan.executionRequest.kind is "${String(
        executionRequest.kind
      )}", expected "reviewer_fix_task".`
    );
  }

  if (executionRequest.status !== 'pending') {
    return invalid(
      `reviewer_fix_task_run_plan.executionRequest.status is "${String(
        executionRequest.status
      )}", expected "pending".`
    );
  }

  if (executionRequest.source !== 'reviewer_gate') {
    return invalid(
      `reviewer_fix_task_run_plan.executionRequest.source is "${String(
        executionRequest.source
      )}", expected "reviewer_gate".`
    );
  }

  if (executionRequest.taskId !== taskId) {
    return invalid(
      'reviewer_fix_task_run_plan.executionRequest.taskId does not match taskId.'
    );
  }

  if (executionRequest.parentTaskId !== parentTaskId) {
    return invalid(
      'reviewer_fix_task_run_plan.executionRequest.parentTaskId does not match parentTaskId.'
    );
  }

  if (executionRequest.attempt !== attempt) {
    return invalid(
      'reviewer_fix_task_run_plan.executionRequest.attempt does not match attempt.'
    );
  }

  if (executionRequest.title !== title) {
    return invalid(
      'reviewer_fix_task_run_plan.executionRequest.title does not match title.'
    );
  }

  if (executionRequest.goal !== goal) {
    return invalid(
      'reviewer_fix_task_run_plan.executionRequest.goal does not match goal.'
    );
  }

  if (!isStringArray(executionRequest.blockingIssues)) {
    return invalid(
      'reviewer_fix_task_run_plan.executionRequest.blockingIssues is not an array of strings.'
    );
  }

  if (!arraysEqual(executionRequest.blockingIssues as string[], blockingIssues)) {
    return invalid(
      'reviewer_fix_task_run_plan.executionRequest.blockingIssues does not match blockingIssues.'
    );
  }

  if (
    executionRequest.task === null ||
    typeof executionRequest.task !== 'object'
  ) {
    return invalid(
      'reviewer_fix_task_run_plan.executionRequest.task is not an object.'
    );
  }

  const execTask = executionRequest.task as Record<string, unknown>;

  if (execTask.taskId !== taskId) {
    return invalid(
      'reviewer_fix_task_run_plan.executionRequest.task.taskId does not match taskId.'
    );
  }

  if (execTask.parentTaskId !== parentTaskId) {
    return invalid(
      'reviewer_fix_task_run_plan.executionRequest.task.parentTaskId does not match parentTaskId.'
    );
  }

  if (execTask.attempt !== attempt) {
    return invalid(
      'reviewer_fix_task_run_plan.executionRequest.task.attempt does not match attempt.'
    );
  }

  if (execTask.title !== title) {
    return invalid(
      'reviewer_fix_task_run_plan.executionRequest.task.title does not match title.'
    );
  }

  if (execTask.goal !== goal) {
    return invalid(
      'reviewer_fix_task_run_plan.executionRequest.task.goal does not match goal.'
    );
  }

  if (execTask.source !== 'reviewer_gate') {
    return invalid(
      `reviewer_fix_task_run_plan.executionRequest.task.source is "${String(
        execTask.source
      )}", expected "reviewer_gate".`
    );
  }

  if (!isStringArray(execTask.blockingIssues)) {
    return invalid(
      'reviewer_fix_task_run_plan.executionRequest.task.blockingIssues is not an array of strings.'
    );
  }

  if (!arraysEqual(execTask.blockingIssues as string[], blockingIssues)) {
    return invalid(
      'reviewer_fix_task_run_plan.executionRequest.task.blockingIssues does not match blockingIssues.'
    );
  }

  if (fixTask.taskId !== taskId) {
    return invalid(
      'reviewer_fix_task_run_plan.fixTask.taskId does not match taskId.'
    );
  }

  if (fixTask.parentTaskId !== parentTaskId) {
    return invalid(
      'reviewer_fix_task_run_plan.fixTask.parentTaskId does not match parentTaskId.'
    );
  }

  if (fixTask.attempt !== attempt) {
    return invalid(
      'reviewer_fix_task_run_plan.fixTask.attempt does not match attempt.'
    );
  }

  if (fixTask.title !== title) {
    return invalid(
      'reviewer_fix_task_run_plan.fixTask.title does not match title.'
    );
  }

  if (fixTask.goal !== goal) {
    return invalid(
      'reviewer_fix_task_run_plan.fixTask.goal does not match goal.'
    );
  }

  if (fixTask.source !== 'reviewer_gate') {
    return invalid(
      `reviewer_fix_task_run_plan.fixTask.source is "${String(
        fixTask.source
      )}", expected "reviewer_gate".`
    );
  }

  if (!isStringArray(fixTask.blockingIssues)) {
    return invalid(
      'reviewer_fix_task_run_plan.fixTask.blockingIssues is not an array of strings.'
    );
  }

  if (!arraysEqual(fixTask.blockingIssues as string[], blockingIssues)) {
    return invalid(
      'reviewer_fix_task_run_plan.fixTask.blockingIssues does not match blockingIssues.'
    );
  }

  const expectedTaskId = `fix-${parentTaskId}-reviewer-${attempt}`;
  if (taskId !== expectedTaskId) {
    return invalid(
      `reviewer_fix_task_run_plan.taskId is "${taskId}", expected "${expectedTaskId}".`
    );
  }

  const clonedBlockingIssues = [...blockingIssues];

  const clonedExecTask: ReviewerFixTaskDraft = {
    taskId,
    parentTaskId,
    attempt,
    title,
    goal,
    source: 'reviewer_gate',
    blockingIssues: [...(execTask.blockingIssues as string[])],
  };

  const clonedExecutionRequest: ReviewerFixTaskExecutionRequest = {
    kind: 'reviewer_fix_task',
    status: 'pending',
    source: 'reviewer_gate',
    taskId,
    parentTaskId,
    attempt,
    title,
    goal,
    blockingIssues: [...(executionRequest.blockingIssues as string[])],
    task: clonedExecTask,
  };

  const clonedFixTask: ReviewerFixTaskDraft = {
    taskId,
    parentTaskId,
    attempt,
    title,
    goal,
    source: 'reviewer_gate',
    blockingIssues: [...(fixTask.blockingIssues as string[])],
  };

  const clonedRunPlan: ReviewerFixTaskRunPlanStateReady['runPlan'] = {
    action: 'run_fix_task',
    reason: typeof p.reason === 'string' ? p.reason : '',
    executionRequest: clonedExecutionRequest,
    fixTask: clonedFixTask,
    taskId,
    parentTaskId,
    attempt,
    title,
    goal,
    blockingIssues: clonedBlockingIssues,
  };

  return {
    status: 'ready',
    reason: 'Reviewer fix task run plan is valid and ready.',
    runPlan: clonedRunPlan,
    executionRequest: clonedExecutionRequest,
    fixTask: clonedFixTask,
    blockingIssues: clonedBlockingIssues,
  };
}
