import { loadBlockDefinition } from './block/block-loader.js';
import type { BlockDefinition } from './block/block-types.js';
import { redactSecrets } from './sandbox-preflight-repair.js';
import { checkRealBlockRunReadiness, type ReadinessReport } from './real-block-run-ai-readiness.js';
import { checkProviderSmokeReadiness, type ProviderSmokeCheckResult } from './real-block-run-ai-checklist.js';
import { isCompletedTaskStatus, loadExistingBlockState, type RealBlockRunState } from './real-block-run-ai-state.js';

export interface DryRunTaskItem {
  task_id: string;
  title: string;
  status?: string;
  allowed_files: string[];
  denied_files: string[];
  checks: string[];
  max_lines_changed: number;
  wouldSkip: boolean;
  isNext: boolean;
}

export interface RealBlockRunAIDryRunReport {
  ok: boolean;
  mode: 'real-block-run-ai-dry-run';
  blockPath: string;
  resume: boolean;
  provider: string;
  blockId: string;
  blockTitle: string;
  repoPath: string;
  baseBranch: string;
  workBranch: string;
  readiness: ReadinessReport;
  providerSmoke: ProviderSmokeCheckResult;
  totalTasks: number;
  tasks: DryRunTaskItem[];
  nextCommands: string[];
  warnings: string[];
  reasons: string[];
}

function getEnv(env: NodeJS.ProcessEnv, name: string): string | undefined {
  return env[name]?.trim();
}

function loadBlockSafely(blockPath: string): { block?: BlockDefinition; reason?: string } {
  try {
    return { block: loadBlockDefinition(blockPath) };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Block definition is invalid';
    return { reason: message };
  }
}

function loadExistingStateSafely(block: BlockDefinition): RealBlockRunState | null | { error: string } {
  try {
    return loadExistingBlockState(block);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Existing block state is invalid';
    return { error: message };
  }
}

function buildTaskStatuses(
  block: BlockDefinition,
  existingState: RealBlockRunState | null,
  resume: boolean
): DryRunTaskItem[] {
  const completedTaskIds = new Set<string>();
  if (existingState) {
    for (const result of existingState.taskResults) {
      if (isCompletedTaskStatus(result.status)) {
        completedTaskIds.add(result.taskId);
      }
    }
  }

  const items: DryRunTaskItem[] = block.tasks.map((task) => {
    const existingResult = existingState?.taskResults.find((r) => r.taskId === task.task_id);
    const wouldSkip = resume && (existingResult ? isCompletedTaskStatus(existingResult.status) : false);
    return {
      task_id: task.task_id,
      title: task.title,
      status: existingResult?.status,
      allowed_files: task.allowed_files,
      denied_files: task.denied_files,
      checks: task.checks,
      max_lines_changed: task.max_lines_changed,
      wouldSkip: Boolean(wouldSkip),
      isNext: false,
    };
  });

  let nextFound = false;
  for (const item of items) {
    if (!item.wouldSkip) {
      item.isNext = true;
      nextFound = true;
      break;
    }
  }

  // If every task would be skipped (e.g. completed block in resume mode), nothing is next.
  if (!nextFound) {
    for (const item of items) {
      item.isNext = false;
    }
  }

  return items;
}

export function createRealBlockRunAIDryRunReport(
  blockPath: string,
  options: { resume?: boolean; provider?: string; env?: NodeJS.ProcessEnv } = {}
): RealBlockRunAIDryRunReport {
  const env = options.env ?? process.env;
  const resume = options.resume ?? false;
  const providerInput = options.provider?.trim() ?? 'kimi';

  const readiness = checkRealBlockRunReadiness(blockPath, { resume });
  const providerSmoke = checkProviderSmokeReadiness(env, providerInput);

  const warnings: string[] = [];
  const reasons: string[] = [];
  const nextCommands: string[] = [];

  if (!providerSmoke.supported) {
    reasons.push(`Provider ${providerSmoke.provider} is not supported for real-provider-smoke`);
  } else if (!providerSmoke.envReady) {
    reasons.push('Provider smoke env is incomplete');
    warnings.push('Set all provider smoke env vars before running real-provider-smoke.');
  } else {
    nextCommands.push(providerSmoke.shouldRunCommand!);
  }

  if (!readiness.ready) {
    reasons.push('Block readiness failed');
    warnings.push('Resolve block readiness issues before running real-block-run-ai.');
  } else {
    nextCommands.push(`npx tsx src/cli.ts real-block-run-ai ${blockPath}`);
  }

  const blockLoad = loadBlockSafely(blockPath);

  let block: BlockDefinition | undefined;
  let tasks: DryRunTaskItem[] = [];
  let totalTasks = 0;

  if (blockLoad.block) {
    block = blockLoad.block;
    totalTasks = block.tasks.length;
    const existingStateResult = loadExistingStateSafely(block);
    const existingState = existingStateResult && 'error' in existingStateResult ? null : (existingStateResult as RealBlockRunState | null);
    if (existingStateResult && 'error' in existingStateResult) {
      warnings.push(`Could not read existing block state: ${existingStateResult.error}`);
    }
    tasks = buildTaskStatuses(block, existingState, resume);
  } else {
    reasons.push(blockLoad.reason ?? 'Block definition could not be loaded');
  }

  if (nextCommands.length === 0) {
    warnings.push('Run readiness and provider smoke before real block execution.');
  }

  const reportCommand = readiness.statePath
    ? `npx tsx src/cli.ts real-block-run-ai-report ${readiness.statePath}`
    : `npx tsx src/cli.ts real-block-run-ai-report runs/block/<block_id>/state.json`;
  nextCommands.push(reportCommand);

  const ok = readiness.ready && providerSmoke.supported && providerSmoke.envReady;

  return {
    ok,
    mode: 'real-block-run-ai-dry-run',
    blockPath,
    resume,
    provider: providerSmoke.provider,
    blockId: block?.block_id ?? readiness.blockId ?? 'unknown',
    blockTitle: block?.title ?? readiness.blockTitle ?? 'unknown',
    repoPath: block?.repo_path ?? readiness.repoPath ?? 'unknown',
    baseBranch: block?.base_branch ?? 'unknown',
    workBranch: block?.work_branch ?? 'unknown',
    readiness,
    providerSmoke,
    totalTasks,
    tasks,
    nextCommands,
    warnings,
    reasons,
  };
}

export function formatRealBlockRunAIDryRunReport(report: RealBlockRunAIDryRunReport): string {
  return redactSecrets(JSON.stringify(report, null, 2));
}
