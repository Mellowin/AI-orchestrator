import { resolve, normalize } from 'node:path';
import { loadBlockDefinition } from './block/block-loader.js';
import type { BlockDefinition } from './block/block-types.js';
import { redactSecrets } from './sandbox-preflight-repair.js';

export interface RealBlockValidateTaskSummary {
  task_id: string;
  title: string;
  allowed_files: string[];
  denied_files: string[];
  checks: string[];
  max_lines_changed: number;
}

export interface RealBlockValidateReport {
  ok: boolean;
  mode: 'real-block-validate';
  blockPath: string;
  blockId?: string;
  title?: string;
  repoPath?: string;
  baseBranch?: string;
  workBranch?: string;
  taskCount?: number;
  tasks?: RealBlockValidateTaskSummary[];
  warnings: string[];
  nextCommands?: string[];
  error?: string;
  reasons?: string[];
}

const STARTER_PLACEHOLDER_GOAL = 'Edit this goal to describe what the task should accomplish.';

function looksLikePlaceholderGoal(goal: string): boolean {
  const trimmed = goal.trim();
  return trimmed === STARTER_PLACEHOLDER_GOAL || trimmed.includes('Edit this goal');
}

function collectWarnings(block: BlockDefinition): string[] {
  const warnings: string[] = [];

  if (!block.work_branch.startsWith('ai-')) {
    warnings.push(`work_branch "${block.work_branch}" does not start with "ai-"`);
  }

  for (const task of block.tasks) {
    if (task.allowed_files.length === 0) {
      warnings.push(`Task "${task.task_id}" has empty allowed_files`);
    }
    if (task.checks.length === 0) {
      warnings.push(`Task "${task.task_id}" has empty checks`);
    }
    if (looksLikePlaceholderGoal(task.goal)) {
      warnings.push(`Task "${task.task_id}" goal still looks like the starter placeholder`);
    }
  }

  return warnings;
}

function buildTaskSummaries(block: BlockDefinition): RealBlockValidateTaskSummary[] {
  return block.tasks.map((task) => ({
    task_id: task.task_id,
    title: task.title,
    allowed_files: task.allowed_files,
    denied_files: task.denied_files,
    checks: task.checks,
    max_lines_changed: task.max_lines_changed,
  }));
}

export function validateRealBlockFile(blockPath: string): RealBlockValidateReport {
  const trimmedPath = blockPath?.trim();
  if (!trimmedPath) {
    const error = 'Block path is required';
    return {
      ok: false,
      mode: 'real-block-validate',
      blockPath: trimmedPath ?? '',
      warnings: [],
      error,
      reasons: [error],
    };
  }

  // Resolve for internal validation, but preserve the user-supplied path in the report.
  const resolvedPath = resolve(normalize(trimmedPath));

  let block: BlockDefinition;
  try {
    block = loadBlockDefinition(resolvedPath);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const redacted = redactSecrets(message);
    return {
      ok: false,
      mode: 'real-block-validate',
      blockPath: trimmedPath,
      warnings: [],
      error: redacted,
      reasons: [redacted],
    };
  }

  const warnings = collectWarnings(block);

  return {
    ok: true,
    mode: 'real-block-validate',
    blockPath: trimmedPath,
    blockId: block.block_id,
    title: block.title,
    repoPath: block.repo_path,
    baseBranch: block.base_branch,
    workBranch: block.work_branch,
    taskCount: block.tasks.length,
    tasks: buildTaskSummaries(block),
    warnings,
    nextCommands: [
      `npx tsx src/cli.ts real-block-run-ai-checklist ${trimmedPath}`,
      `npx tsx src/cli.ts real-block-run-ai-dry-run ${trimmedPath}`,
    ],
  };
}

export function formatRealBlockValidateReport(report: RealBlockValidateReport): string {
  return redactSecrets(JSON.stringify(report, null, 2));
}
