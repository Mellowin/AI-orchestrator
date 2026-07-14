import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadAutopilotRunConfig, runAutopilotRun } from '../../autopilot-run/index.js';
import type { AutopilotPlanMission, AutopilotPlanResult } from '../../autopilot-plan/types.js';
import type { AutopilotRunResult } from '../../autopilot-run/types.js';
import { runMissionFinalReview } from './final-review.js';
import { getMissionStatePath, loadMissionState, saveMissionState } from './state-manager.js';
import { writeMultitaskMissionReport } from './report-writer.js';
import type {
  MultitaskMissionResult,
  MultitaskMissionTaskResult,
  MultitaskMissionVerdict,
  RunMultitaskMissionOptions,
} from './types.js';

function nowIso(): string {
  return new Date().toISOString();
}

function buildNextHumanAction(verdict: MultitaskMissionVerdict, autopilot?: AutopilotRunResult): string | undefined {
  if (verdict === 'MULTITASK_MISSION_DONE' || verdict === 'MULTITASK_MISSION_DONE_WITH_CAVEATS') {
    return autopilot?.mvp_result?.pr?.url
      ? `Review the PR at ${autopilot.mvp_result.pr.url} and approve/integrate manually if acceptable.`
      : 'Review the generated commits and create a PR manually if desired.';
  }
  if (verdict === 'MULTITASK_MISSION_REPAIR_EXHAUSTED') {
    return 'Inspect the CI diagnosis and apply the remaining fixes manually.';
  }
  if (verdict === 'MULTITASK_MISSION_CI_TIMEOUT') {
    return 'Check GitHub Actions directly; the workflow may still be running.';
  }
  if (verdict === 'MULTITASK_MISSION_NEEDS_HUMAN') {
    return 'A task or safety gate needs human review before continuing.';
  }
  return 'Inspect the mission report for the failure reason.';
}

function mapTaskResults(autopilot: AutopilotRunResult): MultitaskMissionTaskResult[] {
  return (
    autopilot.mvp_result?.task_results.map((t) => {
      let status: MultitaskMissionTaskResult['status'];
      switch (t.status) {
        case 'passed':
          status = 'accepted';
          break;
        case 'passed_with_caveats':
          status = 'fixed_and_accepted';
          break;
        case 'blocked':
          status = 'blocked';
          break;
        case 'skipped':
          status = 'skipped';
          break;
        case 'needs_human':
          status = 'needs_human';
          break;
        default:
          status = 'failed';
      }
      return {
        task_id: t.id,
        title: t.title,
        status,
        commit_sha: t.commit_sha,
        fix_commit_sha: t.fix_commit_sha,
        reason: t.reason,
      };
    }) ?? []
  );
}

function mapAutopilotVerdict(
  autopilot: AutopilotRunResult,
  finalReview: import('./types.js').MultitaskMissionFinalReview
): { verdict: MultitaskMissionVerdict; reason: string } {
  const baseReason = autopilot.reason;

  if (autopilot.verdict === 'AUTOPILOT_GREEN' || autopilot.verdict === 'AUTOPILOT_MVP_DONE_CI_NOT_OBSERVED') {
    if (finalReview.verdict === 'approved') {
      return { verdict: 'MULTITASK_MISSION_DONE', reason: baseReason };
    }
    if (finalReview.verdict === 'approved_with_caveats') {
      return {
        verdict: 'MULTITASK_MISSION_DONE_WITH_CAVEATS',
        reason: [baseReason, ...finalReview.caveats].join('; '),
      };
    }
    return {
      verdict: 'MULTITASK_MISSION_FAILED',
      reason: `Mission-level final review rejected: ${finalReview.summary}`,
    };
  }

  if (autopilot.verdict === 'AUTOPILOT_CI_TIMEOUT') {
    return { verdict: 'MULTITASK_MISSION_CI_TIMEOUT', reason: baseReason };
  }
  if (autopilot.verdict === 'AUTOPILOT_REPAIR_EXHAUSTED') {
    return { verdict: 'MULTITASK_MISSION_REPAIR_EXHAUSTED', reason: baseReason };
  }
  if (autopilot.verdict === 'AUTOPILOT_NEEDS_TOKEN' || autopilot.verdict === 'AUTOPILOT_ACCESS_ERROR') {
    return { verdict: 'MULTITASK_MISSION_NEEDS_HUMAN', reason: baseReason };
  }

  return { verdict: 'MULTITASK_MISSION_FAILED', reason: baseReason };
}

export async function runMultitaskMission(
  mission: AutopilotPlanMission,
  planResult: AutopilotPlanResult,
  options: RunMultitaskMissionOptions = {}
): Promise<MultitaskMissionResult> {
  const startedAt = nowIso();
  const startTime = Date.now();
  const runDir = resolve(mission.output_dir, mission.run_id);
  const command = options.command ?? `npx tsx src/cli.ts autopilot-one-click "${mission.goal}"`;

  const runAutopilotRunFn = options.runAutopilotRunFn ?? runAutopilotRun;

  saveMissionState(runDir, { run_id: mission.run_id, stage: 'planning' }, options.writeStateFn);

  const autopilotConfigPath = planResult.generated_files.find((p) => p.endsWith('autopilot.config.json'));
  if (!autopilotConfigPath || !existsSync(autopilotConfigPath)) {
    const reason = 'Generated autopilot config not found';
    saveMissionState(runDir, { run_id: mission.run_id, stage: 'completed', last_error: reason }, options.writeStateFn);
    return {
      mission,
      plan: planResult.plan,
      plan_result: planResult,
      task_results: [],
      verdict: 'MULTITASK_MISSION_FAILED',
      reason,
      run_dir: runDir,
      exit_code: 1,
    };
  }

  saveMissionState(runDir, { run_id: mission.run_id, stage: 'running' }, options.writeStateFn);

  const autopilotConfig = loadAutopilotRunConfig(autopilotConfigPath);
  const autopilotResult = await runAutopilotRunFn(autopilotConfig, autopilotConfigPath, {
    command: `npx tsx src/cli.ts autopilot-run ${autopilotConfigPath}`,
  });

  saveMissionState(runDir, { run_id: mission.run_id, stage: 'reviewing' }, options.writeStateFn);

  const finalReview = options.runFinalReviewFn
    ? await options.runFinalReviewFn({ mission, plan: planResult.plan, autopilotResult })
    : await runMissionFinalReview({ mission, plan: planResult.plan, autopilotResult });

  const { verdict, reason } = mapAutopilotVerdict(autopilotResult, finalReview);
  const exitCode =
    autopilotResult.exit_code === 0 &&
    (verdict === 'MULTITASK_MISSION_DONE' || verdict === 'MULTITASK_MISSION_DONE_WITH_CAVEATS')
      ? 0
      : 1;

  const result: MultitaskMissionResult = {
    mission,
    plan: planResult.plan,
    plan_result: planResult,
    autopilot_result: autopilotResult,
    final_review: finalReview,
    task_results: mapTaskResults(autopilotResult),
    verdict,
    reason,
    run_dir: runDir,
    exit_code: exitCode,
    next_human_action: buildNextHumanAction(verdict, autopilotResult),
  };

  const finishedAt = nowIso();
  const durationMs = Date.now() - startTime;

  writeMultitaskMissionReport(runDir, result, startedAt, finishedAt, durationMs);
  saveMissionState(runDir, { run_id: mission.run_id, stage: 'completed', result }, options.writeStateFn);

  return result;
}

export { loadMissionState, getMissionStatePath };
