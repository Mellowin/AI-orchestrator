import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadAutopilotRunConfig, runAutopilotRun } from '../../autopilot-run/index.js';
import { loadMvpRunConfig } from '../../mvp-run/index.js';
import { createMvpRunPr } from '../../mvp-run/pr-creator.js';
import type { MvpRunConfig, MvpRunPrResult } from '../../mvp-run/types.js';
import { buildProductionFinalReviewCallFn } from './reviewer-provider.js';
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

function collectMissionCommitShas(tasks: MultitaskMissionTaskState[]): Set<string> {
  const shas = new Set<string>();
  for (const s of tasks) {
    if (s.commit_sha) shas.add(s.commit_sha);
    if (s.fix_commit_sha) shas.add(s.fix_commit_sha);
  }
  return shas;
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
  baseSha: string,
  tasks: MultitaskMissionTaskState[],
  alreadyRolledBack: string[],
  push: boolean,
  gitExec: GitExecFn
): { ok: true; rolledBack: string[] } | { ok: false; rolledBack: string[]; error: string } {
  const missionCommits = collectMissionCommitShas(tasks);
  const log = getBranchCommitsSinceBase(repoPath, workBranch, baseSha, gitExec);
  if (!log.ok) {
    return { ok: false, rolledBack: alreadyRolledBack, error: log.error };
  }
  // git log returns newest-first; revert newest first so each revert applies
  // cleanly to the previous state.
  const toRevert = log.commits.filter((sha) => missionCommits.has(sha) && !alreadyRolledBack.includes(sha));
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
  return buildVerdictResult(
    mission,
    planResult,
    runDir,
    reason,
    'MULTITASK_MISSION_FAILED',
    startedAt,
    startTime
  );
}

function buildVerdictResult(
  mission: AutopilotPlanMission,
  planResult: AutopilotPlanResult,
  runDir: string,
  reason: string,
  verdict: MultitaskMissionVerdict,
  startedAt: string,
  startTime: number
): MultitaskMissionResult {
  return {
    mission,
    plan: planResult.plan,
    plan_result: planResult,
    task_results: [],
    verdict,
    reason,
    run_dir: runDir,
    exit_code: 1,
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

function buildMissionResult(
  mission: AutopilotPlanMission,
  planResult: AutopilotPlanResult,
  runDir: string,
  reason: string,
  verdict: MultitaskMissionVerdict,
  startedAt: string,
  startTime: number
): MultitaskMissionResult {
  return buildVerdictResult(mission, planResult, runDir, reason, verdict, startedAt, startTime);
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
    if (resume && state.stage === 'completed' && state.result) {
      // A terminal result has already been recorded; do not re-run autopilot-run.
      return state.result;
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

  if (!mutationAllowed) {
    return buildSafeModeResult(mission, planResult, runDir, state, options, startedAt, startTime);
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
        let reason = `Work branch ${workBranch} already exists; rerun with --resume or use a different run-id to avoid resetting branch state`;
        if (!isBranchBasedOn(mission.repo_path, workBranch, mission.base_branch, baseSha, gitExec)) {
          reason = `Work branch ${workBranch} exists but is not based on ${mission.base_branch} (${baseSha}); refusing to reuse`;
        }
        state.stage = 'completed';
        state.last_error = reason;
        saveMissionState(runDir, state, options.writeStateFn);
        return buildFailureResult(mission, planResult, runDir, reason, startedAt, startTime);
      }
      createWorkBranch(mission.repo_path, workBranch, baseSha, gitExec);
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
      skipPrCreation: true,
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
        revertCommits(mission.repo_path, blockedTaskCommits, gitExec);
        const rolledBack = [...(state.rolled_back_commits ?? []), ...blockedTaskCommits];
        state.rolled_back_commits = rolledBack;
        // When the mission is allowed to push, the remote branch already contains
        // the rejected commits; push the revert so the branch does not keep code
        // that the final mission gate rejected.
        if (mission.capabilities.allow_repo_push) {
          const pushResult = gitExec(['push', 'origin', workBranch], { cwd: mission.repo_path });
          if (pushResult.status !== 0) {
            throw new Error(pushResult.stderr || `git push origin ${workBranch} failed`);
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

  let finalReview: MultitaskMissionFinalReview;
  try {
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
      task_results: taskResults,
      task_states: state.tasks,
      verdict,
      reason,
      run_dir: runDir,
      exit_code: 1,
      next_human_action: buildNextHumanAction(verdict, autopilotResult),
      work_branch: workBranch,
    };

    state.stage = 'completed';
    state.last_error = reason;
    state.result = result;
    saveMissionState(runDir, state, options.writeStateFn);

    const finishedAt = nowIso();
    const durationMs = Date.now() - startTime;
    writeMultitaskMissionReport(runDir, result, startedAt, finishedAt, durationMs);

    return result;
  }

  let { verdict, reason } = mapAutopilotVerdict(autopilotResult, finalReview, allRequiredAccepted);
  let rollbackError: string | undefined;

  // When the final mission gate rejects the work, any mission commits already
  // pushed to the remote branch must be reverted so the branch does not keep
  // rejected code. This covers both blocked/failed tasks (handled earlier) and
  // accepted tasks that fail the integrated final review.
  if (mutationAllowed && verdict !== 'MULTITASK_MISSION_DONE' && verdict !== 'MULTITASK_MISSION_DONE_WITH_CAVEATS') {
    const rollback = performMissionRollback(
      mission.repo_path,
      workBranch,
      baseSha,
      state.tasks,
      state.rolled_back_commits ?? [],
      mission.capabilities.allow_repo_push,
      gitExec
    );
    if (rollback.ok) {
      state.rolled_back_commits = rollback.rolledBack;
    } else {
      rollbackError = rollback.error;
      state.rolled_back_commits = rollback.rolledBack;
      verdict = 'MULTITASK_MISSION_FAILED';
      reason = `Mission rollback failed: ${rollback.error}`;
    }
  }

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

  let pr: { number: number; url: string } | undefined;
  if (verdict === 'MULTITASK_MISSION_DONE' || verdict === 'MULTITASK_MISSION_DONE_WITH_CAVEATS') {
    if (mission.capabilities.allow_pr_create) {
      pr = await createMissionPr(autopilotConfigPath, autopilotResult, reason, options);
    }
  } else if (state.pr) {
    await closeMissionPr(mission.repo_slug, state.pr.number, options);
  }

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
    pr: pr ?? state.pr,
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
