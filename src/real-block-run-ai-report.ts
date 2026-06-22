import { existsSync, readFileSync } from 'node:fs';
import { redactSecrets } from './sandbox-preflight-repair.js';
import type { RealBlockRunState, RealBlockRunTaskResult, RealBlockRunSummary } from './real-block-run-ai-state.js';
import type { ReviewerEvidence } from './reviewer-evidence.js';

function isObject(val: unknown): val is Record<string, unknown> {
  return typeof val === 'object' && val !== null && !Array.isArray(val);
}

function isValidStatus(status: unknown): status is 'completed' | 'blocked' | 'failed' {
  return typeof status === 'string' && ['completed', 'blocked', 'failed'].includes(status);
}

function isValidTaskStatus(status: unknown): status is RealBlockRunTaskResult['status'] {
  return (
    typeof status === 'string' &&
    ['accepted', 'fixed_and_accepted', 'blocked', 'fix_required', 'failed'].includes(status)
  );
}

function assertString(obj: Record<string, unknown>, key: string, context: string): string {
  const value = obj[key];
  if (typeof value !== 'string') {
    throw new Error(`Invalid block state: ${context} must be a string`);
  }
  return value;
}

function assertNumber(obj: Record<string, unknown>, key: string, context: string): number {
  const value = obj[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Invalid block state: ${context} must be a number`);
  }
  return value;
}

function validateSummary(summary: unknown): RealBlockRunSummary {
  if (!isObject(summary)) {
    throw new Error('Invalid block state: summary must be an object');
  }

  return {
    totalTasks: assertNumber(summary, 'totalTasks', 'summary.totalTasks'),
    acceptedTasks: assertNumber(summary, 'acceptedTasks', 'summary.acceptedTasks'),
    fixedTasks: assertNumber(summary, 'fixedTasks', 'summary.fixedTasks'),
    completedTasks: assertNumber(summary, 'completedTasks', 'summary.completedTasks'),
    blockedTaskId: typeof summary.blockedTaskId === 'string' ? summary.blockedTaskId : undefined,
    failedTaskId: typeof summary.failedTaskId === 'string' ? summary.failedTaskId : undefined,
    stoppedReason: typeof summary.stoppedReason === 'string' ? summary.stoppedReason : undefined,
  };
}

function validateTaskResult(result: unknown, index: number): RealBlockRunTaskResult {
  if (!isObject(result)) {
    throw new Error(`Invalid block state: task result ${index} must be an object`);
  }

  const status = result.status;
  if (!isValidTaskStatus(status)) {
    throw new Error(`Invalid block state: task result ${index} has invalid status`);
  }

  const taskId = assertString(result, 'taskId', `task result ${index}.taskId`);
  const title = assertString(result, 'title', `task result ${index}.title`);

  return {
    taskId,
    title,
    status,
    originalCommitSha: typeof result.originalCommitSha === 'string' ? result.originalCommitSha : undefined,
    fixCommitSha: typeof result.fixCommitSha === 'string' ? result.fixCommitSha : undefined,
    reviewerGateStatus: typeof result.reviewerGateStatus === 'string' ? result.reviewerGateStatus : undefined,
    reviewerSummary: typeof result.reviewerSummary === 'string' ? result.reviewerSummary : undefined,
    fixAttempted: result.fixAttempted === true,
    fixTaskId: typeof result.fixTaskId === 'string' ? result.fixTaskId : undefined,
    fixRunnerStatus: typeof result.fixRunnerStatus === 'string' ? result.fixRunnerStatus : undefined,
    fixRunnerNextAction: typeof result.fixRunnerNextAction === 'string' ? result.fixRunnerNextAction : undefined,
    secondReviewerGateStatus: typeof result.secondReviewerGateStatus === 'string' ? result.secondReviewerGateStatus : undefined,
    secondReviewerSummary: typeof result.secondReviewerSummary === 'string' ? result.secondReviewerSummary : undefined,
    fixCheckSummary: isObject(result.fixCheckSummary)
      ? (result.fixCheckSummary as ReviewerEvidence['checkSummary'])
      : undefined,
    finalStatus: typeof result.finalStatus === 'string' ? result.finalStatus : status,
    nextAction: typeof result.nextAction === 'string' ? result.nextAction : 'continue',
    reason: typeof result.reason === 'string' ? result.reason : undefined,
    childStateTaskId: typeof result.childStateTaskId === 'string' ? result.childStateTaskId : taskId,
  };
}

export function loadAndValidateBlockState(statePath: string): RealBlockRunState {
  if (!existsSync(statePath)) {
    throw new Error(`Block state file not found: ${statePath}`);
  }

  let raw: string;
  try {
    raw = readFileSync(statePath, 'utf-8');
  } catch {
    throw new Error(`Could not read block state file: ${statePath}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Block state file is not valid JSON: ${statePath}`);
  }

  if (!isObject(parsed)) {
    throw new Error('Block state file is not a valid object');
  }

  const status = parsed.status;
  if (!isValidStatus(status)) {
    throw new Error('Block state has invalid status');
  }

  if (!Array.isArray(parsed.taskResults)) {
    throw new Error('Block state has invalid taskResults');
  }

  return {
    block_id: assertString(parsed, 'block_id', 'block_id'),
    title: assertString(parsed, 'title', 'title'),
    status,
    currentTaskId: typeof parsed.currentTaskId === 'string' ? parsed.currentTaskId : null,
    statePath: typeof parsed.statePath === 'string' ? parsed.statePath : statePath,
    taskResults: parsed.taskResults.map(validateTaskResult),
    summary: validateSummary(parsed.summary),
    startedAt: assertString(parsed, 'startedAt', 'startedAt'),
    finishedAt: typeof parsed.finishedAt === 'string' ? parsed.finishedAt : undefined,
    safetyNote: typeof parsed.safetyNote === 'string' ? parsed.safetyNote : '',
    resumed: parsed.resumed === true,
    resumeStartedAt: typeof parsed.resumeStartedAt === 'string' ? parsed.resumeStartedAt : undefined,
  };
}

function redactReport(text: string): string {
  return redactSecrets(text)
    .replace(/\b(ghp_[a-zA-Z0-9]{36,})\b/g, '[REDACTED]')
    .replace(/\b(github_pat_[a-zA-Z0-9_]{40,})\b/gi, '[REDACTED]')
    .replace(/\b(token)\s+([a-zA-Z0-9_\-]{8,})\b/gi, '$1 [REDACTED]');
}

function formatTaskResult(result: RealBlockRunTaskResult, index: number): string {
  const lines: string[] = [];
  lines.push(`${index + 1}. ${result.taskId} — ${result.status}`);
  lines.push(`   title: ${result.title}`);
  lines.push(`   finalStatus: ${result.finalStatus}`);
  lines.push(`   nextAction: ${result.nextAction}`);

  if (result.originalCommitSha) {
    lines.push(`   originalCommitSha: ${result.originalCommitSha}`);
  }
  if (result.fixAttempted) {
    lines.push(`   fixAttempted: true`);
  }
  if (result.fixTaskId) {
    lines.push(`   fixTaskId: ${result.fixTaskId}`);
  }
  if (result.fixRunnerStatus) {
    lines.push(`   fixRunnerStatus: ${result.fixRunnerStatus}`);
  }
  if (result.fixRunnerNextAction) {
    lines.push(`   fixRunnerNextAction: ${result.fixRunnerNextAction}`);
  }
  if (result.fixCommitSha) {
    lines.push(`   fixCommitSha: ${result.fixCommitSha}`);
  }
  if (result.reviewerGateStatus) {
    lines.push(`   reviewerGateStatus: ${result.reviewerGateStatus}`);
  }
  if (result.reviewerSummary) {
    lines.push(`   reviewerSummary: ${redactSecrets(result.reviewerSummary)}`);
  }
  if (result.secondReviewerGateStatus) {
    lines.push(`   secondReviewerGateStatus: ${result.secondReviewerGateStatus}`);
  }
  if (result.secondReviewerSummary) {
    lines.push(`   secondReviewerSummary: ${redactSecrets(result.secondReviewerSummary)}`);
  }
  if (result.fixCheckSummary) {
    lines.push('   fixCheckSummary:');
    const summary = result.fixCheckSummary;
    if (summary.typecheck !== undefined) {
      lines.push(`     typecheck: ${summary.typecheck}`);
    }
    if (summary.build !== undefined) {
      lines.push(`     build: ${summary.build}`);
    }
    if (summary.test !== undefined) {
      lines.push(`     test: ${summary.test}`);
    }
    if (summary.tests !== undefined) {
      const tests = summary.tests;
      lines.push(
        `     tests: total=${tests.total ?? '?'} suites=${tests.suites ?? '?'} failures=${tests.failures ?? '?'}`
      );
    }
  }
  if (result.reason) {
    lines.push(`   reason: ${redactSecrets(result.reason)}`);
  }

  return lines.join('\n');
}

export function formatRealBlockRunReport(state: RealBlockRunState, statePath: string): string {
  const lines: string[] = [];

  lines.push('Block Run Report');
  lines.push('================');
  lines.push(`Block: ${state.block_id}`);
  lines.push(`Title: ${state.title}`);
  lines.push(`Status: ${state.status}`);
  lines.push(`State: ${statePath}`);
  lines.push(`Started: ${state.startedAt}`);
  if (state.finishedAt) {
    lines.push(`Finished: ${state.finishedAt}`);
  }
  if (state.resumed) {
    lines.push(`Resumed: yes`);
  }
  if (state.resumeStartedAt) {
    lines.push(`Resume started: ${state.resumeStartedAt}`);
  }

  lines.push('');
  lines.push('Summary:');
  lines.push(`- totalTasks: ${state.summary.totalTasks}`);
  lines.push(`- completedTasks: ${state.summary.completedTasks}`);
  lines.push(`- acceptedTasks: ${state.summary.acceptedTasks}`);
  lines.push(`- fixedTasks: ${state.summary.fixedTasks}`);
  if (state.summary.blockedTaskId) {
    lines.push(`- blockedTaskId: ${state.summary.blockedTaskId}`);
  }
  if (state.summary.failedTaskId) {
    lines.push(`- failedTaskId: ${state.summary.failedTaskId}`);
  }
  if (state.summary.stoppedReason) {
    lines.push(`- stoppedReason: ${state.summary.stoppedReason}`);
  }

  lines.push('');
  lines.push('Tasks:');
  if (state.taskResults.length === 0) {
    lines.push('  No tasks recorded.');
  } else {
    for (let i = 0; i < state.taskResults.length; i++) {
      lines.push(formatTaskResult(state.taskResults[i], i));
    }
  }

  lines.push('');
  lines.push('Safety note:');
  lines.push('This report is read-only. No provider, repository, or state mutation was performed.');
  lines.push('No commits, pushes, merges, or child runner invocations were made.');

  return redactReport(lines.join('\n'));
}

export function renderBlockRunReport(statePath: string): string {
  const state = loadAndValidateBlockState(statePath);
  return formatRealBlockRunReport(state, statePath);
}
