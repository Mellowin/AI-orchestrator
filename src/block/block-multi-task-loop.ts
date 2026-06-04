import type { MultiTaskLoopInput, MultiTaskLoopResult } from './block-multi-runner-types.js';
import type { OneTaskLoopResult } from './block-runner-types.js';
import type { BlockState } from './block-types.js';
import { loadBlockState, saveBlockState, initBlockState } from './block-state-manager.js';
import { loadBlockDefinition } from './block-loader.js';
import { runOneTaskLoop } from './block-one-task-loop.js';

export async function runMultiTaskFakeLoop(
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

  // 3. Validate mode
  if (input.mode !== 'fake') {
    throw new Error('Multi-task loop only supports fake mode');
  }

  const results: OneTaskLoopResult[] = [];
  let tasksAttempted = 0;
  let tasksAccepted = 0;
  let tasksFixRequired = 0;
  let tasksBlocked = 0;

  // 4. Loop
  while (tasksAttempted < input.maxTasksPerRun) {
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

    // Run one task in safe fake mode
    const taskResult = await runOneTaskLoop({
      blockId,
      mode: 'fake',
      allowBlockRunOne: false,
      allowRealProvider: false,
      allowRealRepoApply: false,
      allowRealRepoCommit: false,
      allowRealRepoPush: false,
      allowKimiReviewer: false,
      reviewerProvider: 'fake',
      coderProvider: 'fake',
      blockDefinitionPath: input.blockDefinitionPath,
      fakeCoderOptions: input.fakeCoderOptions,
      fakeReviewerOptions: input.fakeReviewerOptions,
    });

    results.push(taskResult);
    tasksAttempted++;

    if (taskResult.status_after === 'accepted') {
      tasksAccepted++;
    } else if (taskResult.status_after === 'fix_required') {
      tasksFixRequired++;
      if (input.stopOnRejected) {
        break;
      }
      // If stopOnRejected is false, we still need to avoid infinite loops.
      // Only continue if the task actually advanced (current_task_id changed).
      // If the same task is still current after fix_required, stop to avoid loop.
      const afterState = loadBlockState(blockId);
      if (afterState?.current_task_id === currentTaskId) {
        safetyFindings.push(
          `Stopped after fix_required on ${currentTaskId} to avoid infinite loop`
        );
        break;
      }
    } else if (taskResult.status_after === 'blocked') {
      tasksBlocked++;
      if (input.stopOnBlocked) {
        break;
      }
    } else if (taskResult.status_after === 'checks_failed') {
      // Treat checks_failed like fix_required for loop control
      tasksFixRequired++;
      if (input.stopOnRejected) {
        break;
      }
      const afterState = loadBlockState(blockId);
      if (afterState?.current_task_id === currentTaskId) {
        safetyFindings.push(
          `Stopped after checks_failed on ${currentTaskId} to avoid infinite loop`
        );
        break;
      }
    }

    // Safety: if block status became blocked during the task, stop
    const latestState = loadBlockState(blockId);
    if (latestState?.status === 'blocked') {
      break;
    }
  }

  // Final state read
  const finalState = loadBlockState(blockId);

  return {
    block_id: blockId,
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
