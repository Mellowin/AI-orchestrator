/**
 * Autopilot One-Click — raw human goal -> mission -> plan -> autopilot run.
 */

import type { AutopilotPlanMission, AutopilotPlanResult } from '../autopilot-plan/types.js';
import type { AutopilotRunResult } from '../autopilot-run/types.js';

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
  | 'ONE_CLICK_CONFIG_ERROR'
  | 'ONE_CLICK_FAILED'
  | 'MULTITASK_MISSION_DONE'
  | 'MULTITASK_MISSION_DONE_WITH_CAVEATS'
  | 'MULTITASK_MISSION_FAILED'
  | 'MULTITASK_MISSION_NEEDS_HUMAN'
  | 'MULTITASK_MISSION_EXTERNAL_BLOCKER';

export interface AutopilotOneClickOptions {
  mode?: 'fake' | 'github';
  preset?: AutopilotOneClickPreset;
  run_id?: string;
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
  started_at: string;
  finished_at: string;
  duration_ms: number;
}
