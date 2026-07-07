import { existsSync, statSync, readFileSync } from 'node:fs';
import { resolve, normalize } from 'node:path';
import type { BlockDefinition } from './block-types.js';

const SAFE_BLOCK_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

function isSafeBlockIdentifier(value: string): boolean {
  return SAFE_BLOCK_ID_PATTERN.test(value);
}

export function loadBlockDefinition(path: string): BlockDefinition {
  if (!path || typeof path !== 'string') {
    throw new Error('Block definition path is required');
  }

  const resolvedPath = resolve(normalize(path.trim()));

  if (!existsSync(resolvedPath)) {
    throw new Error(`Block definition file not found: ${path}`);
  }

  const stats = statSync(resolvedPath);
  if (!stats.isFile()) {
    throw new Error(`Block definition path is not a file: ${path}`);
  }

  let raw: string;
  try {
    raw = readFileSync(resolvedPath, 'utf-8');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to read block definition: ${msg}`);
  }

  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Failed to parse block definition JSON: ${path}`);
  }

  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    throw new Error('Block definition must be a JSON object');
  }

  const obj = data as Record<string, unknown>;

  // Required string fields
  const blockId = obj.block_id;
  if (!blockId || typeof blockId !== 'string') {
    throw new Error('Block definition missing required field: block_id');
  }
  if (!isSafeBlockIdentifier(blockId)) {
    throw new Error('Block definition block_id contains unsupported characters');
  }

  const title = obj.title;
  if (!title || typeof title !== 'string') {
    throw new Error('Block definition missing required field: title');
  }

  const repoPath = obj.repo_path;
  if (!repoPath || typeof repoPath !== 'string') {
    throw new Error('Block definition missing required field: repo_path');
  }

  const baseBranch = obj.base_branch;
  if (!baseBranch || typeof baseBranch !== 'string') {
    throw new Error('Block definition missing required field: base_branch');
  }

  const workBranch = obj.work_branch;
  if (!workBranch || typeof workBranch !== 'string') {
    throw new Error('Block definition missing required field: work_branch');
  }
  if (workBranch === 'main') {
    throw new Error('Block definition work_branch must not be "main"');
  }

  // Providers
  const providers = obj.providers;
  if (typeof providers !== 'object' || providers === null || Array.isArray(providers)) {
    throw new Error('Block definition missing required field: providers');
  }
  const providersObj = providers as Record<string, unknown>;

  const coder = providersObj.coder;
  if (typeof coder !== 'object' || coder === null || Array.isArray(coder)) {
    throw new Error('Block definition missing required provider: providers.coder');
  }
  const coderObj = coder as Record<string, unknown>;
  if (!coderObj.provider || typeof coderObj.provider !== 'string') {
    throw new Error('Block definition missing required field: providers.coder.provider');
  }
  if (!coderObj.model || typeof coderObj.model !== 'string') {
    throw new Error('Block definition missing required field: providers.coder.model');
  }
  if ('apiKey' in coderObj) {
    throw new Error('Provider apiKey must not be stored in block definition; use environment variables');
  }

  const reviewer = providersObj.reviewer;
  if (typeof reviewer !== 'object' || reviewer === null || Array.isArray(reviewer)) {
    throw new Error('Block definition missing required provider: providers.reviewer');
  }
  const reviewerObj = reviewer as Record<string, unknown>;
  if (!reviewerObj.provider || typeof reviewerObj.provider !== 'string') {
    throw new Error('Block definition missing required field: providers.reviewer.provider');
  }
  if (!reviewerObj.model || typeof reviewerObj.model !== 'string') {
    throw new Error('Block definition missing required field: providers.reviewer.model');
  }
  if ('apiKey' in reviewerObj) {
    throw new Error('Provider apiKey must not be stored in block definition; use environment variables');
  }

  // Review policy
  const reviewPolicy = obj.review_policy;
  if (typeof reviewPolicy !== 'object' || reviewPolicy === null || Array.isArray(reviewPolicy)) {
    throw new Error('Block definition missing required field: review_policy');
  }
  const reviewPolicyObj = reviewPolicy as Record<string, unknown>;

  const requireDeterministicChecks = reviewPolicyObj.require_deterministic_checks;
  if (typeof requireDeterministicChecks !== 'boolean') {
    throw new Error('Block definition review_policy.require_deterministic_checks must be a boolean');
  }

  const maxFixAttempts = reviewPolicyObj.max_fix_attempts;
  if (typeof maxFixAttempts !== 'number' || !Number.isInteger(maxFixAttempts) || maxFixAttempts < 1 || maxFixAttempts > 5) {
    throw new Error('Block definition review_policy.max_fix_attempts must be an integer between 1 and 5');
  }

  const reviewerMode = reviewPolicyObj.reviewer_mode;
  if (reviewerMode !== 'single' && reviewerMode !== 'multi_future') {
    throw new Error('Block definition review_policy.reviewer_mode must be "single" or "multi_future"');
  }

  const taskTimeoutMs = reviewPolicyObj.task_timeout_ms;
  if (taskTimeoutMs !== undefined) {
    if (typeof taskTimeoutMs !== 'number' || !Number.isInteger(taskTimeoutMs) || taskTimeoutMs < 30000 || taskTimeoutMs > 900000) {
      throw new Error('Block definition review_policy.task_timeout_ms must be an integer between 30000 and 900000');
    }
  }

  const reviewerParseRetries = reviewPolicyObj.reviewer_parse_retries;
  if (reviewerParseRetries !== undefined) {
    if (typeof reviewerParseRetries !== 'number' || !Number.isInteger(reviewerParseRetries) || reviewerParseRetries < 0 || reviewerParseRetries > 5) {
      throw new Error('Block definition review_policy.reviewer_parse_retries must be an integer between 0 and 5');
    }
  }

  const onBlockedTask = reviewPolicyObj.on_blocked_task;
  if (onBlockedTask !== undefined && onBlockedTask !== 'stop' && onBlockedTask !== 'continue' && onBlockedTask !== 'skip') {
    throw new Error('Block definition review_policy.on_blocked_task must be "stop", "continue", or "skip"');
  }

  // Tasks
  const tasks = obj.tasks;
  if (!Array.isArray(tasks) || tasks.length === 0) {
    throw new Error('Block definition tasks must be a non-empty array');
  }

  const taskIds = new Set<string>();
  for (let i = 0; i < tasks.length; i++) {
    const task = tasks[i];
    if (typeof task !== 'object' || task === null || Array.isArray(task)) {
      throw new Error(`Block definition task ${i} must be an object`);
    }
    const t = task as Record<string, unknown>;

    const taskId = t.task_id;
    if (!taskId || typeof taskId !== 'string') {
      throw new Error(`Block definition task ${i} missing required field: task_id`);
    }
    if (!isSafeBlockIdentifier(taskId)) {
      throw new Error(`Block definition task ${i} task_id contains unsupported characters`);
    }
    if (taskIds.has(taskId)) {
      throw new Error(`Block definition duplicate task_id: ${taskId}`);
    }
    taskIds.add(taskId);

    const taskTitle = t.title;
    if (!taskTitle || typeof taskTitle !== 'string') {
      throw new Error(`Block definition task ${i} missing required field: title`);
    }

    const taskGoal = t.goal;
    if (!taskGoal || typeof taskGoal !== 'string') {
      throw new Error(`Block definition task ${i} missing required field: goal`);
    }

    const allowedFiles = t.allowed_files;
    if (!Array.isArray(allowedFiles) || !allowedFiles.every((f) => typeof f === 'string')) {
      throw new Error(`Block definition task ${i} allowed_files must be an array of strings`);
    }

    const deniedFiles = t.denied_files;
    if (!Array.isArray(deniedFiles) || !deniedFiles.every((f) => typeof f === 'string')) {
      throw new Error(`Block definition task ${i} denied_files must be an array of strings`);
    }

    const maxLinesChanged = t.max_lines_changed;
    if (typeof maxLinesChanged !== 'number' || !Number.isFinite(maxLinesChanged) || maxLinesChanged <= 0) {
      throw new Error(`Block definition task ${i} max_lines_changed must be a positive number`);
    }

    const checks = t.checks;
    if (!Array.isArray(checks) || !checks.every((c) => typeof c === 'string')) {
      throw new Error(`Block definition task ${i} checks must be an array of strings`);
    }
  }

  return data as BlockDefinition;
}
