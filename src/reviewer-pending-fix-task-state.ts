import type { ReviewerFixTaskDraft } from './reviewer-fix-task-plan.js';

export type PendingReviewerFixTaskStateStatus =
  | 'not_present'
  | 'ready'
  | 'invalid';

export interface PendingReviewerFixTaskStateInput {
  runState: unknown;
}

export interface PendingReviewerFixTaskStateReady {
  status: 'ready';
  reason: string;
  pendingFixTask: {
    status: 'pending';
    source: 'reviewer_gate';
    task: ReviewerFixTaskDraft;
    parentTaskId: string;
    attempt: number;
    createdFromResolutionAction: 'append_fix_task';
  };
  blockingIssues: string[];
}

export interface PendingReviewerFixTaskStateNotPresent {
  status: 'not_present';
  reason: string;
  pendingFixTask?: undefined;
  blockingIssues: string[];
}

export interface PendingReviewerFixTaskStateInvalid {
  status: 'invalid';
  reason: string;
  pendingFixTask?: undefined;
  blockingIssues: string[];
}

export type PendingReviewerFixTaskStateResult =
  | PendingReviewerFixTaskStateReady
  | PendingReviewerFixTaskStateNotPresent
  | PendingReviewerFixTaskStateInvalid;

function notPresent(reason: string): PendingReviewerFixTaskStateNotPresent {
  return { status: 'not_present', reason, blockingIssues: [] };
}

function invalid(reason: string): PendingReviewerFixTaskStateInvalid {
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

export function readPendingReviewerFixTaskState(
  input: PendingReviewerFixTaskStateInput
): PendingReviewerFixTaskStateResult {
  const { runState } = input;

  if (
    runState === null ||
    runState === undefined ||
    typeof runState !== 'object'
  ) {
    return notPresent('Run state is not an object.');
  }

  const pending = (runState as Record<string, unknown>).pending_reviewer_fix_task;

  if (pending === undefined) {
    return notPresent('pending_reviewer_fix_task is missing.');
  }

  if (pending === null || typeof pending !== 'object') {
    return invalid('pending_reviewer_fix_task is not an object.');
  }

  const p = pending as Record<string, unknown>;

  if (p.status !== 'pending') {
    return invalid(
      `pending_reviewer_fix_task.status is "${String(p.status)}", expected "pending".`
    );
  }

  if (p.source !== 'reviewer_gate') {
    return invalid(
      `pending_reviewer_fix_task.source is "${String(p.source)}", expected "reviewer_gate".`
    );
  }

  if (p.createdFromResolutionAction !== 'append_fix_task') {
    return invalid(
      `pending_reviewer_fix_task.createdFromResolutionAction is "${String(
        p.createdFromResolutionAction
      )}", expected "append_fix_task".`
    );
  }

  if (!isNonEmptyString(p.parentTaskId)) {
    return invalid(
      'pending_reviewer_fix_task.parentTaskId is not a non-empty string.'
    );
  }

  if (!isPositiveInteger(p.attempt)) {
    return invalid(
      'pending_reviewer_fix_task.attempt is not a positive integer.'
    );
  }

  if (p.task === null || typeof p.task !== 'object') {
    return invalid('pending_reviewer_fix_task.task is not an object.');
  }

  const task = p.task as Record<string, unknown>;
  const parentTaskId = p.parentTaskId;
  const attempt = p.attempt;

  if (!isNonEmptyString(task.taskId)) {
    return invalid(
      'pending_reviewer_fix_task.task.taskId is not a non-empty string.'
    );
  }

  const expectedTaskId = `fix-${parentTaskId}-reviewer-${attempt}`;
  if (task.taskId !== expectedTaskId) {
    return invalid(
      `pending_reviewer_fix_task.task.taskId is "${task.taskId}", expected "${expectedTaskId}".`
    );
  }

  if (task.parentTaskId !== parentTaskId) {
    return invalid(
      'pending_reviewer_fix_task.task.parentTaskId does not match parentTaskId.'
    );
  }

  if (task.attempt !== attempt) {
    return invalid(
      'pending_reviewer_fix_task.task.attempt does not match attempt.'
    );
  }

  if (task.source !== 'reviewer_gate') {
    return invalid(
      `pending_reviewer_fix_task.task.source is "${String(task.source)}", expected "reviewer_gate".`
    );
  }

  if (!isNonEmptyString(task.title)) {
    return invalid(
      'pending_reviewer_fix_task.task.title is not a non-empty string.'
    );
  }

  if (!isNonEmptyString(task.goal)) {
    return invalid(
      'pending_reviewer_fix_task.task.goal is not a non-empty string.'
    );
  }

  if (!isStringArray(task.blockingIssues)) {
    return invalid(
      'pending_reviewer_fix_task.task.blockingIssues is not an array of strings.'
    );
  }

  const pendingFixTask = {
    status: 'pending' as const,
    source: 'reviewer_gate' as const,
    task: {
      taskId: task.taskId,
      parentTaskId: task.parentTaskId,
      title: task.title,
      goal: task.goal,
      attempt: task.attempt,
      blockingIssues: [...(task.blockingIssues as string[])],
      source: 'reviewer_gate' as const,
    } as ReviewerFixTaskDraft,
    parentTaskId: p.parentTaskId,
    attempt: p.attempt,
    createdFromResolutionAction: 'append_fix_task' as const,
  };

  return {
    status: 'ready',
    reason: 'Pending reviewer fix task is valid and ready.',
    pendingFixTask,
    blockingIssues: [],
  };
}
