import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import type { AutopilotPlanMission } from '../autopilot-plan/types.js';
import {
  getDefaultWorkspaceRoot,
  makeCandidatePath,
  makeMissionRepoPath,
  makeMissionWorkspaceRoot,
  makeShortRunId,
  makeShortTaskId,
} from '../workspace-paths.js';
import { isPathTraversal, makeGoalSlug, makeRunId } from './goal-parser.js';
import type { AutopilotOneClickOptions, AutopilotOneClickPreset } from './types.js';

export class MissionBuilderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MissionBuilderError';
  }
}

const DEFAULT_OUTPUT_DIR = 'reports/autopilot-plans';
const REPO_SLUG_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const GITHUB_HTTPS_RE = /^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/;
const GITHUB_SSH_RE = /^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/;

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
      caps.allow_real_provider = true;
      caps.allow_repo_apply = true;
      caps.allow_repo_commit = true;
      caps.allow_repo_push = true;
      caps.allow_pr_create = true;
      caps.allow_pr_update = true;
      caps.allow_actions_read = true;
      caps.allow_repair = true;
      break;
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

function runGit(cwd: string, args: string[], allowFailure = false): { ok: boolean; stdout: string; stderr: string } {
  const result = spawnSync('git', args, { cwd, encoding: 'utf-8', shell: false });
  if (!allowFailure && result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr || result.stdout || 'unknown error'}`);
  }
  return {
    ok: result.status === 0,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
  };
}

function isGitRepo(path: string): boolean {
  return existsSync(resolve(path, '.git'));
}

interface ParsedRepo {
  kind: 'owner_repo' | 'url' | 'local';
  source: string;
  cloneUrl: string;
  repoSlug: string;
}

function parseRepoInput(repo: string): ParsedRepo {
  if (isPathTraversal(repo)) {
    throw new MissionBuilderError(`--repo contains path traversal: ${repo}`);
  }

  const httpsMatch = repo.match(GITHUB_HTTPS_RE);
  if (httpsMatch) {
    const [, owner, name] = httpsMatch;
    return { kind: 'url', source: repo, cloneUrl: repo, repoSlug: `${owner}/${name}` };
  }

  const sshMatch = repo.match(GITHUB_SSH_RE);
  if (sshMatch) {
    const [, owner, name] = sshMatch;
    return { kind: 'url', source: repo, cloneUrl: repo, repoSlug: `${owner}/${name}` };
  }

  if (REPO_SLUG_RE.test(repo)) {
    return { kind: 'owner_repo', source: repo, cloneUrl: `https://github.com/${repo}.git`, repoSlug: repo };
  }

  const resolved = resolve(repo);
  if (!existsSync(resolved)) {
    throw new MissionBuilderError(`--repo local path does not exist: ${resolved}`);
  }
  if (!isGitRepo(resolved)) {
    throw new MissionBuilderError(`--repo local path is not a git repository: ${resolved}`);
  }

  // Derive a repo slug from the local repo's origin remote when possible.
  const originResult = runGit(resolved, ['remote', 'get-url', 'origin'], true);
  let repoSlug = 'local/mission';
  if (originResult.ok) {
    const originUrl = originResult.stdout.trim();
    const originHttps = originUrl.match(GITHUB_HTTPS_RE);
    const originSsh = originUrl.match(GITHUB_SSH_RE);
    if (originHttps) {
      repoSlug = `${originHttps[1]}/${originHttps[2]}`;
    } else if (originSsh) {
      repoSlug = `${originSsh[1]}/${originSsh[2]}`;
    }
  }

  return { kind: 'local', source: resolved, cloneUrl: resolved, repoSlug };
}

