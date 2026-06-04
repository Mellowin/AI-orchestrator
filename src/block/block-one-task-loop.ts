import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { existsSync, mkdirSync } from 'node:fs';
import type { OneTaskLoopInput, OneTaskLoopResult } from './block-runner-types.js';
import type { BlockDefinition, BlockState } from './block-types.js';
import { loadBlockState, saveBlockState, updateBlockState, initBlockState } from './block-state-manager.js';
import { loadBlockDefinition } from './block-loader.js';
import {
  markTaskInProgress,
  markTaskChecksFailed,
  markTaskCommitted,
  markTaskPushed,
  markTaskWaitingReview,
  markTaskAccepted,
  markTaskFixRequired,
  markTaskBlocked,
} from './block-transitions.js';
import {
  getCurrentBlockTaskDefinition,
  buildCoderInputFromBlockTask,
  buildTaskGuardrailsFromBlockTask,
  resolveCoderAndReviewerProviders,
} from './block-task-runner.js';
import { applyFileUpdates, rollbackFileUpdates } from '../patch-engine.js';
import type { PatchManifestEntry, Check } from '../types.js';
import { runChecks } from '../runner.js';
import { validateFileList, validateProposedFileLineDeltas } from '../guardrails.js';
import { parseKimiOutputJson } from '../kimi-output-validator.js';
import { buildCommitEvidence } from '../reviewer/commit-verifier.js';
import { runDeterministicReviewChecks } from '../reviewer/deterministic-review-checks.js';
import { buildReviewInput } from '../reviewer/review-input-builder.js';
import { runReviewerGate } from '../reviewer/reviewer-gate.js';

function parseCheckStrings(checks: string[]): Check[] {
  return checks.map((c) => {
    const parts = c.trim().split(/\s+/);
    return { command: parts[0], args: parts.slice(1) };
  });
}

function generateFakeCommitSha(): string {
  return 'f'.repeat(40);
}

function ensureGitUserConfig(repoPath: string): void {
  spawnSync('git', ['config', 'user.email', 'ai-orchestrator@example.com'], {
    cwd: repoPath,
    shell: false,
    encoding: 'utf-8',
  });
  spawnSync('git', ['config', 'user.name', 'AI Orchestrator'], {
    cwd: repoPath,
    shell: false,
    encoding: 'utf-8',
  });
}

function getCurrentBranch(repoPath: string): string {
  const result = spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
    cwd: repoPath,
    shell: false,
    encoding: 'utf-8',
  });
  if (result.status !== 0) {
    throw new Error('Failed to get current branch');
  }
  return result.stdout.trim();
}

function gitAddAll(repoPath: string): void {
  spawnSync('git', ['add', '-A'], {
    cwd: repoPath,
    shell: false,
    encoding: 'utf-8',
  });
}

function gitCommit(repoPath: string, message: string): { ok: boolean; sha: string } {
  const result = spawnSync('git', ['commit', '-m', message, '--no-gpg-sign'], {
    cwd: repoPath,
    shell: false,
    encoding: 'utf-8',
  });
  if (result.status !== 0) {
    return { ok: false, sha: '' };
  }
  const shaResult = spawnSync('git', ['rev-parse', 'HEAD'], {
    cwd: repoPath,
    shell: false,
    encoding: 'utf-8',
  });
  return { ok: true, sha: shaResult.stdout.trim() };
}

function gitPush(repoPath: string, branch: string): boolean {
  const result = spawnSync('git', ['push', 'origin', branch], {
    cwd: repoPath,
    shell: false,
    encoding: 'utf-8',
  });
  return result.status === 0;
}

function gitResetHardToParent(repoPath: string): void {
  spawnSync('git', ['reset', '--hard', 'HEAD~1'], {
    cwd: repoPath,
    shell: false,
    encoding: 'utf-8',
  });
}

function getRunDir(blockId: string): string {
  return join(process.cwd(), 'runs', 'blocks', blockId, 'attempt-1');
}

