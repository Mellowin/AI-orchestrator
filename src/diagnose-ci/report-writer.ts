import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type {
  DiagnoseCiCapabilitySummary,
  DiagnoseCiClassification,
  DiagnoseCiConfig,
  DiagnoseCiConfidence,
  DiagnoseCiJob,
  DiagnoseCiLogParseResult,
  DiagnoseCiReportPaths,
  DiagnoseCiWorkflowRun,
} from './types.js';
import { redactSecrets } from './redaction.js';

export interface DiagnoseCiReportInput {
  config: DiagnoseCiConfig;
  command: string;
  capabilities: DiagnoseCiCapabilitySummary;
  run: DiagnoseCiWorkflowRun;
  jobs: DiagnoseCiJob[];
  parseResult: DiagnoseCiLogParseResult;
  classification: DiagnoseCiClassification;
  confidence: DiagnoseCiConfidence;
  reason: string;
  fixTaskMdPath: string;
  reportDir: string;
}

export function getDiagnoseCiReportDir(config: DiagnoseCiConfig, runId: number): string {
  return resolve(config.report_dir, String(runId));
}

function ensureDir(dir: string): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

function recommendedAction(classification: DiagnoseCiClassification): string {
  switch (classification) {
    case 'CI_GREEN':
      return 'No action required; the workflow completed successfully.';
    case 'TEST_FAILURE':
      return 'Run the failing tests locally, fix the underlying code, and re-run the workflow.';
    case 'SUMMARY_LOCK_STALE':
      return 'Update TESTING_SUMMARY.md so that Last verified commit matches the latest commit and only summary files changed after it.';
    case 'TYPECHECK_FAILURE':
      return 'Run `npm run typecheck`, fix all type errors, and re-run the workflow.';
    case 'BUILD_FAILURE':
      return 'Run `npm run build`, fix all build errors, and re-run the workflow.';
    case 'CI_TIMEOUT':
      return 'Investigate slow or hanging steps; consider splitting jobs, increasing timeouts, or caching dependencies.';
    case 'WORKFLOW_INFRA_FAILURE':
      return 'Check GitHub Actions service status and re-run the workflow; no code change is indicated.';
    case 'ACCESS_FAILURE':
      return 'Verify the GitHub token permissions and repository access, then retry.';
    case 'UNKNOWN_FAILURE':
      return 'Inspect the full logs and triage manually; the classifier could not determine a specific cause.';
    default:
      return 'Review the diagnostic report and triage manually.';
  }
}

function renderFailedJobs(jobs: DiagnoseCiJob[]): string {
  const failed = jobs.filter(
    (job) =>
      job.conclusion !== null &&
      job.conclusion !== 'success' &&
      job.conclusion !== 'skipped' &&
      job.conclusion !== 'neutral'
  );

  if (failed.length === 0) {
    return 'None';
  }

  const lines: string[] = [];
  for (const job of failed) {
    lines.push(`- **${job.name}** (id=${job.id}, conclusion=${job.conclusion})`);
    const failedSteps =
      job.steps?.filter(
        (step) =>
          step.conclusion === 'failure' ||
          step.status === 'failed' ||
          step.conclusion === 'cancelled'
      ) ?? [];
    for (const step of failedSteps) {
      lines.push(`  - step ${step.number ?? '?'}: \`${step.name}\` (${step.conclusion ?? step.status})`);
    }
  }
  return lines.join('\n');
}

