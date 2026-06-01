import {
  ensureClean,
  getChangedFiles,
  getCurrentBranch,
  getWorkingTreeDiffStat,
  prepareWorkBranch,
} from './git-manager.js';
import { config } from './config.js';
import { parseKimiOutputJson } from './kimi-output-validator.js';
import { applyFileUpdates, rollbackFileUpdates } from './patch-engine.js';
import {
  validateDiffSize,
  validateFileList,
  validateTestsPresent,
  validateProposedFileLineDeltas,
} from './guardrails.js';
import { runChecks } from './runner.js';
import { parseReviewerOutputJson } from './reviewer-output-validator.js';
import {
  initAttemptDir,
  initState,
  loadState,
  saveState,
  writeAttemptFile,
} from './state-manager.js';
import type { PatchManifestEntry, RunState, Task } from './types.js';

export interface PipelineLoopResult {
  success: boolean;
  logs: string;
}

function saveArtifact(
  taskId: string,
  attempt: number,
  filename: string,
  data: string,
  logs: string
): string {
  if (attempt <= 0) return logs;
  try {
    writeAttemptFile(taskId, attempt, filename, data);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return logs + `Artifact save failed: ${filename}: ${msg}\n`;
  }
  return logs;
}

export function runPipelineLoop(
  task: Task,
  rawKimiJson: string,
  rawReviewerJson: string
): PipelineLoopResult {
  let logs = '';
  let manifest: PatchManifestEntry[] = [];
  let state: RunState | null = null;
  let attemptNum = 0;

  try {
    state = loadState(task.id) ?? initState(task);

    if (state.current_attempt >= config.maxAttempts) {
      const maxLogs = `Max attempts reached: ${state.current_attempt}/${config.maxAttempts}\n`;
      state.status = 'failed_max_attempts';
      state.last_logs = maxLogs;
      state.updated_at = new Date().toISOString();
      saveState(task.id, state);
      return { success: false, logs: maxLogs };
    }

    state.current_attempt += 1;
    attemptNum = state.current_attempt;
    state.status = 'patching';
    state.updated_at = new Date().toISOString();
    saveState(task.id, state);

    const attemptDir = initAttemptDir(task.id, attemptNum);

    logs = saveArtifact(task.id, attemptNum, 'raw-kimi-output.json', rawKimiJson, logs);
    const kimiOutput = parseKimiOutputJson(rawKimiJson);
    logs += 'KimiOutput parsed successfully\n';

    logs = saveArtifact(
      task.id,
      attemptNum,
      'parsed-kimi-output.json',
      JSON.stringify(kimiOutput, null, 2),
      logs
    );

    if (kimiOutput.files.length === 0) {
      logs += 'No file changes proposed\n';
      if (kimiOutput.notes) {
        logs += `Notes: ${kimiOutput.notes}\n`;
      }
    } else {
      const updatePaths = kimiOutput.files.map((f) => f.path);
      const preApplyResult = validateFileList(updatePaths, task.guardrails);
      if (!preApplyResult.ok) {
        logs += `Pre-apply guardrails failed: ${preApplyResult.reason}\n`;
        throw new Error(preApplyResult.reason);
      }
      logs += 'Pre-apply guardrails passed\n';

      validateProposedFileLineDeltas(
        task.repo_path,
        kimiOutput.files,
        task.guardrails.max_lines_changed
      );
      logs += 'Pre-apply line delta guardrails passed\n';
    }

    ensureClean(task.repo_path);
    logs += 'Working tree is clean\n';

    const currentBranch = getCurrentBranch(task.repo_path);
    logs += `Current branch: ${currentBranch}\n`;
    const isResume = currentBranch === task.work_branch;
    prepareWorkBranch(task.repo_path, task.base_branch, task.work_branch, isResume);
    logs += `Work branch ready: ${task.work_branch}\n`;

    if (kimiOutput.files.length > 0) {
      manifest = applyFileUpdates(task.repo_path, kimiOutput.files, attemptDir);
      logs += `Applied ${manifest.length} file(s)\n`;
      logs = saveArtifact(
        task.id,
        attemptNum,
        'patch-manifest.json',
        JSON.stringify(manifest, null, 2),
        logs
      );
    }

    const changedFiles = getChangedFiles(task.repo_path);
    const diffStat = getWorkingTreeDiffStat(task.repo_path);
    logs += `Changed files: ${changedFiles.length}\n`;

    const fileListResult = validateFileList(changedFiles, task.guardrails);
    if (!fileListResult.ok) {
      logs += `Guardrails file check failed: ${fileListResult.reason}\n`;
      throw new Error(fileListResult.reason);
    }

    const diffSizeResult = validateDiffSize(diffStat, task.guardrails.max_lines_changed);
    if (!diffSizeResult.ok) {
      logs += `Guardrails diff size failed: ${diffSizeResult.reason}\n`;
      throw new Error(diffSizeResult.reason);
    }

    const testsResult = validateTestsPresent(
      changedFiles,
      task.guardrails.require_tests ?? false
    );
    if (!testsResult.ok) {
      logs += `Guardrails tests failed: ${testsResult.reason}\n`;
      throw new Error(testsResult.reason);
    }

    const checkResult = runChecks(task.repo_path, task.checks);
    if (!checkResult.success) {
      logs += `Checks failed: ${checkResult.failedStep?.command} ${checkResult.failedStep?.args?.join(' ')}\n${checkResult.logs}\n`;
      throw new Error('Checks failed');
    }
    logs += 'All checks passed\n';

    // Reviewer step
    state.status = 'reviewing';
    state.updated_at = new Date().toISOString();
    saveState(task.id, state);

    logs = saveArtifact(
      task.id,
      attemptNum,
      'raw-reviewer-output.json',
      rawReviewerJson,
      logs
    );
    const reviewVerdict = parseReviewerOutputJson(rawReviewerJson);
    logs += `Reviewer verdict: ${reviewVerdict.verdict}\n`;

    logs = saveArtifact(
      task.id,
      attemptNum,
      'parsed-reviewer-output.json',
      JSON.stringify(reviewVerdict, null, 2),
      logs
    );

    state.last_review = reviewVerdict;

    if (reviewVerdict.verdict === 'approve') {
      logs += 'Review approved\n';
      logs = saveArtifact(task.id, attemptNum, 'logs.txt', logs, logs);
      state.status = 'approved';
      state.last_logs = logs;
      state.updated_at = new Date().toISOString();
      saveState(task.id, state);
      return { success: true, logs };
    }

    if (reviewVerdict.verdict === 'reject') {
      logs += 'Review rejected\n';
      logs = saveArtifact(task.id, attemptNum, 'logs.txt', logs, logs);
      state.status = 'rejected';
      state.last_logs = logs;
      state.updated_at = new Date().toISOString();
      saveState(task.id, state);
      return { success: false, logs };
    }

    // needs_changes: rollback unapproved patch, keep state as 'reviewing'
    // (closest existing safe status for "review completed, more work needed")
    logs += 'Review requested changes\n';
    logs = saveArtifact(task.id, attemptNum, 'logs.txt', logs, logs);
    state.status = 'reviewing';
    state.last_logs = logs;
    state.updated_at = new Date().toISOString();
    saveState(task.id, state);

    if (manifest.length > 0) {
      try {
        rollbackFileUpdates(task.repo_path, manifest);
        logs += 'Rollback completed\n';
      } catch (rollbackErr) {
        const rollbackMessage =
          rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr);
        logs += `Rollback failed: ${rollbackMessage}\n`;
      }
    }

    return { success: false, logs };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logs += `Flow failed: ${message}\n`;

    if (manifest.length > 0) {
      try {
        rollbackFileUpdates(task.repo_path, manifest);
        logs += 'Rollback completed\n';
      } catch (rollbackErr) {
        const rollbackMessage =
          rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr);
        logs += `Rollback failed: ${rollbackMessage}\n`;
      }
    }

    logs = saveArtifact(task.id, attemptNum, 'logs.txt', logs, logs);

    if (state) {
      try {
        state.status = 'failed_guardrails';
        state.last_logs = logs;
        state.updated_at = new Date().toISOString();
        saveState(task.id, state);
      } catch (stateErr) {
        const stateMessage = stateErr instanceof Error ? stateErr.message : String(stateErr);
        logs += `State save failed: ${stateMessage}\n`;
      }
    }

    return { success: false, logs };
  }
}
