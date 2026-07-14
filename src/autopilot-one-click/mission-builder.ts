import { resolve } from 'node:path';
import type { AutopilotPlanMission } from '../autopilot-plan/types.js';
import { isPathTraversal, makeGoalSlug, makeRunId, makeWorkBranch } from './goal-parser.js';
import type { AutopilotOneClickOptions, AutopilotOneClickPreset } from './types.js';

export class MissionBuilderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MissionBuilderError';
  }
}

const DEFAULT_OUTPUT_DIR = 'reports/autopilot-plans';

function applyPreset(preset: AutopilotOneClickPreset) {
  const caps = {
    allow_real_provider: false,
    allow_repo_apply: false,
    allow_repo_commit: false,
    allow_repo_push: false,
    allow_pr_create: false,
    allow_pr_update: false,
    allow_actions_read: false,
    allow_repair: false,
  };

  switch (preset) {
    case 'safe':
      break;
    case 'read-ci':
      caps.allow_actions_read = true;
      break;
    case 'real-pr':
      caps.allow_real_provider = true;
      caps.allow_repo_apply = true;
      caps.allow_repo_commit = true;
      caps.allow_repo_push = true;
      caps.allow_pr_create = true;
      caps.allow_pr_update = true;
      caps.allow_actions_read = true;
      break;
    case 'real-repair':
    case 'real-multitask':
      caps.allow_real_provider = true;
      caps.allow_repo_apply = true;
      caps.allow_repo_commit = true;
      caps.allow_repo_push = true;
      caps.allow_pr_create = true;
      caps.allow_pr_update = true;
      caps.allow_actions_read = true;
      caps.allow_repair = true;
      break;
    case 'multitask-safe':
      break;
  }

  return caps;
}

export function buildMissionFromGoal(
  goal: string,
  options: AutopilotOneClickOptions
): AutopilotPlanMission {
  const preset = options.preset ?? 'safe';
  const mode = options.mode ?? (preset === 'safe' || preset === 'multitask-safe' ? 'fake' : 'github');

  if ((preset === 'safe' || preset === 'multitask-safe') && mode !== 'fake') {
    throw new MissionBuilderError(`preset '${preset}' requires mode 'fake'`);
  }

  if (preset === 'real-multitask' && mode !== 'github') {
    throw new MissionBuilderError("preset 'real-multitask' requires mode 'github'");
  }

  if (options.run_id && isPathTraversal(options.run_id)) {
    throw new MissionBuilderError('run_id contains path traversal');
  }
  const runId = options.run_id ? sanitizeUserRunId(options.run_id) : makeRunId(goal);

  const outputDir = options.output_dir ?? DEFAULT_OUTPUT_DIR;
  if (isPathTraversal(outputDir)) {
    throw new MissionBuilderError('output_dir contains path traversal');
  }

  const repoPath = options.repo_path ?? '.';
  if (isPathTraversal(repoPath)) {
    throw new MissionBuilderError('repo_path contains path traversal');
  }

  const baseBranch = options.base_branch ?? 'main';
  if (baseBranch.includes('..') || baseBranch.includes('/') || baseBranch.includes('\\')) {
    throw new MissionBuilderError('base_branch contains unsafe characters');
  }

  const allowedFiles = options.allowed_files?.length
    ? options.allowed_files.filter((f) => {
        if (isPathTraversal(f)) {
          throw new MissionBuilderError(`allowed_files contains path traversal: ${f}`);
        }
        return true;
      })
    : undefined;

  const repoSlug = options.repo_slug ?? 'local/raw-goal';
  if (isPathTraversal(repoSlug)) {
    throw new MissionBuilderError('repo_slug contains path traversal');
  }

  const capabilities = applyPreset(preset);

  // Enforce fake-mode safety ceiling.
  if (mode === 'fake') {
    capabilities.allow_real_provider = false;
    capabilities.allow_repo_apply = false;
    capabilities.allow_repo_commit = false;
    capabilities.allow_repo_push = false;
    capabilities.allow_pr_create = false;
    capabilities.allow_pr_update = false;
    capabilities.allow_actions_read = false;
    capabilities.allow_repair = false;
  }

  const mission: AutopilotPlanMission = {
    run_id: runId,
    repo_slug: repoSlug,
    repo_path: repoPath,
    base_branch: baseBranch,
    goal,
    mode,
    capabilities,
    output_dir: outputDir,
    constraints: [`Preset: ${preset}`, `Mode: ${mode}`],
    allowed_files: allowedFiles,
  };

  if (mode === 'github') {
    mission.provider = { name: 'kimi', token_env: 'KIMI_API_KEY' };
    mission.github = { token_env: 'GITHUB_TOKEN' };
    mission.ci = {
      wait_for_ci: capabilities.allow_actions_read,
      poll_interval_seconds: 15,
      timeout_seconds: 900,
    };
    mission.repair = {
      max_attempts: preset === 'real-repair' || preset === 'real-multitask' ? 2 : 1,
    };
  }

  return mission;
}

function sanitizeUserRunId(value: string): string {
  const safe = value.replace(/[^a-zA-Z0-9_-]/g, '-').replace(/^-+|-+$/g, '');
  if (!safe) {
    throw new MissionBuilderError('run_id is empty after sanitization');
  }
  return safe;
}
