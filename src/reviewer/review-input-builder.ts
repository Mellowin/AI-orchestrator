import type { ReviewInput } from './reviewer-types.js';

const SHA_REGEX = /^[0-9a-fA-F]{40}$/;

export function buildReviewInput(input: {
  blockId?: string;
  taskId: string;
  taskTitle: string;
  taskGoal: string;
  allowedFiles: string[];
  deniedFiles: string[];
  maxLinesChanged: number;
  commitSha: string;
  changedFiles: string[];
  diff: string;
  typecheckResult: string;
  buildResult: string;
  testResult: string;
  gitStatus: string;
  safetyFindings: string[];
  previousFailure?: string;
}): ReviewInput {
  if (!input.taskId || typeof input.taskId !== 'string') {
    throw new Error('taskId is required and must be a string');
  }
  if (!input.taskGoal || typeof input.taskGoal !== 'string') {
    throw new Error('taskGoal is required and must be a string');
  }
  if (!input.taskTitle || typeof input.taskTitle !== 'string') {
    throw new Error('taskTitle is required and must be a string');
  }
  if (!input.commitSha || !SHA_REGEX.test(input.commitSha)) {
    throw new Error('commitSha must be a full 40-character hex string');
  }
  if (!Array.isArray(input.changedFiles)) {
    throw new Error('changedFiles must be an array');
  }
  if (!Array.isArray(input.allowedFiles)) {
    throw new Error('allowedFiles must be an array');
  }
  if (!Array.isArray(input.deniedFiles)) {
    throw new Error('deniedFiles must be an array');
  }
  if (!Array.isArray(input.safetyFindings)) {
    throw new Error('safetyFindings must be an array');
  }

  return {
    block_id: input.blockId,
    task_id: input.taskId.trim(),
    task_title: input.taskTitle.trim(),
    task_goal: input.taskGoal.trim(),
    allowed_files: input.allowedFiles.map((f) => (typeof f === 'string' ? f.trim() : String(f))),
    denied_files: input.deniedFiles.map((f) => (typeof f === 'string' ? f.trim() : String(f))),
    max_lines_changed: input.maxLinesChanged,
    commit_sha: input.commitSha.toLowerCase(),
    changed_files: input.changedFiles.map((f) => (typeof f === 'string' ? f.trim() : String(f))),
    diff: input.diff,
    typecheck_result: input.typecheckResult,
    build_result: input.buildResult,
    test_result: input.testResult,
    git_status: input.gitStatus,
    safety_findings: input.safetyFindings.map((f) => (typeof f === 'string' ? f.trim() : String(f))),
    previous_failure: input.previousFailure,
  };
}
