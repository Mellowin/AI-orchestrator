import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createAIClient } from '../ai-client-factory.js';
import { loadMvpRunConfig, runMvpRun } from '../mvp-run/index.js';
import type { MvpRunConfig, MvpRunResult } from '../mvp-run/types.js';
import { runDiagnoseCi } from '../diagnose-ci/index.js';
import type { DiagnoseCiConfig, DiagnoseCiOptions, DiagnoseCiResult } from '../diagnose-ci/types.js';
import { redactSecrets } from '../diagnose-ci/redaction.js';
import { AutopilotGithubError } from './github-client.js';
import { resolveAutopilotWorkflowRunId, pollAutopilotWorkflowRun } from './github-client.js';
import { runRepairAttempt } from './repair-runner.js';
import { validateAutopilotEnv, buildCapabilitySummary } from './env-validator.js';
import { writeAutopilotReports, getAutopilotReportDir } from './report-writer.js';
import { addTimelineEvent, createTimeline, writeTimeline } from './timeline-writer.js';
import { isMvpSuccess } from './config-loader.js';
import type {
  AutopilotCapabilitySummary,
  AutopilotRunConfig,
  AutopilotRunOptions,
  AutopilotRunResult,
  AutopilotRunTimelineEvent,
  AutopilotRunVerdict,
} from './types.js';

export interface RunAutopilotRunInternalOptions extends AutopilotRunOptions {
  runMvpRunFn?: typeof runMvpRun;
  runDiagnoseCiFn?: typeof runDiagnoseCi;
  createAIClientFn?: typeof createAIClient;
  spawnFn?: typeof spawnSync;
  /** When true, the autopilot run executes the MVP loop but does not create a GitHub PR. */
  skipPrCreation?: boolean;
}

function nowIso(): string {
  return new Date().toISOString();
}

function getHeadSha(repoPath: string, branch: string, spawnFn: typeof spawnSync): string {
  const result = spawnFn('git', ['rev-parse', branch], {
    cwd: repoPath,
    encoding: 'utf-8',
    shell: false,
  });
  if (result.status !== 0) {
    throw new Error(`git rev-parse ${branch} failed: ${result.stderr}`);
  }
  return result.stdout.trim();
}

function mapGithubError(err: unknown): AutopilotRunVerdict {
  if (err instanceof AutopilotGithubError) {
    return err.verdict;
  }
  return 'AUTOPILOT_FAILED';
}

function buildMvpConfig(autopilotConfig: AutopilotRunConfig): MvpRunConfig {
  const mvpConfig = loadMvpRunConfig(autopilotConfig.mvp_config_path);
  mvpConfig.repo_slug = autopilotConfig.repo_slug;
  mvpConfig.base_branch = autopilotConfig.base_branch;
  mvpConfig.work_branch = autopilotConfig.work_branch;
  mvpConfig.run_id = autopilotConfig.run_id;
  mvpConfig.report_dir = join(getAutopilotReportDir(autopilotConfig.report_dir, autopilotConfig.run_id), 'mvp-run');
  return mvpConfig;
}

function buildDiagnoseConfig(config: AutopilotRunConfig, runId: number, reportDir: string): DiagnoseCiConfig {
  return {
    mode: config.mode as 'fake' | 'github',
    run_id: config.run_id,
    repo_slug: config.repo_slug,
    target: { workflow_run_id: runId },
    token_env: config.diagnose_config.token_env,
    report_dir: join(reportDir, 'diagnose-ci'),
    include_raw_logs: config.diagnose_config.include_raw_logs,
    max_log_excerpt_chars: config.diagnose_config.max_log_excerpt_chars,
    allow_github_write: false,
  };
}

function writeLatestDiagnosisAndFixTask(reportDir: string, diagnosis: DiagnoseCiResult): void {
  if (!existsSync(reportDir)) {
    mkdirSync(reportDir, { recursive: true });
  }

  if (diagnosis.report_paths) {
    copyFileSync(diagnosis.report_paths.fix_task_md, join(reportDir, 'latest-fix-task.md'));
    copyFileSync(diagnosis.report_paths.fix_task_json, join(reportDir, 'latest-diagnosis.json'));
    return;
  }

  const fallback = {
    verdict: diagnosis.verdict,
    run_id: diagnosis.run_id,
    classification: diagnosis.classification,
    confidence: diagnosis.confidence,
    reason: diagnosis.reason,
  };
  writeFileSync(join(reportDir, 'latest-diagnosis.json'), JSON.stringify(fallback, null, 2), 'utf-8');
  writeFileSync(
    join(reportDir, 'latest-fix-task.md'),
    `# CI Fix Task (degraded)\n\n${diagnosis.reason}\n`,
    'utf-8'
  );
}

