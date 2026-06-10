import type { BlockState, BlockTaskState, BlockTaskStatus, BlockStatus } from './block-types.js';

export function getCurrentTask(state: BlockState): BlockTaskState | null {
  if (!state.current_task_id) {
    return null;
  }
  return state.tasks.find((t) => t.task_id === state.current_task_id) ?? null;
}

function findTask(state: BlockState, taskId: string): BlockTaskState {
  const task = state.tasks.find((t) => t.task_id === taskId);
  if (!task) {
    throw new Error(`Unknown task: ${taskId}`);
  }
  return task;
}

function cloneState(state: BlockState): BlockState {
  return JSON.parse(JSON.stringify(state));
}

function now(): string {
  return new Date().toISOString();
}

const SHA_REGEX = /^[0-9a-fA-F]{40}$/;

function nextPendingTask(state: BlockState): BlockTaskState | null {
  for (const task of state.tasks) {
    if (task.status === 'pending') {
      return task;
    }
  }
  return null;
}

function allTasksAccepted(state: BlockState): boolean {
  return state.tasks.every((t) => t.status === 'accepted');
}

export function markTaskInProgress(state: BlockState, taskId: string): BlockState {
  const s = cloneState(state);
  const task = findTask(s, taskId);
  if (task.status === 'accepted') {
    throw new Error(`Cannot transition accepted task ${taskId} backwards`);
  }
  if (task.status === 'blocked') {
    throw new Error(`Cannot restart blocked task ${taskId} without human intervention`);
  }
  // Clear stale data when starting a fix attempt
  if (task.status === 'rejected' || task.status === 'fix_required' || task.status === 'checks_failed') {
    task.blocking_issues = [];
    task.reviewer_decision = null;
    task.reviewer_summary = null;
    task.commit_sha = null;
    task.pushed_ref = null;
  }
  task.status = 'in_progress';
  task.current_attempt += 1;
  s.status = 'running';
  task.updated_at = now();
  s.updated_at = now();
  return s;
}

export function markTaskCoderDone(state: BlockState, taskId: string): BlockState {
  const s = cloneState(state);
  const task = findTask(s, taskId);
  if (task.status === 'accepted') {
    throw new Error(`Cannot transition accepted task ${taskId} backwards`);
  }
  task.status = 'coder_done';
  task.updated_at = now();
  s.updated_at = now();
  return s;
}

export function markTaskChecksFailed(
  state: BlockState,
  taskId: string,
  blockingIssues: string[]
): BlockState {
  const s = cloneState(state);
  const task = findTask(s, taskId);
  if (task.status === 'accepted') {
    throw new Error(`Cannot transition accepted task ${taskId} backwards`);
  }
  if (!s.review_policy) {
    throw new Error(`Block state is missing review_policy; cannot enforce max_fix_attempts`);
  }
  task.fix_attempts += 1;
  task.blocking_issues = blockingIssues.map((i) => String(i));
  const maxFixAttempts = s.review_policy.max_fix_attempts;
  if (task.fix_attempts >= maxFixAttempts) {
    task.status = 'blocked';
    s.status = 'blocked';
    s.current_task_id = null;
  } else {
    task.status = 'checks_failed';
    s.status = 'fixing';
  }
  task.updated_at = now();
  s.updated_at = now();
  return s;
}

export function markTaskCommitted(state: BlockState, taskId: string, commitSha: string): BlockState {
  if (!SHA_REGEX.test(commitSha)) {
    throw new Error('commitSha must be a full 40-character hex string');
  }
  const s = cloneState(state);
  const task = findTask(s, taskId);
  if (task.status === 'accepted') {
    throw new Error(`Cannot transition accepted task ${taskId} backwards`);
  }
  task.status = 'committed';
  task.commit_sha = commitSha.toLowerCase();
  task.updated_at = now();
  s.updated_at = now();
  return s;
}

export function markTaskPushed(
  state: BlockState,
  taskId: string,
  commitSha: string,
  pushedRef: string
): BlockState {
  if (!SHA_REGEX.test(commitSha)) {
    throw new Error('commitSha must be a full 40-character hex string');
  }
  const s = cloneState(state);
  const task = findTask(s, taskId);
  if (task.status === 'accepted') {
    throw new Error(`Cannot transition accepted task ${taskId} backwards`);
  }
  task.status = 'pushed';
  task.commit_sha = commitSha.toLowerCase();
  task.pushed_ref = pushedRef;
  task.updated_at = now();
  s.updated_at = now();
  return s;
}

export function markTaskWaitingReview(state: BlockState, taskId: string): BlockState {
  const s = cloneState(state);
  const task = findTask(s, taskId);
  if (task.status === 'accepted') {
    throw new Error(`Cannot transition accepted task ${taskId} backwards`);
  }
  task.status = 'waiting_review';
  s.status = 'waiting_review';
  task.updated_at = now();
  s.updated_at = now();
  return s;
}

export function markTaskAccepted(
  state: BlockState,
  taskId: string,
  reviewSummary: string
): BlockState {
  const s = cloneState(state);
  const task = findTask(s, taskId);
  if (task.blocking_issues.length > 0) {
    throw new Error(`Cannot accept task ${taskId} with blocking issues`);
  }
  task.status = 'accepted';
  task.reviewer_decision = 'accepted';
  task.reviewer_summary = reviewSummary;
  task.updated_at = now();

  const next = nextPendingTask(s);
  if (next) {
    s.current_task_id = next.task_id;
    s.status = 'running';
  } else if (allTasksAccepted(s)) {
    s.current_task_id = null;
    s.status = 'completed';
  }
  s.updated_at = now();
  return s;
}

export function markTaskRejected(
  state: BlockState,
  taskId: string,
  blockingIssues: string[],
  reviewSummary: string
): BlockState {
  const s = cloneState(state);
  const task = findTask(s, taskId);
  task.status = 'rejected';
  task.reviewer_decision = 'rejected';
  task.blocking_issues = blockingIssues.map((i) => String(i));
  task.reviewer_summary = reviewSummary;
  task.updated_at = now();
  s.updated_at = now();
  return s;
}

export function markTaskFixRequired(
  state: BlockState,
  taskId: string,
  blockingIssues: string[],
  reviewSummary: string
): BlockState {
  const s = cloneState(state);
  const task = findTask(s, taskId);
  if (!s.review_policy) {
    throw new Error(`Block state is missing review_policy; cannot enforce max_fix_attempts`);
  }
  task.fix_attempts += 1;
  task.blocking_issues = blockingIssues.map((i) => String(i));
  task.reviewer_summary = reviewSummary;
  const maxFixAttempts = s.review_policy.max_fix_attempts;
  if (task.fix_attempts >= maxFixAttempts) {
    task.status = 'blocked';
    s.status = 'blocked';
    s.current_task_id = null;
  } else {
    task.status = 'fix_required';
    s.status = 'fixing';
  }
  task.updated_at = now();
  s.updated_at = now();
  return s;
}

export function markTaskBlocked(
  state: BlockState,
  taskId: string,
  blockingIssues: string[],
  reviewSummary: string
): BlockState {
  const s = cloneState(state);
  const task = findTask(s, taskId);
  task.status = 'blocked';
  task.blocking_issues = blockingIssues.map((i) => String(i));
  task.reviewer_summary = reviewSummary;
  s.status = 'blocked';
  s.current_task_id = null;
  task.updated_at = now();
  s.updated_at = now();
  return s;
}
