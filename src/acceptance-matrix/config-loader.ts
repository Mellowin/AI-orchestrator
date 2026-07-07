import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { AcceptanceMatrixConfig, AcceptanceScenarioConfig } from './types.js';

const VALID_PROVIDERS = ['fake', 'kimi'];
const VALID_SCENARIO_TYPES = ['golden_real_multitask', 'blocked_stop', 'blocked_continue'];
const VALID_UNSAFE_MODES = ['none', 'fake_deterministic'];

export function loadAcceptanceMatrixConfig(configPath: string): AcceptanceMatrixConfig {
  const raw = readFileSync(configPath, 'utf-8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Acceptance matrix config is not valid JSON: ${message}`);
  }
  const validation = validateAcceptanceMatrixConfig(parsed);
  if (!validation.ok) {
    throw new Error(`Invalid acceptance matrix config:\n${validation.reasons.join('\n')}`);
  }
  const config = parsed as AcceptanceMatrixConfig;
  config.report_dir = resolve(config.report_dir);
  config.sandbox_repo_path = resolve(config.sandbox_repo_path);
  return config;
}

export function validateAcceptanceMatrixConfig(value: unknown): { ok: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (value === null || typeof value !== 'object') {
    reasons.push('Config must be an object');
    return { ok: false, reasons };
  }
  const config = value as Record<string, unknown>;

  if (!VALID_PROVIDERS.includes(String(config.provider))) {
    reasons.push(`provider must be one of ${VALID_PROVIDERS.join(', ')}`);
  }
  if (typeof config.allow_real_provider !== 'boolean') {
    reasons.push('allow_real_provider must be a boolean');
  }
  if (typeof config.allow_github_pr_create !== 'boolean') {
    reasons.push('allow_github_pr_create must be a boolean');
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
  if (typeof config.stop_on_orchestrator_bug !== 'boolean') {
    reasons.push('stop_on_orchestrator_bug must be a boolean');
  }
  if (typeof config.report_dir !== 'string' || config.report_dir.length === 0) {
    reasons.push('report_dir must be a non-empty string');
  }
  if (typeof config.sandbox_repo_path !== 'string' || config.sandbox_repo_path.length === 0) {
    reasons.push('sandbox_repo_path must be a non-empty string');
  }
  if (config.sandbox_repo_slug !== undefined && typeof config.sandbox_repo_slug !== 'string') {
    reasons.push('sandbox_repo_slug must be a string when provided');
  }
  if (!Array.isArray(config.scenarios) || config.scenarios.length === 0) {
    reasons.push('scenarios must be a non-empty array');
  } else {
    for (let i = 0; i < config.scenarios.length; i++) {
      reasons.push(...validateScenarioConfig(config.scenarios[i], i));
    }
  }

  return { ok: reasons.length === 0, reasons };
}

function validateScenarioConfig(value: unknown, index: number): string[] {
  const reasons: string[] = [];
  if (value === null || typeof value !== 'object') {
    reasons.push(`scenarios[${index}] must be an object`);
    return reasons;
  }
  const scenario = value as Record<string, unknown>;

  if (!VALID_SCENARIO_TYPES.includes(String(scenario.type))) {
    reasons.push(`scenarios[${index}].type must be one of ${VALID_SCENARIO_TYPES.join(', ')}`);
  }
  if (typeof scenario.base_branch !== 'string' || scenario.base_branch.length === 0) {
    reasons.push(`scenarios[${index}].base_branch must be a non-empty string`);
  }
  if (typeof scenario.work_branch !== 'string' || scenario.work_branch.length === 0) {
    reasons.push(`scenarios[${index}].work_branch must be a non-empty string`);
  }
  if (!VALID_UNSAFE_MODES.includes(String(scenario.unsafe_response_mode))) {
    reasons.push(`scenarios[${index}].unsafe_response_mode must be one of ${VALID_UNSAFE_MODES.join(', ')}`);
  }
  if (scenario.label !== undefined && typeof scenario.label !== 'string') {
    reasons.push(`scenarios[${index}].label must be a string when provided`);
  }
  if (scenario.stop_on_failure !== undefined && typeof scenario.stop_on_failure !== 'boolean') {
    reasons.push(`scenarios[${index}].stop_on_failure must be a boolean when provided`);
  }
  if (scenario.env !== undefined) {
    if (typeof scenario.env !== 'object' || scenario.env === null) {
      reasons.push(`scenarios[${index}].env must be an object when provided`);
    } else {
      for (const [key, val] of Object.entries(scenario.env)) {
        if (typeof val !== 'string') {
          reasons.push(`scenarios[${index}].env["${key}"] must be a string`);
        }
      }
    }
  }
  return reasons;
}

export function scenarioRequiresFakeUnsafeResponse(scenario: AcceptanceScenarioConfig): boolean {
  return scenario.type !== 'golden_real_multitask' && scenario.unsafe_response_mode === 'fake_deterministic';
}