export function writeDiagnoseCiReports(input: DiagnoseCiReportInput): DiagnoseCiReportPaths {
  ensureDir(input.reportDir);

  const reportMdPath = join(input.reportDir, 'report.md');
  const reportJsonPath = join(input.reportDir, 'report.json');
  const fixTaskMdPath = input.fixTaskMdPath;

  const lines: string[] = [];
  lines.push('# CI Diagnostic Report');
  lines.push('');
  lines.push(`- **Command:** \`${input.command}\``);
  lines.push(`- **Repository:** \`${input.config.repo_slug}\``);
  lines.push(`- **Mode:** \`${input.config.mode}\``);
  lines.push(`- **Target:** \`${JSON.stringify(input.config.target)}\``);
  lines.push('');
  lines.push('## Capabilities');
  lines.push('');
  lines.push('Requested:');
  for (const cap of input.capabilities.requested) {
    lines.push(`- ${cap}`);
  }
  lines.push('');
  lines.push('Forbidden:');
  for (const cap of input.capabilities.forbidden) {
    lines.push(`- ${cap}`);
  }
  lines.push('');
  lines.push('## Resolved Workflow Run');
  lines.push('');
  lines.push(`- **Run ID:** ${input.run.id}`);
  lines.push(`- **Run number:** ${input.run.run_number}`);
  lines.push(`- **Name:** ${input.run.name}`);
  lines.push(`- **Event:** ${input.run.event}`);
  lines.push(`- **Branch:** ${input.run.branch}`);
  lines.push(`- **Head SHA:** ${input.run.head_sha}`);
  lines.push(`- **Status:** ${input.run.status}`);
  lines.push(`- **Conclusion:** ${input.run.conclusion ?? 'unknown'}`);
  if (input.run.html_url) {
    lines.push(`- **URL:** ${input.run.html_url}`);
  }
  lines.push('');
  lines.push('## Failed Jobs and Steps');
  lines.push('');
  lines.push(renderFailedJobs(input.jobs));
  lines.push('');
  lines.push('## Extracted Failures');
  lines.push('');

  if (input.parseResult.failedTestFiles.length > 0) {
    lines.push('### Failing Tests');
    for (const failure of input.parseResult.failedTestFiles) {
      lines.push(`- **File:** \`${failure.file}\``);
      if (failure.subtest) lines.push(`  - Subtest: ${failure.subtest}`);
      if (failure.location) lines.push(`  - Location: ${failure.location}`);
      if (failure.message) lines.push(`  - Message: ${redactSecrets(failure.message)}`);
      if (failure.expected) lines.push(`  - Expected: ${failure.expected}`);
      if (failure.actual) lines.push(`  - Actual: ${failure.actual}`);
    }
    lines.push('');
  }

  if (input.parseResult.summaryLock) {
    lines.push('### TESTING_SUMMARY Lock');
    const lock = input.parseResult.summaryLock;
    if (lock.staleCommit) lines.push(`- Stale commit: \`${lock.staleCommit}\``);
    if (lock.currentCommit) lines.push(`- Current commit: \`${lock.currentCommit}\``);
    if (lock.changedFile) lines.push(`- Changed file: \`${lock.changedFile}\``);
    if (lock.message) lines.push(`- Message: ${redactSecrets(lock.message)}`);
    lines.push('');
  }

  if (input.parseResult.chunkRunner) {
    lines.push('### Chunk Runner Summary');
    const summary = input.parseResult.chunkRunner;
    lines.push(`- Tests: ${summary.totalTests ?? '?'}`);
    lines.push(`- Suites: ${summary.totalSuites ?? '?'}`);
    lines.push(`- Pass: ${summary.pass ?? '?'}`);
    lines.push(`- Fail: ${summary.fail ?? '?'}`);
    lines.push(`- Cancelled: ${summary.cancelled ?? '?'}`);
    lines.push(`- Skipped: ${summary.skipped ?? '?'}`);
    if (summary.rawLine) lines.push(`- Raw: \`${summary.rawLine}\``);
    lines.push('');
  }

  if (input.parseResult.timeouts.length > 0) {
    lines.push('### Timeouts');
    for (const timeout of input.parseResult.timeouts) {
      lines.push(`- ${redactSecrets(timeout)}`);
    }
    lines.push('');
  }

  if (input.parseResult.typecheckFailures.length > 0) {
    lines.push('### Type-check Failures');
    for (const failure of input.parseResult.typecheckFailures) {
      lines.push(`- ${redactSecrets(failure)}`);
    }
    lines.push('');
  }

  if (input.parseResult.buildFailures.length > 0) {
    lines.push('### Build Failures');
    for (const failure of input.parseResult.buildFailures) {
      lines.push(`- ${redactSecrets(failure)}`);
    }
    lines.push('');
  }

  lines.push('## Classification');
  lines.push('');
  lines.push(`- **Classification:** \`${input.classification}\``);
  lines.push(`- **Confidence:** ${input.confidence}`);
  lines.push(`- **Reason:** ${redactSecrets(input.reason)}`);
  lines.push('');
  lines.push('## Recommended Next Action');
  lines.push('');
  lines.push(recommendedAction(input.classification));
  lines.push('');
  lines.push('## Generated Fix Task');
  lines.push('');
  lines.push(`- ${fixTaskMdPath}`);
  lines.push('');
  lines.push('## Log Excerpt');
  lines.push('');
  lines.push('```');
  lines.push(redactSecrets(input.parseResult.rawExcerpt));
  lines.push('```');
  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push('This report was generated by the read-only `diagnose-ci` command.');
  lines.push('No token values are included in this report.');

  writeFileSync(reportMdPath, lines.join('\n'), 'utf-8');

  const reportJson = {
    command: input.command,
    repo_slug: input.config.repo_slug,
    mode: input.config.mode,
    target: input.config.target,
    capabilities: input.capabilities,
    run: input.run,
    failed_jobs: input.jobs.filter(
      (job) =>
        job.conclusion !== null &&
        job.conclusion !== 'success' &&
        job.conclusion !== 'skipped' &&
        job.conclusion !== 'neutral'
    ),
    parse_result: {
      failed_test_files: input.parseResult.failedTestFiles,
      summary_lock: input.parseResult.summaryLock,
      chunk_runner: input.parseResult.chunkRunner,
      timeouts: input.parseResult.timeouts,
      typecheck_failures: input.parseResult.typecheckFailures,
      build_failures: input.parseResult.buildFailures,
      raw_excerpt: input.parseResult.rawExcerpt,
    },
    classification: input.classification,
    confidence: input.confidence,
    reason: input.reason,
    recommended_action: recommendedAction(input.classification),
    fix_task_md: fixTaskMdPath,
    include_raw_logs: input.config.include_raw_logs,
  };

  if (input.config.include_raw_logs) {
    // Raw logs are stored in a separate field only when explicitly requested.
    (reportJson as Record<string, unknown>).raw_logs = input.parseResult.rawExcerpt;
  }

  writeFileSync(reportJsonPath, redactSecrets(JSON.stringify(reportJson, null, 2)), 'utf-8');

  return {
    report_dir: input.reportDir,
    report_md: reportMdPath,
    report_json: reportJsonPath,
    fix_task_md: fixTaskMdPath,
    fix_task_json: join(input.reportDir, 'fix-task.json'),
  };
}
