/**
 * Reliability campaign — types for autonomous failure detection, diagnosis and repair.
 */

import type { DiagnoseCiClassification } from '../diagnose-ci/types.js';

export type ReliabilityMode = 'fake' | 'github';

export type ReliabilityClassification =
  | 'TEST_ASSERTION_FAILURE'
  | 'TYPECHECK_FAILURE'
  | 'BUILD_FAILURE'
  | 'IMPORT_OR_MODULE_FAILURE'
  | 'MISSING_EXPORT'
  | 'WRONG_FUNCTION_BEHAVIOR'
  | 'CONFIG_VALIDATION_FAILURE'
  | 'CLI_CONTRACT_FAILURE'
  | 'TESTING_SUMMARY_STALE'
  | 'DOCUMENTATION_CONTRACT_FAILURE'
  | 'PROVIDER_BAD_OUTPUT'
  | 'ALLOWED_FILE_SCOPE_VIOLATION'
  | 'WINDOWS_PATH_OR_ENV_ISOLATION_FAILURE'
  | 'CI_TIMEOUT'
  | 'CI_CANCELLED'
  | 'GITHUB_RATE_LIMIT'
  | 'GITHUB_ACCESS_FAILURE'
  | 'PUSH_PERMISSION_FAILURE'
  | 'PROVIDER_AUTH_FAILURE'
  | 'PROVIDER_RATE_LIMIT'
  | 'NETWORK_TRANSIENT'
  | 'WORKFLOW_INFRA_FAILURE'
  | 'REQUIREMENTS_AMBIGUOUS'
  | 'FIX_REQUIRES_FORBIDDEN_FILE'
  | 'FIX_REQUIRES_MIGRATION'
  | 'FIX_REQUIRES_SECRET'
  | 'FIX_REQUIRES_DESTRUCTIVE_ACTION'
  | 'UNKNOWN_FAILURE';

export type ReliabilityRepairPermitted = 'yes' | 'no' | 'human_required';

export interface ReliabilityClassificationMeta {
  classification: ReliabilityClassification;
  permitted: ReliabilityRepairPermitted;
  /** Default max attempts for this classification. */
  maxAttempts: number;
  /** Human-readable description of when this classification applies. */
  description: string;
  /** Required evidence before a repair is attempted. */
  requiredEvidence: string[];
  /** Stop condition for this classification. */
  stopCondition: string;
  /** Final verdict when repair is not permitted. */
  finalVerdictWhenBlocked: ReliabilityScenarioVerdict;
}

export type ReliabilityScenarioVerdict =
  | 'REPAIRED'
  | 'REPAIR_EXHAUSTED'
  | 'EXTERNAL_BLOCKER'
  | 'AMBIGUOUS_BLOCKER'
  | 'UNSAFE_PATCH_REJECTED'
  | 'FALSE_GREEN_REJECTED'
  | 'NOT_FIXABLE';

export type ReliabilityCampaignVerdict =
  | 'RELIABILITY_TARGET_MET'
  | 'RELIABILITY_TARGET_MET_WITH_CAVEATS'
  | 'RELIABILITY_TARGET_NOT_MET'
  | 'RELIABILITY_CAMPAIGN_FAILED';

export interface ReliabilityScenarioConfig {
  id: string;
  category: 'fixable' | 'external' | 'unsafe';
  classification: ReliabilityClassification;
  fixable: boolean;
  /** If deterministic repair is available, name of the strategy. */
  repair_strategy?: string;
  allowed_files: string[];
  denied_files?: string[];
  /** Files to modify to introduce the fault. */
  setup: ReliabilityScenarioPatch[];
  /** Expected fix patch for deterministic scenarios. */
  fix?: ReliabilityScenarioPatch[];
  /** Local check commands to run after repair. */
  verification_commands?: string[][];
  /** Expected targeted check command to reproduce the failure. */
  reproduction_command?: string[];
  /** Expected final outcome. */
  expected_verdict: ReliabilityScenarioVerdict;
  /** Optional human-readable note. */
  note?: string;
}

export interface ReliabilityScenarioPatch {
  path: string;
  /** If true, apply this patch by replacing the whole file content. */
  overwrite?: boolean;
  /** Search string for find-and-replace. Ignored when overwrite=true. */
  search?: string;
  /** Replacement string. */
  replace: string;
}

