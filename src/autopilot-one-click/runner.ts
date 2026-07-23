import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadMissionConfig } from '../autopilot-plan/config-loader.js';
import { runAutopilotPlan } from '../autopilot-plan/runner.js';
import type { AutopilotPlanMission, AutopilotPlanResult } from '../autopilot-plan/types.js';
import { loadAutopilotRunConfig, runAutopilotRun } from '../autopilot-run/index.js';
import { runMultitaskMission } from './multitask/runner.js';
import { buildMissionFromGoal, MissionBuilderError } from './mission-builder.js';
import { writeOneClickReport } from './report-writer.js';
import type {
  AutopilotOneClickOptions,
  AutopilotOneClickResult,
  AutopilotOneClickVerdict,
} from './types.js';

function makeFailureResult(
  verdict: AutopilotOneClickVerdict,
  reason: string,
  mission?: AutopilotPlanMission,
  planResult?: AutopilotPlanResult
): AutopilotOneClickResult {
  const now = new Date().toISOString();
  return {
    raw_goal: undefined,
    mission: mission ?? ({} as AutopilotPlanMission),
    plan_result: planResult ?? ({} as AutopilotPlanResult),
    run_dir: mission?.output_dir ? `${mission.output_dir}/<unknown>` : '<unknown>',
    verdict,
    reason,
    exit_code: 1,
    generated_paths: [],
  };
}

function requiresConfirmation(mission: AutopilotPlanMission): boolean {
  const caps = mission.capabilities;
  return (
    caps.allow_repo_push ||
    caps.allow_pr_create ||
    caps.allow_pr_update ||
    caps.allow_actions_read
  );
}

