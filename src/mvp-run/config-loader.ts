import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { MvpRunConfig } from './types.js';

const VALID_PROVIDERS = ['fake', 'kimi'];
const VALID_BLOCKED_POLICIES = ['stop', 'continue'];

export function loadMvpRunConfig(configPath: string): MvpRunConfig {
  const raw = readFileSync(configPath, 'utf-8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`MVP run config is not valid JSON: ${message}`);
  }
  const validation = validateMvpRunConfig(parsed);
  if (!validation.ok) {
    throw new Error(`Invalid MVP run config:\n${validation.reasons.join('\n')}`);
  }
  const config = parsed as MvpRunConfig;
  config.repo_path = resolve(config.repo_path);
  config.report_dir = resolve(config.report_dir);
  return config;
}

export function validateMvpRunConfig(value: unknown): { ok: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (value === null || typeof value !== 'object') {
    reasons.push('Config must be an object');
    return { ok: false, reasons };
  }
  const config = value as Record<string, unknown>;

  if (!VALID_PROVIDERS.includes(String(config.provider))) {
    reasons.push(`provider must be one of ${VALID_PROVIDERS.join(', ')}`);
  }
  if (typeof config.repo_path !== 'string' || config.repo_path.length === 0) {
    reasons.push('repo_path must be a non-empty string');
  }
  if (config.repo_slug !== undefined && typeof config.repo_slug !== 'string') {
    reasons.push('repo_slug must be a string when provided');
  }
  if (typeof config.base_branch !== 'string' || config.base_branch.length === 0) {
    reasons.push('base_branch must be a non-empty string');
  }
  if (typeof config.work_branch !== 'string' || config.work_branch.length === 0) {
    reasons.push('work_branch must be a non-empty string');
  }
  if (config.work_branch === 'main' || config.work_branch === 'master') {
    reasons.push('work_branch must not be a protected branch like main or master');
  }
  if (typeof config.run_id !== 'string' || config.run_id.length === 0) {
    reasons.push('run_id must be a non-empty string');
  }
  if (typeof config.allow_real_provider !== 'boolean') {
    reasons.push('allow_real_provider must be a boolean');
  }
  if (typeof config.allow_real_repo_apply !== 'boolean') {
    reasons.push('allow_real_repo_apply must be a boolean');
  }
  if (typeof config.allow_real_repo_commit !== 'boolean') {
    reasons.push('allow_real_repo_commit must be a boolean');
  }
  if (typeof config.allow_real_repo_push !== 'boolean') {
    reasons.push('allow_real_repo_push must be a boolean');
  }
  if (typeof config.allow_github_pr_create !== 'boolean') {
    reasons.push('allow_github_pr_create must be a boolean');
  }
  if (typeof config.report_dir !== 'string' || config.report_dir.length === 0) {
    reasons.push('report_dir must be a non-empty string');
  }
  if (config.on_blocked_task !== undefined && !VALID_BLOCKED_POLICIES.includes(String(config.on_blocked_task))) {
    reasons.push(`on_blocked_task must be one of ${VALID_BLOCKED_POLICIES.join(', ')} when provided`);
  }

  if (!Array.isArray(config.tasks) || config.tasks.length === 0) {
    reasons.push('tasks must be a non-empty array');
  } else {
    for (let i = 0; i < config.tasks.length; i++) {
      reasons.push(...validateTaskConfig(config.tasks[i], i));
    }
  }

  return { ok: reasons.length === 0, reasons };
}

function validateTaskConfig(value: unknown, index: number): string[] {
  const reasons: string[] = [];
  if (value === null || typeof value !== 'object') {
    reasons.push(`tasks[${index}] must be an object`);
    return reasons;
  }
  const task = value as Record<string, unknown>;

  if (typeof task.id !== 'string' || task.id.length === 0) {
    reasons.push(`tasks[${index}].id must be a non-empty string`);
  }
  if (typeof task.title !== 'string' || task.title.length === 0) {
    reasons.push(`tasks[${index}].title must be a non-empty string`);
  }
  if (typeof task.goal !== 'string' || task.goal.length === 0) {
    reasons.push(`tasks[${index}].goal must be a non-empty string`);
  }
  if (!Array.isArray(task.allowed_files) || task.allowed_files.length === 0) {
    reasons.push(`tasks[${index}].allowed_files must be a non-empty array`);
  } else {
    for (let j = 0; j < task.allowed_files.length; j++) {
      if (typeof task.allowed_files[j] !== 'string') {
        reasons.push(`tasks[${index}].allowed_files[${j}] must be a string`);
      }
    }
  }
  if (task.denied_files !== undefined && !Array.isArray(task.denied_files)) {
    reasons.push(`tasks[${index}].denied_files must be an array when provided`);
  }
  if (task.tests !== undefined && !Array.isArray(task.tests)) {
    reasons.push(`tasks[${index}].tests must be an array when provided`);
  }

  return reasons;
}
