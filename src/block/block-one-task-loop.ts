import type { OneTaskLoopInput, OneTaskLoopResult } from './block-runner-types.js';
import type { BlockDefinition, BlockTaskDefinition } from './block-types.js';
import { loadBlockState, saveBlockState, getBlockRunDir } from './block-state-manager.js';
import { loadBlockDefinition } from './block-loader.js';
import {
  markTaskInProgress,
  markTaskChecksFailed,
  markTaskCommitted,
  markTaskWaitingReview,
  markTaskAccepted,
  markTaskFixRequired,
  markTaskBlocked,
  markTaskPushed,
} from './block-transitions.js';
import {
  getCurrentBlockTaskDefinition,
  buildCoderInputFromBlockTask,
  buildTaskGuardrailsFromBlockTask,
  resolveCoderAndReviewerProviders,
  convertBlockChecks,
} from './block-task-runner.js';
import { validateFileList, validateProposedFileLineDeltas } from '../guardrails.js';
import { runDeterministicReviewChecks } from '../reviewer/deterministic-review-checks.js';
import { buildReviewInput } from '../reviewer/review-input-builder.js';
import { runReviewerGate } from '../reviewer/reviewer-gate.js';
import { redactReviewerText, redactReviewerList } from '../reviewer/reviewer-redaction.js';
import type { CoderResult } from '../providers/provider-types.js';
import { validateRealOneTaskModeSafety } from './block-real-mode-safety.js';
import {
  getCurrentBranchName,
  getGitStatusPorcelain,
  stageOnlyFiles,
  commitStagedChanges,
  pushCurrentBranch,
  assertNoUnrelatedChanges,
  getCommitDiff,
} from './block-real-mode-git.js';
import { applyFileUpdates, rollbackFileUpdates } from '../patch-engine.js';
import { runChecks } from '../runner.js';

function generateFakeCommitSha(): string {
  return 'f'.repeat(40);
}

function buildCheckFailureMessage(
  checkResult: import('../types.js').RunResult
): string {
  const command = checkResult.failedStep?.command ?? 'unknown';
  const rawLogs = checkResult.logs?.trim() ?? '';
  let message = `Checks failed: ${command}`;
  if (rawLogs) {
    message += `\n${rawLogs}`;
  }
  message = redactReviewerText(message);
  const MAX_LEN = 4000;
  if (message.length > MAX_LEN) {
    message = message.slice(0, MAX_LEN) + '\n[truncated]';
  }
  return message;
}

function buildFakeCommitEvidence(
  taskDefinition: BlockTaskDefinition,
  coderResult: CoderResult,
  blockDefinition: BlockDefinition
): {
  changedFiles: string[];
  diff: string;
  gitStatus: string;
  currentBranch: string;
  safetyFindings: string[];
} {
  const changedFiles = coderResult.files.map((f) => f.path);
  const diffLines: string[] = [];
  for (const file of coderResult.files) {
    const contentLines = file.content.split('\n');
    diffLines.push(`diff --git a/${file.path} b/${file.path}`);
    diffLines.push('new file mode 100644');
    diffLines.push('--- /dev/null');
    diffLines.push(`+++ b/${file.path}`);
    diffLines.push(`@@ -0,0 +1,${contentLines.length} @@`);
    for (const line of contentLines) {
      diffLines.push(`+${line}`);
    }
  }
  return {
    changedFiles,
    diff: diffLines.join('\n'),
    gitStatus: '',
    currentBranch: blockDefinition.work_branch,
    safetyFindings: [],
  };
}

