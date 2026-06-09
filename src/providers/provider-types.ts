export type ProviderRole = 'coder' | 'reviewer' | 'fixer' | 'planner' | 'summarizer';

export type ProviderId =
  | 'fake'
  | 'kimi'
  | 'openai'
  | 'claude'
  | 'gemini'
  | 'deepseek'
  | 'qwen'
  | 'mistral';

export interface CoderTaskInput {
  task_id: string;
  title: string;
  goal: string;
  allowed_files: string[];
  denied_files: string[];
  max_lines_changed: number;
  repo_context: string;
  previous_failure?: string;
}

export interface CoderResultFile {
  path: string;
  content: string;
}

export interface CoderResult {
  summary: string;
  files: CoderResultFile[];
  notes?: string;
}

export interface ReviewInput {
  block_id?: string;
  task_id: string;
  task_title: string;
  task_goal: string;
  allowed_files: string[];
  denied_files: string[];
  max_lines_changed: number;
  commit_sha: string;
  changed_files: string[];
  diff: string;
  typecheck_result: string;
  build_result: string;
  test_result: string;
  git_status: string;
  safety_findings: string[];
  previous_failure?: string;
}

export type ReviewerDecisionValue = 'accepted' | 'rejected';
export type ReviewerConfidence = 'low' | 'medium' | 'high';
export type ReviewerNextAction =
  | 'advance_to_next_task'
  | 'send_fix_to_coder'
  | 'block_for_human';

export interface ReviewerDecision {
  decision: ReviewerDecisionValue;
  confidence: ReviewerConfidence;
  blocking_issues: string[];
  non_blocking_issues: string[];
  review_summary: string;
  fix_task: string | null;
  next_action: ReviewerNextAction;
}

export interface CoderProvider {
  readonly id: ProviderId;
  readonly role: Extract<ProviderRole, 'coder'>;
  runTask(input: CoderTaskInput): Promise<CoderResult>;
  runFix(input: CoderTaskInput): Promise<CoderResult>;
}

export interface ReviewerProvider {
  readonly id: ProviderId;
  readonly role: Extract<ProviderRole, 'reviewer'>;
  reviewCommit(input: ReviewInput): Promise<ReviewerDecision>;
}

export interface ProviderConfig {
  provider: ProviderId;
  model: string;
  apiKey?: string;
  baseUrl?: string;
  userAgent?: string;
}

export interface BlockProviderConfig {
  coder: ProviderConfig;
  reviewer: ProviderConfig;
}
