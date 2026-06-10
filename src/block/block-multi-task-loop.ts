import type {
  MultiTaskLoopInput,
  MultiTaskLoopResult,
  MultiTaskLoopMode,
} from './block-multi-runner-types.js';
import type { OneTaskLoopResult } from './block-runner-types.js';
import type { BlockState } from './block-types.js';
import { loadBlockState, saveBlockState, initBlockState } from './block-state-manager.js';
import { loadBlockDefinition } from './block-loader.js';
import { runOneTaskLoop } from './block-one-task-loop.js';

const FAKE_MAX_TASKS_LIMIT = 100;
const REAL_MAX_TASKS_LIMIT = 3;
const DEFAULT_MAX_TOTAL_ATTEMPTS = 20;
const MAX_TOTAL_ATTEMPTS_LIMIT = 100;

function validateMaxTasksPerRun(mode: MultiTaskLoopMode, maxTasksPerRun: number): void {
  if (!Number.isFinite(maxTasksPerRun) || !Number.isInteger(maxTasksPerRun) || maxTasksPerRun < 1) {
    throw new Error('maxTasksPerRun must be a positive integer');
  }

  if (mode === 'fake') {
    if (maxTasksPerRun > FAKE_MAX_TASKS_LIMIT) {
      throw new Error(`Fake mode maxTasksPerRun must be <= ${FAKE_MAX_TASKS_LIMIT}`);
    }
  } else {
    if (maxTasksPerRun > REAL_MAX_TASKS_LIMIT) {
      throw new Error(
        `Real mode maxTasksPerRun must be <= ${REAL_MAX_TASKS_LIMIT}`
      );
    }
  }
}

function validateMaxTotalAttemptsPerRun(maxTotalAttemptsPerRun: number): void {
  if (!Number.isFinite(maxTotalAttemptsPerRun) || !Number.isInteger(maxTotalAttemptsPerRun) || maxTotalAttemptsPerRun < 1) {
    throw new Error('maxTotalAttemptsPerRun must be a positive integer');
  }
  if (maxTotalAttemptsPerRun > MAX_TOTAL_ATTEMPTS_LIMIT) {
    throw new Error(`maxTotalAttemptsPerRun must be <= ${MAX_TOTAL_ATTEMPTS_LIMIT}`);
  }
}

function validateRealModeSafety(
  mode: MultiTaskLoopMode,
  input: MultiTaskLoopInput
): string[] {
  const issues: string[] = [];

  if (mode === 'fake') {
    return issues;
  }

  if (!input.allowBlockRunOne) {
    issues.push('Real multi-task mode requires ALLOW_BLOCK_RUN_ONE=true');
  }
  if (!input.allowRealProvider) {
    issues.push('Real multi-task mode requires ALLOW_REAL_PROVIDER=true');
  }
  if (!input.allowRealRepoApply) {
    issues.push('Real multi-task mode requires ALLOW_REAL_REPO_APPLY=true');
  }
  if (!input.allowRealRepoCommit) {
    issues.push('Real multi-task mode requires ALLOW_REAL_REPO_COMMIT=true');
  }
  if (input.allowRealRepoPush) {
    issues.push('Stage 6.8 real multi-task mode requires ALLOW_REAL_REPO_PUSH=false');
  }

  if (mode === 'real_kimi_coder_kimi_reviewer') {
    if (!input.allowKimiReviewer) {
      issues.push('Real multi-task mode with Kimi reviewer requires ALLOW_KIMI_REVIEWER=true');
    }
    if (input.coderProvider !== 'kimi') {
      issues.push('Real multi-task mode with Kimi reviewer requires coderProvider=kimi');
    }
    if (input.reviewerProvider !== 'kimi') {
      issues.push('Real multi-task mode with Kimi reviewer requires reviewerProvider=kimi');
    }
  } else if (mode === 'real_kimi_coder_fake_reviewer') {
    if (input.coderProvider !== 'kimi') {
      issues.push('Real multi-task mode requires coderProvider=kimi');
    }
    if (input.reviewerProvider !== 'fake') {
      issues.push('Real multi-task mode with fake reviewer requires reviewerProvider=fake');
    }
    if (input.allowKimiReviewer) {
      issues.push('Real multi-task mode with fake reviewer must not set ALLOW_KIMI_REVIEWER=true');
    }
  }

  return issues;
}

