import type {
  ReviewerFixTaskRunPlanStateResult,
} from './reviewer-fix-task-run-plan-state.js';
import {
  runReviewerFixTaskWithExecutor,
  type ReviewerFixTaskExecutor,
  type ReviewerFixTaskRunnerResult,
} from './reviewer-fix-task-runner.js';
import {
  buildPersistedReviewerFixTaskRunnerResultState,
  type PersistedReviewerFixTaskRunnerResultState,
} from './reviewer-fix-task-runner-result-state.js';

export interface ReviewerFixTaskControlledRunInput {
  runPlanState: ReviewerFixTaskRunPlanStateResult;
  executor: ReviewerFixTaskExecutor;
}

export interface ReviewerFixTaskControlledRunResult {
  runnerResult: ReviewerFixTaskRunnerResult;
  persistedState: PersistedReviewerFixTaskRunnerResultState;
}

export async function runReviewerFixTaskControlled(
  input: ReviewerFixTaskControlledRunInput
): Promise<ReviewerFixTaskControlledRunResult> {
  const { runPlanState, executor } = input;

  const runnerResult = await runReviewerFixTaskWithExecutor({
    runPlanState,
    executor,
  });

  const persistedState = buildPersistedReviewerFixTaskRunnerResultState({
    runnerResult,
  });

  return { runnerResult, persistedState };
}