export interface ReliabilityConfig {
  run_id: string;
  mode: ReliabilityMode;
  repo_slug: string;
  repo_path: string;
  base_branch: string;
  scenario_dir: string;
  max_repair_attempts: number;
  real_github: boolean;
  real_provider: boolean;
  report_dir: string;
  /** GitHub token env var name for real mode. */
  github_token_env?: string;
  /** Provider token env var name for real mode. */
  provider_token_env?: string;
  /** Optional isolation root for temp clones. */
  temp_root?: string;
  /** CI observation timeout in seconds for real GitHub mode. */
  ci_timeout_seconds?: number;
  /** CI polling interval in seconds for real GitHub mode. */
  ci_poll_interval_seconds?: number;
}

export interface ReliabilityScenarioResult {
  scenario_id: string;
  classification: ReliabilityClassification;
  confidence: 'high' | 'medium' | 'low';
  expected_classification: ReliabilityClassification;
  classification_correct: boolean;
  verdict: ReliabilityScenarioVerdict;
  expected_verdict: ReliabilityScenarioVerdict;
  verdict_correct: boolean;
  repair_attempts: number;
  repair_commits: string[];
  pr_number?: number;
  pr_url?: string;
  original_ci_run_id?: number;
  original_ci_conclusion?: string | null;
  final_ci_run_id?: number;
  final_ci_conclusion?: string | null;
  failure_reason?: string;
  unsafe_patch_detected: boolean;
  unauthorized_files: string[];
  secret_leak_detected: boolean;
  started_at: string;
  finished_at: string;
  duration_ms: number;
}

export interface ReliabilityRunResult {
  scorecard: ReliabilityScorecard;
  reportDir: string;
}

export type ReliabilityScenarioStateStatus = 'pending' | 'setup_pushed' | 'repair_pushed' | 'done';

export interface ReliabilityCampaignScenarioState {
  scenario_id: string;
  status: ReliabilityScenarioStateStatus;
  branch?: string;
  pr_number?: number;
  pr_url?: string;
  setup_sha?: string;
  repair_shas?: string[];
  original_ci_run_id?: number;
  original_ci_conclusion?: string | null;
  final_ci_run_id?: number;
  final_ci_conclusion?: string | null;
  result?: ReliabilityScenarioResult;
}

export interface ReliabilityCampaignState {
  run_id: string;
  mode: ReliabilityMode;
  started_at: string;
  updated_at: string;
  scenarios: ReliabilityCampaignScenarioState[];
}

export interface ReliabilityScorecard {
  run_id: string;
  mode: ReliabilityMode;
  total_scenarios: number;
  correctly_classified: number;
  incorrectly_classified: number;
  fixable_scenarios: number;
  autonomously_repaired: number;
  repair_exhausted: number;
  unsafe_patches_rejected: number;
  external_blockers_stopped: number;
  ambiguous_blockers_stopped: number;
  false_green_count: number;
  unauthorized_file_count: number;
  secret_leak_count: number;
  average_attempts_per_repair: number;
  average_diagnosis_time_ms: number;
  average_repair_time_ms: number;
  real_ci_red_to_green_count: number;
  final_reliability_percentage: number;
  verdict: ReliabilityCampaignVerdict;
  reason: string;
  scenarios: ReliabilityScenarioResult[];
}

export interface ReliabilityRunOptions {
  fetchFn?: typeof globalThis.fetch;
  spawnFn?: typeof import('node:child_process').spawnSync;
  nowFn?: () => number;
  /** Resume an existing campaign from saved state instead of creating new PRs. */
  resume?: boolean;
}

/** Maps from existing diagnose-ci classifications to reliability taxonomy. */
export function mapDiagnoseCiClassification(
  classification: DiagnoseCiClassification | null | undefined
): ReliabilityClassification {
  switch (classification) {
    case 'TEST_FAILURE':
      return 'TEST_ASSERTION_FAILURE';
    case 'TYPECHECK_FAILURE':
      return 'TYPECHECK_FAILURE';
    case 'BUILD_FAILURE':
      return 'BUILD_FAILURE';
    case 'SUMMARY_LOCK_STALE':
      return 'TESTING_SUMMARY_STALE';
    case 'CI_TIMEOUT':
      return 'CI_TIMEOUT';
    case 'WORKFLOW_INFRA_FAILURE':
      return 'WORKFLOW_INFRA_FAILURE';
    case 'ACCESS_FAILURE':
      return 'GITHUB_ACCESS_FAILURE';
    case 'UNKNOWN_FAILURE':
    default:
      return 'UNKNOWN_FAILURE';
  }
}
