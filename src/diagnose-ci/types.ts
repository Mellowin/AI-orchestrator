/**
 * Diagnose CI — types for the read-only CI failure diagnostic command.
 *
 * This module never mutates the target repository. It reads workflow metadata,
 * job logs, and classifies failures into actionable categories.
 */

export type DiagnoseCiMode = 'fake' | 'github';

export type DiagnoseCiFakeScenario = 'green' | 'red';

export interface DiagnoseCiTarget {
  workflow_run_id?: number;
  pr_number?: number;
  commit_sha?: string;
}

export interface DiagnoseCiConfig {
  mode: DiagnoseCiMode;
  /** Human identifier for this diagnostic run (used in filenames). */
  run_id: string;
  /** Repository slug in "owner/repo" form. */
  repo_slug: string;
  target: DiagnoseCiTarget;
  /** Environment variable name that holds the GitHub token. */
  token_env: string;
  /** Base directory for generated reports. */
  report_dir: string;
  /** If true, full raw logs are written alongside excerpts. */
  include_raw_logs: boolean;
  /** Maximum length of the raw log excerpt stored in the parse result. */
  max_log_excerpt_chars: number;
  /** Write operations are forbidden; this flag must remain false. */
  allow_github_write: boolean;
  /** Fake scenario used when mode is "fake". */
  fake_scenario?: DiagnoseCiFakeScenario;
}

export type DiagnoseCiVerdict =
  | 'DIAGNOSE_CI_GREEN'
  | 'DIAGNOSE_CI_RED'
  | 'DIAGNOSE_CI_NEEDS_TOKEN'
  | 'DIAGNOSE_CI_ACCESS_ERROR'
  | 'DIAGNOSE_CI_NOT_FOUND'
  | 'DIAGNOSE_CI_FAILED';

export type DiagnoseCiClassification =
  | 'CI_GREEN'
  | 'TEST_FAILURE'
  | 'SUMMARY_LOCK_STALE'
  | 'TYPECHECK_FAILURE'
  | 'BUILD_FAILURE'
  | 'CI_TIMEOUT'
  | 'WORKFLOW_INFRA_FAILURE'
  | 'ACCESS_FAILURE'
  | 'UNKNOWN_FAILURE';

export type DiagnoseCiConfidence = 'high' | 'medium';

export interface DiagnoseCiFailedTestFile {
  file: string;
  subtest?: string;
  message?: string;
  expected?: string;
  actual?: string;
  stack?: string;
  location?: string;
}

export interface DiagnoseCiSummaryLock {
  staleCommit?: string;
  currentCommit?: string;
  changedFile?: string;
  message?: string;
}

export interface DiagnoseCiChunkRunnerSummary {
  totalTests?: number;
  totalSuites?: number;
  pass?: number;
  fail?: number;
  skipped?: number;
  cancelled?: number;
  rawLine?: string;
}

export interface DiagnoseCiLogParseResult {
  failedTestFiles: DiagnoseCiFailedTestFile[];
  summaryLock: DiagnoseCiSummaryLock | null;
  chunkRunner: DiagnoseCiChunkRunnerSummary | null;
  timeouts: string[];
  typecheckFailures: string[];
  buildFailures: string[];
  rawExcerpt: string;
}

export interface DiagnoseCiWorkflowRun {
  id: number;
  run_number: number;
  name: string;
  event: string;
  branch: string;
  head_sha: string;
  status: string;
  conclusion: string | null;
  html_url?: string;
}

export interface DiagnoseCiJob {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  steps?: DiagnoseCiJobStep[];
}

export interface DiagnoseCiJobStep {
  number?: number;
  name: string;
  status: string;
  conclusion: string | null;
}

export interface DiagnoseCiCapabilitySummary {
  requested: string[];
  forbidden: string[];
}

export interface DiagnoseCiReportPaths {
  report_dir: string;
  report_md: string;
  report_json: string;
  fix_task_md: string;
  fix_task_json: string;
}

export interface DiagnoseCiResult {
  verdict: DiagnoseCiVerdict;
  run_id: number | null;
  classification: DiagnoseCiClassification | null;
  confidence: DiagnoseCiConfidence | null;
  report_paths: DiagnoseCiReportPaths | null;
  reason: string;
}

export interface DiagnoseCiOptions {
  /** Injected fetch implementation for testing. Defaults to global fetch. */
  fetchFn?: typeof globalThis.fetch;
  /** Command string to record in the report. */
  command?: string;
}
