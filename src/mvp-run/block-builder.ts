import { resolve } from 'node:path';
import type { BlockDefinition } from '../block/block-types.js';
import type { MvpRunConfig } from './types.js';

const MAX_LINES_CHANGED = 100;

export function buildMvpRunBlock(config: MvpRunConfig): BlockDefinition {
  const provider = config.provider === 'fake' ? 'fake' : 'kimi';

  return {
    block_id: config.run_id,
    title: `MVP run: ${config.run_id}`,
    repo_path: resolve(config.repo_path).replace(/\\/g, '/'),
    base_branch: config.base_branch,
    work_branch: config.work_branch,
    providers: {
      coder: { provider, model: 'kimi-k2.6' },
      reviewer: { provider, model: 'kimi-k2.6' },
    },
    review_policy: {
      require_deterministic_checks: false,
      max_fix_attempts: 2,
      reviewer_mode: 'single',
      task_timeout_ms: 120000,
      reviewer_parse_retries: 2,
      on_blocked_task: config.on_blocked_task ?? 'stop',
    },
    tasks: config.tasks.map((task) => ({
      task_id: task.id,
      title: task.title,
      goal: task.goal,
      allowed_files: task.allowed_files,
      denied_files: task.denied_files?.length ? task.denied_files : ['.env'],
      max_lines_changed: task.max_lines_changed ?? MAX_LINES_CHANGED,
      checks: task.checks?.length ? task.checks : task.tests ?? [],
    })),
  };
}
