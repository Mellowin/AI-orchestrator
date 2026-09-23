import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadMissionConfig } from '../autopilot-plan/config-loader.js';
import { runAutopilotPlan } from '../autopilot-plan/runner.js';
import type { AutopilotPlanMission, AutopilotPlanResult } from '../autopilot-plan/types.js';
import { loadAutopilotRunConfig, runAutopilotRun } from '../autopilot-run/index.js';
import { runMultitaskMission } from './multitask/runner.js';
import { buildMissionFromGoal, MissionBuilderError } from './mission-builder.js';
import { buildResumeCommand } from './resume-command.js';
import { runGitWriteAuthPreflight } from '../git-write-auth-preflight.js';
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

  // Fail closed on ambiguous resume: a raw-goal mission derives its run id from
  // the current time, so --resume without an explicit --run-id would silently
  // create a NEW mission instead of resuming the paused one. Persisted mission
  // configs already carry a stable run_id and are exempt. No report directory,
  // no provider call, no repository mutation happens on this path.
  if (options.resume === true && !input.endsWith('.json') && !options.run_id) {
    return makeFailureResult(
      'ONE_CLICK_CONFIG_ERROR',
      'Resume requires the original --run-id for a raw-goal mission.'
    );
  }

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

  const presetFromMission = mission.constraints
    ?.find((c) => c.startsWith('Preset: '))
    ?.slice('Preset: '.length)
    .trim();

  // The canonical real-multitask one-click command does not require --yes.
  if (
    (options.preset === 'real-multitask' || presetFromMission === 'real-multitask') &&
    !options.yes
  ) {
    options.yes = true;
  }

  if (requiresConfirmation(mission) && !options.yes) {
    return makeFailureResult(
      'ONE_CLICK_NEEDS_CONFIRMATION',
      'Remote writes (push, PR, CI read) require explicit confirmation. Rerun with --yes.',
      mission
    );
  }

  // Non-mutating Git write-auth preflight: verify that the configured
  // GITHUB_TOKEN can push to the target repository BEFORE the first expensive
  // planner/coder provider call. A credential interruption here pauses the
  // mission resumably with provider call count = 0 instead of burning quota.
  // When the mission's provider token is absent the planner gate reports that
  // first (no provider call is consumed either way), so the preflight is
  // skipped and legacy token-error precedence is preserved.
  const providerTokenEnv = mission.provider?.token_env ?? 'KIMI_API_KEY';
  const providerTokenPresent = (process.env[providerTokenEnv]?.trim() ?? '') !== '';
  if (
    mission.mode === 'github' &&
    mission.capabilities.allow_repo_push &&
    (!mission.capabilities.allow_real_provider || providerTokenPresent)
  ) {
    const preflightFn = options.writeAuthPreflightFn ?? runGitWriteAuthPreflight;
    const preflight = preflightFn({ repoPath: mission.repo_path });
    if (!preflight.ok) {
      const failure = preflight.failure;
      const isResumable = failure?.pause_recommended === true;
      const reason = `Git write-auth preflight failed (${failure?.failure_kind ?? 'unknown'}): ${
        failure?.sanitized_message ?? preflight.reason ?? 'unknown'
      }`;
      const finishedAt = new Date().toISOString();
      const durationMs = new Date(finishedAt).getTime() - new Date(startedAt).getTime();
      const preflightResult: AutopilotOneClickResult = {
        raw_goal: rawGoal,
        mission_path: missionPath,
        mission,
        plan_result: {} as AutopilotPlanResult,
        run_dir: runDirBase,
        verdict: isResumable ? 'MULTITASK_MISSION_PAUSED_GIT_AUTH' : 'MULTITASK_MISSION_FAILED',
        reason,
        exit_code: 1,
        generated_paths: [],
        resume_supported: isResumable,
        ...(isResumable
          ? {
              resume_command: buildResumeCommand(command, mission.run_id),
              next_human_action:
                'Update GITHUB_TOKEN with a credential that can push to the repository and run the command again with --resume; no provider calls were made.',
            }
          : {}),
        ...(failure !== undefined ? { git_failure: failure } : {}),
      };
      const reportPaths = writeOneClickReport(runDirBase, preflightResult, startedAt, finishedAt, durationMs);
      return {
        ...preflightResult,
        generated_paths: [reportPaths.mdPath, reportPaths.jsonPath],
      };
    }
  }

  const planFn = options.planFn ?? runAutopilotPlan;
  const planResult = await planFn(mission, { command });

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
          resume_command: multitaskResult.resume_command,
          resume_supported: multitaskResult.resume_supported,
          git_failure: multitaskResult.git_failure,
          multitask_result: multitaskResult,
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
        resume_command: multitaskResult.resume_command,
        resume_supported: multitaskResult.resume_supported,
        git_failure: multitaskResult.git_failure,
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
