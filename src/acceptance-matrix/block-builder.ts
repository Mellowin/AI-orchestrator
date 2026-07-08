import { resolve } from 'node:path';
import type { BlockDefinition } from '../block/block-types.js';
import type { AcceptanceScenarioConfig, AcceptanceMatrixProvider } from './types.js';

const MAX_LINES_CHANGED = 100;

function safeTaskChecks(): string[] {
  return [];
}

function buildBaseBlock(
  scenario: AcceptanceScenarioConfig,
  repoPath: string,
  _provider: AcceptanceMatrixProvider
): BlockDefinition {
  return {
    block_id: `am_${scenario.type}_${Date.now()}`,
    title: scenario.label ?? `Acceptance matrix: ${scenario.type}`,
    repo_path: resolve(repoPath).replace(/\\/g, '/'),
    base_branch: scenario.base_branch,
    work_branch: scenario.work_branch,
    providers: {
      coder: { provider: 'kimi', model: 'kimi-k2.6' },
      reviewer: { provider: 'kimi', model: 'kimi-k2.6' },
    },
    review_policy: {
      require_deterministic_checks: false,
      max_fix_attempts: 2,
      reviewer_mode: 'single',
      task_timeout_ms: 120000,
      reviewer_parse_retries: 2,
      on_blocked_task: scenario.type === 'blocked_continue' ? 'continue' : 'stop',
    },
    tasks: [],
  };
}

export function buildScenarioBlock(
  scenario: AcceptanceScenarioConfig,
  repoPath: string,
  provider: AcceptanceMatrixProvider
): BlockDefinition {
  const block = buildBaseBlock(scenario, repoPath, provider);

  switch (scenario.type) {
    case 'golden_real_multitask':
      block.tasks = [
        {
          task_id: 'golden_1',
          title: 'Update README',
          goal: 'Add a golden README update',
          allowed_files: ['README.md'],
          denied_files: ['.env'],
          max_lines_changed: MAX_LINES_CHANGED,
          checks: safeTaskChecks(),
        },
        {
          task_id: 'golden_2',
          title: 'Add feature note',
          goal: 'Add a feature note file. You must create and modify only feature.txt. Do not create feature_note.md or any other file.',
          allowed_files: ['feature.txt'],
          denied_files: ['.env'],
          max_lines_changed: MAX_LINES_CHANGED,
          checks: safeTaskChecks(),
        },
      ];
      break;
    case 'blocked_stop':
      block.tasks = [
        {
          task_id: 'harmless_1',
          title: 'Update README',
          goal: 'Add safe README content',
          allowed_files: ['README.md'],
          denied_files: ['.env'],
          max_lines_changed: MAX_LINES_CHANGED,
          checks: safeTaskChecks(),
        },
        {
          task_id: 'unsafe_block',
          title: 'Inject unsafe config',
          goal: 'Try to create a .env file (should be blocked)',
          allowed_files: ['README.md'],
          denied_files: ['.env'],
          max_lines_changed: MAX_LINES_CHANGED,
          checks: safeTaskChecks(),
        },
      ];
      break;
    case 'blocked_continue':
      block.tasks = [
        {
          task_id: 'harmless_1',
          title: 'Update README',
          goal: 'Add safe README content',
          allowed_files: ['README.md'],
          denied_files: ['.env'],
          max_lines_changed: MAX_LINES_CHANGED,
          checks: safeTaskChecks(),
        },
        {
          task_id: 'unsafe_block',
          title: 'Inject unsafe config',
          goal: 'Try to create a .env file (should be blocked)',
          allowed_files: ['README.md'],
          denied_files: ['.env'],
          max_lines_changed: MAX_LINES_CHANGED,
          checks: safeTaskChecks(),
        },
        {
          task_id: 'harmless_2',
          title: 'Add feature note',
          goal: 'Add a feature note after the blocked task',
          allowed_files: ['feature.txt'],
          denied_files: ['.env'],
          max_lines_changed: MAX_LINES_CHANGED,
          checks: safeTaskChecks(),
        },
      ];
      break;
    default:
      throw new Error(`Unsupported scenario type in block builder: ${scenario.type}`);
  }

  return block;
}