export async function runOneTaskLoop(input: OneTaskLoopInput): Promise<OneTaskLoopResult> {
  const isFakeMode = input.mode === 'fake';

  // 1. Load block state
  let blockState = loadBlockState(input.blockId);
  if (!blockState) {
    throw new Error(`Block state not found: ${input.blockId}`);
  }

  // 2. Load block definition
  if (!input.blockDefinitionPath) {
    throw new Error('blockDefinitionPath is required in OneTaskLoopInput');
  }
  const blockDefinition = loadBlockDefinition(input.blockDefinitionPath);

  if (blockDefinition.block_id !== input.blockId) {
    throw new Error(`Block definition id mismatch: ${blockDefinition.block_id} vs ${input.blockId}`);
  }

  // 3. Get current task
  const taskDefinition = getCurrentBlockTaskDefinition(blockDefinition, blockState);
  const taskId = taskDefinition.task_id;
  const currentTaskState = blockState.tasks.find((t) => t.task_id === taskId);
  const statusBefore = currentTaskState?.status ?? 'unknown';

  // Capture fix context before markTaskInProgress clears it
  const isFixAttempt = statusBefore === 'fix_required' || statusBefore === 'checks_failed' || statusBefore === 'rejected';
  const fixContext = isFixAttempt && currentTaskState
    ? {
        attempt: currentTaskState.fix_attempts + 1,
        reviewerSummary: currentTaskState.reviewer_summary
          ? redactReviewerText(currentTaskState.reviewer_summary)
          : undefined,
        fixTask: null,
        blockingIssues: redactReviewerList([...currentTaskState.blocking_issues]),
        checkFailureSummary: currentTaskState.blocking_issues.length > 0
          ? redactReviewerText(currentTaskState.blocking_issues.join('; '))
          : undefined,
      }
    : undefined;

  // 4. Resolve providers BEFORE state mutation so invalid env/config fails early
  const providers = resolveCoderAndReviewerProviders({
    mode: input.mode,
    coderBlockConfig: blockDefinition.providers.coder,
    reviewerBlockConfig: blockDefinition.providers.reviewer,
    allowRealProvider: input.allowRealProvider,
    allowKimiReviewer: input.allowKimiReviewer,
    fakeCoderOptions: input.fakeCoderOptions,
    fakeReviewerOptions: input.fakeReviewerOptions,
    env: process.env,
  });

  // Real mode: pure flag checks and git safety BEFORE state mutation
  if (!isFakeMode) {
    if (!input.allowBlockRunOne) {
      throw new Error('Real mode requires ALLOW_BLOCK_RUN_ONE=true');
    }
    if (!input.allowRealProvider) {
      throw new Error('Real mode requires ALLOW_REAL_PROVIDER=true');
    }
    if (!input.allowRealRepoApply) {
      throw new Error('Real mode requires ALLOW_REAL_REPO_APPLY=true');
    }
    if (!input.allowRealRepoCommit) {
      throw new Error('Real mode requires ALLOW_REAL_REPO_COMMIT=true');
    }

    // Git-based safety checks
    const currentBranch = getCurrentBranchName(blockDefinition.repo_path);
    const gitStatus = getGitStatusPorcelain(blockDefinition.repo_path);
    const safetyResult = validateRealOneTaskModeSafety({
      mode: input.mode,
      allowBlockRunOne: input.allowBlockRunOne,
      allowRealProvider: input.allowRealProvider,
      allowRealRepoApply: input.allowRealRepoApply,
      allowRealRepoCommit: input.allowRealRepoCommit,
      allowRealRepoPush: input.allowRealRepoPush,
      allowKimiReviewer: input.allowKimiReviewer,
      coderProvider: input.coderProvider,
      reviewerProvider: input.reviewerProvider,
      repoPath: blockDefinition.repo_path,
      workBranch: blockDefinition.work_branch,
      currentBranch,
      gitStatus,
    });
    if (!safetyResult.ok) {
      throw new Error(`Real mode safety check failed: ${safetyResult.blockingIssues.join('; ')}`);
    }
  }

  // 5. Mark task in_progress
  blockState = markTaskInProgress(blockState, taskId);
  saveBlockState(blockState);

  // 6. Build coder input
  const coderInput = buildCoderInputFromBlockTask(blockDefinition, taskDefinition, blockState, fixContext);

  // 7. Call coder provider
  const coderResult = isFixAttempt
    ? await providers.coder.runFix(coderInput)
    : await providers.coder.runTask(coderInput);

  // 8. Validate coder output with guardrails (path-only, no filesystem mutation)
  const updatePaths = coderResult.files.map((f) => f.path);
  const guardrails = buildTaskGuardrailsFromBlockTask(taskDefinition);
  const guardrailsResult = validateFileList(updatePaths, guardrails);
  if (!guardrailsResult.ok) {
    blockState = markTaskChecksFailed(blockState, taskId, [guardrailsResult.reason ?? 'Guardrails failed']);
    saveBlockState(blockState);
    return {
      block_id: input.blockId,
      task_id: taskId,
      status_before: statusBefore,
      status_after: blockState.tasks.find((t) => t.task_id === taskId)?.status ?? 'checks_failed',
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
        status_after: blockState.tasks.find((t) => t.task_id === taskId)?.status ?? 'checks_failed',
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

  // 9. Build execution results (fake vs real)
  let checksPassed: boolean;
  let commitSha: string | null;
  let pushed: boolean;
  let diff: string;
  let gitStatus: string;
  let currentBranch: string;
  let safetyFindings: string[] = [];
  let filesApplied: string[] = updatePaths;

  if (isFakeMode) {
    checksPassed = true;
    commitSha = generateFakeCommitSha();
    pushed = false;
    const fakeEvidence = buildFakeCommitEvidence(taskDefinition, coderResult, blockDefinition);
    diff = fakeEvidence.diff;
    gitStatus = fakeEvidence.gitStatus;
    currentBranch = fakeEvidence.currentBranch;
    safetyFindings = fakeEvidence.safetyFindings;
  } else {
    // Real mode: apply, check, commit, push
    const runDir = getBlockRunDir(input.blockId);
    let manifest: import('../types.js').PatchManifestEntry[] = [];

    try {
      // Apply file updates
      manifest = applyFileUpdates(blockDefinition.repo_path, coderResult.files, runDir);

      // Run checks
      const checks = convertBlockChecks(taskDefinition.checks, blockDefinition.repo_path);
      const checkResult = runChecks(blockDefinition.repo_path, checks);

      if (!checkResult.success) {
        // Rollback applied files
        rollbackFileUpdates(blockDefinition.repo_path, manifest);
        const failMsg = buildCheckFailureMessage(checkResult);
        blockState = markTaskChecksFailed(blockState, taskId, [failMsg]);
        saveBlockState(blockState);
        return {
          block_id: input.blockId,
          task_id: taskId,
          status_before: statusBefore,
          status_after: blockState.tasks.find((t) => t.task_id === taskId)?.status ?? 'checks_failed',
          coder_called: true,
          reviewer_called: false,
          files_applied: filesApplied,
          checks_passed: false,
          commit_sha: null,
          pushed: false,
          reviewer_decision: null,
          next_action: 'send_fix_to_coder',
          safety_findings: [failMsg],
        };
      }

      checksPassed = true;

      // Assert no unrelated changes
      assertNoUnrelatedChanges(blockDefinition.repo_path, updatePaths);

      // Stage only approved files
      stageOnlyFiles(blockDefinition.repo_path, updatePaths);

      // Commit staged changes
      const commitMessage = `ai-orchestrator: ${input.blockId} ${taskId}`;
      commitSha = commitStagedChanges(blockDefinition.repo_path, commitMessage);

      // Push if allowed
      if (input.allowRealRepoPush) {
        pushed = pushCurrentBranch(blockDefinition.repo_path, blockDefinition.work_branch);
      } else {
        pushed = false;
      }

      // Build real evidence
      diff = getCommitDiff(blockDefinition.repo_path);
      gitStatus = getGitStatusPorcelain(blockDefinition.repo_path);
      currentBranch = getCurrentBranchName(blockDefinition.repo_path);
    } catch (applyErr) {
      // Rollback on any apply/check/commit error
      if (manifest.length > 0) {
        try {
          rollbackFileUpdates(blockDefinition.repo_path, manifest);
        } catch {
          // ignore rollback errors
        }
      }
      const rawMsg = applyErr instanceof Error ? applyErr.message : String(applyErr);
      const msg = redactReviewerText(rawMsg);
      blockState = markTaskChecksFailed(blockState, taskId, [msg]);
      saveBlockState(blockState);
      return {
        block_id: input.blockId,
        task_id: taskId,
        status_before: statusBefore,
        status_after: blockState.tasks.find((t) => t.task_id === taskId)?.status ?? 'checks_failed',
        coder_called: true,
        reviewer_called: false,
        files_applied: filesApplied,
        checks_passed: false,
        commit_sha: null,
        pushed: false,
        reviewer_decision: null,
        next_action: 'send_fix_to_coder',
        safety_findings: [msg],
      };
    }
  }

  // 10. Run deterministic review checks
  const deterministicResult = runDeterministicReviewChecks({
    allowedFiles: taskDefinition.allowed_files,
    deniedFiles: taskDefinition.denied_files,
    maxLinesChanged: taskDefinition.max_lines_changed,
    changedFiles: filesApplied,
    diff,
    typecheckResult: 'pass',
    buildResult: 'pass',
    testResult: 'pass',
    gitStatus,
    commitSha: commitSha!,
    currentBranch,
  });

  // 11. Build ReviewInput
  const reviewInput = buildReviewInput({
    blockId: input.blockId,
    taskId,
    taskTitle: taskDefinition.title,
    taskGoal: taskDefinition.goal,
    allowedFiles: taskDefinition.allowed_files,
    deniedFiles: taskDefinition.denied_files,
    maxLinesChanged: taskDefinition.max_lines_changed,
    commitSha: commitSha!,
    changedFiles: filesApplied,
    diff,
    typecheckResult: 'pass',
    buildResult: 'pass',
    testResult: 'pass',
    gitStatus,
    safetyFindings: [...safetyFindings, ...deterministicResult.safetyFindings],
    previousFailure: fixContext?.checkFailureSummary,
  });

  // 12. Run reviewer gate
  const reviewerGateResult = await runReviewerGate({
    reviewer: providers.reviewer,
    reviewInput,
    deterministicResult: {
      ok: deterministicResult.ok,
      blockingIssues: deterministicResult.blockingIssues,
      safetyFindings: deterministicResult.safetyFindings,
    },
  });

  // 13. Update block state based on reviewer decision
  let statusAfter: string;
  let nextAction: string;

  if (reviewerGateResult.decision.decision === 'accepted') {
    blockState = markTaskCommitted(blockState, taskId, commitSha);
    if (pushed) {
      blockState = markTaskPushed(blockState, taskId, commitSha, blockDefinition.work_branch);
    }
    blockState = markTaskWaitingReview(blockState, taskId);
    blockState = markTaskAccepted(blockState, taskId, reviewerGateResult.decision.review_summary);
    statusAfter = 'accepted';
    nextAction = 'advance_to_next_task';
    if (!pushed) {
      safetyFindings.push('Push not performed');
    }
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
    const fixIssues = reviewerGateResult.decision.blocking_issues;
    const fixSummary = reviewerGateResult.decision.review_summary;
    blockState = markTaskFixRequired(blockState, taskId, fixIssues, fixSummary);
    statusAfter = blockState.tasks.find((t) => t.task_id === taskId)?.status ?? 'fix_required';
    nextAction = 'send_fix_to_coder';
  }

  saveBlockState(blockState);

  return {
    block_id: input.blockId,
    task_id: taskId,
    status_before: statusBefore,
    status_after: statusAfter,
    coder_called: true,
    reviewer_called: reviewerGateResult.reviewerCalled,
    files_applied: filesApplied,
    checks_passed: checksPassed,
    commit_sha: commitSha,
    pushed,
    reviewer_decision: reviewerGateResult.decision.decision,
    next_action: nextAction,
    safety_findings: [...safetyFindings, ...reviewerGateResult.safetyFindings],
  };
}

