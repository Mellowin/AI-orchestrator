import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadAutopilotRunConfig, runAutopilotRun, runAutopilotRemoteFinalization } from '../../autopilot-run/index.js';
import { loadMvpRunConfig } from '../../mvp-run/index.js';
import { createMvpRunPr } from '../../mvp-run/pr-creator.js';
import type { MvpRunConfig, MvpRunPrResult } from '../../mvp-run/types.js';
import { buildProductionFinalReviewCallFn } from './reviewer-provider.js';
import type { AutopilotPlanMission, AutopilotPlanResult, AutopilotPlanTask } from '../../autopilot-plan/types.js';
import type { AutopilotRunResult, AutopilotRunVerdict, AutopilotRemoteFinalizationResult } from '../../autopilot-run/index.js';
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
  getBaseSha,
  isAncestor,
  isBranchBasedOn,
  revertCommits,
  type GitExecFn,
} from './git-helpers.js';
import { collectDiff } from './final-review.js';
import { runIntegratedValidation, type IntegratedValidationResult } from './integrated-validator.js';
import { runFinalizationRepair } from './finalization-repair.js';
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

function mapAutopilotFailureToMissionVerdict(
  autopilot: AutopilotRunResult
): { verdict: MultitaskMissionVerdict; reason: string } {
  if (autopilot.verdict === 'AUTOPILOT_CI_TIMEOUT') {
    return { verdict: 'MULTITASK_MISSION_EXTERNAL_BLOCKER', reason: autopilot.reason };
  }
  if (autopilot.verdict === 'AUTOPILOT_NEEDS_TOKEN' || autopilot.verdict === 'AUTOPILOT_ACCESS_ERROR') {
    return { verdict: 'MULTITASK_MISSION_NEEDS_HUMAN', reason: autopilot.reason };
  }
  return { verdict: 'MULTITASK_MISSION_FAILED', reason: autopilot.reason };
}

