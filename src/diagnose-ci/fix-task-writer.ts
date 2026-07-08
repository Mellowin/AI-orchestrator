import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  DiagnoseCiClassification,
  DiagnoseCiConfig,
  DiagnoseCiConfidence,
  DiagnoseCiJob,
  DiagnoseCiJobStep,
  DiagnoseCiLogParseResult,
  DiagnoseCiReportPaths,
  DiagnoseCiWorkflowRun,
} from './types.js';
import { redactSecrets } from './redaction.js';

export interface DiagnoseCiFixTaskInput {
  config: DiagnoseCiConfig;
  run: DiagnoseCiWorkflowRun;
  jobs: DiagnoseCiJob[];
  parseResult: DiagnoseCiLogParseResult;
  classification: DiagnoseCiClassification;
  confidence: DiagnoseCiConfidence;
  reason: string;
  reportDir: string;
}

function ensureDir(dir: string): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

function findFailedJob(jobs: DiagnoseCiJob[]): DiagnoseCiJob | null {
  return (
    jobs.find(
      (job) =>
        job.conclusion !== null &&
        job.conclusion !== 'success' &&
        job.conclusion !== 'skipped' &&
        job.conclusion !== 'neutral'
    ) ?? null
  );
}

function findFailedStep(steps: DiagnoseCiJobStep[] | undefined): DiagnoseCiJobStep | null {
  if (!steps) return null;
  return (
    steps.find(
      (step) =>
        step.conclusion === 'failure' ||
        step.status === 'failed' ||
        step.conclusion === 'cancelled'
    ) ?? null
  );
}

function rootCauseHypothesis(
  classification: DiagnoseCiClassification,
  parseResult: DiagnoseCiLogParseResult
): string {
  switch (classification) {
    case 'CI_GREEN':
      return 'No root cause needed; the workflow is green.';
    case 'TEST_FAILURE':
      return `One or more tests failed. Primary failure: ${parseResult.failedTestFiles.map((f) => `${f.file}${f.subtest ? ` > ${f.subtest}` : ''}`).join(', ')}.`;
    case 'SUMMARY_LOCK_STALE':
      return 'TESTING_SUMMARY.md is out of sync: the Last verified commit does not match the current commit, or non-summary files were changed after it.';
    case 'TYPECHECK_FAILURE':
      return 'TypeScript type-checking failed. Likely a type error introduced by recent changes.';
    case 'BUILD_FAILURE':
      return 'The build step failed. Likely a syntax, import, or bundling issue introduced by recent changes.';
    case 'CI_TIMEOUT':
      return 'A job or step exceeded its time limit or was cancelled. Likely a hung process, slow dependency, or infinite loop.';
    case 'WORKFLOW_INFRA_FAILURE':
      return 'A workflow or job failed without a clear code-related signal. This may be a transient GitHub Actions infrastructure issue.';
    case 'ACCESS_FAILURE':
      return 'The diagnostic could not access the GitHub API. Token may be missing, expired, or lack required permissions.';
    case 'UNKNOWN_FAILURE':
      return 'The classifier could not determine a specific root cause from the available logs. Manual triage is required.';
    default:
      return 'Manual triage required.';
  }
}

function reproductionCommands(parseResult: DiagnoseCiLogParseResult): string[] {
  const commands: string[] = ['npm install'];

  if (parseResult.failedTestFiles.length > 0) {
    const primaryFile = parseResult.failedTestFiles[0].file;
    commands.push(`npx tsx --test ${primaryFile}`);
  }

  commands.push('npm run typecheck');
  commands.push('npm run build');

  return commands;
}

function verificationCommands(parseResult: DiagnoseCiLogParseResult): string[] {
  const commands: string[] = ['npm run typecheck', 'npm run build'];
  if (parseResult.failedTestFiles.length > 0) {
    const primaryFile = parseResult.failedTestFiles[0].file;
    commands.push(`npx tsx --test ${primaryFile}`);
  }
  return commands;
}

export function writeDiagnoseCiFixTask(input: DiagnoseCiFixTaskInput): Pick<
  DiagnoseCiReportPaths,
  'fix_task_md' | 'fix_task_json'
