import type {
  DiagnoseCiClassification,
  DiagnoseCiConfidence,
  DiagnoseCiJob,
  DiagnoseCiLogParseResult,
  DiagnoseCiWorkflowRun,
} from './types.js';

export interface DiagnoseCiClassificationResult {
  classification: DiagnoseCiClassification;
  confidence: DiagnoseCiConfidence;
  reason: string;
}

function hasFailedJob(jobs: DiagnoseCiJob[]): boolean {
  return jobs.some(
    (job) =>
      job.conclusion !== null &&
      job.conclusion !== 'success' &&
      job.conclusion !== 'skipped' &&
      job.conclusion !== 'neutral'
  );
}

function stepFailedNamed(jobs: DiagnoseCiJob[], name: string): boolean {
  return jobs.some((job) =>
    job.steps?.some(
      (step) =>
        step.name.trim().toLowerCase() === name.toLowerCase() &&
        (step.conclusion === 'failure' || step.status === 'failed')
    )
  );
}

export function classifyRun(
  run: DiagnoseCiWorkflowRun,
  jobs: DiagnoseCiJob[],
  parseResult: DiagnoseCiLogParseResult
): DiagnoseCiClassificationResult {
  const conclusion = run.conclusion ?? 'unknown';
  const failedJobs = hasFailedJob(jobs);

  if (conclusion === 'success' && !failedJobs) {
    return {
      classification: 'CI_GREEN',
      confidence: 'high',
      reason: 'Workflow completed successfully with no failed jobs',
    };
  }

  if (conclusion === 'failure' && parseResult.failedTestFiles.length > 0) {
    const names = parseResult.failedTestFiles.map((f) => f.file).join(', ');
    return {
      classification: 'TEST_FAILURE',
      confidence: 'high',
      reason: `Workflow failed with failing tests in: ${names}`,
    };
  }

  if (parseResult.summaryLock) {
    return {
      classification: 'SUMMARY_LOCK_STALE',
      confidence: 'high',
      reason: `Stale TESTING_SUMMARY lock detected: ${parseResult.summaryLock.message ?? 'summary verification failed'}`,
    };
  }

  if (parseResult.typecheckFailures.length > 0 || stepFailedNamed(jobs, 'Type check')) {
    return {
      classification: 'TYPECHECK_FAILURE',
      confidence: 'high',
      reason: `Type-check failure detected${parseResult.typecheckFailures.length > 0 ? ' in logs' : ' in workflow steps'}`,
    };
  }

  if (parseResult.buildFailures.length > 0 || stepFailedNamed(jobs, 'Build')) {
    return {
      classification: 'BUILD_FAILURE',
      confidence: 'high',
      reason: `Build failure detected${parseResult.buildFailures.length > 0 ? ' in logs' : ' in workflow steps'}`,
    };
  }

  if (
    parseResult.timeouts.length > 0 ||
    conclusion === 'cancelled' ||
    conclusion === 'timed_out'
  ) {
    return {
      classification: 'CI_TIMEOUT',
      confidence: 'high',
      reason: `Timeout or cancellation detected${parseResult.timeouts.length > 0 ? ' in logs' : ` (conclusion=${conclusion})`}`,
    };
  }

  if (failedJobs) {
    return {
      classification: 'WORKFLOW_INFRA_FAILURE',
      confidence: 'medium',
      reason: 'One or more jobs failed without a recognizable test, build, typecheck, or timeout pattern',
    };
  }

  return {
    classification: 'UNKNOWN_FAILURE',
    confidence: 'medium',
    reason: `Workflow conclusion is ${conclusion} but no recognized failure pattern was found`,
  };
}
