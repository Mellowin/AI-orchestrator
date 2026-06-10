export interface RealOneTaskModeSafetyInput {
  mode: string;
  allowBlockRunOne: boolean;
  allowRealProvider: boolean;
  allowRealRepoApply: boolean;
  allowRealRepoCommit: boolean;
  allowRealRepoPush: boolean;
  allowKimiReviewer: boolean;
  coderProvider: string;
  reviewerProvider: string;
  repoPath: string;
  workBranch: string;
  currentBranch: string;
  gitStatus: string;
}

export interface RealOneTaskModeSafetyResult {
  ok: boolean;
  blockingIssues: string[];
}

export function validateRealOneTaskModeSafety(
  input: RealOneTaskModeSafetyInput
): RealOneTaskModeSafetyResult {
  const issues: string[] = [];

  if (input.mode === 'fake') {
    return { ok: true, blockingIssues: [] };
  }

  if (input.mode === 'real_kimi_coder_kimi_reviewer') {
    // real_kimi_coder_kimi_reviewer gate checks
    if (!input.allowBlockRunOne) {
      issues.push('Real mode requires ALLOW_BLOCK_RUN_ONE=true');
    }
    if (!input.allowRealProvider) {
      issues.push('Real mode requires ALLOW_REAL_PROVIDER=true');
    }
    if (!input.allowRealRepoApply) {
      issues.push('Real mode requires ALLOW_REAL_REPO_APPLY=true');
    }
    if (!input.allowRealRepoCommit) {
      issues.push('Real mode requires ALLOW_REAL_REPO_COMMIT=true');
    }
    if (!input.allowKimiReviewer) {
      issues.push('Real mode with Kimi reviewer requires ALLOW_KIMI_REVIEWER=true');
    }
    if (input.coderProvider !== 'kimi') {
      issues.push('Real mode requires coderProvider=kimi');
    }
    if (input.reviewerProvider !== 'kimi') {
      issues.push('Real mode with Kimi reviewer requires reviewerProvider=kimi');
    }
  } else if (input.mode === 'real_kimi_coder_fake_reviewer') {
    // real_kimi_coder_fake_reviewer gate checks
    if (!input.allowBlockRunOne) {
      issues.push('Real mode requires ALLOW_BLOCK_RUN_ONE=true');
    }
    if (!input.allowRealProvider) {
      issues.push('Real mode requires ALLOW_REAL_PROVIDER=true');
    }
    if (!input.allowRealRepoApply) {
      issues.push('Real mode requires ALLOW_REAL_REPO_APPLY=true');
    }
    if (!input.allowRealRepoCommit) {
      issues.push('Real mode requires ALLOW_REAL_REPO_COMMIT=true');
    }
    if (input.coderProvider !== 'kimi') {
      issues.push('Real mode requires coderProvider=kimi');
    }
    if (input.reviewerProvider !== 'fake') {
      issues.push('Real mode requires reviewerProvider=fake');
    }
    if (input.allowKimiReviewer) {
      issues.push('Real mode with fake reviewer must not set ALLOW_KIMI_REVIEWER=true');
    }
  } else {
    return {
      ok: false,
      blockingIssues: [`Unknown one-task loop mode: ${input.mode}`],
    };
  }

  // Branch safety
  if (input.currentBranch === 'main') {
    issues.push('Current branch is main');
  }
  if (input.currentBranch === 'HEAD') {
    issues.push('Current branch is HEAD (detached)');
  }
  if (input.currentBranch !== input.workBranch) {
    issues.push(
      `Current branch "${input.currentBranch}" does not match work branch "${input.workBranch}"`
    );
  }
  if (input.workBranch === 'main') {
    issues.push('Work branch must not be main');
  }

  // Dirty repo protection
  if (input.gitStatus.trim().length > 0) {
    issues.push('Working tree is not clean before mutation');
  }

  return {
    ok: issues.length === 0,
    blockingIssues: issues,
  };
}
