import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ReliabilityConfig, ReliabilityMode } from './types.js';

export interface LoadReliabilityConfigOptions {
  /** Override repo_path when running from a nested working directory. */
  cwd?: string;
}

export function loadReliabilityConfig(path: string, options: LoadReliabilityConfigOptions = {}): ReliabilityConfig {
  if (!existsSync(path)) {
    throw new Error(`Reliability config not found: ${path}`);
  }

  const raw = readFileSync(path, 'utf-8');
  const parsed = JSON.parse(raw) as unknown;
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Reliability config must be a JSON object: ${path}`);
  }

  const obj = parsed as Record<string, unknown>;

  function requiredString(key: string): string {
    const value = obj[key];
    if (typeof value !== 'string' || value.length === 0) {
      throw new Error(`Reliability config missing required field: ${key}`);
    }
    return value;
  }

  const modeValue = requiredString('mode');
  if (modeValue !== 'fake' && modeValue !== 'github') {
    throw new Error(`Reliability config mode must be "fake" or "github": ${modeValue}`);
  }
  const mode: ReliabilityMode = modeValue;

  const runId = requiredString('run_id');
  const repoSlug = requiredString('repo_slug');
  const repoPath = resolve(options.cwd ?? process.cwd(), requiredString('repo_path'));
  const baseBranch = requiredString('base_branch');
  const scenarioDir = resolve(options.cwd ?? process.cwd(), requiredString('scenario_dir'));
  const reportDir = resolve(options.cwd ?? process.cwd(), requiredString('report_dir'));

  const maxRepairAttempts = typeof obj.max_repair_attempts === 'number' ? obj.max_repair_attempts : 2;
  if (!Number.isInteger(maxRepairAttempts) || maxRepairAttempts < 0 || maxRepairAttempts > 3) {
    throw new Error('Reliability config max_repair_attempts must be an integer between 0 and 3');
  }

  const realGithub = obj.real_github === true;
  const realProvider = obj.real_provider === true;

  if (mode === 'github' && !realGithub) {
    throw new Error('Reliability config real_github must be true when mode is "github"');
  }

  const githubTokenEnv = typeof obj.github_token_env === 'string' ? obj.github_token_env : 'GITHUB_TOKEN';
  const providerTokenEnv = typeof obj.provider_token_env === 'string' ? obj.provider_token_env : 'KIMI_API_KEY';
  const tempRoot = typeof obj.temp_root === 'string' ? obj.temp_root : undefined;
  const ciTimeoutSeconds = typeof obj.ci_timeout_seconds === 'number' ? obj.ci_timeout_seconds : 600;
  const ciPollIntervalSeconds = typeof obj.ci_poll_interval_seconds === 'number' ? obj.ci_poll_interval_seconds : 15;

  if (!Number.isInteger(ciTimeoutSeconds) || ciTimeoutSeconds <= 0) {
    throw new Error('Reliability config ci_timeout_seconds must be a positive integer');
  }
  if (!Number.isInteger(ciPollIntervalSeconds) || ciPollIntervalSeconds <= 0) {
    throw new Error('Reliability config ci_poll_interval_seconds must be a positive integer');
  }

  const scenarioFilter = Array.isArray(obj.scenario_filter)
    ? obj.scenario_filter.filter((item): item is string => typeof item === 'string')
    : undefined;

  return {
    run_id: runId,
    mode,
    repo_slug: repoSlug,
    repo_path: repoPath,
    base_branch: baseBranch,
    scenario_dir: scenarioDir,
    max_repair_attempts: maxRepairAttempts,
    real_github: realGithub,
    real_provider: realProvider,
    report_dir: reportDir,
    github_token_env: githubTokenEnv,
    provider_token_env: providerTokenEnv,
    temp_root: tempRoot,
    ci_timeout_seconds: ciTimeoutSeconds,
    ci_poll_interval_seconds: ciPollIntervalSeconds,
    scenario_filter: scenarioFilter,
  };
}
