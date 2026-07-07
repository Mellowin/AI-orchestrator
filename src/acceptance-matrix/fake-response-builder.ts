import type {
  AcceptanceScenarioType,
  FakeResponseScenario,
} from './types.js';

export interface FakeResponseArrays {
  /** Coder responses per task. A task entry may be a single response or a sequence for retries. */
  kimi: (string | string[] | undefined)[];
  reviewer: (string | undefined)[];
  fixKimi: (string | undefined)[];
  secondReviewer: (string | undefined)[];
}

function fileUpdate(path: string, content: string): string {
  return JSON.stringify({
    mode: 'file_update',
    files: [{ path, content }],
    notes: `Update ${path}`,
  });
}

function acceptedReview(summary: string): string {
  return JSON.stringify({
    decision: 'accepted',
    confidence: 'high',
    blocking_issues: [],
    non_blocking_issues: [],
    review_summary: summary,
    fix_task: null,
    next_action: 'advance_to_next_task',
  });
}

function rejectedReview(summary: string, fixTask: string): string {
  return JSON.stringify({
    decision: 'rejected',
    confidence: 'medium',
    blocking_issues: [summary],
    non_blocking_issues: [],
    review_summary: summary,
    fix_task: fixTask,
    next_action: 'send_fix_to_coder',
  });
}

function unsafeEnvResponse(): string {
  // Use an allowed file path but unsafe content so the deterministic safety
  // policy blocks the task (guardrails alone would just exit with no state).
  return fileUpdate('README.md', '# Unsafe\n\nconsole.log(process.env.KIMI_API_KEY)\n');
}

export function buildFakeResponseScenario(
  scenarioType: AcceptanceScenarioType
): FakeResponseScenario {
  switch (scenarioType) {
    case 'golden_real_multitask':
      return {
        type: scenarioType,
        responses: [
          { task_id: 'golden_1', kind: 'accept' },
          { task_id: 'golden_2', kind: 'needs_changes' },
        ],
      };
    case 'blocked_stop':
      return {
        type: scenarioType,
        responses: [
          { task_id: 'harmless_1', kind: 'accept' },
          { task_id: 'unsafe_block', kind: 'unsafe_file' },
        ],
      };
    case 'blocked_continue':
      return {
        type: scenarioType,
        responses: [
          { task_id: 'harmless_1', kind: 'accept' },
          { task_id: 'unsafe_block', kind: 'unsafe_file' },
          { task_id: 'harmless_2', kind: 'accept' },
        ],
      };
    default:
      throw new Error(`Unsupported scenario type for fake responses: ${scenarioType}`);
  }
}

export function buildFakeResponseArrays(scenarioType: AcceptanceScenarioType): FakeResponseArrays {
  switch (scenarioType) {
    case 'golden_real_multitask':
      return {
        kimi: [
          fileUpdate('README.md', '# Golden README\n\nFirst task.\n'),
          fileUpdate('feature.txt', 'feature v1\n'),
        ],
        reviewer: [
          acceptedReview('Task golden_1 accepted'),
          rejectedReview('content too brief', 'Expand the feature note'),
        ],
        fixKimi: [undefined, fileUpdate('feature.txt', 'feature v1 - expanded with details\n')],
        secondReviewer: [undefined, acceptedReview('Task golden_2 fix accepted')],
      };
    case 'blocked_stop':
      return {
        kimi: [
          fileUpdate('README.md', '# Harmless README\n\nSafe content.\n'),
          unsafeEnvResponse(),
        ],
        reviewer: [acceptedReview('Task harmless_1 accepted'), undefined],
        fixKimi: [undefined, undefined],
        secondReviewer: [undefined, undefined],
      };
    case 'blocked_continue':
      return {
        kimi: [
          fileUpdate('README.md', '# Harmless README\n\nSafe content.\n'),
          unsafeEnvResponse(),
          fileUpdate('feature.txt', 'feature after unsafe block\n'),
        ],
        reviewer: [acceptedReview('Task harmless_1 accepted'), undefined, acceptedReview('Task harmless_2 accepted')],
        fixKimi: [undefined, undefined, undefined],
        secondReviewer: [undefined, undefined, undefined],
      };
    default:
      throw new Error(`Unsupported scenario type for fake response arrays: ${scenarioType}`);
  }
}