function readFixTaskMarkdown(reportDir: string): string | undefined {
  const path = join(reportDir, 'latest-fix-task.md');
  if (!existsSync(path)) {
    return undefined;
  }
  return readFileSync(path, 'utf-8');
}

function extractFailingFile(reportDir: string): string | undefined {
  const path = join(reportDir, 'latest-diagnosis.json');
  if (!existsSync(path)) {
    return undefined;
  }
  try {
    const raw = readFileSync(path, 'utf-8');
    const json = JSON.parse(raw) as Record<string, unknown>;
    const files = json.failing_tests as Array<{ file?: string }> | undefined;
    if (Array.isArray(files) && files.length > 0 && typeof files[0].file === 'string') {
      return files[0].file;
    }
  } catch {
    // ignore parse errors
  }
  return undefined;
}

function computeExitCode(verdict: AutopilotRunVerdict): number {
  switch (verdict) {
    case 'AUTOPILOT_GREEN':
    case 'AUTOPILOT_MVP_DONE_CI_NOT_OBSERVED':
    case 'AUTOPILOT_CI_RED_DIAGNOSED':
      return 0;
    default:
      return 1;
  }
}

function printPreflight(
  config: AutopilotRunConfig,
  capabilities: AutopilotCapabilitySummary,
  envCheck: ReturnType<typeof validateAutopilotEnv>
): void {
  console.error('[autopilot-run] AUTOPILOT RUN');
  console.error(`  Run id: ${config.run_id}`);
  console.error(`  Repo: ${config.repo_slug}`);
  console.error(`  Mode: ${config.mode}`);
  console.error(`  Base branch: ${config.base_branch}`);
  console.error(`  Work branch: ${config.work_branch}`);
  console.error(`  MVP config: ${config.mvp_config_path}`);
  console.error(`  Report dir: ${config.report_dir}`);
  console.error('  Requested capabilities:');
  for (const cap of capabilities.requested) {
    console.error(`    - ${cap}`);
  }
  console.error('  Allowed write capabilities:');
  if (capabilities.allowed_write.length === 0) {
    console.error('    - none');
  } else {
    for (const cap of capabilities.allowed_write) {
      console.error(`    - ${cap}`);
    }
  }
  console.error('  Forbidden capabilities:');
  for (const cap of capabilities.forbidden) {
    console.error(`    - ${cap}`);
  }
  console.error(`  Token present: ${envCheck.token_present ? 'yes' : 'no'}`);
  console.error(`  Provider present: ${envCheck.provider_present ? 'yes' : 'no'}`);
  console.error(`  CI enabled: ${config.ci.enabled ? 'yes' : 'no'}`);
  console.error(`  Repair enabled: ${config.repair.enabled ? 'yes' : 'no'}`);
  console.error(`  Max repair attempts: ${config.repair.max_attempts}`);
}

