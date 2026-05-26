import { parseKimiOutputJson } from './kimi-output-validator.js';
import { applyFileUpdates, rollbackFileUpdates } from './patch-engine.js';
import { getChangedFiles, getDiffStat } from './git-manager.js';
import {
  validateDiffSize,
  validateFileList,
  validateTestsPresent,
} from './guardrails.js';
import { runChecks } from './runner.js';
import { getRunDir } from './state-manager.js';
import type { Task } from './types.js';

export function runMockApplyFlow(
  task: Task,
  rawKimiJson: string
): { success: boolean; logs: string } {
  let logs = '';

  const kimiOutput = parseKimiOutputJson(rawKimiJson);
  logs += 'KimiOutput parsed successfully\n';

  const updatePaths = kimiOutput.files.map((f) => f.path);
  const preApplyResult = validateFileList(updatePaths, task.guardrails);
  if (!preApplyResult.ok) {
    logs += `Pre-apply guardrails failed: ${preApplyResult.reason}\n`;
    return { success: false, logs };
  }
  logs += 'Pre-apply guardrails passed\n';

  const runDir = getRunDir(task.id);
  const manifest = applyFileUpdates(task.repo_path, kimiOutput.files, runDir);
  logs += `Applied ${manifest.length} file(s)\n`;

  try {
    const changedFiles = getChangedFiles(task.repo_path);
    const diffStat = getDiffStat(task.repo_path);
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
    return { success: true, logs };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logs += `Rolling back due to error: ${message}\n`;
    rollbackFileUpdates(task.repo_path, manifest);
    logs += 'Rollback completed\n';
    return { success: false, logs };
  }
}
