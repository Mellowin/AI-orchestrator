import type { AutopilotPlanGeneratedPlan, AutopilotPlanMission, AutopilotPlanResult } from '../../autopilot-plan/types.js';
import type { AutopilotRunResult } from '../../autopilot-run/types.js';

export interface FinalReviewInput {
  mission: AutopilotPlanMission;
  plan: AutopilotPlanGeneratedPlan;
  autopilotResult: AutopilotRunResult;
}

export type MultitaskMissionVerdict =
  | 'MULTITASK_MISSION_DONE'
  | 'MULTITASK_MISSION_DONE_WITH_CAVEATS'
  | 'MULTITASK_MISSION_FAILED'
  | 'MULTITASK_MISSION_NEEDS_HUMAN'
  | 'MULTITASK_MISSION_CI_TIMEOUT'
  | 'MULTITASK_MISSION_REPAIR_EXHAUSTED';

export interface MultitaskMissionTaskResult {
  task_id: string;
  title: string;
  status: 'accepted' | 'fixed_and_accepted' | 'failed' | 'blocked' | 'skipped' | 'needs_human';
  commit_sha?: string;
  fix_commit_sha?: string;
  reason?: string;
}

export interface MultitaskMissionFinalReview {
  verdict: 'approved' | 'approved_with_caveats' | 'needs_changes' | 'rejected';
  summary: string;
  caveats: string[];
}

export interface MultitaskMissionResult {
  mission: AutopilotPlanMission;
  plan: AutopilotPlanGeneratedPlan;
  plan_result: AutopilotPlanResult;
  autopilot_result?: AutopilotRunResult;
  final_review?: MultitaskMissionFinalReview;
  task_results: MultitaskMissionTaskResult[];
  verdict: MultitaskMissionVerdict;
  reason: string;
  run_dir: string;
  exit_code: number;
  next_human_action?: string;
}

export interface RunMultitaskMissionOptions {
  command?: string;
  runAutopilotPlanFn?: typeof import('../../autopilot-plan/runner.js').runAutopilotPlan;
  runAutopilotRunFn?: typeof import('../../autopilot-run/index.js').runAutopilotRun;
  runFinalReviewFn?: (input: FinalReviewInput) => Promise<MultitaskMissionFinalReview>;
  writeStateFn?: (path: string, state: unknown) => void;
  readStateFn?: (path: string) => unknown;
}
