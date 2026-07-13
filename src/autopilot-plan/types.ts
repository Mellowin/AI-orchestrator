/**
 * Autopilot Plan — mission intake: human goal -> generated autopilot config.
 */

export type AutopilotPlanMode = 'fake' | 'github';

export type AutopilotPlanVerdict =
  | 'AUTOPILOT_PLAN_READY'
  | 'AUTOPILOT_PLAN_READY_WITH_CAVEATS'
  | 'AUTOPILOT_PLAN_NEEDS_PROVIDER_TOKEN'
  | 'AUTOPILOT_PLAN_CONFIG_ERROR'
  | 'AUTOPILOT_PLAN_PROVIDER_BAD_OUTPUT'
  | 'AUTOPILOT_PLAN_FAILED';

export interface AutopilotPlanProviderConfig {
  name: 'kimi';
  token_env: string;
}

export interface AutopilotPlanGithubConfig {
  token_env: string;
}

export interface AutopilotPlanCiConfig {
  wait_for_ci: boolean;
  poll_interval_seconds: number;
  timeout_seconds: number;
}

export interface AutopilotPlanRepairConfig {
  max_attempts: number;
}

export interface AutopilotPlanCapabilities {
  allow_real_provider: boolean;
  allow_repo_apply: boolean;
  allow_repo_commit: boolean;
  allow_repo_push: boolean;
  allow_pr_create: boolean;
  allow_pr_update: boolean;
  allow_actions_read: boolean;
  allow_repair: boolean;
}

export interface AutopilotPlanMission {
  run_id: string;
  repo_slug: string;
  repo_path: string;
  base_branch: string;
  goal: string;
  constraints?: string[];
  allowed_files?: string[];
  mode: AutopilotPlanMode;
  capabilities: AutopilotPlanCapabilities;
  provider?: AutopilotPlanProviderConfig;
  github?: AutopilotPlanGithubConfig;
  ci?: Partial<AutopilotPlanCiConfig>;
  repair?: Partial<AutopilotPlanRepairConfig>;
  output_dir: string;
}

export interface AutopilotPlanTask {
  id: string;
  title: string;
  goal: string;
  allowed_files: string[];
  denied_files?: string[];
  tests?: string[];
  risk: 'low' | 'medium' | 'high';
}

export interface AutopilotPlanGeneratedPlan {
  goal: string;
  mode: AutopilotPlanMode;
  tasks: AutopilotPlanTask[];
  ci_enabled: boolean;
  repair_enabled: boolean;
  risk_level: 'low' | 'medium' | 'high';
  caveats: string[];
}

export interface AutopilotPlanCapabilitySummary {
  requested: string[];
  allowed_write: string[];
  forbidden: string[];
}

export interface AutopilotPlanPreflightInfo {
  run_id: string;
  repo: string;
  goal: string;
  mode: AutopilotPlanMode;
  output_dir: string;
  capabilities: AutopilotPlanCapabilitySummary;
  provider_token_present: boolean;
  github_token_present: boolean;
  caveats: string[];
}

export interface AutopilotPlanResult {
  mission: AutopilotPlanMission;
  plan: AutopilotPlanGeneratedPlan;
  preflight: AutopilotPlanPreflightInfo;
  run_dir: string;
  generated_files: string[];
  verdict: AutopilotPlanVerdict;
  reason: string;
  exit_code: number;
  next_command: string;
}

export interface RunAutopilotPlanOptions {
  command?: string;
  runIdOverride?: string;
  providerCallFn?: (prompt: string, system?: string) => Promise<unknown>;
}