function printSummary(result: AutopilotRunResult): void {
  console.error('[autopilot-run] ---');
  console.error(`[autopilot-run] MVP: ${result.mvp_result?.verdict ?? 'n/a'}`);
  console.error(`[autopilot-run] PR: ${result.mvp_result?.pr?.created ? (result.mvp_result.pr.url ?? `#${result.mvp_result.pr.number}`) : 'none'}`);
  console.error(`[autopilot-run] CI: ${result.ci_run_id !== undefined ? `${result.ci_run_id} (${result.ci_conclusion ?? 'unknown'})` : 'not observed'}`);
  console.error(`[autopilot-run] Diagnosis: ${result.diagnosis?.classification ?? 'n/a'}`);
  console.error(`[autopilot-run] Repair attempts: ${result.repair_attempts}`);
  console.error(`[autopilot-run] Final verdict: ${result.verdict}`);
  console.error(`[autopilot-run] Report: ${result.report_dir}`);
}

export async function runAutopilotRun(
  config: AutopilotRunConfig,
  configPath: string,
  options: RunAutopilotRunInternalOptions = {}
): Promise<AutopilotRunResult> {
  const startedAt = nowIso();
  const startTime = Date.now();
  const command = options.command ?? `npx tsx src/autopilot-run/index.ts ${configPath}`;
  const reportDir = getAutopilotReportDir(config.report_dir, config.run_id);
  const timeline = createTimeline();
  const fetchFn = options.fetchFn ?? globalThis.fetch;
  const spawnFn = options.spawnFn ?? spawnSync;

  addTimelineEvent(timeline, 'preflight', {
    mode: config.mode,
    run_id: config.run_id,
    repo_slug: config.repo_slug,
  });

  const envCheck = validateAutopilotEnv(config);
  const capabilities = buildCapabilitySummary(config);
  printPreflight(config, capabilities, envCheck);

  function buildResult(
    verdict: AutopilotRunVerdict,
    reason: string,
    mvpResult?: MvpRunResult,
    ciRunId?: number,
    ciConclusion?: string | null,
    diagnosis?: DiagnoseCiResult,
    repairAttempts = 0
  ): AutopilotRunResult {
    return {
      config,
      command,
      config_path: resolve(configPath),
      started_at: startedAt,
      finished_at: nowIso(),
      duration_ms: Date.now() - startTime,
      verdict,
      reason: redactSecrets(reason),
      mvp_result: mvpResult,
      ci_run_id: ciRunId,
      ci_conclusion: ciConclusion,
      diagnosis,
      repair_attempts: repairAttempts,
      report_dir: reportDir,
      exit_code: computeExitCode(verdict),
    };
  }

  function finalize(result: AutopilotRunResult): AutopilotRunResult {
    writeAutopilotReports(result, capabilities, timeline);
    writeTimeline(reportDir, timeline);
    printSummary(result);
    return result;
  }

  if (!envCheck.ok) {
    return finalize(buildResult(envCheck.verdict ?? 'AUTOPILOT_FAILED', envCheck.reason));
  }

  let mvpConfig: MvpRunConfig;
  try {
    mvpConfig = buildMvpConfig(config);
    if (options.skipPrCreation) {
      mvpConfig.allow_github_pr_create = false;
    }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return finalize(buildResult('AUTOPILOT_CONFIG_ERROR', reason));
  }

  addTimelineEvent(timeline, 'mvp_started');
  const runMvpRunFn = options.runMvpRunFn ?? runMvpRun;
  const resume = options.resume ?? false;
  const mvpResult = await runMvpRunFn(mvpConfig, config.mvp_config_path, { resume });
  addTimelineEvent(timeline, 'mvp_completed', { verdict: mvpResult.verdict });

  if (!isMvpSuccess(mvpResult.verdict)) {
    const reason = `MVP run failed: ${mvpResult.verdict} — ${mvpResult.reason}`;
    return finalize(buildResult('AUTOPILOT_MVP_FAILED', reason, mvpResult));
  }

  if (mvpResult.pr?.created && mvpResult.pr.number !== undefined) {
    addTimelineEvent(timeline, 'pr_created', {
      number: mvpResult.pr.number,
      url: mvpResult.pr.url,
    });
  } else {
    addTimelineEvent(timeline, 'pr_detected', { created: false });
  }

  if (!config.ci.enabled || !config.ci.wait_for_ci) {
    const reason = 'CI observation disabled; autopilot stopped after MVP success';
    return finalize(buildResult('AUTOPILOT_MVP_DONE_CI_NOT_OBSERVED', reason, mvpResult));
  }

  addTimelineEvent(timeline, 'ci_wait_started');
  const repoPath = resolve(mvpConfig.repo_path);
  let headSha: string;
  try {
    headSha = getHeadSha(repoPath, config.work_branch, spawnFn);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return finalize(buildResult('AUTOPILOT_FAILED', `Failed to determine head SHA: ${reason}`, mvpResult));
  }

  let runId: number;
  try {
    runId = await resolveAutopilotWorkflowRunId(config, headSha, fetchFn);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return finalize(buildResult(mapGithubError(err), reason, mvpResult));
  }

  const pollResult = await pollAutopilotWorkflowRun(config, runId, fetchFn);
  addTimelineEvent(timeline, 'ci_completed', {
    run_id: runId,
    status: pollResult.status,
    conclusion: pollResult.run?.conclusion ?? null,
  });

  if (pollResult.status === 'timeout') {
    const reason = `CI workflow ${runId} timed out after ${config.ci.timeout_seconds}s`;
    return finalize(buildResult('AUTOPILOT_CI_TIMEOUT', reason, mvpResult, runId, null));
  }

  const conclusion = pollResult.run?.conclusion ?? null;
  if (conclusion === 'success') {
    const reason = `CI workflow ${runId} completed successfully`;
    return finalize(buildResult('AUTOPILOT_GREEN', reason, mvpResult, runId, conclusion));
  }

  addTimelineEvent(timeline, 'diagnosis_started', { run_id: runId });

  let diagnosis: DiagnoseCiResult;
  if (config.mode === 'github' && !envCheck.token_present) {
    diagnosis = {
      verdict: 'DIAGNOSE_CI_RED',
      run_id: runId,
      classification: 'ACCESS_FAILURE',
      confidence: 'medium',
      report_paths: null,
      reason: 'CI is red but no token is available to read logs; degraded diagnosis only',
    };
  } else {
    const diagnoseConfig = buildDiagnoseConfig(config, runId, reportDir);
    const runDiagnoseCiFn = options.runDiagnoseCiFn ?? runDiagnoseCi;
    const diagnoseOptions: DiagnoseCiOptions = {
      fetchFn,
      command: `${command} → diagnose-ci`,
    };
    try {
      diagnosis = await runDiagnoseCiFn(diagnoseConfig, diagnoseOptions);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      diagnosis = {
        verdict: 'DIAGNOSE_CI_FAILED',
        run_id: runId,
        classification: 'UNKNOWN_FAILURE',
        confidence: 'medium',
        report_paths: null,
        reason,
      };
    }
  }

  writeLatestDiagnosisAndFixTask(reportDir, diagnosis);
  addTimelineEvent(timeline, 'diagnosis_completed', {
    verdict: diagnosis.verdict,
    classification: diagnosis.classification,
  });

  if (!config.repair.enabled) {
    const reason = `CI workflow ${runId} is red; repair disabled`;
    return finalize(buildResult('AUTOPILOT_CI_RED_DIAGNOSED', reason, mvpResult, runId, conclusion, diagnosis));
  }

  const fixTaskMd = readFixTaskMarkdown(reportDir);
  let attempts = 0;
  const maxAttempts = config.repair.max_attempts;

  while (attempts < maxAttempts) {
    attempts += 1;
    addTimelineEvent(timeline, 'repair_attempt_started', { attempt: attempts });

    const repairResult = await runRepairAttempt(
      config,
      {
        repoPath,
        fixTaskMd: fixTaskMd ?? '',
        failingFile: extractFailingFile(reportDir),
        reportDir,
        attempt: attempts,
      },
      {
        createAIClientFn: options.createAIClientFn,
        spawnFn,
      }
    );

    addTimelineEvent(timeline, 'repair_attempt_completed', {
      attempt: attempts,
      ok: repairResult.ok,
      pushed: repairResult.pushed,
    });

    if (!repairResult.ok) {
      if (attempts >= maxAttempts) {
        const reason = `Repair failed: ${repairResult.reason}`;
        return finalize(
          buildResult('AUTOPILOT_REPAIR_FAILED', reason, mvpResult, runId, conclusion, diagnosis, attempts)
        );
      }
      continue;
    }

    if (repairResult.pushed) {
      addTimelineEvent(timeline, 'push_completed', {
        attempt: attempts,
        files: repairResult.files,
      });
    }

    let newHeadSha: string;
    try {
      newHeadSha = getHeadSha(repoPath, config.work_branch, spawnFn);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      return finalize(
        buildResult('AUTOPILOT_FAILED', `Failed to determine new head SHA: ${reason}`, mvpResult, runId, conclusion, diagnosis, attempts)
      );
    }

    let newRunId: number;
    try {
      newRunId = await resolveAutopilotWorkflowRunId(config, newHeadSha, fetchFn);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      return finalize(buildResult(mapGithubError(err), reason, mvpResult, runId, conclusion, diagnosis, attempts));
    }

    const newPoll = await pollAutopilotWorkflowRun(config, newRunId, fetchFn);
    addTimelineEvent(timeline, 'ci_completed', {
      run_id: newRunId,
      status: newPoll.status,
      conclusion: newPoll.run?.conclusion ?? null,
    });

    if (newPoll.status === 'timeout') {
      const reason = `Follow-up CI workflow ${newRunId} timed out after ${config.ci.timeout_seconds}s`;
      return finalize(
        buildResult('AUTOPILOT_CI_TIMEOUT', reason, mvpResult, newRunId, null, diagnosis, attempts)
      );
    }

    if (newPoll.run?.conclusion === 'success') {
      const reason = `CI workflow ${newRunId} green after repair attempt ${attempts}`;
      return finalize(
        buildResult('AUTOPILOT_GREEN', reason, mvpResult, newRunId, 'success', diagnosis, attempts)
      );
    }

    const runDiagnoseCiFn = options.runDiagnoseCiFn ?? runDiagnoseCi;
    try {
      const updatedDiagnosis = await runDiagnoseCiFn(
        buildDiagnoseConfig(config, newRunId, reportDir),
        { fetchFn, command: `${command} → diagnose-ci` }
      );
      diagnosis = updatedDiagnosis;
      writeLatestDiagnosisAndFixTask(reportDir, diagnosis);
      addTimelineEvent(timeline, 'diagnosis_completed', {
        verdict: diagnosis.verdict,
        classification: diagnosis.classification,
      });
    } catch {
      // Keep previous diagnosis and continue loop.
    }
  }

  const reason = `Repair loop exhausted after ${attempts} attempts`;
  return finalize(
    buildResult('AUTOPILOT_REPAIR_EXHAUSTED', reason, mvpResult, runId, conclusion, diagnosis, attempts)
  );
}