function resolveDefaultBaseBranch(repoPath: string): string | undefined {
  // Fast path: origin/HEAD symbolic ref.
  const sym = runGit(repoPath, ['symbolic-ref', 'refs/remotes/origin/HEAD'], true);
  if (sym.ok) {
    const ref = sym.stdout.trim();
    const prefix = 'refs/remotes/origin/';
    if (ref.startsWith(prefix)) {
      return ref.slice(prefix.length);
    }
  }

  // Fallback: parse `git remote show origin`.
  const show = runGit(repoPath, ['remote', 'show', 'origin'], true);
  if (show.ok) {
    const match = show.stdout.match(/HEAD branch:\s*(\S+)/);
    if (match && match[1]) {
      return match[1];
    }
  }

  return undefined;
}

function cloneMissionRepo(cloneUrl: string, workspacePath: string): void {
  if (existsSync(workspacePath)) {
    if (isGitRepo(workspacePath)) {
      // Reuse existing mission workspace (e.g. on resume).
      return;
    }
    throw new MissionBuilderError(`Mission workspace path exists but is not a git repo: ${workspacePath}`);
  }

  const parentDir = resolve(workspacePath, '..');
  if (!existsSync(parentDir)) {
    mkdirSync(parentDir, { recursive: true });
  }

  const clone = spawnSync('git', ['clone', '--config', 'core.autocrlf=false', cloneUrl, workspacePath], {
    encoding: 'utf-8',
    shell: false,
  });
  if (clone.status !== 0) {
    throw new MissionBuilderError(`Failed to clone mission repo: ${clone.stderr?.trim() || 'unknown error'}`);
  }
}

function resolveRepoAndBase(
  options: AutopilotOneClickOptions,
  outputDir: string,
  runId: string,
  mode: AutopilotPlanMission['mode']
): { repoPath: string; baseBranch: string; repoSlug: string; workspaceRoot?: string } {
  if (options.repo) {
    const parsed = parseRepoInput(options.repo);

    if (mode === 'github') {
      // Execution workspace is decoupled from the human-readable report path so
      // that long run ids do not create Windows MAX_PATH problems during git clone.
      const topLevelRoot = getDefaultWorkspaceRoot();
      const shortRunId = makeShortRunId(runId);
      const workspaceRoot = makeMissionWorkspaceRoot(topLevelRoot, shortRunId);
      const repoPath = makeMissionRepoPath(workspaceRoot);
      cloneMissionRepo(parsed.cloneUrl, repoPath);
      const baseBranch = options.base_branch ?? resolveDefaultBaseBranch(repoPath) ?? 'main';
      return { repoPath, baseBranch, repoSlug: parsed.repoSlug, workspaceRoot };
    }

    // Fake/safe mode: use the source directly (no isolated workspace needed).
    const sourcePath = parsed.kind === 'local' ? parsed.source : parsed.cloneUrl;
    const baseBranch = options.base_branch ?? 'main';
    return { repoPath: sourcePath, baseBranch, repoSlug: parsed.repoSlug };
  }

  const repoPath = options.repo_path ?? '.';
  if (isPathTraversal(repoPath)) {
    throw new MissionBuilderError('repo_path contains path traversal');
  }
  const baseBranch = options.base_branch ?? 'main';
  const repoSlug = options.repo_slug ?? 'local/raw-goal';
  return { repoPath, baseBranch, repoSlug };
}

export function buildMissionFromGoal(
  goal: string,
  options: AutopilotOneClickOptions
): AutopilotPlanMission {
  const preset = options.preset ?? 'real-multitask';
  const mode = options.mode ?? (preset === 'safe' || preset === 'multitask-safe' ? 'fake' : 'github');

  if ((preset === 'safe' || preset === 'multitask-safe') && mode !== 'fake') {
    throw new MissionBuilderError(`preset '${preset}' requires mode 'fake'`);
  }

  if (preset === 'real-multitask' && mode !== 'github' && options.mode !== 'fake') {
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

  const { repoPath, baseBranch, repoSlug, workspaceRoot } = resolveRepoAndBase(options, outputDir, runId, mode);

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
    ...(workspaceRoot ? { workspace_root: workspaceRoot } : {}),
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
