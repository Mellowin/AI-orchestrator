import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

export interface SandboxPrepareResult {
  ok: boolean;
  repoPath: string;
  baseBranch: string;
  issues: string[];
}

function runGit(repoPath: string, args: string[]): { ok: boolean; stdout: string; stderr: string } {
  const result = spawnSync('git', args, {
    cwd: repoPath,
    encoding: 'utf-8',
    shell: false,
  });
  return {
    ok: result.status === 0,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
  };
}

export function prepareSandboxRepo(
  repoPath: string,
  baseBranch: string
): SandboxPrepareResult {
  const resolved = resolve(repoPath);
  const issues: string[] = [];

  if (!existsSync(resolved)) {
    issues.push(`Sandbox repo path does not exist: ${resolved}`);
    return { ok: false, repoPath: resolved, baseBranch, issues };
  }
  if (!existsSync(resolve(resolved, '.git'))) {
    issues.push(`Sandbox repo path is not a git repository: ${resolved}`);
    return { ok: false, repoPath: resolved, baseBranch, issues };
  }

  const inside = runGit(resolved, ['rev-parse', '--is-inside-work-tree']);
  if (!inside.ok || inside.stdout.trim() !== 'true') {
    issues.push('Repository is not inside a git work tree');
    return { ok: false, repoPath: resolved, baseBranch, issues };
  }

  // Fetch origin if available, but do not fail if offline.
  const remoteResult = runGit(resolved, ['remote', 'get-url', 'origin']);
  if (remoteResult.ok) {
    runGit(resolved, ['fetch', 'origin', baseBranch]);
  }

  // Ensure base branch exists locally.
  const baseCheck = runGit(resolved, ['show-ref', '--verify', `refs/heads/${baseBranch}`]);
  if (!baseCheck.ok) {
    const originCheck = runGit(resolved, ['show-ref', '--verify', `refs/remotes/origin/${baseBranch}`]);
    if (originCheck.ok) {
      const checkout = runGit(resolved, ['checkout', '-B', baseBranch, `origin/${baseBranch}`]);
      if (!checkout.ok) {
        issues.push(`Could not create base branch from origin/${baseBranch}: ${checkout.stderr}`);
        return { ok: false, repoPath: resolved, baseBranch, issues };
      }
    } else {
      issues.push(`Base branch ${baseBranch} does not exist locally or on origin`);
      return { ok: false, repoPath: resolved, baseBranch, issues };
    }
  }

  // Switch to base branch and ensure it is clean.
  const checkout = runGit(resolved, ['checkout', baseBranch]);
  if (!checkout.ok) {
    issues.push(`Could not checkout base branch ${baseBranch}: ${checkout.stderr}`);
    return { ok: false, repoPath: resolved, baseBranch, issues };
  }

  const status = runGit(resolved, ['status', '--porcelain']);
  if (!status.ok) {
    issues.push(`Could not check working tree status: ${status.stderr}`);
    return { ok: false, repoPath: resolved, baseBranch, issues };
  }
  if (status.stdout.trim().length > 0) {
    issues.push(`Base branch ${baseBranch} has uncommitted changes; please clean the sandbox repo`);
    return { ok: false, repoPath: resolved, baseBranch, issues };
  }

  return { ok: true, repoPath: resolved, baseBranch, issues };
}

export function prepareScenarioWorkBranch(
  repoPath: string,
  baseBranch: string,
  workBranch: string
): { ok: boolean; issues: string[] } {
  const issues: string[] = [];

  if (workBranch === 'main' || workBranch === 'master') {
    issues.push(`work_branch must not be a protected branch: ${workBranch}`);
    return { ok: false, issues };
  }

  // Delete local work branch if it exists.
  const localRef = runGit(repoPath, ['show-ref', '--verify', `refs/heads/${workBranch}`]);
  if (localRef.ok) {
    const deleted = runGit(repoPath, ['branch', '-D', workBranch]);
    if (!deleted.ok) {
      issues.push(`Could not delete existing local work branch ${workBranch}: ${deleted.stderr}`);
      return { ok: false, issues };
    }
  }

  // Create and checkout a fresh work branch from base.
  const create = runGit(repoPath, ['checkout', '-B', workBranch, baseBranch]);
  if (!create.ok) {
    issues.push(`Could not create work branch ${workBranch} from ${baseBranch}: ${create.stderr}`);
    return { ok: false, issues };
  }

  return { ok: true, issues: [] };
}
