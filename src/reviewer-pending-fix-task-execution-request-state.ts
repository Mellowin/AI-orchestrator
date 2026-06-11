import type {
  PendingReviewerFixTaskExecutionRequestResult,
  ReviewerFixTaskExecutionRequest,
} from './reviewer-pending-fix-task-execution-request.js';

export type PendingReviewerFixTaskExecutionRequestStateStatus =
  | 'not_present'
  | 'ready'
  | 'invalid';

export interface PendingReviewerFixTaskExecutionRequestStateInput {
  runState: unknown;
}

export interface PendingReviewerFixTaskExecutionRequestStateReady {
  status: 'ready';
  reason: string;
  executionRequestResult: PendingReviewerFixTaskExecutionRequestResult & {
    action: 'create_execution_request';
    executionRequest: ReviewerFixTaskExecutionRequest;
  };
  executionRequest: ReviewerFixTaskExecutionRequest;
  blockingIssues: string[];
}

export interface PendingReviewerFixTaskExecutionRequestStateNotPresent {
  status: 'not_present';
  reason: string;
  executionRequestResult?: undefined;
  executionRequest?: undefined;
  blockingIssues: string[];
}

export interface PendingReviewerFixTaskExecutionRequestStateInvalid {
  status: 'invalid';
  reason: string;
  executionRequestResult?: undefined;
  executionRequest?: undefined;
  blockingIssues: string[];
}

export type PendingReviewerFixTaskExecutionRequestStateResult =
  | PendingReviewerFixTaskExecutionRequestStateReady
  | PendingReviewerFixTaskExecutionRequestStateNotPresent
  | PendingReviewerFixTaskExecutionRequestStateInvalid;

function notPresent(
  reason: string
): PendingReviewerFixTaskExecutionRequestStateNotPresent {
  return { status: 'not_present', reason, blockingIssues: [] };
}