export async function runAutopilotOneClick(
  input: string,
  options: AutopilotOneClickOptions,
  command: string
): Promise<AutopilotOneClickResult> {
  const startedAt = new Date().toISOString();
  let mission: AutopilotPlanMission;
  let missionPath: string | undefined;
  let rawGoal: string | undefined;

  try {
    if (input.endsWith('.json')) {
      missionPath = resolve(input);
      mission = loadMissionConfig(missionPath);
    } else {
      rawGoal = input;
      mission = buildMissionFromGoal(input, options);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return makeFailureResult(
      err instanceof MissionBuilderError ? 'ONE_CLICK_CONFIG_ERROR' : 'ONE_CLICK_FAILED',
      message
    );
  }

  const runDirBase = resolve(mission.output_dir, mission.run_id);

  if (requiresConfirmation(mission) && !options.yes) {
    return makeFailureResult(
      'ONE_CLICK_NEEDS_CONFIRMATION',
      'Remote writes (push, PR, CI read) require explicit confirmation. Rerun with --yes.',
      mission
    );
  }

  const planResult = await runAutopilotPlan(mission, { command });

  let verdict: AutopilotOneClickVerdict;
  let reason: string;
  let exitCode = 0;

  if (planResult.verdict === 'AUTOPILOT_PLAN_NEEDS_PROVIDER_TOKEN') {
    verdict = 'ONE_CLICK_NEEDS_TOKEN';
    reason = planResult.reason;
    exitCode = 1;
  } else if (
    planResult.verdict === 'AUTOPILOT_PLAN_CONFIG_ERROR' ||
    planResult.verdict === 'AUTOPILOT_PLAN_PROVIDER_BAD_OUTPUT' ||
    planResult.verdict === 'AUTOPILOT_PLAN_FAILED'
  ) {
    verdict = 'ONE_CLICK_PLAN_FAILED';
    reason = planResult.reason;
    exitCode = 1;
  } else if (planResult.exit_code !== 0 || planResult.generated_files.length === 0) {
    verdict = 'ONE_CLICK_PLAN_FAILED';
    reason = planResult.reason || 'Plan step failed';
    exitCode = 1;
  } else {
    const presetFromMission = mission.constraints
      ?.find((c) => c.startsWith('Preset: '))
      ?.slice('Preset: '.length)
      .trim();
    const isMultitaskMission =
      options.preset === 'real-multitask' ||
      options.preset === 'multitask-safe' ||
      presetFromMission === 'real-multitask' ||
      presetFromMission === 'multitask-safe';

    if (isMultitaskMission) {
      const runMultitaskMissionFn = options.runMultitaskMissionFn ?? runMultitaskMission;
      let multitaskResult;
      try {
        multitaskResult = await runMultitaskMissionFn(mission, planResult, { command, resume: options.resume });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const finishedAt = new Date().toISOString();
        const durationMs = new Date(finishedAt).getTime() - new Date(startedAt).getTime();
        const reportPaths = writeOneClickReport(
          runDirBase,
          {
            raw_goal: rawGoal,
            mission_path: missionPath,
            mission,
            plan_result: planResult,
            run_dir: runDirBase,
            verdict: 'MULTITASK_MISSION_FAILED',
            reason: `Multitask runner failed: ${message}`,
            exit_code: 1,
            generated_paths: planResult.generated_files,
          },
          startedAt,
          finishedAt,
          durationMs
        );
        return {
          raw_goal: rawGoal,
          mission_path: missionPath,
          mission,
          plan_result: planResult,
          run_dir: runDirBase,
          verdict: 'MULTITASK_MISSION_FAILED',
          reason: `Multitask runner failed: ${message}`,
          exit_code: 1,
          generated_paths: [...planResult.generated_files, reportPaths.mdPath, reportPaths.jsonPath],
        };
      }

      const finishedAt = new Date().toISOString();
      const durationMs = new Date(finishedAt).getTime() - new Date(startedAt).getTime();

      const reportPaths = writeOneClickReport(
        runDirBase,
        {
          raw_goal: rawGoal,
          mission_path: missionPath,
          mission,
          plan_result: planResult,
          autopilot_result: multitaskResult.autopilot_result,
          run_dir: runDirBase,
          verdict: multitaskResult.verdict as AutopilotOneClickVerdict,
          reason: multitaskResult.reason,
          exit_code: multitaskResult.exit_code,
          generated_paths: planResult.generated_files,
          next_human_action: multitaskResult.next_human_action,
        },
        startedAt,
        finishedAt,
        durationMs
      );

      return {
        raw_goal: rawGoal,
        mission_path: missionPath,
        mission,
        plan_result: planResult,
        autopilot_result: multitaskResult.autopilot_result,
        run_dir: runDirBase,
        verdict: multitaskResult.verdict as AutopilotOneClickVerdict,
        reason: multitaskResult.reason,
        exit_code: multitaskResult.exit_code,
        generated_paths: [...planResult.generated_files, reportPaths.mdPath, reportPaths.jsonPath],
        next_human_action: multitaskResult.next_human_action,
        multitask_result: multitaskResult,
      };
    }

    const autopilotConfigPath = planResult.generated_files.find((p) =>
      p.endsWith('autopilot.config.json')
    );
    if (!autopilotConfigPath || !existsSync(autopilotConfigPath)) {
      verdict = 'ONE_CLICK_PLAN_FAILED';
      reason = 'Generated autopilot config not found';
      exitCode = 1;
    } else {
      try {
        const autopilotConfig = loadAutopilotRunConfig(autopilotConfigPath);
        const autopilotResult = await runAutopilotRun(autopilotConfig, autopilotConfigPath, {
          command: `npx tsx src/cli.ts autopilot-run ${autopilotConfigPath}`,
        });

        const finishedAt = new Date().toISOString();
        const durationMs = new Date(finishedAt).getTime() - new Date(startedAt).getTime();

        const reportPaths = writeOneClickReport(
          runDirBase,
          {
            raw_goal: rawGoal,
            mission_path: missionPath,
            mission,
            plan_result: planResult,
            autopilot_result: autopilotResult,
            run_dir: runDirBase,
            verdict: 'ONE_CLICK_DONE',
            reason: autopilotResult.reason || 'One-click flow completed',
            exit_code: autopilotResult.exit_code,
            generated_paths: planResult.generated_files,
            next_human_action: autopilotResult.next_human_action,
          },
          startedAt,
          finishedAt,
          durationMs
        );

        if (autopilotResult.exit_code !== 0) {
          verdict = 'ONE_CLICK_AUTOPILOT_FAILED';
          reason = autopilotResult.reason || 'Autopilot step failed';
          exitCode = autopilotResult.exit_code;
        } else if (planResult.verdict === 'AUTOPILOT_PLAN_READY_WITH_CAVEATS') {
          verdict = 'ONE_CLICK_DONE_WITH_CAVEATS';
          reason = 'One-click flow completed with caveats';
          exitCode = 0;
        } else {
          verdict = 'ONE_CLICK_DONE';
          reason = 'One-click flow completed';
          exitCode = 0;
        }

        return {
          raw_goal: rawGoal,
          mission_path: missionPath,
          mission,
          plan_result: planResult,
          autopilot_result: autopilotResult,
          run_dir: runDirBase,
          verdict,
          reason,
          exit_code: exitCode,
          generated_paths: [...planResult.generated_files, reportPaths.mdPath, reportPaths.jsonPath],
          next_human_action: autopilotResult.next_human_action,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        verdict = 'ONE_CLICK_AUTOPILOT_FAILED';
        reason = message;
        exitCode = 1;
      }
    }
  }

  const finishedAt = new Date().toISOString();
  const durationMs = new Date(finishedAt).getTime() - new Date(startedAt).getTime();

  const reportPaths = writeOneClickReport(
    runDirBase,
    {
      raw_goal: rawGoal,
      mission_path: missionPath,
      mission,
      plan_result: planResult,
      run_dir: runDirBase,
      verdict,
      reason,
      exit_code: exitCode,
      generated_paths: planResult.generated_files,
    },
    startedAt,
    finishedAt,
    durationMs
  );

  return {
    raw_goal: rawGoal,
    mission_path: missionPath,
    mission,
    plan_result: planResult,
    run_dir: runDirBase,
    verdict,
    reason,
    exit_code: exitCode,
    generated_paths: [...planResult.generated_files, reportPaths.mdPath, reportPaths.jsonPath],
  };
}
