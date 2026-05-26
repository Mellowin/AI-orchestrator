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
  getRunDir,
  initAttemptDir,
  initState,
  loadState,
  saveState,
  writeAttemptFile,
} from './state-manager.js';
import type { PatchManifestEntry, RunState, Task } from './types.js';

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

    initAttemptDir(task.id, attemptNum);
    try {
      writeAttemptFile(task.id, attemptNum, 'raw-kimi-output.json', rawKimiJson);
    } catch (artifactErr) {
      const msg = artifactErr instanceof Error ? artifactErr.message : String(artifactErr);
      logs += `Attempt artifact save failed: raw-kimi-output.json: ${msg}\n`;
    }

    const kimiOutput = parseKimiOutputJson(rawKimiJson);
    logs += 'KimiOutput parsed successfully\n';

    try {
      writeAttemptFile(
        task.id,
        attemptNum,
        'parsed-kimi-output.json',
        JSON.stringify(kimiOutput, null, 2)
      );
    } catch (artifactErr) {
      const msg = artifactErr instanceof Error ? artifactErr.message : String(artifactErr);
      logs += `Attempt artifact save failed: parsed-kimi-output.json: ${msg}\n`;
    }

    const updatePaths = kimiOutput.files.map((f) => f.path);
    const preApplyResult = validateFileList(updatePaths, task.guardrails);
    if (!preApplyResult.ok) {
      logs += `Pre-apply guardrails failed: ${preApplyResult.reason}\n`;
      throw new Error(preApplyResult.reason);
    }
    logs += 'Pre-apply guardrails passed\n';

    ensureClean(task.repo_path);
    logs += 'Working tree is clean\n';

    const runDir = getRunDir(task.id);
    manifest = applyFileUpdates(task.repo_path, kimiOutput.files, runDir);
    logs += `Applied ${manifest.length} file(s)\n`;

    try {
      writeAttemptFile(
        task.id,
        attemptNum,
        'patch-manifest.json',
        JSON.stringify(manifest, null, 2)
      );
    } catch (artifactErr) {
      const msg = artifactErr instanceof Error ? artifactErr.message : String(artifactErr);
      logs += `Attempt artifact save failed: patch-manifest.json: ${msg}\n`;
    }

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

    try {
      writeAttemptFile(task.id, attemptNum, 'logs.txt', logs);
    } catch (artifactErr) {
      const msg = artifactErr instanceof Error ? artifactErr.message : String(artifactErr);
      logs += `Attempt artifact save failed: logs.txt: ${msg}\n`;
    }

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

    if (attemptNum > 0) {
      try {
        writeAttemptFile(task.id, attemptNum, 'logs.txt', logs);
      } catch (artifactErr) {
        const msg = artifactErr instanceof Error ? artifactErr.message : String(artifactErr);
        logs += `Attempt artifact save failed: logs.txt: ${msg}\n`;
      }
    }

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