function invalid(
  reason: string
): PendingReviewerFixTaskExecutionRequestStateInvalid {
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

export function readPendingReviewerFixTaskExecutionRequestState(
  input: PendingReviewerFixTaskExecutionRequestStateInput
): PendingReviewerFixTaskExecutionRequestStateResult {
  const { runState } = input;

  if (
    runState === null ||
    runState === undefined ||
    typeof runState !== 'object'
  ) {
    return notPresent('Run state is not an object.');
  }

  const pending = (runState as Record<string, unknown>)
    .pending_reviewer_fix_task_execution_request;

  if (pending === undefined) {
    return notPresent('pending_reviewer_fix_task_execution_request is missing.');
  }

  if (pending === null || typeof pending !== 'object') {
    return invalid(
      'pending_reviewer_fix_task_execution_request is not an object.'
    );
  }

  const p = pending as Record<string, unknown>;

  if (p.action !== 'create_execution_request') {
    return invalid(
      `pending_reviewer_fix_task_execution_request.action is "${String(
        p.action
      )}", expected "create_execution_request".`
    );
  }

  if (p.executionRequest === null || typeof p.executionRequest !== 'object') {
    return invalid(
      'pending_reviewer_fix_task_execution_request.executionRequest is not an object.'
    );
  }

  if (!isStringArray(p.blockingIssues)) {
    return invalid(
      'pending_reviewer_fix_task_execution_request.blockingIssues is not an array of strings.'
    );
  }

  const topBlockingIssues = p.blockingIssues as string[];

  const executionRequest = p.executionRequest as Record<string, unknown>;

  if (executionRequest.kind !== 'reviewer_fix_task') {
    return invalid(
      `pending_reviewer_fix_task_execution_request.executionRequest.kind is "${String(
        executionRequest.kind
      )}", expected "reviewer_fix_task".`
    );
  }

  if (executionRequest.status !== 'pending') {
    return invalid(
      `pending_reviewer_fix_task_execution_request.executionRequest.status is "${String(
        executionRequest.status
      )}", expected "pending".`
    );
  }

  if (executionRequest.source !== 'reviewer_gate') {
    return invalid(
      `pending_reviewer_fix_task_execution_request.executionRequest.source is "${String(
        executionRequest.source
      )}", expected "reviewer_gate".`
    );
  }

  if (!isNonEmptyString(executionRequest.taskId)) {
    return invalid(
      'pending_reviewer_fix_task_execution_request.executionRequest.taskId is not a non-empty string.'
    );
  }

  if (!isNonEmptyString(executionRequest.parentTaskId)) {
    return invalid(
      'pending_reviewer_fix_task_execution_request.executionRequest.parentTaskId is not a non-empty string.'
    );
  }

  if (!isPositiveInteger(executionRequest.attempt)) {
    return invalid(
      'pending_reviewer_fix_task_execution_request.executionRequest.attempt is not a positive integer.'
    );
  }

  if (!isNonEmptyString(executionRequest.title)) {
    return invalid(
      'pending_reviewer_fix_task_execution_request.executionRequest.title is not a non-empty string.'
    );
  }

  if (!isNonEmptyString(executionRequest.goal)) {
    return invalid(
      'pending_reviewer_fix_task_execution_request.executionRequest.goal is not a non-empty string.'
    );
  }

  if (!isStringArray(executionRequest.blockingIssues)) {
    return invalid(
      'pending_reviewer_fix_task_execution_request.executionRequest.blockingIssues is not an array of strings.'
    );
  }

  if (
    executionRequest.task === null ||
    typeof executionRequest.task !== 'object'
  ) {
    return invalid(
      'pending_reviewer_fix_task_execution_request.executionRequest.task is not an object.'
    );
  }

  const task = executionRequest.task as Record<string, unknown>;
  const parentTaskId = executionRequest.parentTaskId;
  const attempt = executionRequest.attempt;
  const taskId = executionRequest.taskId;
  const title = executionRequest.title;
  const goal = executionRequest.goal;
  const blockingIssues = executionRequest.blockingIssues as string[];

  const expectedTaskId = `fix-${parentTaskId}-reviewer-${attempt}`;
  if (taskId !== expectedTaskId) {
    return invalid(
      `pending_reviewer_fix_task_execution_request.executionRequest.taskId is "${taskId}", expected "${expectedTaskId}".`
    );
  }

  if (task.taskId !== taskId) {
    return invalid(
      'pending_reviewer_fix_task_execution_request.executionRequest.task.taskId does not match executionRequest.taskId.'
    );
  }

  if (task.parentTaskId !== parentTaskId) {
    return invalid(
      'pending_reviewer_fix_task_execution_request.executionRequest.task.parentTaskId does not match executionRequest.parentTaskId.'
    );
  }

  if (task.attempt !== attempt) {
    return invalid(
      'pending_reviewer_fix_task_execution_request.executionRequest.task.attempt does not match executionRequest.attempt.'
    );
  }

  if (task.title !== title) {
    return invalid(
      'pending_reviewer_fix_task_execution_request.executionRequest.task.title does not match executionRequest.title.'
    );
  }

  if (task.goal !== goal) {
    return invalid(
      'pending_reviewer_fix_task_execution_request.executionRequest.task.goal does not match executionRequest.goal.'
    );
  }

  if (task.source !== 'reviewer_gate') {
    return invalid(
      `pending_reviewer_fix_task_execution_request.executionRequest.task.source is "${String(
        task.source
      )}", expected "reviewer_gate".`
    );
  }

  if (!isStringArray(task.blockingIssues)) {
    return invalid(
      'pending_reviewer_fix_task_execution_request.executionRequest.task.blockingIssues is not an array of strings.'
    );
  }

  if (!arraysEqual(task.blockingIssues as string[], blockingIssues)) {
    return invalid(
      'pending_reviewer_fix_task_execution_request.executionRequest.task.blockingIssues does not match executionRequest.blockingIssues.'
    );
  }

  const clonedExecutionRequest: ReviewerFixTaskExecutionRequest = {
    kind: 'reviewer_fix_task',
    status: 'pending',
    source: 'reviewer_gate',
    taskId,
    parentTaskId,
    attempt,
    title,
    goal,
    blockingIssues: [...blockingIssues],
    task: {
      taskId,
      parentTaskId,
      title,
      goal,
      attempt,
      source: 'reviewer_gate',
      blockingIssues: [...(task.blockingIssues as string[])],
    },
  };

  const executionRequestResult: PendingReviewerFixTaskExecutionRequestResult & {
    action: 'create_execution_request';
    executionRequest: ReviewerFixTaskExecutionRequest;
  } = {
    action: 'create_execution_request',
    reason: typeof p.reason === 'string' ? p.reason : '',
    executionRequest: clonedExecutionRequest,
    blockingIssues: [...topBlockingIssues],
  };

  return {
    status: 'ready',
    reason: 'Pending reviewer fix task execution request is valid and ready.',
    executionRequestResult,
    executionRequest: clonedExecutionRequest,
    blockingIssues: [...topBlockingIssues],
  };
}
