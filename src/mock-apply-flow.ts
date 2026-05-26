import {
  ensureClean,
  getChangedFiles,
  getWorkingTreeDiffStat,
} from './git-manager.js';
import { parseKimiOutputJson } from './kimi-output-validator.js';
import { applyFileUpdates, rollbackFileUpdates } from './patch-engine.js';
import {
  validateDiffSize,
  validateFileList,
  validateTestsPresent,
} from './guardrails.js';
import { runChecks } from './runner.js';
import {
  initAttemptDir,
  initState,
  loadState,
  saveState,
  writeAttemptFile,
} from './state-manager.js';
import type { PatchManifestEntry, RunState, Task } from './types.js';

function saveAttemptArtifact(
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
    return logs + `Attempt artifact save failed: ${filename}: ${msg}\n`;
  }
  return logs;
}

export function runMockApplyFlow(
  task: Task,
  rawKimiJson: string
): { success: boolean; logs: string } {
  let logs = '';
  let manifest: PatchManifestEntry[] = [];
  let state: RunState | null = null;
  let attemptNum = 0;

  try {
    state = loadState(task.id) ?? initState(task);
    state.current_attempt += 1;
    attemptNum = state.current_attempt;
    state.status = 'running';
    state.updated_at = new Date().toISOString();
    saveState(task.id, state);

    const attemptDir = initAttemptDir(task.id, attemptNum);
    logs = saveAttemptArtifact(
      task.id,
      attemptNum,
      'raw-kimi-output.json',
      rawKimiJson,
      logs
    );

    const kimiOutput = parseKimiOutputJson(rawKimiJson);
    logs += 'KimiOutput parsed successfully\n';

    logs = saveAttemptArtifact(
      task.id,
      attemptNum,
      'parsed-kimi-output.json',
      JSON.stringify(kimiOutput, null, 2),
      logs
    );

    const updatePaths = kimiOutput.files.map((f) => f.path);
    const preApplyResult = validateFileList(updatePaths, task.guardrails);
    if (!preApplyResult.ok) {
      logs += `Pre-apply guardrails failed: ${preApplyResult.reason}\n`;
      throw new Error(preApplyResult.reason);
    }
    logs += 'Pre-apply guardrails passed\n';

    ensureClean(task.repo_path);
    logs += 'Working tree is clean\n';

    manifest = applyFileUpdates(task.repo_path, kimiOutput.files, attemptDir);
    logs += `Applied ${manifest.length} file(s)\n`;

    logs = saveAttemptArtifact(
      task.id,
      attemptNum,
      'patch-manifest.json',
      JSON.stringify(manifest, null, 2),
      logs
    );

    const changedFiles = getChangedFiles(task.repo_path);
    const diffStat = getWorkingTreeDiffStat(task.repo_path);
    logs += `Changed files: ${changedFiles.length}\n`;

    const fileListResult = validateFileList(changedFiles, task.guardrails);
    if (!fileListResult.ok) {
      logs += `Guardrails file check failed: ${fileListResult.reason}\n`;
      throw new Error(fileListResult.reason);
    }

    const diffSizeResult = validateDiffSize(
      diffStat,
      task.guardrails.max_lines_changed
    );
    if (!diffSizeResult.ok) {
      logs += `Guardrails diff size failed: ${diffSizeResult.reason}\n`;
      throw new Error(diffSizeResult.reason);
    }

    const testsResult = validateTestsPresent(
      changedFiles,
      task.guardrails.require_tests
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

    logs = saveAttemptArtifact(task.id, attemptNum, 'logs.txt', logs, logs);

    state.status = 'approved';
    state.last_logs = logs;
    state.updated_at = new Date().toISOString();
    saveState(task.id, state);

    return { success: true, logs };
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

    logs = saveAttemptArtifact(task.id, attemptNum, 'logs.txt', logs, logs);

    if (state) {
      try {
        state.status = 'failed';
        state.last_logs = logs;
        state.updated_at = new Date().toISOString();
        saveState(task.id, state);
      } catch (stateErr) {
        const stateMessage =
          stateErr instanceof Error ? stateErr.message : String(stateErr);
        logs += `State save failed: ${stateMessage}\n`;
      }
    }

    return { success: false, logs };
  }
}