export async function runMultiTaskLoop(
  input: MultiTaskLoopInput
): Promise<MultiTaskLoopResult> {
  const startedAt = new Date().toISOString();
  const safetyFindings: string[] = [];

  // 1. Load block definition
  const blockDefinition = loadBlockDefinition(input.blockDefinitionPath);
  const blockId = input.blockId ?? blockDefinition.block_id;

  if (blockDefinition.block_id !== blockId) {
    throw new Error(
      `Block definition id mismatch: ${blockDefinition.block_id} vs ${blockId}`
    );
  }

  // 2. Ensure block state exists
  let blockState = loadBlockState(blockId);
  if (!blockState) {
    blockState = initBlockState(blockDefinition);
    saveBlockState(blockState);
  }

  // 3. Validate limits
  validateMaxTasksPerRun(input.mode, input.maxTasksPerRun);
  validateMaxTotalAttemptsPerRun(input.maxTotalAttemptsPerRun);

  // 4. Real-mode safety checks before any mutation
  const realModeIssues = validateRealModeSafety(input.mode, input);
  if (realModeIssues.length > 0) {
    throw new Error(`Real multi-task mode safety check failed: ${realModeIssues.join('; ')}`);
  }

  const results: OneTaskLoopResult[] = [];
  let tasksAttempted = 0;
  let tasksAccepted = 0;
  let tasksFixRequired = 0;
  let tasksBlocked = 0;
  let totalAttempts = 0;

  // 5. Loop
  while (totalAttempts < input.maxTotalAttemptsPerRun) {
    // Re-read state each iteration
    blockState = loadBlockState(blockId);
    if (!blockState) {
      safetyFindings.push('Block state disappeared during loop');
      break;
    }

    // Stop conditions
    if (blockState.status === 'completed') {
      break;
    }
    if (blockState.status === 'blocked') {
      break;
    }
    if (!blockState.current_task_id) {
      break;
    }

    const currentTaskId = blockState.current_task_id;

    // Run one task using the already-accepted one-task loop
    const taskResult = await runOneTaskLoop({
      blockId,
      mode: input.mode,
      allowBlockRunOne: input.allowBlockRunOne,
      allowRealProvider: input.allowRealProvider,
      allowRealRepoApply: input.allowRealRepoApply,
      allowRealRepoCommit: input.allowRealRepoCommit,
      allowRealRepoPush: input.allowRealRepoPush,
      allowKimiReviewer: input.allowKimiReviewer,
      reviewerProvider: input.reviewerProvider,
      coderProvider: input.coderProvider,
      blockDefinitionPath: input.blockDefinitionPath,
      fakeCoderOptions: input.fakeCoderOptions,
      fakeReviewerOptions: input.fakeReviewerOptions,
    });

    results.push(taskResult);
    totalAttempts++;

    if (taskResult.status_after === 'accepted') {
      tasksAttempted++;
      tasksAccepted++;
    } else if (taskResult.status_after === 'blocked') {
      tasksAttempted++;
      tasksBlocked++;
      if (input.stopOnBlocked) {
        break;
      }
    } else if (taskResult.status_after === 'fix_required' || taskResult.status_after === 'checks_failed') {
      tasksFixRequired++;
      if (input.stopOnRejected) {
        break;
      }
      // Continue loop to retry same task if limits allow
      const afterState = loadBlockState(blockId);
      if (afterState?.status === 'blocked') {
        break;
      }
      // If task is still the same and not blocked, loop will retry
      continue;
    }

    // Task-level limit: stop if we have attempted enough distinct tasks
    if (tasksAttempted >= input.maxTasksPerRun) {
      break;
    }

    // Safety: if block status became blocked during the task, stop
    const latestState = loadBlockState(blockId);
    if (latestState?.status === 'blocked') {
      break;
    }
  }

  if (totalAttempts >= input.maxTotalAttemptsPerRun && blockState?.status !== 'completed' && blockState?.status !== 'blocked') {
    safetyFindings.push(`Stopped after ${totalAttempts} total attempts (maxTotalAttemptsPerRun reached)`);
  }

  // Final state read
  const finalState = loadBlockState(blockId);

  return {
    block_id: blockId,
    mode: input.mode,
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    tasks_attempted: tasksAttempted,
    tasks_accepted: tasksAccepted,
    tasks_fix_required: tasksFixRequired,
    tasks_blocked: tasksBlocked,
    final_block_status: finalState?.status ?? 'unknown',
    current_task_id: finalState?.current_task_id ?? null,
    results,
    safety_findings: safetyFindings,
  };
}

export async function runMultiTaskFakeLoop(
  input: Omit<MultiTaskLoopInput, 'mode' | 'allowBlockRunOne' | 'allowRealProvider' | 'allowRealRepoApply' | 'allowRealRepoCommit' | 'allowRealRepoPush' | 'allowKimiReviewer' | 'coderProvider' | 'reviewerProvider'>
): Promise<MultiTaskLoopResult> {
  return runMultiTaskLoop({
    ...input,
    mode: 'fake',
    maxTotalAttemptsPerRun: input.maxTotalAttemptsPerRun ?? DEFAULT_MAX_TOTAL_ATTEMPTS,
    allowBlockRunOne: false,
    allowRealProvider: false,
    allowRealRepoApply: false,
    allowRealRepoCommit: false,
    allowRealRepoPush: false,
    allowKimiReviewer: false,
    coderProvider: 'fake',
    reviewerProvider: 'fake',
  });
}
