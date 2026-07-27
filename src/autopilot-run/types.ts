/**
 * Autopilot Run — one-click autonomous multitask + CI self-repair loop.
 *
 * Composes `mvp-run` (multi-task execution) with `diagnose-ci` (CI failure
 * diagnosis) and a bounded repair loop backed by an AI provider.
 */

import type { DiagnoseCiResult } from '../diagnose-ci/types.js';
import type { MvpRunResult } from '../mvp-run/types.js';

export type AutopilotRunMode = 'fake' | 'github';

export type AutopilotRunVerdict =
  | 'AUTOPILOT_GREEN'
  | 'AUTOPILOT_MVP_FAILED'
  | 'AUTOPILOT_MVP_DONE_CI_NOT_OBSERVED'
  | 'AUTOPILOT_MVP_DEFERRED'
  | 'AUTOPILOT_CI_TIMEOUT'
  | 'AUTOPILOT_CI_RED_DIAGNOSED'
  | 'AUTOPILOT_REPAIR_EXHAUSTED'
  | 'AUTOPILOT_REPAIR_FAILED'
  | 'AUTOPILOT_NEEDS_TOKEN'
  | 'AUTOPILOT_ACCESS_ERROR'
  | 'AUTOPILOT_CONFIG_ERROR'
  | 'AUTOPILOT_FAILED';

export type AutopilotRepairProvider = 'mock' | 'kimi';

export interface AutopilotRunDiagnoseConfig {
  token_env: string;
  include_raw_logs: boolean;
  max_log_excerpt_chars: number;
}

export interface AutopilotRunCiConfig {
  enabled: boolean;
  wait_for_ci: boolean;
  poll_interval_seconds: number;
  timeout_seconds: number;
}

export interface AutopilotRunRepairConfig {
  enabled: boolean;
  max_attempts: number;
  provider: AutopilotRepairProvider;
  allow_real_provider: boolean;
  allow_apply: boolean;
  allow_commit: boolean;
  allow_push: boolean;
  allowed_files?: string[];
  denied_files: string[];
}

export interface AutopilotRunGithubConfig {
  allow_pr_create: boolean;
  allow_pr_update: boolean;
  allow_actions_read: boolean;
  allow_write: boolean;
}

export interface AutopilotRunConfig {
  mode: AutopilotRunMode;
  run_id: string;
  repo_slug: string;
  base_branch: string;
  work_branch: string;
  mvp_config_path: string;
  diagnose_config: AutopilotRunDiagnoseConfig;
  ci: AutopilotRunCiConfig;
  repair: AutopilotRunRepairConfig;
  github: AutopilotRunGithubConfig;
  report_dir: string;
}

export interface AutopilotCapabilitySummary {
  requested: string[];
  allowed_write: string[];
  forbidden: string[];
}

export interface AutopilotRunTimelineEvent {
  timestamp: string;
  event: string;
  payload?: Record<string, unknown>;
}

export interface AutopilotRunResult {
  config: AutopilotRunConfig;
  command: string;
  config_path: string;
  started_at: string;
  finished_at: string;
  duration_ms: number;
  verdict: AutopilotRunVerdict;
  reason: string;
  mvp_result?: MvpRunResult;
  ci_run_id?: number;
  ci_conclusion?: string | null;
  diagnosis?: DiagnoseCiResult;
  repair_attempts: number;
  report_dir: string;
  exit_code: number;
  next_human_action?: string;
}

export interface AutopilotRunOptions {
  /** Injected fetch implementation for testing. Defaults to global fetch. */
  fetchFn?: typeof globalThis.fetch;
  /** Command string to record in the report. */
  command?: string;
  /** Resume an existing MVP run instead of starting from scratch. */
  resume?: boolean;
}
