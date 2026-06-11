import { runSandboxApplyFlow } from './sandbox-apply-flow.js';
import type { Task } from './types.js';

export interface RealRepoSandboxPreflightInput {
  task: Task;
  rawProviderText: string;
  sandboxRoot: string;
}

export interface RealRepoSandboxPreflightResult {
  ok: boolean;
  failedStep?: string;
  appliedFiles?: string[];
  checkResult?: import('./types.js').RunResult;
  logs: string;
}

export function runRealRepoSandboxPreflight(
  input: RealRepoSandboxPreflightInput
): RealRepoSandboxPreflightResult {
  const flowResult = runSandboxApplyFlow({
    task: input.task,
    rawProviderText: input.rawProviderText,
    sandboxRoot: input.sandboxRoot,
  });

  return {
    ok: flowResult.success,
    failedStep: flowResult.failedStep,
    appliedFiles: flowResult.appliedFiles,
    checkResult: flowResult.checkResult,
    logs: flowResult.logs,
  };
}
