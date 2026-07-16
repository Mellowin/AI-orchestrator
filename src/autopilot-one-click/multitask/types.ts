import type { AutopilotPlanGeneratedPlan, AutopilotPlanMission, AutopilotPlanResult, AutopilotPlanTask } from '../../autopilot-plan/types.js';
import type { AutopilotRunResult } from '../../autopilot-run/types.js';

import type { MvpRunPrResult } from '../../mvp-run/types.js';

export type FinalReviewCallFn = (prompt: string) => Promise<string>;

export interface FinalReviewInput {
  mission: AutopilotPlanMission;
  plan: AutopilotPlanGeneratedPlan;
  autopilotResult: AutopilotRunResult;
  /** Git diff between base branch and work branch, if available. */
  integratedDiff?: string;
  /** Per-task state including acceptance results. */
  taskStates?: MultitaskMissionTaskState[];
}

export type MultitaskMissionVerdict =
  | 'MULTITASK_MISSION_DONE'
  | 'MULTITASK_MISSION_DONE_WITH_CAVEATS'
  | 'MULTITASK_MISSION_FAILED'
  | 'MULTITASK_MISSION_NEEDS_HUMAN'
  | 'MULTITASK_MISSION_EXTERNAL_BLOCKER';

export interface MultitaskMissionTaskState {
  task_id: string;
  status: 'pending' | 'running' | 'accepted' | 'fixed_and_accepted' | 'failed' | 'blocked' | 'skipped' | 'skipped_safe_mode' | 'needs_human';
  commit_sha?: string;
  fix_commit_sha?: string;
  reason?: string;
  attempt?: number;
}

export interface MultitaskMissionTaskResult {
  task_id: string;
  title: string;
  status: 'accepted' | 'fixed_and_accepted' | 'failed' | 'blocked' | 'skipped' | 'skipped_safe_mode' | 'needs_human';
  commit_sha?: string;
  fix_commit_sha?: string;
  reason?: string;
}

export interface MultitaskMissionFinalReview {
  verdict: 'approved' | 'approved_with_caveats' | 'needs_changes' | 'rejected';
  summary: string;
  caveats: string[];
  unauthorized_files?: string[];
  acceptance_gaps?: string[];
}

export interface MultitaskMissionResult {
  mission: AutopilotPlanMission;
  plan: AutopilotPlanGeneratedPlan;
  plan_result: AutopilotPlanResult;
  autopilot_result?: AutopilotRunResult;
  final_review?: MultitaskMissionFinalReview;
  task_results: MultitaskMissionTaskResult[];
  task_states?: MultitaskMissionTaskState[];
  verdict: MultitaskMissionVerdict;
  reason: string;
  run_dir: string;
  exit_code: number;
  next_human_action?: string;
  /** Branch used for the mission (local or pushed). */
  work_branch?: string;
  /** PR opened for the mission, if any. */
  pr?: { number: number; url: string };
}

export interface RunMultitaskMissionOptions {
  command?: string;
  resume?: boolean;
  runAutopilotPlanFn?: typeof import('../../autopilot-plan/runner.js').runAutopilotPlan;
  runAutopilotRunFn?: typeof import('../../autopilot-run/index.js').runAutopilotRun;
  runFinalReviewFn?: (input: FinalReviewInput) => Promise<MultitaskMissionFinalReview>;
  /** Production path: override the OpenAI reviewer callback used by the final review. */
  reviewCallFn?: FinalReviewCallFn;
  collectDiffFn?: (repoPath: string, baseBranch: string, workBranch: string) => string;
  writeStateFn?: (path: string, data: string) => void;
  readStateFn?: (path: string) => string;
  gitExecFn?: (args: string[], options?: { cwd?: string }) => { status: number | null; stdout: string; stderr: string };
  /** Override PR creation for tests. */
  createMvpRunPrFn?: (config: import('../../mvp-run/types.js').MvpRunConfig, token: string, summary: string) => Promise<MvpRunPrResult>;
  /** Override PR close for tests. */
  closeMvpRunPrFn?: (repoSlug: string, prNumber: number, token: string) => Promise<void>;
}
