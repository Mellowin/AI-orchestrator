import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type {
  AutopilotPlanCapabilities,
  AutopilotPlanMission,
  AutopilotPlanMode,
} from './types.js';

const VALID_MODES: AutopilotPlanMode[] = ['fake', 'github'];

const DEFAULT_CAPABILITIES: AutopilotPlanCapabilities = {
  allow_real_provider: false,
  allow_repo_apply: false,
  allow_repo_commit: false,
  allow_repo_push: false,
  allow_pr_create: false,
  allow_pr_update: false,
  allow_actions_read: false,
  allow_repair: false,
};

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function normalizeCapabilities(
  raw: unknown,
  mode: AutopilotPlanMode
): AutopilotPlanCapabilities {
  const input = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const caps: AutopilotPlanCapabilities = { ...DEFAULT_CAPABILITIES };

  for (const key of Object.keys(DEFAULT_CAPABILITIES) as Array<
    keyof AutopilotPlanCapabilities
  >) {
    const value = input[key];
    if (typeof value === 'boolean') {
      caps[key] = value;
    }
  }

  if (mode === 'fake') {
    caps.allow_real_provider = false;
    caps.allow_repo_apply = false;
    caps.allow_repo_commit = false;
    caps.allow_repo_push = false;
    caps.allow_pr_create = false;
    caps.allow_pr_update = false;
    caps.allow_actions_read = false;
    caps.allow_repair = false;
  }

  return caps;
}

export function validateMissionConfig(value: unknown): AutopilotPlanMission {
  if (!value || typeof value !== 'object') {
    throw new Error('Mission config must be a JSON object');
  }

  const raw = value as Record<string, unknown>;

  if (!isNonEmptyString(raw.run_id)) {
    throw new Error('Mission config must have a non-empty run_id');
  }
  if (!isNonEmptyString(raw.repo_slug)) {
    throw new Error('Mission config must have a non-empty repo_slug');
  }
  if (!isNonEmptyString(raw.repo_path)) {
    throw new Error('Mission config must have a non-empty repo_path');
  }
  if (!isNonEmptyString(raw.base_branch)) {
    throw new Error('Mission config must have a non-empty base_branch');
  }
  if (!isNonEmptyString(raw.goal)) {
    throw new Error('Mission config must have a non-empty goal');
  }
  if (!isNonEmptyString(raw.mode) || !VALID_MODES.includes(raw.mode as AutopilotPlanMode)) {
    throw new Error("Mission mode must be 'fake' or 'github'");
  }
  if (!isNonEmptyString(raw.output_dir)) {
    throw new Error('Mission config must have a non-empty output_dir');
  }

  const mode = raw.mode as AutopilotPlanMode;
  const capabilities = normalizeCapabilities(raw.capabilities, mode);

  const mission: AutopilotPlanMission = {
    run_id: raw.run_id,
    repo_slug: raw.repo_slug,
    repo_path: raw.repo_path,
    base_branch: raw.base_branch,
    goal: raw.goal,
    mode,
    capabilities,
    output_dir: raw.output_dir,
  };

  if (raw.constraints !== undefined) {
    if (!isStringArray(raw.constraints)) {
      throw new Error('Mission constraints must be an array of strings');
    }
    mission.constraints = raw.constraints;
  }

  if (raw.provider !== undefined) {
    if (
      !raw.provider ||
      typeof raw.provider !== 'object' ||
      (raw.provider as Record<string, unknown>).name !== 'kimi' ||
      !isNonEmptyString((raw.provider as Record<string, unknown>).token_env)
    ) {
      throw new Error('Mission provider must be { name: "kimi", token_env: string }');
    }
    mission.provider = {
      name: 'kimi',
      token_env: String((raw.provider as Record<string, unknown>).token_env),
    };
  }

  if (raw.github !== undefined) {
    if (
      !raw.github ||
      typeof raw.github !== 'object' ||
      !isNonEmptyString((raw.github as Record<string, unknown>).token_env)
    ) {
      throw new Error('Mission github must be { token_env: string }');
    }
    mission.github = {
      token_env: String((raw.github as Record<string, unknown>).token_env),
    };
  }

  if (raw.ci !== undefined) {
    if (!raw.ci || typeof raw.ci !== 'object') {
      throw new Error('Mission ci must be an object');
    }
    const ci = raw.ci as Record<string, unknown>;
    mission.ci = {
      wait_for_ci: typeof ci.wait_for_ci === 'boolean' ? ci.wait_for_ci : capabilities.allow_actions_read,
      poll_interval_seconds: typeof ci.poll_interval_seconds === 'number' ? ci.poll_interval_seconds : 15,
      timeout_seconds: typeof ci.timeout_seconds === 'number' ? ci.timeout_seconds : 900,
    };
  }

  if (raw.repair !== undefined) {
    if (!raw.repair || typeof raw.repair !== 'object') {
      throw new Error('Mission repair must be an object');
    }
    const repair = raw.repair as Record<string, unknown>;
    mission.repair = {
      max_attempts: typeof repair.max_attempts === 'number' ? repair.max_attempts : 1,
    };
  }

  if (raw.allowed_files !== undefined) {
    if (!isStringArray(raw.allowed_files)) {
      throw new Error('Mission allowed_files must be an array of strings');
    }
    mission.allowed_files = raw.allowed_files;
  }

  return mission;
}

export function loadMissionConfig(configPath: string): AutopilotPlanMission {
  const resolved = resolve(configPath);
  if (!existsSync(resolved)) {
    throw new Error(`Mission config not found: ${configPath}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(resolved, 'utf-8'));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to parse mission config: ${message}`);
  }

  return validateMissionConfig(parsed);
}

export function buildWorkBranch(runId: string): string {
  const safe = runId.replace(/[^a-zA-Z0-9_-]/g, '-');
  return `mission-${safe}`;
}

export function resolveRepoPath(repoPath: string, configPath: string): string {
  const base = configPath ? resolve(configPath, '..') : process.cwd();
  return resolve(base, repoPath);
}
