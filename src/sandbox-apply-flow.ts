import { parseKimiOutputJson } from './kimi-output-validator.js';
import {
  validateFileList,
  validateProposedFileLineDeltas,
} from './guardrails.js';
import { createSandboxRepoCopy } from './sandbox-repo.js';
import { applyToSandboxRepo } from './sandbox-apply.js';
import { runChecks } from './runner.js';
import type { Task } from './types.js';

export interface SandboxApplyFlowInput {
  task: Task;
  rawProviderText: string;
  sandboxRoot: string;
}

export interface SandboxApplyFlowResult {
  success: boolean;
  sandboxRepoPath?: string;
  appliedFiles?: string[];
  checksPassed?: boolean;
  failedStep?: string;
  checkResult?: import('./types.js').RunResult;
  logs: string;
}

export function runSandboxApplyFlow(
  input: SandboxApplyFlowInput
): SandboxApplyFlowResult {
  const logs: string[] = [];
  let sandboxRepoPath: string | undefined;
  let appliedFiles: string[] | undefined;
  let rollbackFn: (() => void) | undefined;
  let sandboxCleanupFn: (() => void) | undefined;

  function log(msg: string): void {
    logs.push(msg);
  }

  function cleanupSandbox(): boolean {
    log('step: cleanup');
    if (sandboxCleanupFn) {
      try {
        sandboxCleanupFn();
        return true;
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        log(`cleanup failed: ${reason}`);
        return false;
      }
    }
    return true;
  }

  // Step: parse
  log('step: parse');
  let parsed;
  try {
    parsed = parseKimiOutputJson(input.rawProviderText);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    log(`parse failed: ${reason}`);
    return { success: false, failedStep: 'parse', logs: logs.join('\n') };
  }

  // Step: guardrails
  log('step: guardrails');
  const fileList = parsed.files.map((f) => f.path);
  const fileListValidation = validateFileList(fileList, input.task.guardrails);
  if (!fileListValidation.ok) {
    log(`guardrails failed: ${fileListValidation.reason}`);
    return { success: false, failedStep: 'guardrails', logs: logs.join('\n') };
  }

  try {
    validateProposedFileLineDeltas(
      input.task.repo_path,
      parsed.files,
      input.task.guardrails.max_lines_changed
    );
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    log(`guardrails failed: ${reason}`);
    return { success: false, failedStep: 'guardrails', logs: logs.join('\n') };
  }

  // Step: sandbox copy
  log('step: sandbox copy');
  try {
    const sandboxResult = createSandboxRepoCopy(
      input.task.repo_path,
      input.sandboxRoot
    );
    sandboxRepoPath = sandboxResult.sandboxRepoPath;
    sandboxCleanupFn = sandboxResult.cleanup;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    log(`sandbox copy failed: ${reason}`);
    return { success: false, failedStep: 'sandbox_copy', logs: logs.join('\n') };
  }

  // Step: apply
  log('step: apply');
  try {
    const applyResult = applyToSandboxRepo(sandboxRepoPath, parsed.files);
    appliedFiles = applyResult.appliedFiles;
    rollbackFn = applyResult.rollback;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    log(`apply failed: ${reason}`);
    cleanupSandbox();
    return { success: false, failedStep: 'apply', logs: logs.join('\n') };
  }

  // Step: checks
  log('step: checks');
  const checkResult = runChecks(sandboxRepoPath, input.task.checks);
  if (!checkResult.success) {
    log(`checks failed: ${checkResult.logs}`);
    if (rollbackFn) {
      log('step: rollback');
      try {
        rollbackFn();
      } catch (rollbackErr) {
        const rollbackReason =
          rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr);
        log(`rollback failed: ${rollbackReason}`);
      }
    }
    if (!cleanupSandbox()) {
      return { success: false, failedStep: 'cleanup', logs: logs.join('\n') };
    }
    return { success: false, failedStep: 'checks', checkResult, logs: logs.join('\n') };
  }

  log(`checks passed: ${checkResult.logs}`);

  // Cleanup on success
  if (!cleanupSandbox()) {
    return { success: false, failedStep: 'cleanup', logs: logs.join('\n') };
  }

  return {
    success: true,
    appliedFiles,
    checksPassed: true,
    logs: logs.join('\n'),
  };
}
