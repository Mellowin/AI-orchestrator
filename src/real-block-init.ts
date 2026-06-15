import { existsSync, statSync, writeFileSync } from 'node:fs';
import { dirname, resolve, normalize } from 'node:path';
import { loadBlockDefinition } from './block/block-loader.js';
import { redactSecrets } from './sandbox-preflight-repair.js';

export interface RealBlockInitOptions {
  blockId?: string;
  title?: string;
  repoPath?: string;
  baseBranch?: string;
  workBranch?: string;
  taskId?: string;
  taskTitle?: string;
  force?: boolean;
}

export interface RealBlockInitReport {
  ok: boolean;
  mode: 'real-block-init';
  outputPath: string;
  blockId: string;
  taskCount: number;
  nextCommands: string[];
  error?: string;
}

const SAFE_ID_PATTERN = /^[A-Za-z0-9_-]+$/;
const MAX_ID_LENGTH = 100;

function isSafeId(value: string): boolean {
  return value.length > 0 && value.length <= MAX_ID_LENGTH && SAFE_ID_PATTERN.test(value);
}

function getFlagValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index >= 0 && args[index + 1]) {
    return args[index + 1];
  }
  return undefined;
}

function validateOutputPath(outputPath: string, force?: boolean): { ok: true; resolvedPath: string } | { ok: false; error: string } {
  const trimmed = outputPath.trim();
  if (!trimmed) {
    return { ok: false, error: 'Output path is required' };
  }
  if (!trimmed.toLowerCase().endsWith('.json')) {
    return { ok: false, error: 'Output path must end with .json' };
  }

  const resolvedPath = resolve(normalize(trimmed));
  const parentDir = dirname(resolvedPath);

  if (!existsSync(parentDir)) {
    return { ok: false, error: `Parent directory does not exist: ${parentDir}` };
  }

  if (existsSync(resolvedPath)) {
    const stats = statSync(resolvedPath);
    if (stats.isDirectory()) {
      return { ok: false, error: `Output path is a directory: ${resolvedPath}` };
    }
    if (!force) {
      return { ok: false, error: `Output file already exists: ${resolvedPath}. Use --force to overwrite.` };
    }
  }

  return { ok: true, resolvedPath };
}

function buildBlockDefinition(options: Required<RealBlockInitOptions>): Record<string, unknown> {
  return {
    block_id: options.blockId,
    title: options.title,
    repo_path: options.repoPath,
    base_branch: options.baseBranch,
    work_branch: options.workBranch,
    providers: {
      coder: { provider: 'kimi', model: 'kimi-k2.6' },
      reviewer: { provider: 'kimi', model: 'kimi-k2.6' },
    },
    review_policy: {
      require_deterministic_checks: true,
      max_fix_attempts: 1,
      reviewer_mode: 'single',
    },
    tasks: [
      {
        task_id: options.taskId,
        title: options.taskTitle,
        goal: 'Edit this goal to describe what the task should accomplish.',
        allowed_files: ['README.md'],
        denied_files: [],
        max_lines_changed: 100,
        checks: ['npm run typecheck'],
      },
    ],
  };
}

export function createRealBlockInitFile(
  outputPath: string,
  options: RealBlockInitOptions = {}
): RealBlockInitReport {
  const pathValidation = validateOutputPath(outputPath, options.force);
  if (!pathValidation.ok) {
    return {
      ok: false,
      mode: 'real-block-init',
      outputPath: resolve(normalize(outputPath.trim() || outputPath)),
      blockId: options.blockId ?? 'unknown',
      taskCount: 0,
      nextCommands: [],
      error: pathValidation.error,
    };
  }

  const resolvedPath = pathValidation.resolvedPath;

  const blockId = options.blockId?.trim() || 'my_block';
  const title = options.title?.trim() || 'My AI block';
  const repoPath = options.repoPath?.trim() || '.';
  const baseBranch = options.baseBranch?.trim() || 'main';
  const workBranch = options.workBranch?.trim() || 'ai-my-block';
  const taskId = options.taskId?.trim() || 'task_1';
  const taskTitle = options.taskTitle?.trim() || 'First task';

  if (!isSafeId(blockId)) {
    return {
      ok: false,
      mode: 'real-block-init',
      outputPath: resolvedPath,
      blockId,
      taskCount: 0,
      nextCommands: [],
      error: `block_id contains unsupported characters or length: ${blockId}`,
    };
  }

  if (!isSafeId(taskId)) {
    return {
      ok: false,
      mode: 'real-block-init',
      outputPath: resolvedPath,
      blockId,
      taskCount: 0,
      nextCommands: [],
      error: `task_id contains unsupported characters or length: ${taskId}`,
    };
  }

  if (workBranch === 'main') {
    return {
      ok: false,
      mode: 'real-block-init',
      outputPath: resolvedPath,
      blockId,
      taskCount: 0,
      nextCommands: [],
      error: 'work_branch must not be "main"',
    };
  }

  if (workBranch === baseBranch) {
    return {
      ok: false,
      mode: 'real-block-init',
      outputPath: resolvedPath,
      blockId,
      taskCount: 0,
      nextCommands: [],
      error: 'work_branch must not equal base_branch',
    };
  }

  const block = buildBlockDefinition({
    blockId,
    title,
    repoPath,
    baseBranch,
    workBranch,
    taskId,
    taskTitle,
    force: options.force ?? false,
  });

  try {
    writeFileSync(resolvedPath, JSON.stringify(block, null, 2), 'utf-8');
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to write block file';
    return {
      ok: false,
      mode: 'real-block-init',
      outputPath: resolvedPath,
      blockId,
      taskCount: 0,
      nextCommands: [],
      error: message,
    };
  }

  try {
    loadBlockDefinition(resolvedPath);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Generated block failed validation';
    return {
      ok: false,
      mode: 'real-block-init',
      outputPath: resolvedPath,
      blockId,
      taskCount: 0,
      nextCommands: [],
      error: message,
    };
  }

  return {
    ok: true,
    mode: 'real-block-init',
    outputPath: resolvedPath,
    blockId,
    taskCount: 1,
    nextCommands: [
      `npx tsx src/cli.ts real-block-run-ai-checklist ${resolvedPath}`,
      `npx tsx src/cli.ts real-block-run-ai-dry-run ${resolvedPath}`,
    ],
  };
}

export function formatRealBlockInitReport(report: RealBlockInitReport): string {
  return redactSecrets(JSON.stringify(report, null, 2));
}

export { getFlagValue };
