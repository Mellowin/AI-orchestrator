import { classifyRun } from './classifier.js';
import { buildCapabilitySummary, validateDiagnoseCiEnv } from './env-validator.js';
import {
  DiagnoseCiGithubError,
  fetchWorkflowBundle,
  type WorkflowBundle,
} from './github-client.js';
import { parseLog } from './log-parser.js';
import { redactSecrets } from './redaction.js';
import { getDiagnoseCiReportDir, writeDiagnoseCiReports } from './report-writer.js';
import { writeDiagnoseCiFixTask } from './fix-task-writer.js';
import type {
  DiagnoseCiConfig,
  DiagnoseCiOptions,
  DiagnoseCiResult,
  DiagnoseCiVerdict,
} from './types.js';

function logInfo(message: string): void {
  // eslint-disable-next-line no-console
  console.error(redactSecrets(message));
}

function errorReason(err: unknown): string {
  const reason = err instanceof Error ? err.message : String(err);
  return redactSecrets(reason);
}

export async function runDiagnoseCi(
  config: DiagnoseCiConfig,
  options: DiagnoseCiOptions = {}
): Promise<DiagnoseCiResult> {
  const fetchFn = options.fetchFn ?? globalThis.fetch;
  const command = options.command ?? 'npx tsx src/cli.ts diagnose-ci <config>';

  const capabilities = buildCapabilitySummary(config);
  logInfo('[diagnose-ci] Requested capabilities: ' + capabilities.requested.join(', '));
  logInfo('[diagnose-ci] Forbidden capabilities: ' + capabilities.forbidden.join(', '));

  if (config.allow_github_write) {
    return {
      verdict: 'DIAGNOSE_CI_FAILED',
      run_id: null,
      classification: null,
      confidence: null,
      report_paths: null,
      reason: 'allow_github_write must be false for the read-only diagnose-ci command',
    };
  }

  const envCheck = validateDiagnoseCiEnv(config);
  if (!envCheck.ok) {
    return {
      verdict: envCheck.verdict ?? 'DIAGNOSE_CI_FAILED',
      run_id: null,
      classification: null,
      confidence: null,
      report_paths: null,
      reason: envCheck.reason,
    };
  }

  let bundle: WorkflowBundle;
  try {
    bundle = await fetchWorkflowBundle(config, fetchFn);
  } catch (err) {
    if (err instanceof DiagnoseCiGithubError) {
      return {
        verdict: err.verdict,
        run_id: null,
        classification: null,
        confidence: null,
        report_paths: null,
        reason: errorReason(err),
      };
    }
    return {
      verdict: 'DIAGNOSE_CI_FAILED',
      run_id: null,
      classification: null,
      confidence: null,
      report_paths: null,
      reason: errorReason(err),
    };
  }

  const combinedLog = Object.values(bundle.logs).join('\n\n');
  const parseResult = parseLog(combinedLog, config.max_log_excerpt_chars);
  const classificationResult = classifyRun(bundle.run, bundle.jobs, parseResult);

  const reportDir = getDiagnoseCiReportDir(config, bundle.run.id);

  const fixTaskPaths = writeDiagnoseCiFixTask({
    config,
    run: bundle.run,
    jobs: bundle.jobs,
    parseResult,
    classification: classificationResult.classification,
    confidence: classificationResult.confidence,
    reason: classificationResult.reason,
    reportDir,
  });

  const reportPaths = writeDiagnoseCiReports({
    config,
    command,
    capabilities,
    run: bundle.run,
    jobs: bundle.jobs,
    parseResult,
    classification: classificationResult.classification,
    confidence: classificationResult.confidence,
    reason: classificationResult.reason,
    fixTaskMdPath: fixTaskPaths.fix_task_md,
    reportDir,
  });

  const verdict: DiagnoseCiVerdict =
    classificationResult.classification === 'CI_GREEN' ? 'DIAGNOSE_CI_GREEN' : 'DIAGNOSE_CI_RED';

  logInfo(`[diagnose-ci] Verdict: ${verdict}`);
  logInfo(`[diagnose-ci] Classification: ${classificationResult.classification} (${classificationResult.confidence})`);
  logInfo(`[diagnose-ci] Report: ${reportPaths.report_md}`);
  logInfo(`[diagnose-ci] Fix task: ${reportPaths.fix_task_md}`);

  return {
    verdict,
    run_id: bundle.run.id,
    classification: classificationResult.classification,
    confidence: classificationResult.confidence,
    report_paths: reportPaths,
    reason: classificationResult.reason,
  };
}
