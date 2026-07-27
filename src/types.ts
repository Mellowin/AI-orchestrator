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
  | 'pushed'
  | 'blocked';

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
}

export interface RunState {
  task_id: string;
  status: RunStatus;
  current_attempt: number;
  branch: string;
  repo_path: string;
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

export interface ContextPackage {
  task_summary: string;
  goal: string;
  constraints: string[];
  files: { path: string; content: string }[];
  max_lines_changed?: number;
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
