/**
 * Autopilot One-Click — raw human goal -> mission -> plan -> autopilot run.
 */

import type { AutopilotPlanMission, AutopilotPlanResult } from '../autopilot-plan/types.js';
import type { AutopilotRunResult } from '../autopilot-run/types.js';
import type { StructuredGitRemoteFailure } from '../git-remote-failure.js';
import type { GitWriteAuthPreflightInput, GitWriteAuthPreflightResult } from '../git-write-auth-preflight.js';

export type AutopilotOneClickPreset =
  | 'safe'
  | 'read-ci'
  | 'real-pr'
  | 'real-repair'
  | 'real-multitask'
  | 'multitask-safe';

export type AutopilotOneClickVerdict =
  | 'ONE_CLICK_DONE'
  | 'ONE_CLICK_DONE_WITH_CAVEATS'
  | 'ONE_CLICK_PLAN_FAILED'
  | 'ONE_CLICK_AUTOPILOT_FAILED'
  | 'ONE_CLICK_NEEDS_TOKEN'
  | 'ONE_CLICK_NEEDS_CONFIRMATION'
  | 'ONE_CLICK_CONFIG_ERROR'
  | 'ONE_CLICK_FAILED'
  | 'MULTITASK_MISSION_DONE'
  | 'MULTITASK_MISSION_DONE_WITH_CAVEATS'
  | 'MULTITASK_MISSION_FAILED'
  | 'MULTITASK_MISSION_NEEDS_HUMAN'
  | 'MULTITASK_MISSION_PAUSED_PROVIDER'
  | 'MULTITASK_MISSION_PAUSED_GIT_AUTH'
  | 'MULTITASK_MISSION_EXTERNAL_BLOCKER';

export interface AutopilotOneClickOptions {
  mode?: 'fake' | 'github';
  preset?: AutopilotOneClickPreset;
  run_id?: string;
  /** Repository target: owner/repo, GitHub URL, or local path. */
  repo?: string;
  repo_slug?: string;
  repo_path?: string;
  base_branch?: string;
  output_dir?: string;
  allowed_files?: string[];
  yes?: boolean;
  resume?: boolean;
  /** Internal test hook for the multitask mission runner. */
  runMultitaskMissionFn?: (
    mission: AutopilotPlanMission,
    planResult: AutopilotPlanResult,
    options: { command: string; resume?: boolean }
  ) => Promise<import('./multitask/types.js').MultitaskMissionResult>;
  /** Internal test hook for the non-mutating Git write-auth preflight. */
  writeAuthPreflightFn?: (input: GitWriteAuthPreflightInput) => GitWriteAuthPreflightResult;
}

export interface AutopilotOneClickResult {
  raw_goal?: string;
  mission_path?: string;
  mission: AutopilotPlanMission;
  plan_result: AutopilotPlanResult;
  autopilot_result?: AutopilotRunResult;
  run_dir: string;
  verdict: AutopilotOneClickVerdict;
  reason: string;
  exit_code: number;
  generated_paths: string[];
  next_human_action?: string;
  /** Command that resumes a mission paused on a provider interruption. */
  resume_command?: string;
  /** True when the mission can be resumed with `resume_command` after fixing the external cause. */
  resume_supported?: boolean;
  /** Structured Git remote failure when the mission paused on a Git auth interruption. */
  git_failure?: StructuredGitRemoteFailure;
  /** Present when the multitask mission runner produced a separate mission result. */
  multitask_result?: import('./multitask/types.js').MultitaskMissionResult;
}

export interface AutopilotOneClickReport {
  raw_goal?: string;
  mission_path?: string;
  mission: AutopilotPlanMission;
  plan_verdict: string;
  autopilot_verdict?: string;
  final_verdict: AutopilotOneClickVerdict;
  run_dir: string;
  generated_paths: string[];
  reason: string;
  next_human_action?: string;
  /** Command that resumes a mission paused on a provider interruption. */
  resume_command?: string;
  /** True when the mission can be resumed with `resume_command` after fixing the external cause. */
  resume_supported?: boolean;
  /** Structured Git remote failure when the mission paused on a Git auth interruption. */
  git_failure?: StructuredGitRemoteFailure;
  started_at: string;
  finished_at: string;
  duration_ms: number;
}
