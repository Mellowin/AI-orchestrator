export type OneTaskLoopMode =
  | 'fake'
  | 'real_kimi_coder_fake_reviewer'
  | 'real_kimi_coder_kimi_reviewer';

export interface OneTaskLoopInput {
  blockId: string;
  mode: OneTaskLoopMode;
  allowBlockRunOne: boolean;
  allowRealProvider: boolean;
  allowRealRepoApply: boolean;
  allowRealRepoCommit: boolean;
  allowRealRepoPush: boolean;
  allowKimiReviewer: boolean;
  reviewerProvider: 'fake' | 'kimi';
  coderProvider: 'fake' | 'kimi';
  blockDefinitionPath: string;
  fakeCoderOptions?: import('../providers/fake/fake-coder-provider.js').FakeCoderOptions;
  fakeReviewerOptions?: import('../providers/fake/fake-reviewer-provider.js').FakeReviewerOptions;
  maxAttempts?: number;
}

export interface OneTaskLoopResult {
  block_id: string;
  task_id: string;
  status_before: string;
  status_after: string;
  coder_called: boolean;
  reviewer_called: boolean;
  files_applied: string[];
  checks_passed: boolean;
  commit_sha: string | null;
  pushed: boolean;
  reviewer_decision: 'accepted' | 'rejected' | null;
  next_action: string;
  safety_findings: string[];
}
