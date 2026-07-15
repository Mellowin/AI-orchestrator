import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadAutopilotRunConfig, runAutopilotRun } from '../../autopilot-run/index.js';
import type { AutopilotPlanMission, AutopilotPlanResult, AutopilotPlanTask } from '../../autopilot-plan/types.js';
import type { AutopilotRunResult } from '../../autopilot-run/types.js';
import { runMissionFinalReview } from './final-review.js';
import {
  computePlanHash,
  getMissionRunDir,
  getMissionStatePath,
  loadMissionState,
  saveMissionState,
  type PersistedMissionState,
} from './state-manager.js';
import { writeMultitaskMissionReport } from './report-writer.js';
import {
  allRequiredTasksAccepted,
  buildInitialTaskStates,
  filterRunnableTasks,
  getDescendants,
  getFailedOrBlockedTasks,
  scheduleTasks,
} from './scheduler.js';
import { validateGeneratedPlan } from './plan-validator.js';
import {
  branchExists,
  checkoutBranch,
  createWorkBranch,
  getBaseSha,
  isAncestor,
  isBranchBasedOn,
  revertCommits,
  type GitExecFn,
} from './git-helpers.js';
import { collectDiff } from './final-review.js';
import type {
  MultitaskMissionFinalReview,
  MultitaskMissionResult,
  MultitaskMissionTaskResult,
  MultitaskMissionTaskState,
  MultitaskMissionVerdict,
  RunMultitaskMissionOptions,
} from './types.js';

function nowIso(): string {
  return new Date().toISOString();
}

import { spawnSync } from 'node:child_process';

function defaultGitExec(args: string[], options?: { cwd?: string }) {
  return spawnSync('git', args, { cwd: options?.cwd, encoding: 'utf-8', shell: false });
}

function buildNextHumanAction(verdict: MultitaskMissionVerdict, autopilot?: AutopilotRunResult): string | undefined {
  if (verdict === 'MULTITASK_MISSION_DONE' || verdict === 'MULTITASK_MISSION_DONE_WITH_CAVEATS') {
    return autopilot?.mvp_result?.pr?.url
      ? `Review the PR at ${autopilot.mvp_result.pr.url} and approve/integrate manually if acceptable.`
      : 'Review the generated commits and create a PR manually if desired.';
  }
  if (verdict === 'MULTITASK_MISSION_EXTERNAL_BLOCKER') {
    return 'Check GitHub Actions directly; the workflow may still be running or an external dependency is blocking.';
  }
  if (verdict === 'MULTITASK_MISSION_NEEDS_HUMAN') {
    return 'A task or safety gate needs human review before continuing.';
  }
  return 'Inspect the mission report for the failure reason.';
}

function mapMvpStatusToMissionStatus(status: string): MultitaskMissionTaskResult['status'] {
  switch (status) {
    case 'passed':
      return 'accepted';
    case 'passed_with_caveats':
      return 'fixed_and_accepted';
    case 'blocked':
      return 'blocked';
    case 'skipped':
      return 'skipped';
    case 'needs_human':
      return 'needs_human';
    default:
      return 'failed';
  }
}

function mapAutopilotResultToTaskStates(autopilot: AutopilotRunResult): MultitaskMissionTaskState[] {
  return (
    autopilot.mvp_result?.task_results.map((t) => ({
      task_id: t.id,
      status: mapMvpStatusToMissionStatus(t.status),
      commit_sha: t.commit_sha,
      fix_commit_sha: t.fix_commit_sha,
      reason: t.reason,
    })) ?? []
  );
}

function mergeTaskStates(
  previous: MultitaskMissionTaskState[],
  latest: MultitaskMissionTaskState[]
): MultitaskMissionTaskState[] {
  const merged = new Map(previous.map((s) => [s.task_id, s]));
  for (const state of latest) {
    const existing = merged.get(state.task_id);
    if (existing && (existing.status === 'accepted' || existing.status === 'fixed_and_accepted')) {
      // Preserve accepted state from a prior run; keep any new commit metadata if missing.
      merged.set(state.task_id, {
        ...existing,
        commit_sha: existing.commit_sha ?? state.commit_sha,
        fix_commit_sha: existing.fix_commit_sha ?? state.fix_commit_sha,
      });
      continue;
    }
    merged.set(state.task_id, state);
  }
  return Array.from(merged.values());
}

