import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type {
  DiagnoseCiConfig,
  DiagnoseCiFakeScenario,
  DiagnoseCiMode,
  DiagnoseCiTarget,
} from './types.js';

const VALID_MODES: DiagnoseCiMode[] = ['fake', 'github'];
const VALID_FAKE_SCENARIOS: DiagnoseCiFakeScenario[] = ['green', 'red'];
const REPO_SLUG_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export function loadDiagnoseCiConfig(configPath: string): DiagnoseCiConfig {
  let raw: string;
  try {
    raw = readFileSync(configPath, 'utf-8');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Diagnose CI config not found or unreadable: ${message}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Diagnose CI config is not valid JSON: ${message}`);
  }

  if (parsed === null || typeof parsed !== 'object') {
    throw new Error('Diagnose CI config must be a JSON object');
  }

  const config = parsed as Record<string, unknown>;
  applyDefaults(config);

  const validation = validateDiagnoseCiConfig(config);
  if (!validation.ok) {
    throw new Error(`Invalid diagnose CI config:\n${validation.reasons.join('\n')}`);
  }

  const result = config as unknown as DiagnoseCiConfig;
  result.report_dir = resolve(result.report_dir);
  return result;
}

function applyDefaults(config: Record<string, unknown>): void {
  if (config.token_env === undefined) {
    config.token_env = 'GITHUB_TOKEN';
  }
  if (config.include_raw_logs === undefined) {
    config.include_raw_logs = false;
  }
  if (config.max_log_excerpt_chars === undefined) {
    config.max_log_excerpt_chars = 4000;
  }
  if (config.allow_github_write === undefined) {
    config.allow_github_write = false;
  }
  if (config.fake_scenario === undefined) {
    config.fake_scenario = 'green';
  }
}

export function validateDiagnoseCiConfig(value: Record<string, unknown>): {
  ok: boolean;
  reasons: string[];
} {
  const reasons: string[] = [];

  if (!VALID_MODES.includes(String(value.mode) as DiagnoseCiMode)) {
    reasons.push(`mode must be one of ${VALID_MODES.join(', ')}`);
  }

  if (typeof value.run_id !== 'string' || value.run_id.length === 0) {
    reasons.push('run_id must be a non-empty string');
  }

  if (typeof value.repo_slug !== 'string' || !REPO_SLUG_RE.test(value.repo_slug)) {
    reasons.push('repo_slug must be in "owner/repo" format');
  }

  reasons.push(...validateTarget(value.target));

  if (typeof value.token_env !== 'string' || value.token_env.length === 0) {
    reasons.push('token_env must be a non-empty string');
  }

  if (typeof value.report_dir !== 'string' || value.report_dir.length === 0) {
    reasons.push('report_dir must be a non-empty string');
  }

  if (typeof value.include_raw_logs !== 'boolean') {
    reasons.push('include_raw_logs must be a boolean');
  }

  if (
    typeof value.max_log_excerpt_chars !== 'number' ||
    !Number.isFinite(value.max_log_excerpt_chars) ||
    value.max_log_excerpt_chars < 0
  ) {
    reasons.push('max_log_excerpt_chars must be a non-negative number');
  }

  if (typeof value.allow_github_write !== 'boolean') {
    reasons.push('allow_github_write must be a boolean');
  }

  if (value.allow_github_write === true) {
    reasons.push('allow_github_write must be false (diagnose-ci is read-only)');
  }

  if (value.fake_scenario !== undefined) {
    if (!VALID_FAKE_SCENARIOS.includes(String(value.fake_scenario) as DiagnoseCiFakeScenario)) {
      reasons.push(`fake_scenario must be one of ${VALID_FAKE_SCENARIOS.join(', ')}`);
    }
  }

  return { ok: reasons.length === 0, reasons };
}

function validateTarget(value: unknown): string[] {
  const reasons: string[] = [];

  if (value === null || typeof value !== 'object') {
    reasons.push('target must be an object');
    return reasons;
  }

  const target = value as Record<string, unknown>;

  const hasWorkflowRunId =
    target.workflow_run_id !== undefined &&
    (typeof target.workflow_run_id !== 'number' || !Number.isFinite(target.workflow_run_id));
  const hasPrNumber =
    target.pr_number !== undefined &&
    (typeof target.pr_number !== 'number' || !Number.isFinite(target.pr_number));
  const hasCommitSha =
    target.commit_sha !== undefined &&
    (typeof target.commit_sha !== 'string' || target.commit_sha.length === 0);

  if (typeof target.workflow_run_id === 'number' && !Number.isFinite(target.workflow_run_id)) {
    reasons.push('target.workflow_run_id must be a finite number');
  }
  if (typeof target.pr_number === 'number' && !Number.isFinite(target.pr_number)) {
    reasons.push('target.pr_number must be a finite number');
  }
  if (typeof target.commit_sha === 'string' && target.commit_sha.length === 0) {
    reasons.push('target.commit_sha must be a non-empty string');
  }

  const hasAnyTarget =
    (typeof target.workflow_run_id === 'number' && Number.isFinite(target.workflow_run_id)) ||
    (typeof target.pr_number === 'number' && Number.isFinite(target.pr_number)) ||
    (typeof target.commit_sha === 'string' && target.commit_sha.length > 0);

  if (!hasAnyTarget) {
    reasons.push('target must include workflow_run_id, pr_number, or commit_sha');
  }

  // Silence unused-variable warnings while keeping the validation structure explicit.
  void hasWorkflowRunId;
  void hasPrNumber;
  void hasCommitSha;

  return reasons;
}

export function getTargetPriority(target: DiagnoseCiTarget): {
  source: 'workflow_run_id' | 'pr_number' | 'commit_sha';
  value: number | string;
} {
  if (typeof target.workflow_run_id === 'number' && Number.isFinite(target.workflow_run_id)) {
    return { source: 'workflow_run_id', value: target.workflow_run_id };
  }
  if (typeof target.pr_number === 'number' && Number.isFinite(target.pr_number)) {
    return { source: 'pr_number', value: target.pr_number };
  }
  return { source: 'commit_sha', value: target.commit_sha ?? '' };
}
