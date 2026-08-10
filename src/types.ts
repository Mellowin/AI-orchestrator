import type { PersistedReviewerGate } from './reviewer-task-outcome.js';
import type { ReviewerEvidence } from './reviewer-evidence.js';

export interface Task {
  id: string;
  title: string;
  repo_path: string;
  base_branch: string;
  work_branch: string;
  goal: string;
  context_files: string[];
  checks: Check[];
  guardrails: Guardrails;
  acceptance_criteria?: string[];
  /** Read-only context from accepted ancestor tasks, passed to reviewers and fix coders. */
  dependency_evidence?: DependencyEvidencePackage;
}

export interface Check {
  command: string;
  args: string[];
  cwd?: string;
}

export interface Guardrails {
  allow_modify?: string[];
  deny_modify: string[];
  max_lines_changed?: number;
  require_tests?: boolean;
  auto_commit: boolean;
  auto_push: boolean;
  auto_merge: boolean;
}

export type RunStatus =
  | 'pending'
  | 'coding'
  | 'patching'
  | 'running_checks'
  | 'reviewing'
  | 'approved'
  | 'rejected'
  | 'failed_guardrails'
  | 'failed_max_attempts'
  | 'failed'
  | 'pushed'
  | 'blocked';

export type TaskRunPhase =
  | 'generating'
  | 'checking'
  | 'repairing'
  | 'committed'
  | 'pushed'
  | 'reviewer_pending'
  | 'reviewer_fix_pending'
  | 'fix_pushed'
  | 'second_review_pending'
  | 'accepted'
  | 'blocked'
  | 'failed';

export type ProviderAttemptType =
  | 'initial_coder'
  | 'sandbox_repair'
  | 'reviewer'
  | 'reviewer_fix_coder'
  | 'second_reviewer';

export type KimiOutputClassification =
  | 'EMPTY_FILE_LIST'
  | 'ALL_IDENTICAL'
  | 'EFFECTIVE_CHANGES';

export type RollbackPolicy =
  | 'pre_push_failure'
  | 'post_push_preserve_for_human'
  | 'fix_attempt_rollback'
  | 'rollback_skipped_success';

export interface RollbackRecord {
  attempted: boolean;
  status: 'succeeded' | 'failed' | 'skipped';
  checkpointHead: string;
  finalHead?: string;
  reason?: string;
  policy?: RollbackPolicy;
}

export interface ProviderAttempt {
  attempt: number;
  ok: boolean;
  reason?: string;
  retryable?: boolean;
  recovery_prompt?: boolean;
  raw_text_length?: number;
  type?: ProviderAttemptType;
  classification?: KimiOutputClassification;
}

export interface DependencyEvidenceItem {
  task_id: string;
  task_status: string;
  accepted_commit_sha?: string;
  fix_commit_sha?: string;
  path: string;
  content_sha256: string;
  bytes: number;
  lines: number;
  content: string;
  truncated?: boolean;
}

export interface DependencyEvidencePackage {
  items: DependencyEvidenceItem[];
  total_bytes: number;
  truncated: boolean;
  omitted_count: number;
}

export interface ReviewerPhaseEvidence {
  reviewer_started_at?: string;
  reviewer_result?: {
    status: string;
    source: string;
    nextAction: string;
    blockingIssues: string[];
    nonBlockingIssues: string[];
    reviewSummary: string;
    fixTask?: string;
  };
  fix_task_created?: boolean;
  fix_started_at?: string;
  fix_commit_sha?: string;
  fix_pushed_at?: string;
  second_review_started_at?: string;
  second_review_result?: {
    status: string;
    source: string;
    nextAction: string;
    blockingIssues: string[];
    nonBlockingIssues: string[];
    reviewSummary: string;
    fixTask?: string;
  };
}

export interface RunState {
  task_id: string;
  status: RunStatus;
  task_phase?: TaskRunPhase;
  current_attempt: number;
  branch: string;
  repo_path: string;
  /** Immutable base SHA from which this task's diff is measured. */
  task_base_sha?: string;
  /** Path to the persistent candidate workspace clone used for this task. */
  candidate_path?: string;
  /** Expected set of changed files after the last successful apply/stage. */
  expected_changed_files?: string[];
  /** Commit SHA that was accepted and pushed (same as commit_sha when accepted). */
  accepted_commit_sha?: string;
  /** True if the task was accepted after one or more reviewer fix iterations. */
  fixed_and_accepted?: boolean;
  last_kimi_output?: KimiOutput;
  last_review?: ReviewVerdict;
  last_logs?: string;
  created_at: string;
  updated_at: string;
  pushed_remote?: string;
  pushed_ref?: string;
  commit_sha?: string;
  safety_note?: string;
  rollback?: RollbackRecord;
  blocked_by?: 'safety_policy';
  applied?: boolean;
  committed?: boolean;
  pushed?: boolean;
  safety_policy_reasons?: string[];
  provider_attempts?: ProviderAttempt[];
  // Timeout / continuation budget evidence (all optional for backward compatibility).
  task_started_at?: string;
  phase_started_at?: string;
  continuation_count?: number;
  total_elapsed_ms?: number;
  timeout_ms?: number;
  next_timeout_ms?: number;
  child_pid?: number;
  /** Check summary recorded when a fixed task was finally accepted. */
  fix_check_summary?: ReviewerEvidence['checkSummary'];
  /** Check summary recorded for the final accepted candidate. */
  check_summary?: ReviewerEvidence['checkSummary'];
  reviewer_phase_evidence?: ReviewerPhaseEvidence;
  reviewer_gate?: PersistedReviewerGate;
}

export interface KimiOutput {
  mode: 'file_update';
  files: FileUpdate[];
  notes?: string;
}

export interface FileUpdate {
  path: string;
  content: string;
}

export interface ReviewVerdict {
  verdict: 'approve' | 'needs_changes' | 'reject';
  critical_issues: string[];
  requested_changes: string[];
  summary_for_human: string;
}

export interface TaskExecutorInput {
  task: Task;
  task_base_sha: string;
  candidate_path: string;
  run_id: string;
  attempt?: number;
}

export interface ContextPackage {
  task_summary: string;
  goal: string;
  constraints: string[];
  files: { path: string; content: string }[];
  max_lines_changed?: number;
  dependency_evidence?: DependencyEvidencePackage;
}

export interface ValidationResult {
  ok: boolean;
  reason?: string;
}

export interface RunResult {
  success: boolean;
  logs: string;
  failedStep?: Check;
}

export interface DiffStat {
  files: string[];
  insertions: number;
  deletions: number;
  binaryFiles: string[];
}

export interface PatchManifestEntry {
  path: string;
  existedBefore: boolean;
  backupPath: string;
}
