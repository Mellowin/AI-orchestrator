/**
 * MVP Run — product-facing autonomous multi-task execution.
 *
 * One config, one command, no manual orchestration.
 */

import type { Check } from '../types.js';

export type MvpRunProvider = 'fake' | 'kimi';

export type MvpRunVerdict =
  | 'MVP_RUN_PASSED'
  | 'MVP_RUN_PASSED_WITH_CAVEATS'
  | 'MVP_RUN_NEEDS_HUMAN'
  | 'MVP_RUN_FAILED';

export type MvpRunTaskStatus =
  | 'passed'
  | 'passed_with_caveats'
  | 'failed'
  | 'blocked'
  | 'skipped'
  | 'needs_human';

export interface MvpRunTaskConfig {
  id: string;
  title: string;
  goal: string;
  allowed_files: string[];
  denied_files?: string[];
  tests?: string[];
  /** Shell commands or structured checks to run as deterministic verification. Takes precedence over `tests`. */
  checks?: (string | Check)[];
  max_lines_changed?: number;
  depends_on?: string[];
  acceptance_criteria?: string[];
}

export interface MvpRunConfig {
  provider: MvpRunProvider;
  repo_path: string;
  repo_slug?: string;
  base_branch: string;
  work_branch: string;
  run_id: string;
  allow_real_provider: boolean;
  allow_real_repo_apply: boolean;
  allow_real_repo_commit: boolean;
  allow_real_repo_push: boolean;
  allow_github_pr_create: boolean;
  tasks: MvpRunTaskConfig[];
  report_dir: string;
  on_blocked_task?: 'stop' | 'continue';
  /** Optional mission-specific workspace root for execution repos and candidate workspaces. */
  workspace_root?: string;
}

export interface MvpRunPreflightReport {
  repo_path: string;
  repo_slug?: string;
  base_branch: string;
  work_branch: string;
  provider: MvpRunProvider;
  real_provider_enabled: boolean;
  apply_enabled: boolean;
  commit_enabled: boolean;
  push_enabled: boolean;
  pr_creation_enabled: boolean;
  missing_env_vars: string[];
  detected_risks: string[];
}

export interface MvpRunTaskReport {
  id: string;
  title: string;
  status: MvpRunTaskStatus;
  final_status?: string;
  reason?: string;
  provider_attempts: number;
  recovery_attempts: number;
  commit_sha?: string;
  fix_commit_sha?: string;
  files_changed?: string[];
}

export interface MvpRunPrResult {
  created: boolean;
  number?: number;
  url?: string;
  draft?: boolean;
  reason: string;
  classification?: string;
}

export interface MvpRunResult {
  config: MvpRunConfig;
  command: string;
  config_path: string;
  started_at: string;
  finished_at: string;
  duration_ms: number;
  verdict: MvpRunVerdict;
  classification?: string;
  reason: string;
  preflight: MvpRunPreflightReport;
  task_results: MvpRunTaskReport[];
  tasks_total: number;
  tasks_passed: number;
  tasks_failed: number;
  tasks_blocked: number;
  tasks_skipped: number;
  tasks_caveats: number;
  commits: string[];
  branch: string;
  pushed: boolean;
  pr?: MvpRunPrResult;
  caveats: string[];
  failure_classification?: string;
  next_human_action?: string;
  report_dir: string;
  block_state_path?: string;
}