function mapCiVerdictToMissionVerdict(
  ciResult: AutopilotRemoteFinalizationResult
): { verdict: MultitaskMissionVerdict; reason: string } {
  switch (ciResult.verdict) {
    case 'AUTOPILOT_GREEN':
      return { verdict: 'MULTITASK_MISSION_DONE', reason: ciResult.reason };
    case 'AUTOPILOT_CI_TIMEOUT':
      return { verdict: 'MULTITASK_MISSION_EXTERNAL_BLOCKER', reason: ciResult.reason };
    case 'AUTOPILOT_NEEDS_TOKEN':
    case 'AUTOPILOT_ACCESS_ERROR':
      return { verdict: 'MULTITASK_MISSION_NEEDS_HUMAN', reason: ciResult.reason };
    default:
      return { verdict: 'MULTITASK_MISSION_FAILED', reason: ciResult.reason };
  }
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

function getCurrentHead(repoPath: string, gitExec: GitExecFn): string | undefined {
  const result = gitExec(['rev-parse', 'HEAD'], { cwd: repoPath });
  if (result.status !== 0) return undefined;
  return (result.stdout ?? '').trim();
}

function getCommitsBetween(
  repoPath: string,
  fromSha: string,
  toSha: string,
  gitExec: GitExecFn
): string[] {
  const result = gitExec(['log', '--format=%H', `${fromSha}..${toSha}`], { cwd: repoPath });
  if (result.status !== 0) return [];
  return (result.stdout ?? '').split('\n').map((s) => s.trim()).filter((s) => s.length > 0);
}

function getBranchCommitsSinceBase(
  repoPath: string,
  workBranch: string,
  baseSha: string,
  gitExec: GitExecFn
): { ok: true; commits: string[] } | { ok: false; error: string } {
  const result = gitExec(['log', '--format=%H', `${baseSha}..${workBranch}`], { cwd: repoPath });
  if (result.status !== 0) {
    return { ok: false, error: result.stderr || `git log ${baseSha}..${workBranch} failed` };
  }
  const commits = (result.stdout ?? '').split('\n').map((s) => s.trim()).filter((s) => s.length > 0);
  return { ok: true, commits };
}

function performMissionRollback(
  repoPath: string,
  workBranch: string,
  missionCommits: string[],
  alreadyRolledBack: string[],
  push: boolean,
  gitExec: GitExecFn
): { ok: true; rolledBack: string[] } | { ok: false; rolledBack: string[]; error: string } {
  // git log returns newest-first. Revert only mission-owned commits (task commits,
  // fix commits, and CI repair commits) that have not already been rolled back,
  // newest first so each revert applies cleanly to the previous state.
  const toRevert = missionCommits.filter((sha) => !alreadyRolledBack.includes(sha));
  if (toRevert.length === 0) {
    return { ok: true, rolledBack: alreadyRolledBack };
  }

  const checkout = gitExec(['checkout', workBranch], { cwd: repoPath });
  if (checkout.status !== 0) {
    return { ok: false, rolledBack: alreadyRolledBack, error: checkout.stderr || `checkout ${workBranch} failed` };
  }

  const rolledBack = [...alreadyRolledBack];
  for (const sha of toRevert) {
    const revert = gitExec(['revert', '--no-edit', sha], { cwd: repoPath });
    if (revert.status !== 0) {
      return { ok: false, rolledBack, error: revert.stderr || `revert ${sha} failed` };
    }
    rolledBack.push(sha);
  }

  if (push) {
    const pushResult = gitExec(['push', 'origin', workBranch], { cwd: repoPath });
    if (pushResult.status !== 0) {
      return { ok: false, rolledBack, error: pushResult.stderr || `git push origin ${workBranch} failed` };
    }
  }

  return { ok: true, rolledBack };
}

function buildFailureResult(
  mission: AutopilotPlanMission,
  planResult: AutopilotPlanResult,
  runDir: string,
  reason: string,
  startedAt: string,
  startTime: number
): MultitaskMissionResult {
  return buildMissionResult(
    mission,
    planResult,
    runDir,
    reason,
    'MULTITASK_MISSION_FAILED',
    startedAt,
    startTime,
    []
  );
}

function buildMissionResult(
  mission: AutopilotPlanMission,
  planResult: AutopilotPlanResult,
  runDir: string,
  reason: string,
  verdict: MultitaskMissionVerdict,
  startedAt: string,
  startTime: number,
  taskStates: MultitaskMissionTaskState[] = [],
  extra: Partial<MultitaskMissionResult> = {}
): MultitaskMissionResult {
  const taskResults: MultitaskMissionTaskResult[] = taskStates
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
  return {
    mission,
    plan: planResult.plan,
    plan_result: planResult,
    task_results: taskResults,
    task_states: taskStates,
    verdict,
    reason,
    run_dir: runDir,
    exit_code: verdict === 'MULTITASK_MISSION_DONE' || verdict === 'MULTITASK_MISSION_DONE_WITH_CAVEATS' ? 0 : 1,
    ...extra,
  };
}

async function defaultCloseMissionPr(repoSlug: string, prNumber: number, token: string): Promise<void> {
  if (!token) {
    throw new Error('GITHUB_TOKEN is missing');
  }
  const { default: https } = await import('node:https');
  const payload = JSON.stringify({ state: 'closed' });
  const url = `https://api.github.com/repos/${repoSlug}/pulls/${prNumber}`;
  return new Promise((resolve, reject) => {
    const req = https.request(
      url,
      {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'ai-orchestrator',
          'Content-Length': Buffer.byteLength(payload),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', () => {
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            resolve();
          } else {
            reject(new Error(`GitHub API returned status ${res.statusCode}: ${data}`));
          }
        });
      }
    );
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

function buildMvpConfigForMissionPr(
  autopilotConfigPath: string,
  autopilotResult: AutopilotRunResult
): MvpRunConfig {
  const autopilotConfig = loadAutopilotRunConfig(autopilotConfigPath);
  const mvpConfig = loadMvpRunConfig(autopilotConfig.mvp_config_path);
  mvpConfig.repo_slug = autopilotConfig.repo_slug;
  mvpConfig.base_branch = autopilotConfig.base_branch;
  mvpConfig.work_branch = autopilotConfig.work_branch;
  mvpConfig.run_id = autopilotConfig.run_id;
  mvpConfig.report_dir = autopilotResult.mvp_result?.report_dir ?? mvpConfig.report_dir;
  mvpConfig.allow_github_pr_create = true;
  return mvpConfig;
}

async function createMissionPr(
  autopilotConfigPath: string,
  autopilotResult: AutopilotRunResult,
  reportSummary: string,
  options: RunMultitaskMissionOptions
): Promise<{ number: number; url: string } | undefined> {
  const createFn = options.createMvpRunPrFn ?? createMvpRunPr;
  const token = process.env.GITHUB_TOKEN ?? '';
  if (!token) {
    return undefined;
  }
  let mvpConfig: MvpRunConfig;
  try {
    mvpConfig = buildMvpConfigForMissionPr(autopilotConfigPath, autopilotResult);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[multitask] Failed to load MVP config for PR creation: ${message}`);
    return undefined;
  }
  const prResult = await createFn(mvpConfig, token, reportSummary);
  if (prResult.created && prResult.number !== undefined) {
    return { number: prResult.number, url: prResult.url ?? '' };
  }
  return undefined;
}

async function closeMissionPr(
  repoSlug: string,
  prNumber: number,
  options: RunMultitaskMissionOptions
): Promise<void> {
  const closeFn = options.closeMvpRunPrFn ?? defaultCloseMissionPr;
  const token = process.env.GITHUB_TOKEN ?? '';
  try {
    await closeFn(repoSlug, prNumber, token);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[multitask] Failed to close mission PR #${prNumber}: ${message}`);
  }
}

