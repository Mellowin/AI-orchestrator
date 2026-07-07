/**
 * Acceptance Matrix Runner — config and result types.
 *
 * The runner executes a list of MVP scenarios against a throw-away sandbox repo.
 * All scenarios are self-contained: they create branches, run blocks, and classify
 * the outcome. Nothing touches this repository or any protected branch.
 */

export type AcceptanceMatrixProvider = 'fake' | 'kimi';

export type AcceptanceScenarioType =
  | 'golden_real_multitask'
  | 'blocked_stop'
  | 'blocked_continue';

export type UnsafeResponseMode = 'none' | 'fake_deterministic';

export type FailureClassification =
  | 'ORCHESTRATOR_BUG'
  | 'PROVIDER_INSTABILITY'
  | 'PROVIDER_BAD_OUTPUT'
  | 'GITHUB_API_ERROR'
  | 'SANDBOX_TEST_FAILURE'
  | 'SAFETY_POLICY_BLOCK_EXPECTED'
  | 'SAFETY_POLICY_BLOCK_EXPECTED_WITH_FAKE_UNSAFE_RESPONSE'
  | 'CONFIG_ERROR'
  | 'HUMAN_TOKEN_PERMISSION_ERROR'
  | 'UNKNOWN';

export type ScenarioStatus =
  | 'passed'
  | 'passed_with_caveats'
  | 'failed'
  | 'skipped';

export interface AcceptanceScenarioConfig {
  /** Scenario type. */
  type: AcceptanceScenarioType;
  /** Human-readable label. */
  label?: string;
  /** Base branch in the sandbox repo. */
  base_branch: string;
  /** Work branch to create. Must be unique per run. */
  work_branch: string;
  /** How to inject unsafe provider responses (real Kimi refuses). */
  unsafe_response_mode: UnsafeResponseMode;
  /** If true, the runner stops after this scenario fails (default: false). */
  stop_on_failure?: boolean;
  /** Extra environment variables passed to child CLI invocations. */
  env?: Record<string, string>;
}

export interface AcceptanceMatrixConfig {
  /** Runner mode. */
  provider: AcceptanceMatrixProvider;
  /** If true, the runner may call real AI providers (still gated by env). */
  allow_real_provider: boolean;
  /** If true, the runner may create GitHub PRs (still gated by token perms). */
  allow_github_pr_create: boolean;
  /** If true, the runner may apply files to the sandbox repo. */
  allow_real_repo_apply: boolean;
  /** If true, the runner may commit changes in the sandbox repo. */
  allow_real_repo_commit: boolean;
  /** If true, the runner may push changes from the sandbox repo. */
  allow_real_repo_push: boolean;
  /** If true, stop the whole matrix on an unexpected orchestrator bug. */
  stop_on_orchestrator_bug: boolean;
  /** Directory where reports and per-scenario evidence are written. */
  report_dir: string;
  /** Local path to the sandbox git repository. */
  sandbox_repo_path: string;
  /** Remote sandbox repository slug, used only when PR creation is attempted. */
  sandbox_repo_slug?: string;
  /** Scenarios to run in order. */
  scenarios: AcceptanceScenarioConfig[];
}

export interface AcceptanceScenarioResult {
  type: AcceptanceScenarioType;
  label: string;
  status: ScenarioStatus;
  /** True if the result was expected (e.g. a blocked scenario blocked). */
  expected?: boolean;
  /** Failure classification when status is failed or passed_with_caveats. */
  classification?: FailureClassification;
  /** Human-readable explanation. */
  reason: string;
  /** Path to the scenario evidence directory. */
  evidence_dir: string;
  /** Absolute path to the block file used for the scenario. */
  block_path?: string;
  /** Absolute path to the block state produced by the scenario. */
  state_path?: string;
  /** Commits produced in the sandbox repo (if any). */
  commits?: string[];
  /** PR creation result, if attempted. */
  pr?: {
    created: boolean;
    number?: number;
    url?: string;
    draft?: boolean;
    reason?: string;
  };
  /** Resume no-op evidence for scenarios that support resume. */
  resume?: {
    exit_code: number;
    status: string;
    commit_count_ahead_before: number;
    commit_count_ahead_after: number;
    provider_attempts_before: number;
    provider_attempts_after: number;
    provider_rerun: boolean;
    completed_noop_marker_found: boolean;
    reason: string;
  };
  /** Commits produced in the sandbox repo ahead of the base branch. */
  commits_ahead?: string[];
  /** Number of commits ahead of the base branch. */
  commit_count_ahead?: number;
  /** Duration in milliseconds. */
  duration_ms: number;
}

export interface AcceptanceMatrixResult {
  config: AcceptanceMatrixConfig;
  started_at: string;
  finished_at: string;
  duration_ms: number;
  summary: {
    total: number;
    passed: number;
    passed_with_caveats: number;
    failed: number;
    skipped: number;
  };
  results: AcceptanceScenarioResult[];
  report_dir: string;
  orchestrator_exit_code: number;
}

export interface FakeResponseArrays {
  kimi: (string | undefined)[];
  reviewer: (string | undefined)[];
  fixKimi: (string | undefined)[];
  secondReviewer: (string | undefined)[];
}

export interface FakeResponseScenario {
  type: AcceptanceScenarioType;
  responses: FakeResponseStep[];
}

export interface FakeResponseStep {
  /** Optional task id filter; undefined means apply to next AI call. */
  task_id?: string;
  /** Kind of response. */
  kind: 'accept' | 'needs_changes' | 'reject' | 'unsafe_file' | 'unsafe_text';
  /** Optional override content for text responses. */
  content?: string;
}
