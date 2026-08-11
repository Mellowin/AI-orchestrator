import type { Check } from '../types.js';

export type BlockTaskStatus =
  | 'pending'
  | 'in_progress'
  | 'coder_done'
  | 'checks_failed'
  | 'committed'
  | 'pushed'
  | 'waiting_review'
  | 'accepted'
  | 'rejected'
  | 'fix_required'
  | 'blocked';

export type BlockStatus =
  | 'pending'
  | 'running'
  | 'waiting_review'
  | 'fixing'
  | 'completed'
  | 'blocked';

export interface BlockProviderRoleConfig {
  provider: string;
  model: string;
  baseUrl?: string;
  userAgent?: string;
}

export interface BlockProviderConfig {
  coder: BlockProviderRoleConfig;
  reviewer: BlockProviderRoleConfig;
  fixer?: BlockProviderRoleConfig;
  planner?: BlockProviderRoleConfig;
  summarizer?: BlockProviderRoleConfig;
}

export interface BlockReviewPolicy {
  require_deterministic_checks: boolean;
  max_fix_attempts: number;
  reviewer_mode: 'single' | 'multi_future';
  task_timeout_ms?: number;
  reviewer_parse_retries?: number;
  on_blocked_task?: 'stop' | 'continue' | 'skip';
}

import type { DependencyEvidencePackage } from '../types.js';

export interface BlockTaskDefinition {
  task_id: string;
  title: string;
  goal: string;
  allowed_files: string[];
  denied_files: string[];
  max_lines_changed?: number;
  checks: (string | Check)[];
  depends_on?: string[];
  acceptance_criteria?: string[];
  dependency_evidence?: DependencyEvidencePackage;
}

export interface BlockDefinition {
  block_id: string;
  title: string;
  repo_path: string;
  base_branch: string;
  work_branch: string;
  providers: BlockProviderConfig;
  review_policy: BlockReviewPolicy;
  tasks: BlockTaskDefinition[];
  /** Optional mission-specific workspace root for execution repos and candidate workspaces. */
  workspace_root?: string;
}

export interface BlockTaskState {
  task_id: string;
  status: BlockTaskStatus;
  current_attempt: number;
  fix_attempts: number;
  commit_sha: string | null;
  pushed_ref: string | null;
  reviewer_decision: 'accepted' | 'rejected' | null;
  reviewer_summary: string | null;
  blocking_issues: string[];
  updated_at: string;
}

export interface BlockState {
  block_id: string;
  title: string;
  status: BlockStatus;
  repo_path: string;
  base_branch: string;
  work_branch: string;
  current_task_id: string | null;
  created_at: string;
  updated_at: string;
  tasks: BlockTaskState[];
  safety_note: string;
  review_policy: BlockReviewPolicy;
}