function buildSafeModeResult(
  mission: AutopilotPlanMission,
  planResult: AutopilotPlanResult,
  runDir: string,
  state: PersistedMissionState,
  options: RunMultitaskMissionOptions,
  startedAt: string,
  startTime: number
): MultitaskMissionResult {
  const safeReason = 'Safe mode: task planned but not executed because repository mutation is disabled';
  const safeStates = planResult.plan.tasks.map((t) => ({
    task_id: t.id,
    status: 'skipped_safe_mode' as const,
    reason: safeReason,
  }));
  state.tasks = safeStates;
  state.stage = 'completed';

  const taskResults: MultitaskMissionTaskResult[] = planResult.plan.tasks.map((t) => ({
    task_id: t.id,
    title: t.title,
    status: 'skipped_safe_mode',
    reason: safeReason,
  }));

  const result: MultitaskMissionResult = {
    mission,
    plan: planResult.plan,
    plan_result: planResult,
    task_results: taskResults,
    task_states: safeStates,
    verdict: 'MULTITASK_MISSION_DONE_WITH_CAVEATS',
    reason: 'Safe mode: mission planned and validated; no repository mutation was performed.',
    run_dir: runDir,
    exit_code: 0,
    next_human_action: 'To execute this mission, rerun with a mutation-capable preset (e.g., real-multitask).',
    work_branch: state.work_branch,
  };

  state.result = result;
  saveMissionState(runDir, state, options.writeStateFn);

  const finishedAt = nowIso();
  const durationMs = Date.now() - startTime;
  writeMultitaskMissionReport(runDir, result, startedAt, finishedAt, durationMs);

  return result;
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

  // Safe mode does not need a real git base; resolve it only when mutation is allowed.
  // This lets no-mutation missions run in directories without a git repo or base branch.
  const mutationAllowed = isRepoMutationAllowed(mission);
  let baseSha: string;
  if (mutationAllowed) {
    try {
      baseSha = getBaseSha(mission.repo_path, mission.base_branch, gitExec);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return buildFailureResult(mission, planResult, runDir, `Failed to resolve base branch: ${message}`, startedAt, startTime);
    }
  } else {
    baseSha = `safe-mode-no-base-${planHash}`;
  }

  let state: PersistedMissionState | null = resume ? loadMissionState(runDir, options.readStateFn) : null;
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
      mission_commits: [],
    };
  }

  if (!state.mission_commits) {
    state.mission_commits = [];
  }

  const planValidation = validateGeneratedPlan(planResult.plan, mission);
  if (!planValidation.ok) {
    const reason = `Plan validation failed:\n${planValidation.issues.map((i) => `- ${i.field}: ${i.message}`).join('\n')}`;
    state.stage = 'completed';
    state.last_error = reason;
    saveMissionState(runDir, state, options.writeStateFn);
    return buildFailureResult(mission, planResult, runDir, reason, startedAt, startTime);
  }

  if (!mutationAllowed) {
    return buildSafeModeResult(mission, planResult, runDir, state, options, startedAt, startTime);
  }

  if (resume) {
    // Terminal failures can be returned without re-running, even if the work
    // branch is no longer present, because the persisted result is already a
    // failure. Successful terminal results must still pass the ancestry gate.
    if (
      state.stage === 'completed' &&
      state.result &&
      state.result.verdict !== 'MULTITASK_MISSION_DONE' &&
      state.result.verdict !== 'MULTITASK_MISSION_DONE_WITH_CAVEATS'
    ) {
      return state.result;
    }

    if (
      isRepoMutationAllowed(mission) &&
      (state.stage === 'planning' ||
        state.stage === 'executing_tasks' ||
        state.stage === 'running' ||
        (state.stage === 'completed' &&
          state.result &&
          (state.result.verdict === 'MULTITASK_MISSION_DONE' ||
            state.result.verdict === 'MULTITASK_MISSION_DONE_WITH_CAVEATS')))
    ) {
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

    if (state.stage === 'completed' && state.result) {
      // A terminal result has already been recorded and the accepted commits are
      // still present on the work branch; do not re-run autopilot-run.
      return state.result;
    }
  } else if (isRepoMutationAllowed(mission)) {
    try {
      if (branchExists(mission.repo_path, workBranch, gitExec)) {
        let reason = `Work branch ${workBranch} already exists; rerun with --resume or use a different run-id to avoid resetting branch state`;
        if (!isBranchBasedOn(mission.repo_path, workBranch, mission.base_branch, baseSha, gitExec)) {
          reason = `Work branch ${workBranch} exists but is not based on ${mission.base_branch} (${baseSha}); refusing to reuse`;
        }
        state.stage = 'completed';
        state.last_error = reason;
        saveMissionState(runDir, state, options.writeStateFn);
        return buildFailureResult(mission, planResult, runDir, reason, startedAt, startTime);
      }
      // The inner MVP runner is responsible for creating and checking out the
      // work branch. Pre-creating it here would leave the branch checked out and
      // cause the runner's `prepareScenarioWorkBranch` to fail when it tries
      // to delete the existing branch before recreating it.
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return buildFailureResult(mission, planResult, runDir, `Failed to prepare work branch: ${message}`, startedAt, startTime);
    }
  }

  const autopilotConfigPath = planResult.generated_files.find((p) => p.endsWith('autopilot.config.json'));
  if (!autopilotConfigPath || !existsSync(autopilotConfigPath)) {
    const reason = 'Generated autopilot config not found';
    state.stage = 'completed';
    state.last_error = reason;
    saveMissionState(runDir, state, options.writeStateFn);
    return buildFailureResult(mission, planResult, runDir, reason, startedAt, startTime);
  }

  const autopilotConfig = loadAutopilotRunConfig(autopilotConfigPath);

  const shouldSkipAutopilot =
    resume &&
    state.autopilot_result &&
    state.stage !== 'planning' &&
    state.stage !== 'executing_tasks' &&
    state.stage !== 'running';

  let autopilotResult: AutopilotRunResult;
  if (shouldSkipAutopilot) {
    autopilotResult = state.autopilot_result!;
  } else {
    state.stage = 'executing_tasks';
    saveMissionState(runDir, state, options.writeStateFn);
    try {
      autopilotResult = await runAutopilotRunFn(autopilotConfig, autopilotConfigPath, {
        command: `npx tsx src/cli.ts autopilot-run ${autopilotConfigPath}`,
        resume,
        skipPrCreation: true,
        deferRemoteFinalization: true,
      });
      if (mutationAllowed) {
        const afterHead = getCurrentHead(mission.repo_path, gitExec);
        // Track only commits introduced on top of the mission base. When the
        // caller started from a branch other than base_branch, the inner MVP runner
        // will have checked out base_branch and created the work branch from
        // baseSha; comparing against the pre-run HEAD would include base-branch
        // commits that are not part of this mission.
        if (afterHead && isAncestor(mission.repo_path, baseSha, afterHead, gitExec)) {
          const newCommits = getCommitsBetween(mission.repo_path, baseSha, afterHead, gitExec);
          state.mission_commits = Array.from(new Set([...(state.mission_commits ?? []), ...newCommits]));
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      state.last_error = message;
      saveMissionState(runDir, state, options.writeStateFn);
      return buildFailureResult(mission, planResult, runDir, `Autopilot run failed: ${message}`, startedAt, startTime);
    }
  }

  state.autopilot_result = autopilotResult;

  // Reconcile task states.
  const latestStates = mapAutopilotResultToTaskStates(autopilotResult);
  state.tasks = markDescendantsSkipped(planResult.plan.tasks, mergeTaskStates(state.tasks, latestStates));

  // Roll back rejected/blocked task commits from the mission branch only when mutation is allowed.
  if (mutationAllowed) {
    const blockedTaskCommits = Array.from(
      new Set(
        state.tasks
          .filter((s) => s.status === 'blocked' || s.status === 'failed' || s.status === 'needs_human')
          .flatMap((s) => [s.commit_sha, s.fix_commit_sha])
          .filter((sha): sha is string => typeof sha === 'string' && sha.length > 0)
      )
    );
    // Revert newest first so each revert applies cleanly to the previous state.
    blockedTaskCommits.reverse();
    if (blockedTaskCommits.length > 0) {
      try {
        checkoutBranch(mission.repo_path, workBranch, gitExec);
        const beforeSha = gitExec(['rev-parse', 'HEAD'], { cwd: mission.repo_path }).stdout?.trim() ?? '';
        revertCommits(mission.repo_path, blockedTaskCommits, gitExec);
        // On some git configurations `git revert` with multiple commits creates a
        // separate revert commit per SHA. Capture every new commit so later
        // final-review rollback does not try to revert them again.
        const logResult = gitExec(['log', '--format=%H', `${beforeSha}..HEAD`], { cwd: mission.repo_path });
        const newRevertShas = (logResult.stdout ?? '').split('\n').map((s) => s.trim()).filter((s) => s.length > 0);
        const rolledBack = [...(state.rolled_back_commits ?? []), ...blockedTaskCommits, ...newRevertShas];
        state.rolled_back_commits = rolledBack;
        // Rollback for blocked/failed/needs_human tasks stays local per AGENTS.md;
        // the human operator decides whether to push the cleaned-up branch.
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        state.last_error = `Rollback failed: ${message}`;
      }
    }
  }

  const allRequiredAccepted = allRequiredTasksAccepted(planResult.plan.tasks, state.tasks);
  if (
    autopilotResult.verdict !== 'AUTOPILOT_GREEN' &&
    autopilotResult.verdict !== 'AUTOPILOT_MVP_DONE_CI_NOT_OBSERVED' &&
    autopilotResult.verdict !== 'AUTOPILOT_MVP_DEFERRED'
  ) {
    const { verdict, reason } = mapAutopilotFailureToMissionVerdict(autopilotResult);
    const result = buildMissionResult(mission, planResult, runDir, reason, verdict, startedAt, startTime, state.tasks, {
      autopilot_result: autopilotResult,
      work_branch: workBranch,
    });
    state.stage = 'completed';
    state.last_error = reason;
    state.result = result;
    saveMissionState(runDir, state, options.writeStateFn);
    const finishedAt = nowIso();
    const durationMs = Date.now() - startTime;
    writeMultitaskMissionReport(runDir, result, startedAt, finishedAt, durationMs);
    return result;
  }

  if (!allRequiredAccepted) {
    const reason = 'Not all required tasks were accepted; final mission review cannot approve';
    const result = buildMissionResult(
      mission,
      planResult,
      runDir,
      reason,
      'MULTITASK_MISSION_FAILED',
      startedAt,
      startTime,
      state.tasks,
      { autopilot_result: autopilotResult, work_branch: workBranch }
    );
    state.stage = 'completed';
    state.last_error = reason;
    state.result = result;
    saveMissionState(runDir, state, options.writeStateFn);
    const finishedAt = nowIso();
    const durationMs = Date.now() - startTime;
    writeMultitaskMissionReport(runDir, result, startedAt, finishedAt, durationMs);
    return result;
  }

  // Integrated repository validation before final review / PR creation.
  if (isRepoMutationAllowed(mission) && !state.validation_outcome?.ok) {
    state.stage = 'integrated_validation';
    saveMissionState(runDir, state, options.writeStateFn);
    const validationOutcome = runIntegratedValidation(mission.repo_path, { spawnFn: spawnSync });
    state.validation_outcome = validationOutcome;
    saveMissionState(runDir, state, options.writeStateFn);

    if (!validationOutcome.ok) {
      state.validation_failure_classification = validationOutcome.classification as
        | 'REPAIRABLE_REPOSITORY_FAILURE'
        | 'EXTERNAL_BLOCKER';
      saveMissionState(runDir, state, options.writeStateFn);

      if (
        validationOutcome.classification === 'REPAIRABLE_REPOSITORY_FAILURE' &&
        mission.capabilities.allow_repair
      ) {
        const maxAttempts = mission.repair?.max_attempts ?? 1;
        let repairResult: Awaited<ReturnType<typeof runFinalizationRepair>> | undefined;
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
          state.stage = 'finalization_repair';
          state.finalization_repair_attempts = attempt;
          saveMissionState(runDir, state, options.writeStateFn);

          repairResult = await runFinalizationRepair({
            repoPath: mission.repo_path,
            workBranch,
            missionGoal: mission.goal,
            missionAllowedFiles: mission.allowed_files ?? [],
            missionDeniedFiles: [],
            validationResult: validationOutcome,
            reportDir: runDir,
            attempt,
            maxAttempts,
          });

          if (repairResult.ok && repairResult.commitSha) {
            state.finalization_repair_commit_sha = repairResult.commitSha;
            state.finalization_repair_attempts = attempt;
            state.mission_commits = Array.from(
              new Set([...(state.mission_commits ?? []), repairResult.commitSha])
            );

            const revalidation = runIntegratedValidation(mission.repo_path, { spawnFn: spawnSync });
            state.validation_outcome = revalidation;
            saveMissionState(runDir, state, options.writeStateFn);

            if (revalidation.ok) {
              break;
            }
          }
        }

        if (!state.validation_outcome?.ok) {
          const reason = repairResult?.reason ?? validationOutcome.output;
          const result = buildMissionResult(
            mission,
            planResult,
            runDir,
            reason,
            'MULTITASK_MISSION_FAILED',
            startedAt,
            startTime,
            state.tasks,
            {
              autopilot_result: autopilotResult,
              work_branch: workBranch,
              validation_failure_classification: 'REPAIRABLE_REPOSITORY_FAILURE',
              finalization_repair_attempts: state.finalization_repair_attempts ?? 0,
            }
          );
          state.stage = 'completed';
          state.last_error = reason;
          state.result = result;
          saveMissionState(runDir, state, options.writeStateFn);
          const finishedAt = nowIso();
          const durationMs = Date.now() - startTime;
          writeMultitaskMissionReport(runDir, result, startedAt, finishedAt, durationMs);
          return result;
        }
      } else {
        const reason = validationOutcome.output;
        const isExternal = validationOutcome.classification === 'EXTERNAL_BLOCKER';
        const result = buildMissionResult(
          mission,
          planResult,
          runDir,
          reason,
          isExternal ? 'MULTITASK_MISSION_EXTERNAL_BLOCKER' : 'MULTITASK_MISSION_FAILED',
          startedAt,
          startTime,
          state.tasks,
          {
            autopilot_result: autopilotResult,
            work_branch: workBranch,
            validation_failure_classification: validationOutcome.classification as
              | 'REPAIRABLE_REPOSITORY_FAILURE'
              | 'EXTERNAL_BLOCKER',
          }
        );
        state.stage = 'completed';
        state.last_error = reason;
        state.result = result;
        saveMissionState(runDir, state, options.writeStateFn);
        const finishedAt = nowIso();
        const durationMs = Date.now() - startTime;
        writeMultitaskMissionReport(runDir, result, startedAt, finishedAt, durationMs);
        return result;
      }
    }
  }

  // Final review: run only if not already persisted.
  if (!state.final_review) {
    state.stage = 'mission_review';
    saveMissionState(runDir, state, options.writeStateFn);

    let integratedDiff: string;
    try {
      integratedDiff = isRepoMutationAllowed(mission)
        ? options.collectDiffFn
          ? options.collectDiffFn(mission.repo_path, mission.base_branch, workBranch)
          : collectDiff(mission.repo_path, mission.base_branch, workBranch)
        : '';
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const reason = `Integrated diff collection failed: ${message}`;
      if (mutationAllowed) {
        const rollback = performMissionRollback(
          mission.repo_path,
          workBranch,
          state.mission_commits ?? [],
          state.rolled_back_commits ?? [],
          false,
          gitExec
        );
        if (rollback.ok) {
          state.rolled_back_commits = rollback.rolledBack;
        } else {
          state.rolled_back_commits = rollback.rolledBack;
        }
      }
      const result = buildMissionResult(
        mission,
        planResult,
        runDir,
        reason,
        'MULTITASK_MISSION_FAILED',
        startedAt,
        startTime,
        state.tasks,
        { autopilot_result: autopilotResult, work_branch: workBranch }
      );
      state.stage = 'completed';
      state.last_error = reason;
      state.result = result;
      saveMissionState(runDir, state, options.writeStateFn);
      const finishedAt = nowIso();
      const durationMs = Date.now() - startTime;
      writeMultitaskMissionReport(runDir, result, startedAt, finishedAt, durationMs);
      return result;
    }

    const finalReviewInput = {
      mission,
      plan: planResult.plan,
      autopilotResult,
      integratedDiff,
      taskStates: state.tasks,
    };

    try {
      let finalReview: MultitaskMissionFinalReview;
      if (options.runFinalReviewFn) {
        finalReview = await options.runFinalReviewFn(finalReviewInput);
      } else if (mission.mode === 'fake') {
        // Fake mode missions (tests / dry runs) use the deterministic fallback so
        // they can exercise the rest of the pipeline without an OpenAI token.
        finalReview = await runMissionFinalReview(finalReviewInput);
      } else {
        const reviewCallFn = options.reviewCallFn ?? buildProductionFinalReviewCallFn();
        finalReview = await runMissionFinalReview(finalReviewInput, reviewCallFn);
      }
      state.final_review = finalReview;
      saveMissionState(runDir, state, options.writeStateFn);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const verdict: MultitaskMissionVerdict =
        message.includes('OPENAI_API_KEY') || message.includes('Final reviewer is not available')
          ? 'MULTITASK_MISSION_NEEDS_HUMAN'
          : 'MULTITASK_MISSION_EXTERNAL_BLOCKER';
      const reason =
        verdict === 'MULTITASK_MISSION_NEEDS_HUMAN'
          ? `Final reviewer is not available: ${message}`
          : `Final reviewer failed: ${message}`;

      const result = buildMissionResult(
        mission,
        planResult,
        runDir,
        reason,
        verdict,
        startedAt,
        startTime,
        state.tasks,
        { autopilot_result: autopilotResult, work_branch: workBranch }
      );

      state.stage = 'completed';
      state.last_error = reason;
      state.result = result;
      saveMissionState(runDir, state, options.writeStateFn);

      const finishedAt = nowIso();
      const durationMs = Date.now() - startTime;
      writeMultitaskMissionReport(runDir, result, startedAt, finishedAt, durationMs);

      return result;
    }
  }

  const finalReview = state.final_review!;

  // Reject mission if final review is not an approval.
  if (finalReview.verdict !== 'approved' && finalReview.verdict !== 'approved_with_caveats') {
    const rollback = performMissionRollback(
      mission.repo_path,
      workBranch,
      state.mission_commits ?? [],
      state.rolled_back_commits ?? [],
      false,
      gitExec
    );
    if (rollback.ok) {
      state.rolled_back_commits = rollback.rolledBack;
    } else {
      state.rolled_back_commits = rollback.rolledBack;
    }

    const reason =
      finalReview.verdict === 'rejected'
        ? `Mission-level final review rejected: ${finalReview.summary}`
        : `Mission-level final review requested changes: ${finalReview.summary}`;
    const result = buildMissionResult(
      mission,
      planResult,
      runDir,
      reason,
      'MULTITASK_MISSION_FAILED',
      startedAt,
      startTime,
      state.tasks,
      { autopilot_result: autopilotResult, final_review: finalReview, work_branch: workBranch }
    );
    state.stage = 'completed';
    state.last_error = reason;
    state.result = result;
    saveMissionState(runDir, state, options.writeStateFn);
    const finishedAt = nowIso();
    const durationMs = Date.now() - startTime;
    writeMultitaskMissionReport(runDir, result, startedAt, finishedAt, durationMs);
    return result;
  }

  // Create or reuse the mission PR.
  state.stage = 'creating_pr';
  saveMissionState(runDir, state, options.writeStateFn);
  let pr = state.pr;
  if (!pr && mission.capabilities.allow_pr_create) {
    pr = await createMissionPr(autopilotConfigPath, autopilotResult, finalReview.summary, options);
    if (pr) {
      state.pr = pr;
      saveMissionState(runDir, state, options.writeStateFn);
    }
  }

  // Observe CI only after the PR exists. For plans where CI is disabled, the
  // autopilot run already returned MVP_DONE_CI_NOT_OBSERVED and we skip this phase.
  let ciOutcome: AutopilotRemoteFinalizationResult | undefined = state.ci_outcome;
  if (
    autopilotResult.verdict === 'AUTOPILOT_MVP_DEFERRED' &&
    autopilotConfig.ci.enabled &&
    autopilotConfig.ci.wait_for_ci
  ) {
    if (!ciOutcome) {
      state.stage = 'awaiting_ci';
      saveMissionState(runDir, state, options.writeStateFn);
      const mvpConfigForCi = buildMvpConfigForMissionPr(autopilotConfigPath, autopilotResult);
      const runAutopilotRemoteFinalizationFn = options.runAutopilotRemoteFinalizationFn ?? runAutopilotRemoteFinalization;
      try {
        ciOutcome = await runAutopilotRemoteFinalizationFn(autopilotConfig, mvpConfigForCi, {});
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        ciOutcome = {
          verdict: 'AUTOPILOT_FAILED',
          reason: `CI observation failed: ${message}`,
          repair_attempts: 0,
        };
      }
      state.ci_outcome = ciOutcome;
      state.stage = ciOutcome.verdict === 'AUTOPILOT_GREEN' ? 'completed' : 'ci_repair';
      saveMissionState(runDir, state, options.writeStateFn);
    }
    if (ciOutcome.verdict !== 'AUTOPILOT_GREEN') {
      const { verdict, reason } = mapCiVerdictToMissionVerdict(ciOutcome);
      const result = buildMissionResult(
        mission,
        planResult,
        runDir,
        reason,
        verdict,
        startedAt,
        startTime,
        state.tasks,
        {
          autopilot_result: autopilotResult,
          final_review: finalReview,
          pr,
          work_branch: workBranch,
          ci_run_id: ciOutcome.ci_run_id,
          ci_conclusion: ciOutcome.ci_conclusion,
          diagnosis: ciOutcome.diagnosis,
          repair_attempts: ciOutcome.repair_attempts,
        }
      );
      state.stage = 'completed';
      state.last_error = reason;
      state.result = result;
      saveMissionState(runDir, state, options.writeStateFn);
      const finishedAt = nowIso();
      const durationMs = Date.now() - startTime;
      writeMultitaskMissionReport(runDir, result, startedAt, finishedAt, durationMs);
      return result;
    }
  }

  // Mission approved.
  state.stage = 'completed';
  const missionVerdict: MultitaskMissionVerdict =
    finalReview.verdict === 'approved_with_caveats' ? 'MULTITASK_MISSION_DONE_WITH_CAVEATS' : 'MULTITASK_MISSION_DONE';
  const missionReason =
    ciOutcome?.reason ??
    (autopilotResult.verdict === 'AUTOPILOT_MVP_DONE_CI_NOT_OBSERVED'
      ? 'Mission approved; CI observation disabled'
      : 'Mission approved');
  const result = buildMissionResult(
    mission,
    planResult,
    runDir,
    missionReason,
    missionVerdict,
    startedAt,
    startTime,
    state.tasks,
    {
      autopilot_result: autopilotResult,
      final_review: finalReview,
      pr,
      work_branch: workBranch,
      ci_run_id: ciOutcome?.ci_run_id,
      ci_conclusion: ciOutcome?.ci_conclusion,
      diagnosis: ciOutcome?.diagnosis,
      repair_attempts: ciOutcome?.repair_attempts,
    }
  );
  state.result = result;
  saveMissionState(runDir, state, options.writeStateFn);

  const finishedAt = nowIso();
  const durationMs = Date.now() - startTime;
  writeMultitaskMissionReport(runDir, result, startedAt, finishedAt, durationMs);

  return result;
}

export { loadMissionState, getMissionStatePath };