> {
  ensureDir(input.reportDir);

  const fixTaskMdPath = join(input.reportDir, 'fix-task.md');
  const fixTaskJsonPath = join(input.reportDir, 'fix-task.json');

  const failedJob = findFailedJob(input.jobs);
  const failedStep = findFailedStep(failedJob?.steps);

  const lines: string[] = [];
  lines.push('# CI Fix Task');
  lines.push('');
  lines.push(`- **Workflow run:** ${input.run.id}`);
  lines.push(`- **Repository:** ${input.config.repo_slug}`);
  lines.push(`- **Branch:** ${input.run.branch}`);
  lines.push(`- **Head SHA:** ${input.run.head_sha}`);
  lines.push(`- **Classification:** \`${input.classification}\``);
  lines.push(`- **Confidence:** ${input.confidence}`);
  lines.push('');
  lines.push('## Failed Job / Step');
  lines.push('');
  if (failedJob) {
    lines.push(`- **Job:** ${failedJob.name} (id=${failedJob.id}, conclusion=${failedJob.conclusion})`);
  } else {
    lines.push('- **Job:** none identified');
  }
  if (failedStep) {
    lines.push(`- **Step:** ${failedStep.name} (${failedStep.conclusion ?? failedStep.status})`);
  } else {
    lines.push('- **Step:** none identified');
  }
  lines.push('');

  if (input.parseResult.failedTestFiles.length > 0) {
    lines.push('## Failing Test Files / Subtests');
    lines.push('');
    for (const failure of input.parseResult.failedTestFiles) {
      lines.push(`- \`${failure.file}\`${failure.subtest ? ` — ${failure.subtest}` : ''}`);
      if (failure.location) lines.push(`  - Location: ${failure.location}`);
      if (failure.message) lines.push(`  - Message: ${redactSecrets(failure.message)}`);
      if (failure.expected) lines.push(`  - Expected: ${failure.expected}`);
      if (failure.actual) lines.push(`  - Actual: ${failure.actual}`);
    }
    lines.push('');
  }

  lines.push('## Log Excerpts');
  lines.push('');
  lines.push('```');
  lines.push(redactSecrets(input.parseResult.rawExcerpt));
  lines.push('```');
  lines.push('');

  lines.push('## Root-cause Hypothesis');
  lines.push('');
  lines.push(rootCauseHypothesis(input.classification, input.parseResult));
  lines.push('');

  lines.push('## Hard Rules');
  lines.push('');
  lines.push('- This is a read-only diagnostic command.');
  lines.push('- Do not push, merge, or force-push from this task.');
  lines.push('- Do not write to the target repository contents, PR state, or Actions state.');
  lines.push('- Tokens must be supplied via environment variables only.');
  lines.push('- All changes must pass local verification before being committed by a human.');
  lines.push('');

  lines.push('## Local Reproduction');
  lines.push('');
  lines.push('```bash');
  for (const command of reproductionCommands(input.parseResult)) {
    lines.push(command);
  }
  lines.push('```');
  lines.push('');

  lines.push('## Verification Commands');
  lines.push('');
  lines.push('```bash');
  for (const command of verificationCommands(input.parseResult)) {
    lines.push(command);
  }
  lines.push('```');
  lines.push('');

  lines.push('## Final Report Format');
  lines.push('');
  lines.push('When the fix is complete, update the diagnostic report with:');
  lines.push('- Confirmation that the failing test/build/typecheck now passes locally.');
  lines.push('- The commit SHA that contains the fix.');
  lines.push('- A note confirming no repository writes were performed by the diagnostic tool.');
  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push('Generated by `diagnose-ci`.');

  writeFileSync(fixTaskMdPath, lines.join('\n'), 'utf-8');

  const fixTaskJson = {
    run_id: input.run.id,
    repo_slug: input.config.repo_slug,
    branch: input.run.branch,
    head_sha: input.run.head_sha,
    classification: input.classification,
    confidence: input.confidence,
    reason: input.reason,
    failed_job: failedJob
      ? { id: failedJob.id, name: failedJob.name, conclusion: failedJob.conclusion }
      : null,
    failed_step: failedStep
      ? { name: failedStep.name, conclusion: failedStep.conclusion, status: failedStep.status }
      : null,
    failing_tests: input.parseResult.failedTestFiles,
    log_excerpt: input.parseResult.rawExcerpt,
    root_cause_hypothesis: rootCauseHypothesis(input.classification, input.parseResult),
    hard_rules: [
      'This is a read-only diagnostic command.',
      'Do not push, merge, or force-push from this task.',
      'Do not write to the target repository contents, PR state, or Actions state.',
      'Tokens must be supplied via environment variables only.',
      'All changes must pass local verification before being committed by a human.',
    ],
    reproduction_commands: reproductionCommands(input.parseResult),
    verification_commands: verificationCommands(input.parseResult),
    final_report_format: {
      required_fields: [
        'local_pass_confirmation',
        'fix_commit_sha',
        'no_writes_by_diagnostic_tool',
      ],
    },
  };

  writeFileSync(fixTaskJsonPath, redactSecrets(JSON.stringify(fixTaskJson, null, 2)), 'utf-8');

  return { fix_task_md: fixTaskMdPath, fix_task_json: fixTaskJsonPath };
}