function markDescendantsSkipped(
  tasks: AutopilotPlanTask[],
  states: MultitaskMissionTaskState[]
): MultitaskMissionTaskState[] {
  const failedOrBlocked = getFailedOrBlockedTasks(states);
  const toSkip = new Set<string>();
  for (const id of failedOrBlocked) {
    for (const descendant of getDescendants(tasks, id)) {
      toSkip.add(descendant);
    }
  }
  return states.map((s) => {
    if (toSkip.has(s.task_id) && s.status !== 'accepted' && s.status !== 'fixed_and_accepted') {
      return {
        ...s,
        status: 'skipped',
        reason: s.reason ?? 'Skipped because an ancestor task failed or was blocked',
      };
    }
    return s;
  });
}

function mapAutopilotVerdict(
  autopilot: AutopilotRunResult,
  finalReview: MultitaskMissionFinalReview,
  allRequiredAccepted: boolean
): { verdict: MultitaskMissionVerdict; reason: string } {
  const baseReason = autopilot.reason;

  if (
    (autopilot.verdict === 'AUTOPILOT_GREEN' || autopilot.verdict === 'AUTOPILOT_MVP_DONE_CI_NOT_OBSERVED') &&
    allRequiredAccepted
  ) {
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
    return { verdict: 'MULTITASK_MISSION_EXTERNAL_BLOCKER', reason: baseReason };
  }
  if (
    autopilot.verdict === 'AUTOPILOT_REPAIR_EXHAUSTED' ||
    autopilot.verdict === 'AUTOPILOT_REPAIR_FAILED' ||
    autopilot.verdict === 'AUTOPILOT_MVP_FAILED'
  ) {
    return { verdict: 'MULTITASK_MISSION_FAILED', reason: baseReason };
  }
  if (autopilot.verdict === 'AUTOPILOT_NEEDS_TOKEN' || autopilot.verdict === 'AUTOPILOT_ACCESS_ERROR') {
    return { verdict: 'MULTITASK_MISSION_NEEDS_HUMAN', reason: baseReason };
  }

  return { verdict: 'MULTITASK_MISSION_FAILED', reason: baseReason };
}

function isRepoMutationAllowed(mission: AutopilotPlanMission): boolean {
  const caps = mission.capabilities;
  return caps.allow_repo_apply || caps.allow_repo_commit || caps.allow_repo_push;
}

