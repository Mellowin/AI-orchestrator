import type { OneTaskLoopResult } from './block-runner-types.js';

export type MultiTaskLoopMode =
  | 'fake'
  | 'real_kimi_coder_fake_reviewer'
  | 'real_kimi_coder_kimi_reviewer';

export interface MultiTaskLoopInput {
  blockDefinitionPath: string;
  blockId?: string;
  maxTasksPerRun: number;
  maxTotalAttemptsPerRun: number;
  stopOnRejected: boolean;
  stopOnBlocked: boolean;
  mode: MultiTaskLoopMode;
  allowBlockRunOne: boolean;
  allowRealProvider: boolean;
  allowRealRepoApply: boolean;
  allowRealRepoCommit: boolean;
  allowRealRepoPush: boolean;
  allowKimiReviewer: boolean;
  coderProvider: 'fake' | 'kimi';
  reviewerProvider: 'fake' | 'kimi';
  fakeCoderOptions?: import('../providers/fake/fake-coder-provider.js').FakeCoderOptions;
  fakeReviewerOptions?: import('../providers/fake/fake-reviewer-provider.js').FakeReviewerOptions;
}

export interface MultiTaskLoopResult {
  block_id: string;
  mode: MultiTaskLoopMode;
  started_at: string;
  finished_at: string;
  tasks_attempted: number;
  tasks_accepted: number;
  tasks_fix_required: number;
  tasks_blocked: number;
  final_block_status: string;
  current_task_id: string | null;
  results: OneTaskLoopResult[];
  safety_findings: string[];
}
