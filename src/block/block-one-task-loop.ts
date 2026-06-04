import type { OneTaskLoopInput, OneTaskLoopResult } from './block-runner-types.js';
import type { BlockDefinition, BlockTaskDefinition } from './block-types.js';
import { loadBlockState, saveBlockState } from './block-state-manager.js';
import { loadBlockDefinition } from './block-loader.js';
import {
  markTaskInProgress,
  markTaskChecksFailed,
  markTaskCommitted,
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
import { validateFileList, validateProposedFileLineDeltas } from '../guardrails.js';
import { runDeterministicReviewChecks } from '../reviewer/deterministic-review-checks.js';
import { buildReviewInput } from '../reviewer/review-input-builder.js';
import { runReviewerGate } from '../reviewer/reviewer-gate.js';
import type { CoderResult } from '../providers/provider-types.js';

function generateFakeCommitSha(): string {
  return 'f'.repeat(40);
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

function validateRealModeGates(input: OneTaskLoopInput): void {
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
  if (input.reviewerProvider === 'kimi' && !input.allowKimiReviewer) {
    throw new Error('Real mode with Kimi reviewer requires ALLOW_KIMI_REVIEWER=true');
  }
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
  const statusBefore = blockState.tasks.find((t) => t.task_id === taskId)?.status ?? 'unknown';

  // 4. Mark task in_progress
  blockState = markTaskInProgress(blockState, taskId);
  saveBlockState(blockState);

  // Real mode: fail safely before any provider call or mutation
  if (!isFakeMode) {
    validateRealModeGates(input);
    throw new Error('Real mode is not implemented safely yet. Use fake mode.');
  }

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

  // 9. Fake mode: simulate checks, commit, evidence
  // No real file writes, no git commands, no runChecks on real repo
  const checksPassed = true;
  const commitSha = generateFakeCommitSha();
  const pushed = false;

  // 10. Build fake commit evidence from coder result
  const fakeEvidence = buildFakeCommitEvidence(taskDefinition, coderResult, blockDefinition);

  // 11. Run deterministic review checks with explicit fake pass values
  const deterministicResult = runDeterministicReviewChecks({
    allowedFiles: taskDefinition.allowed_files,
    deniedFiles: taskDefinition.denied_files,
    maxLinesChanged: taskDefinition.max_lines_changed,
    changedFiles: fakeEvidence.changedFiles,
    diff: fakeEvidence.diff,
    typecheckResult: 'pass',
    buildResult: 'pass',
    testResult: 'pass',
    gitStatus: fakeEvidence.gitStatus,
    commitSha,
    currentBranch: fakeEvidence.currentBranch,
  });

  // 12. Build ReviewInput
  const reviewInput = buildReviewInput({
    blockId: input.blockId,
    taskId,
    taskTitle: taskDefinition.title,
    taskGoal: taskDefinition.goal,
    allowedFiles: taskDefinition.allowed_files,
    deniedFiles: taskDefinition.denied_files,
    maxLinesChanged: taskDefinition.max_lines_changed,
    commitSha,
    changedFiles: fakeEvidence.changedFiles,
    diff: fakeEvidence.diff,
    typecheckResult: 'pass',
    buildResult: 'pass',
    testResult: 'pass',
    gitStatus: fakeEvidence.gitStatus,
    safetyFindings: [...fakeEvidence.safetyFindings, ...deterministicResult.safetyFindings],
  });

  // 13. Run reviewer gate
  const reviewerGateResult = await runReviewerGate({
    reviewer: providers.reviewer,
    reviewInput,
    deterministicResult: {
      ok: deterministicResult.ok,
      blockingIssues: deterministicResult.blockingIssues,
      safetyFindings: deterministicResult.safetyFindings,
    },
  });

  // 14. Update block state based on reviewer decision
  let statusAfter: string;
  let nextAction: string;

  if (reviewerGateResult.decision.decision === 'accepted') {
    blockState = markTaskCommitted(blockState, taskId, commitSha);
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
    files_applied: updatePaths,
    checks_passed: checksPassed,
    commit_sha: commitSha,
    pushed,
    reviewer_decision: reviewerGateResult.decision.decision,
    next_action: nextAction,
    safety_findings: reviewerGateResult.safetyFindings,
  };
}