function buildFailureResult(
  mission: AutopilotPlanMission,
  planResult: AutopilotPlanResult,
  runDir: string,
  reason: string,
  startedAt: string,
  startTime: number
): MultitaskMissionResult {
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

export async function runMultitaskMission(
  mission: AutopilotPlanMission,
  planResult: AutopilotPlanResult,
  options: RunMultitaskMissionOptions = {}
): Promise<MultitaskMissionResult> {
  const startedAt = nowIso();
  const startTime = Date.now();
  const runDir = getMissionRunDir(mission.output_dir, mission.run_id);
  const command = options.command ?? `npx tsx src/cli.ts autopilot-one-click "${mission.goal}"`;
  const resume = options.resume ?? false;
  const runAutopilotRunFn = options.runAutopilotRunFn ?? runAutopilotRun;
  const gitExec = options.gitExecFn ?? defaultGitExec;
  const workBranch = `mission-${mission.run_id}`;

  const planHash = computePlanHash(planResult.plan);
  let baseSha: string;
  try {
    baseSha = getBaseSha(mission.repo_path, mission.base_branch, gitExec);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return buildFailureResult(mission, planResult, runDir, `Failed to resolve base branch: ${message}`, startedAt, startTime);
  }

  let state: PersistedMissionState | null = loadMissionState(runDir, options.readStateFn);
  if (state) {
    if (state.plan_hash !== planHash) {
      return buildFailureResult(mission, planResult, runDir, 'Resume aborted: mission plan changed', startedAt, startTime);
    }
    if (state.base_sha !== baseSha) {
      return buildFailureResult(mission, planResult, runDir, 'Resume aborted: base branch moved', startedAt, startTime);
    }
  }

  if (!state) {
    state = {
      version: 1,
      run_id: mission.run_id,
      stage: 'planning',
      plan_hash: planHash,
      base_sha: baseSha,
      work_branch: workBranch,
      tasks: buildInitialTaskStates(planResult.plan.tasks),
    };
  }

  const planValidation = validateGeneratedPlan(planResult.plan, mission);
  if (!planValidation.ok) {
    const reason = `Plan validation failed:\n${planValidation.issues.map((i) => `- ${i.field}: ${i.message}`).join('\n')}`;
    state.stage = 'completed';
    state.last_error = reason;
    saveMissionState(runDir, state, options.writeStateFn);
    return buildFailureResult(mission, planResult, runDir, reason, startedAt, startTime);
  }

  if (resume) {
    if (isRepoMutationAllowed(mission)) {
      const requiredCommits: { sha: string; task_id: string; kind: string }[] = [];
      const absent: { task_id: string; kind: string }[] = [];
      for (const s of state.tasks) {
        if (s.status === 'accepted') {
          if (s.commit_sha) {
            requiredCommits.push({ sha: s.commit_sha, task_id: s.task_id, kind: 'commit_sha' });
          } else {
            absent.push({ task_id: s.task_id, kind: 'commit_sha' });
          }
        } else if (s.status === 'fixed_and_accepted') {
          if (s.commit_sha) {
            requiredCommits.push({ sha: s.commit_sha, task_id: s.task_id, kind: 'commit_sha' });
          } else {
            absent.push({ task_id: s.task_id, kind: 'commit_sha' });
          }
          if (s.fix_commit_sha) {
            requiredCommits.push({ sha: s.fix_commit_sha, task_id: s.task_id, kind: 'fix_commit_sha' });
          } else {
            absent.push({ task_id: s.task_id, kind: 'fix_commit_sha' });
          }
        }
      }

      if (absent.length > 0) {
        const details = absent.map((entry) => `${entry.kind} for task ${entry.task_id}`).join(', ');
        const reason = `Resume aborted: required accepted commits are missing from state: ${details}`;
        state.last_error = reason;
        saveMissionState(runDir, state, options.writeStateFn);
        return buildFailureResult(mission, planResult, runDir, reason, startedAt, startTime);
      }

      const missing = requiredCommits.filter(
        (entry) => !isAncestor(mission.repo_path, entry.sha, workBranch, gitExec)
      );
      if (missing.length > 0) {
        const details = missing
          .map((entry) => `${entry.kind} ${entry.sha} for task ${entry.task_id}`)
          .join(', ');
        const reason = `Resume aborted: required accepted commits are not ancestors of ${workBranch}: ${details}`;
        state.last_error = reason;
        saveMissionState(runDir, state, options.writeStateFn);
        return buildFailureResult(mission, planResult, runDir, reason, startedAt, startTime);
      }
    }
  } else if (isRepoMutationAllowed(mission)) {
    try {
      if (branchExists(mission.repo_path, workBranch, gitExec)) {
        if (!isBranchBasedOn(mission.repo_path, workBranch, mission.base_branch, baseSha, gitExec)) {
          return buildFailureResult(
            mission,
            planResult,
            runDir,
            `Work branch ${workBranch} exists but is not based on ${mission.base_branch} (${baseSha}); refusing to reuse`,
            startedAt,
            startTime
          );
        }
        checkoutBranch(mission.repo_path, workBranch, gitExec);
      } else {
        createWorkBranch(mission.repo_path, mission.base_branch, workBranch, gitExec);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return buildFailureResult(mission, planResult, runDir, `Failed to prepare work branch: ${message}`, startedAt, startTime);
    }
  }

  state.stage = 'running';
  saveMissionState(runDir, state, options.writeStateFn);

  const autopilotConfigPath = planResult.generated_files.find((p) => p.endsWith('autopilot.config.json'));
  if (!autopilotConfigPath || !existsSync(autopilotConfigPath)) {
    const reason = 'Generated autopilot config not found';
    state.stage = 'completed';
    state.last_error = reason;
    saveMissionState(runDir, state, options.writeStateFn);
    return buildFailureResult(mission, planResult, runDir, reason, startedAt, startTime);
  }

  const autopilotConfig = loadAutopilotRunConfig(autopilotConfigPath);
  let autopilotResult: AutopilotRunResult;
  try {
    autopilotResult = await runAutopilotRunFn(autopilotConfig, autopilotConfigPath, {
      command: `npx tsx src/cli.ts autopilot-run ${autopilotConfigPath}`,
      resume,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    state.last_error = message;
    saveMissionState(runDir, state, options.writeStateFn);
    return buildFailureResult(mission, planResult, runDir, `Autopilot run failed: ${message}`, startedAt, startTime);
  }

  // Reconcile task states.
  const latestStates = mapAutopilotResultToTaskStates(autopilotResult);
  state.tasks = markDescendantsSkipped(planResult.plan.tasks, mergeTaskStates(state.tasks, latestStates));

  // Roll back rejected/blocked task commits from the mission branch only when mutation is allowed.
  if (isRepoMutationAllowed(mission)) {
    const rollbackCommits = state.tasks
      .filter((s) => s.status === 'blocked' || s.status === 'failed' || s.status === 'needs_human')
      .map((s) => s.commit_sha)
      .filter((sha): sha is string => typeof sha === 'string' && sha.length > 0);
    if (rollbackCommits.length > 0) {
      try {
        checkoutBranch(mission.repo_path, workBranch, gitExec);
        revertCommits(mission.repo_path, rollbackCommits, gitExec);
        if (mission.capabilities.allow_repo_push) {
          const pushResult = gitExec(['push', 'origin', workBranch], { cwd: mission.repo_path });
          if (pushResult.status !== 0) {
            state.last_error = `Rollback revert push failed: ${pushResult.stderr}`;
          }
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        state.last_error = `Rollback failed: ${message}`;
      }
    }
  }

  state.stage = 'reviewing';
  saveMissionState(runDir, state, options.writeStateFn);

  const allRequiredAccepted = allRequiredTasksAccepted(planResult.plan.tasks, state.tasks);
  const integratedDiff = isRepoMutationAllowed(mission)
    ? options.collectDiffFn
      ? options.collectDiffFn(mission.repo_path, mission.base_branch, workBranch)
      : collectDiff(mission.repo_path, mission.base_branch, workBranch)
    : '';

  const finalReviewInput = {
    mission,
    plan: planResult.plan,
    autopilotResult: autopilotResult,
    integratedDiff,
    taskStates: state.tasks,
  };

  const finalReview = options.runFinalReviewFn
    ? await options.runFinalReviewFn(finalReviewInput)
    : await runMissionFinalReview(finalReviewInput);

  const { verdict, reason } = mapAutopilotVerdict(autopilotResult, finalReview, allRequiredAccepted);
  const exitCode =
    autopilotResult.exit_code === 0 &&
    (verdict === 'MULTITASK_MISSION_DONE' || verdict === 'MULTITASK_MISSION_DONE_WITH_CAVEATS')
      ? 0
      : 1;

  const taskResults: MultitaskMissionTaskResult[] = state.tasks
    .filter((s): s is MultitaskMissionTaskState & { status: MultitaskMissionTaskResult['status'] } =>
      s.status !== 'pending' && s.status !== 'running'
    )
    .map((s) => ({
      task_id: s.task_id,
      title: planResult.plan.tasks.find((t) => t.id === s.task_id)?.title ?? s.task_id,
      status: s.status,
      commit_sha: s.commit_sha,
      fix_commit_sha: s.fix_commit_sha,
      reason: s.reason,
    }));

  const result: MultitaskMissionResult = {
    mission,
    plan: planResult.plan,
    plan_result: planResult,
    autopilot_result: autopilotResult,
    final_review: finalReview,
    task_results: taskResults,
    task_states: state.tasks,
    verdict,
    reason,
    run_dir: runDir,
    exit_code: exitCode,
    next_human_action: buildNextHumanAction(verdict, autopilotResult),
    work_branch: workBranch,
    pr: autopilotResult.mvp_result?.pr?.number !== undefined
      ? {
          number: autopilotResult.mvp_result.pr.number,
          url: autopilotResult.mvp_result.pr.url ?? '',
        }
      : state.pr,
  };

  state.stage = 'completed';
  state.result = result;
  if (result.pr) {
    state.pr = result.pr;
  }
  saveMissionState(runDir, state, options.writeStateFn);

  const finishedAt = nowIso();
  const durationMs = Date.now() - startTime;
  writeMultitaskMissionReport(runDir, result, startedAt, finishedAt, durationMs);

  return result;
}

export { loadMissionState, getMissionStatePath };