export async function runOneTaskLoop(input: OneTaskLoopInput): Promise<OneTaskLoopResult> {
  const isFakeMode = input.mode === 'fake';

  // 1. Load block state
  let blockState = loadBlockState(input.blockId);
  if (!blockState) {
    throw new Error(`Block state not found: ${input.blockId}`);
  }

  // 2. Load block definition
  const blockDefinitionPath = input.blockDefinitionPath;
  if (!blockDefinitionPath) {
    throw new Error('blockDefinitionPath is required in OneTaskLoopInput');
  }
  const blockDefinition = loadBlockDefinition(blockDefinitionPath);

  if (blockDefinition.block_id !== input.blockId) {
    throw new Error(`Block definition id mismatch: ${blockDefinition.block_id} vs ${input.blockId}`);
  }

  // 3. Get current task
  const taskDefinition = getCurrentBlockTaskDefinition(blockDefinition, blockState);
  const taskId = taskDefinition.task_id;
  const statusBefore = blockState.tasks.find((t) => t.task_id === taskId)?.status ?? 'unknown';

  // 4. Mark task in_progress
  blockState = markTaskInProgress(blockState, taskId);
  saveBlockState(blockState);

  // 5. Resolve providers
  const providers = resolveCoderAndReviewerProviders({
    mode: input.mode,
    coderConfig: blockDefinition.providers.coder as import('../providers/provider-types.js').ProviderConfig,
    reviewerConfig: blockDefinition.providers.reviewer as import('../providers/provider-types.js').ProviderConfig,
    allowRealProvider: input.allowRealProvider,
    allowKimiReviewer: input.reviewerProvider === 'kimi' && input.allowRealProvider,
    fakeCoderOptions: input.fakeCoderOptions,
    fakeReviewerOptions: input.fakeReviewerOptions,
  });

  // 6. Build coder input
  const coderInput = buildCoderInputFromBlockTask(blockDefinition, taskDefinition, blockState);

  // 7. Call coder provider
  const coderResult = await providers.coder.runTask(coderInput);

  // 8. Validate coder output
  const updatePaths = coderResult.files.map((f) => f.path);
  const guardrails = buildTaskGuardrailsFromBlockTask(taskDefinition);
  const guardrailsResult = validateFileList(updatePaths, guardrails);
  if (!guardrailsResult.ok) {
    // Guardrails failure treated as checks_failed
    blockState = markTaskChecksFailed(blockState, taskId, [guardrailsResult.reason ?? 'Guardrails failed']);
    saveBlockState(blockState);
    return {
      block_id: input.blockId,
      task_id: taskId,
      status_before: statusBefore,
      status_after: 'checks_failed',
      coder_called: true,
      reviewer_called: false,
      files_applied: [],
      checks_passed: false,
      commit_sha: null,
      pushed: false,
      reviewer_decision: null,
      next_action: 'send_fix_to_coder',
      safety_findings: [guardrailsResult.reason ?? 'Guardrails failed'],
    };
  }

  if (guardrails.max_lines_changed !== undefined) {
    try {
      validateProposedFileLineDeltas(
        blockDefinition.repo_path,
        coderResult.files,
        guardrails.max_lines_changed
      );
    } catch (deltaErr) {
      const msg = deltaErr instanceof Error ? deltaErr.message : String(deltaErr);
      blockState = markTaskChecksFailed(blockState, taskId, [msg]);
      saveBlockState(blockState);
      return {
        block_id: input.blockId,
        task_id: taskId,
        status_before: statusBefore,
        status_after: 'checks_failed',
        coder_called: true,
        reviewer_called: false,
        files_applied: [],
        checks_passed: false,
        commit_sha: null,
        pushed: false,
        reviewer_decision: null,
        next_action: 'send_fix_to_coder',
        safety_findings: [msg],
      };
    }
  }

  // 9. Apply changes
  const runDir = getRunDir(input.blockId);
  if (!existsSync(runDir)) {
    mkdirSync(runDir, { recursive: true });
  }

  let manifest: PatchManifestEntry[] | undefined;
  try {
    manifest = applyFileUpdates(blockDefinition.repo_path, coderResult.files, runDir);
  } catch (applyErr) {
    const msg = applyErr instanceof Error ? applyErr.message : String(applyErr);
    blockState = markTaskChecksFailed(blockState, taskId, [`Apply failed: ${msg}`]);
    saveBlockState(blockState);
    return {
      block_id: input.blockId,
      task_id: taskId,
      status_before: statusBefore,
      status_after: 'checks_failed',
      coder_called: true,
      reviewer_called: false,
      files_applied: [],
      checks_passed: false,
      commit_sha: null,
      pushed: false,
      reviewer_decision: null,
      next_action: 'send_fix_to_coder',
      safety_findings: [msg],
    };
  }

  // 10. Run checks
  const checks = parseCheckStrings(taskDefinition.checks);
  const checkResult = runChecks(blockDefinition.repo_path, checks);

  if (!checkResult.success) {
    // Rollback
    if (manifest && manifest.length > 0) {
      try {
        rollbackFileUpdates(blockDefinition.repo_path, manifest);
      } catch {
        // ignore rollback error
      }
    }
    blockState = markTaskChecksFailed(blockState, taskId, [
      checkResult.failedStep
        ? `${checkResult.failedStep.command} ${checkResult.failedStep.args.join(' ')}`
        : 'Checks failed',
    ]);
    saveBlockState(blockState);
    return {
      block_id: input.blockId,
      task_id: taskId,
      status_before: statusBefore,
      status_after: 'checks_failed',
      coder_called: true,
      reviewer_called: false,
      files_applied: updatePaths,
      checks_passed: false,
      commit_sha: null,
      pushed: false,
      reviewer_decision: null,
      next_action: 'send_fix_to_coder',
      safety_findings: ['Checks failed'],
    };
  }

  // 11. Commit
  let commitSha: string;
  let pushed = false;

  if (isFakeMode) {
    // Fake mode: local commit for evidence, then reset
    ensureGitUserConfig(blockDefinition.repo_path);
    gitAddAll(blockDefinition.repo_path);
    const commitRes = gitCommit(blockDefinition.repo_path, `ai-orchestrator: ${taskId}`);
    if (!commitRes.ok) {
      // Commit failed in fake mode — treat as blocked
      if (manifest && manifest.length > 0) {
        try {
          rollbackFileUpdates(blockDefinition.repo_path, manifest);
        } catch {
          // ignore
        }
      }
      blockState = markTaskBlocked(blockState, taskId, ['Fake mode commit failed'], 'Commit failure');
      saveBlockState(blockState);
      return {
        block_id: input.blockId,
        task_id: taskId,
        status_before: statusBefore,
        status_after: 'blocked',
        coder_called: true,
        reviewer_called: false,
        files_applied: updatePaths,
        checks_passed: true,
        commit_sha: null,
        pushed: false,
        reviewer_decision: null,
        next_action: 'block_for_human',
        safety_findings: ['Fake mode commit failed'],
      };
    }
    commitSha = commitRes.sha;
  } else {
    // Real mode
    if (!input.allowRealRepoCommit) {
      throw new Error('Real mode commit requires ALLOW_REAL_REPO_COMMIT=true');
    }
    ensureGitUserConfig(blockDefinition.repo_path);
    gitAddAll(blockDefinition.repo_path);
    const commitRes = gitCommit(blockDefinition.repo_path, `ai-orchestrator: ${taskId}`);
    if (!commitRes.ok) {
      throw new Error('Commit failed in real mode');
    }
    commitSha = commitRes.sha;

    if (input.allowRealRepoPush) {
      const currentBranch = getCurrentBranch(blockDefinition.repo_path);
      pushed = gitPush(blockDefinition.repo_path, currentBranch);
    }
  }

  // 12. Build commit evidence
  let evidence: import('../reviewer/commit-verifier.js').CommitEvidence;
  try {
    evidence = buildCommitEvidence({
      repoPath: blockDefinition.repo_path,
      taskId,
      taskGoal: taskDefinition.goal,
      allowedFiles: taskDefinition.allowed_files,
      deniedFiles: taskDefinition.denied_files,
      maxLinesChanged: taskDefinition.max_lines_changed,
      commitSha,
    });
  } catch (evidenceErr) {
    const msg = evidenceErr instanceof Error ? evidenceErr.message : String(evidenceErr);
    if (isFakeMode) {
      gitResetHardToParent(blockDefinition.repo_path);
    }
    blockState = markTaskBlocked(blockState, taskId, [`Evidence build failed: ${msg}`], 'Evidence failure');
    saveBlockState(blockState);
    return {
      block_id: input.blockId,
      task_id: taskId,
      status_before: statusBefore,
      status_after: 'blocked',
      coder_called: true,
      reviewer_called: false,
      files_applied: updatePaths,
      checks_passed: true,
      commit_sha: commitSha,
      pushed: false,
      reviewer_decision: null,
      next_action: 'block_for_human',
      safety_findings: [msg],
    };
  }

  // 13. Run deterministic review checks
  const deterministicResult = runDeterministicReviewChecks({
    allowedFiles: taskDefinition.allowed_files,
    deniedFiles: taskDefinition.denied_files,
    maxLinesChanged: taskDefinition.max_lines_changed,
    changedFiles: evidence.changedFiles,
    diff: evidence.diff,
    typecheckResult: checkResult.logs.includes('pass') || checkResult.logs.includes('success') ? 'pass' : 'pass',
    buildResult: 'pass',
    testResult: 'pass',
    gitStatus: evidence.gitStatus,
    commitSha: evidence.commitSha,
    currentBranch: evidence.currentBranch,
  });

  // 14. Build ReviewInput
  const reviewInput = buildReviewInput({
    blockId: input.blockId,
    taskId,
    taskTitle: taskDefinition.title,
    taskGoal: taskDefinition.goal,
    allowedFiles: taskDefinition.allowed_files,
    deniedFiles: taskDefinition.denied_files,
    maxLinesChanged: taskDefinition.max_lines_changed,
    commitSha: evidence.commitSha,
    changedFiles: evidence.changedFiles,
    diff: evidence.diff,
    typecheckResult: 'pass',
    buildResult: 'pass',
    testResult: 'pass',
    gitStatus: evidence.gitStatus,
    safetyFindings: [...evidence.safetyFindings, ...deterministicResult.safetyFindings],
  });

  // 15. Run reviewer gate
  const reviewerGateResult = await runReviewerGate({
    reviewer: providers.reviewer,
    reviewInput,
    deterministicResult: {
      ok: deterministicResult.ok,
      blockingIssues: deterministicResult.blockingIssues,
      safetyFindings: deterministicResult.safetyFindings,
    },
  });

  // 16. Update block state based on reviewer decision
  let statusAfter: string;
  let nextAction: string;

  if (reviewerGateResult.decision.decision === 'accepted') {
    blockState = markTaskCommitted(blockState, taskId, commitSha);
    if (pushed) {
      blockState = markTaskPushed(blockState, taskId, commitSha, 'origin');
    }
    blockState = markTaskWaitingReview(blockState, taskId);
    blockState = markTaskAccepted(blockState, taskId, reviewerGateResult.decision.review_summary);
    statusAfter = 'accepted';
    nextAction = 'advance_to_next_task';
  } else if (reviewerGateResult.decision.next_action === 'block_for_human') {
    blockState = markTaskBlocked(
      blockState,
      taskId,
      reviewerGateResult.decision.blocking_issues,
      reviewerGateResult.decision.review_summary
    );
    statusAfter = 'blocked';
    nextAction = 'block_for_human';
  } else {
    // rejected / send_fix_to_coder
    const fixIssues = reviewerGateResult.decision.blocking_issues;
    const fixSummary = reviewerGateResult.decision.review_summary;
    // Use markTaskFixRequired which enforces max_fix_attempts
    blockState = markTaskFixRequired(blockState, taskId, fixIssues, fixSummary);
    statusAfter = blockState.tasks.find((t) => t.task_id === taskId)?.status ?? 'fix_required';
    nextAction = 'send_fix_to_coder';
  }

  saveBlockState(blockState);

  // 17. Fake mode cleanup: reset commit
  if (isFakeMode) {
    gitResetHardToParent(blockDefinition.repo_path);
  }

  return {
    block_id: input.blockId,
    task_id: taskId,
    status_before: statusBefore,
    status_after: statusAfter,
    coder_called: true,
    reviewer_called: reviewerGateResult.reviewerCalled,
    files_applied: updatePaths,
    checks_passed: true,
    commit_sha: commitSha,
    pushed,
    reviewer_decision: reviewerGateResult.decision.decision,
    next_action: nextAction,
    safety_findings: reviewerGateResult.safetyFindings,
  };
}
