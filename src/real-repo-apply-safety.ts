export type RealRepoApplySafetyResult =
  | { ok: true }
  | { ok: false; reason: string };

export type RealRepoStatus = {
  isClean: boolean;
  currentBranch: string;
};

export type RealRepoApplySafetyTask = {
  work_branch?: string;
  guardrails: {
    auto_commit: boolean;
    auto_push: boolean;
    auto_merge: boolean;
  };
};

export function validateRealRepoApplySafety(
  task: RealRepoApplySafetyTask,
  repoStatus: RealRepoStatus
): RealRepoApplySafetyResult {
  if (!repoStatus.isClean) {
    return { ok: false, reason: 'Working tree is not clean' };
  }

  if (!repoStatus.currentBranch || repoStatus.currentBranch.length === 0) {
    return { ok: false, reason: 'Current branch is missing or empty' };
  }

  if (repoStatus.currentBranch === 'main') {
    return { ok: false, reason: 'Current branch is main' };
  }

  if (!task.work_branch || task.work_branch.length === 0) {
    return { ok: false, reason: 'work_branch is missing or empty' };
  }

  if (task.work_branch === 'main') {
    return { ok: false, reason: 'work_branch is main' };
  }

  if (repoStatus.currentBranch !== task.work_branch) {
    return {
      ok: false,
      reason: `Current branch (${repoStatus.currentBranch}) does not equal work_branch (${task.work_branch})`,
    };
  }

  if (task.guardrails.auto_commit !== false) {
    return { ok: false, reason: 'auto_commit must be false' };
  }

  if (task.guardrails.auto_push !== false) {
    return { ok: false, reason: 'auto_push must be false' };
  }

  if (task.guardrails.auto_merge !== false) {
    return { ok: false, reason: 'auto_merge must be false' };
  }

  return { ok: true };
}
