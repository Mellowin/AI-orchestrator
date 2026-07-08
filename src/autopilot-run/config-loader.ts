import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type {
  AutopilotRepairProvider,
  AutopilotRunCiConfig,
  AutopilotRunConfig,
  AutopilotRunDiagnoseConfig,
  AutopilotRunGithubConfig,
  AutopilotRunMode,
  AutopilotRunRepairConfig,
} from './types.js';

const VALID_MODES: AutopilotRunMode[] = ['fake', 'github'];
const VALID_REPAIR_PROVIDERS: AutopilotRepairProvider[] = ['mock', 'kimi'];
const REPO_SLUG_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export function loadAutopilotRunConfig(configPath: string): AutopilotRunConfig {
  let raw: string;
  try {
    raw = readFileSync(configPath, 'utf-8');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Autopilot run config not found or unreadable: ${message}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Autopilot run config is not valid JSON: ${message}`);
  }

  if (parsed === null || typeof parsed !== 'object') {
    throw new Error('Autopilot run config must be a JSON object');
  }

  const config = parsed as Record<string, unknown>;
  applyDefaults(config);

  const validation = validateAutopilotRunConfig(config);
  if (!validation.ok) {
    throw new Error(`Invalid autopilot run config:\n${validation.reasons.join('\n')}`);
  }

  const result = config as unknown as AutopilotRunConfig;
  result.report_dir = resolve(result.report_dir);
  return result;
}

function applyDefaults(config: Record<string, unknown>): void {
  if (config.diagnose_config === undefined || config.diagnose_config === null) {
    config.diagnose_config = {};
  }
  if (typeof config.diagnose_config === 'object' && config.diagnose_config !== null) {
    const dc = config.diagnose_config as Record<string, unknown>;
    if (dc.token_env === undefined) dc.token_env = 'GITHUB_TOKEN';
    if (dc.include_raw_logs === undefined) dc.include_raw_logs = false;
    if (dc.max_log_excerpt_chars === undefined) dc.max_log_excerpt_chars = 4000;
  }

  if (config.ci === undefined || config.ci === null) {
    config.ci = {};
  }
  if (typeof config.ci === 'object' && config.ci !== null) {
    const ci = config.ci as Record<string, unknown>;
    if (ci.enabled === undefined) ci.enabled = false;
    if (ci.wait_for_ci === undefined) ci.wait_for_ci = false;
    if (ci.poll_interval_seconds === undefined) ci.poll_interval_seconds = 15;
    if (ci.timeout_seconds === undefined) ci.timeout_seconds = 900;
  }

  if (config.repair === undefined || config.repair === null) {
    config.repair = {};
  }
  if (typeof config.repair === 'object' && config.repair !== null) {
    const repair = config.repair as Record<string, unknown>;
    if (repair.enabled === undefined) repair.enabled = false;
    if (repair.max_attempts === undefined) repair.max_attempts = 2;
    if (repair.provider === undefined) repair.provider = 'mock';
    if (repair.allow_real_provider === undefined) repair.allow_real_provider = false;
    if (repair.allow_apply === undefined) repair.allow_apply = false;
    if (repair.allow_commit === undefined) repair.allow_commit = false;
    if (repair.allow_push === undefined) repair.allow_push = false;
    if (repair.denied_files === undefined) repair.denied_files = ['.env*'];
  }

  if (config.github === undefined || config.github === null) {
    config.github = {};
  }
  if (typeof config.github === 'object' && config.github !== null) {
    const gh = config.github as Record<string, unknown>;
    if (gh.allow_pr_create === undefined) gh.allow_pr_create = false;
    if (gh.allow_pr_update === undefined) gh.allow_pr_update = false;
    if (gh.allow_actions_read === undefined) gh.allow_actions_read = false;
    if (gh.allow_write === undefined) gh.allow_write = false;
  }
}

export function validateAutopilotRunConfig(value: Record<string, unknown>): {
  ok: boolean;
  reasons: string[];
} {
  const reasons: string[] = [];

  if (!VALID_MODES.includes(String(value.mode) as AutopilotRunMode)) {
    reasons.push(`mode must be one of ${VALID_MODES.join(', ')}`);
  }

  if (typeof value.run_id !== 'string' || value.run_id.length === 0) {
    reasons.push('run_id must be a non-empty string');
  }

  if (typeof value.repo_slug !== 'string' || !REPO_SLUG_RE.test(value.repo_slug)) {
    reasons.push('repo_slug must be in "owner/repo" format');
  }

  if (typeof value.base_branch !== 'string' || value.base_branch.length === 0) {
    reasons.push('base_branch must be a non-empty string');
  }

  if (typeof value.work_branch !== 'string' || value.work_branch.length === 0) {
    reasons.push('work_branch must be a non-empty string');
  }

  if (typeof value.mvp_config_path !== 'string' || value.mvp_config_path.length === 0) {
    reasons.push('mvp_config_path must be a non-empty string');
  }

  reasons.push(...validateDiagnoseConfig(value.diagnose_config));
  reasons.push(...validateCiConfig(value.ci));
  reasons.push(...validateRepairConfig(value.repair));
  reasons.push(...validateGithubConfig(value.github));

  if (typeof value.report_dir !== 'string' || value.report_dir.length === 0) {
    reasons.push('report_dir must be a non-empty string');
  }

  return { ok: reasons.length === 0, reasons };
}

function validateDiagnoseConfig(value: unknown): string[] {
  const reasons: string[] = [];
  if (value === null || typeof value !== 'object') {
    reasons.push('diagnose_config must be an object');
    return reasons;
  }
  const dc = value as Record<string, unknown>;
  if (typeof dc.token_env !== 'string' || dc.token_env.length === 0) {
    reasons.push('diagnose_config.token_env must be a non-empty string');
  }
  if (typeof dc.include_raw_logs !== 'boolean') {
    reasons.push('diagnose_config.include_raw_logs must be a boolean');
  }
  if (
    typeof dc.max_log_excerpt_chars !== 'number' ||
    !Number.isFinite(dc.max_log_excerpt_chars) ||
    dc.max_log_excerpt_chars < 0
  ) {
    reasons.push('diagnose_config.max_log_excerpt_chars must be a non-negative number');
  }
  return reasons;
}

function validateCiConfig(value: unknown): string[] {
  const reasons: string[] = [];
  if (value === null || typeof value !== 'object') {
    reasons.push('ci must be an object');
    return reasons;
  }
  const ci = value as Record<string, unknown>;
  if (typeof ci.enabled !== 'boolean') {
    reasons.push('ci.enabled must be a boolean');
  }
  if (typeof ci.wait_for_ci !== 'boolean') {
    reasons.push('ci.wait_for_ci must be a boolean');
  }
  if (
    typeof ci.poll_interval_seconds !== 'number' ||
    !Number.isFinite(ci.poll_interval_seconds) ||
    ci.poll_interval_seconds < 1
  ) {
    reasons.push('ci.poll_interval_seconds must be a positive number');
  }
  if (
    typeof ci.timeout_seconds !== 'number' ||
    !Number.isFinite(ci.timeout_seconds) ||
    ci.timeout_seconds < 1
  ) {
    reasons.push('ci.timeout_seconds must be a positive number');
  }
  return reasons;
}

function validateRepairConfig(value: unknown): string[] {
  const reasons: string[] = [];
  if (value === null || typeof value !== 'object') {
    reasons.push('repair must be an object');
    return reasons;
  }
  const repair = value as Record<string, unknown>;
  if (typeof repair.enabled !== 'boolean') {
    reasons.push('repair.enabled must be a boolean');
  }
  if (
    typeof repair.max_attempts !== 'number' ||
    !Number.isInteger(repair.max_attempts) ||
    repair.max_attempts < 1
  ) {
    reasons.push('repair.max_attempts must be a positive integer');
  }
  if (!VALID_REPAIR_PROVIDERS.includes(String(repair.provider) as AutopilotRepairProvider)) {
    reasons.push(`repair.provider must be one of ${VALID_REPAIR_PROVIDERS.join(', ')}`);
  }
  if (typeof repair.allow_real_provider !== 'boolean') {
    reasons.push('repair.allow_real_provider must be a boolean');
  }
  if (typeof repair.allow_apply !== 'boolean') {
    reasons.push('repair.allow_apply must be a boolean');
  }
  if (typeof repair.allow_commit !== 'boolean') {
    reasons.push('repair.allow_commit must be a boolean');
  }
  if (typeof repair.allow_push !== 'boolean') {
    reasons.push('repair.allow_push must be a boolean');
  }
  if (repair.allowed_files !== undefined && !Array.isArray(repair.allowed_files)) {
    reasons.push('repair.allowed_files must be an array when provided');
  }
  if (!Array.isArray(repair.denied_files)) {
    reasons.push('repair.denied_files must be an array');
  }
  return reasons;
}

function validateGithubConfig(value: unknown): string[] {
  const reasons: string[] = [];
  if (value === null || typeof value !== 'object') {
    reasons.push('github must be an object');
    return reasons;
  }
  const gh = value as Record<string, unknown>;
  if (typeof gh.allow_pr_create !== 'boolean') {
    reasons.push('github.allow_pr_create must be a boolean');
  }
  if (typeof gh.allow_pr_update !== 'boolean') {
    reasons.push('github.allow_pr_update must be a boolean');
  }
  if (typeof gh.allow_actions_read !== 'boolean') {
    reasons.push('github.allow_actions_read must be a boolean');
  }
  if (typeof gh.allow_write !== 'boolean') {
    reasons.push('github.allow_write must be a boolean');
  }
  return reasons;
}

export function isMvpSuccess(verdict: string): boolean {
  return verdict === 'MVP_RUN_PASSED' || verdict === 'MVP_RUN_PASSED_WITH_CAVEATS';
}
