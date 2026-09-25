import type {
  DiagnoseCiClassification,
  DiagnoseCiConfidence,
  DiagnoseCiJob,
  DiagnoseCiJobEvidence,
  DiagnoseCiLogParseResult,
  DiagnoseCiWorkflowRun,
} from './types.js';

export interface DiagnoseCiClassificationResult {
  classification: DiagnoseCiClassification;
  confidence: DiagnoseCiConfidence;
  reason: string;
}

function isFailedJob(job: DiagnoseCiJob): boolean {
  return (
    job.conclusion !== null &&
    job.conclusion !== 'success' &&
    job.conclusion !== 'skipped' &&
    job.conclusion !== 'neutral'
  );
}

function hasFailedJob(jobs: DiagnoseCiJob[]): boolean {
  return jobs.some(isFailedJob);
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

function emptyParse(): DiagnoseCiLogParseResult {
  return {
    failedTestFiles: [],
    summaryLock: null,
    chunkRunner: null,
    timeouts: [],
    typecheckFailures: [],
    buildFailures: [],
    missingNpmScripts: [],
    rawExcerpt: '',
  };
}

function combineParses(parts: DiagnoseCiLogParseResult[]): DiagnoseCiLogParseResult {
  const combined = emptyParse();
  const seenScripts = new Set<string>();
  for (const part of parts) {
    combined.failedTestFiles.push(...part.failedTestFiles);
    combined.summaryLock = combined.summaryLock ?? part.summaryLock;
    combined.chunkRunner = combined.chunkRunner ?? part.chunkRunner;
    combined.timeouts.push(...part.timeouts);
    combined.typecheckFailures.push(...part.typecheckFailures);
    combined.buildFailures.push(...part.buildFailures);
    for (const script of part.missingNpmScripts) {
      if (!seenScripts.has(script)) {
        seenScripts.add(script);
        combined.missingNpmScripts.push(script);
      }
    }
    if (part.rawExcerpt.length > 0 && combined.rawExcerpt.length === 0) {
      combined.rawExcerpt = part.rawExcerpt;
    }
  }
  return combined;
}

/**
 * Failed-job-first classification.
 *
 * When per-job evidence is available, classification is driven ONLY by logs of
 * actually failed jobs. Logs from successful jobs (which may contain benign
 * timeout-like text from tests) must not determine the workflow failure
 * classification when failed jobs carry actionable errors.
 */
export function classifyRun(
  run: DiagnoseCiWorkflowRun,
  jobs: DiagnoseCiJob[],
  parseResult: DiagnoseCiLogParseResult,
  jobEvidence?: DiagnoseCiJobEvidence[]
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

  // Restrict log-derived signals to failed jobs when per-job evidence exists.
  let effectiveParse = parseResult;
  let failedJobNames: string[] = [];
  if (jobEvidence) {
    const failedEvidence = jobEvidence.filter((e) =>
      e.job_conclusion !== null &&
      e.job_conclusion !== 'success' &&
      e.job_conclusion !== 'skipped' &&
      e.job_conclusion !== 'neutral'
    );
    failedJobNames = failedEvidence.map((e) => e.job_name);
    if (failedEvidence.length > 0) {
      effectiveParse = combineParses(failedEvidence.map((e) => e.parseResult));
      // If failed jobs produced no parseable log evidence at all, fall back to
      // the combined parse so degenerate cases still classify something.
      const hasAnySignal =
        effectiveParse.failedTestFiles.length > 0 ||
        effectiveParse.summaryLock !== null ||
        effectiveParse.typecheckFailures.length > 0 ||
        effectiveParse.buildFailures.length > 0 ||
        effectiveParse.missingNpmScripts.length > 0 ||
        effectiveParse.timeouts.length > 0;
      if (!hasAnySignal && parseResult.rawExcerpt.length > 0) {
        effectiveParse = { ...parseResult, timeouts: [], typecheckFailures: [], buildFailures: [] };
      }
    }
  }

  // Missing npm scripts referenced by workflow commands: precise, actionable,
  // and strictly tied to failed jobs.
  if (effectiveParse.missingNpmScripts.length > 0) {
    const scripts = effectiveParse.missingNpmScripts.map((s) => `"${s}"`).join(', ');
    const where = failedJobNames.length > 0 ? ` in failed job(s): ${failedJobNames.join(', ')}` : '';
    return {
      classification: 'MISSING_NPM_SCRIPT',
      confidence: 'high',
      reason: `CI workflow references npm scripts that do not exist${where}: ${scripts}`,
    };
  }

  if (conclusion === 'failure' && effectiveParse.failedTestFiles.length > 0) {
    const names = effectiveParse.failedTestFiles.map((f) => f.file).join(', ');
    return {
      classification: 'TEST_FAILURE',
      confidence: 'high',
      reason: `Workflow failed with failing tests in: ${names}`,
    };
  }

  if (effectiveParse.summaryLock) {
    return {
      classification: 'SUMMARY_LOCK_STALE',
      confidence: 'high',
      reason: `Stale TESTING_SUMMARY lock detected: ${effectiveParse.summaryLock.message ?? 'summary verification failed'}`,
    };
  }

  if (effectiveParse.typecheckFailures.length > 0 || stepFailedNamed(jobs, 'Type check')) {
    return {
      classification: 'TYPECHECK_FAILURE',
      confidence: 'high',
      reason: `Type-check failure detected${effectiveParse.typecheckFailures.length > 0 ? ' in logs' : ' in workflow steps'}`,
    };
  }

  if (effectiveParse.buildFailures.length > 0 || stepFailedNamed(jobs, 'Build')) {
    return {
      classification: 'BUILD_FAILURE',
      confidence: 'high',
      reason: `Build failure detected${effectiveParse.buildFailures.length > 0 ? ' in logs' : ' in workflow steps'}`,
    };
  }

  if (
    effectiveParse.timeouts.length > 0 ||
    conclusion === 'cancelled' ||
    conclusion === 'timed_out'
  ) {
    return {
      classification: 'CI_TIMEOUT',
      confidence: 'high',
      reason: `Timeout or cancellation detected${effectiveParse.timeouts.length > 0 ? ' in logs' : ` (conclusion=${conclusion})`}`,
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
