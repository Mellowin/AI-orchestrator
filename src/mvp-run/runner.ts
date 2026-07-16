import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runRealBlockRunAI } from '../real-block-run-ai.js';
import type { BlockDefinition } from '../block/block-types.js';
import type { RealBlockRunState, RealBlockRunTaskResult } from '../real-block-run-ai-state.js';
import {
  prepareSandboxRepo,
  prepareScenarioWorkBranch,
} from '../acceptance-matrix/sandbox-preparer.js';
import { countProviderAttempts } from '../acceptance-matrix/provider-attempts-counter.js';
import { buildMvpRunBlock } from './block-builder.js';
import { buildMvpRunFakeResponses } from './fake-response-builder.js';
import { createMvpRunPr } from './pr-creator.js';
import { getMvpRunReportDir, writeMvpRunReports } from './report-writer.js';
import { validateMvpRunRuntime } from './env-validator.js';
import type { MvpRunConfig, MvpRunPreflightReport, MvpRunResult, MvpRunTaskReport, MvpRunVerdict } from './types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '..', '..');

function nowIso(): string {
  return new Date().toISOString();
}

function ensureDir(dir: string): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

function redactSecrets(text: string): string {
  return text
    .replace(/sk-[a-zA-Z0-9]*/g, '[REDACTED]')
    .replace(/Bearer\s+[\S]+/gi, 'Bearer [REDACTED]')
    .replace(/ghp_[a-zA-Z0-9]*/g, '[REDACTED]')
    .replace(/github_pat_[a-zA-Z0-9_-]*/g, '[REDACTED]');
}

function getCommitsAhead(repoPath: string, baseBranch: string, workBranch: string): string[] {
  const result = spawnSync('git', ['rev-list', `${baseBranch}..${workBranch}`], {
    cwd: repoPath,
    encoding: 'utf-8',
    shell: false,
  });
  if (result.status !== 0) return [];
  return result.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
}

function buildPreflight(config: MvpRunConfig, runtime: ReturnType<typeof validateMvpRunRuntime>): MvpRunPreflightReport {
  const risks: string[] = [];
  if (config.provider === 'kimi' && config.allow_real_provider) {
    risks.push('Real Kimi provider will be called; this consumes API quota.');
  }
  if (config.allow_real_repo_apply) {
    risks.push('Files in the target repo will be modified.');
  }
  if (config.allow_real_repo_commit) {
    risks.push('Commits will be created in the target repo.');
  }
  if (config.allow_real_repo_push) {
    risks.push('Commits will be pushed to the remote.');
  }
  if (config.allow_github_pr_create) {
    risks.push('A draft PR will be created on GitHub.');
  }

  return {
    repo_path: resolve(config.repo_path),
    repo_slug: config.repo_slug,
    base_branch: config.base_branch,
    work_branch: config.work_branch,
    provider: config.provider,
    real_provider_enabled: config.provider === 'kimi' && config.allow_real_provider,
    apply_enabled: config.allow_real_repo_apply,
    commit_enabled: config.allow_real_repo_commit,
    push_enabled: config.allow_real_repo_push,
    pr_creation_enabled: config.allow_github_pr_create,
    missing_env_vars: runtime.report.missing_env_vars.length > 0 ? runtime.reasons : [],
    detected_risks: risks,
  };
}

function printPreflight(preflight: MvpRunPreflightReport): void {
  console.error('[mvp-run] Preflight');
  console.error(`  repo path: ${preflight.repo_path}`);
  if (preflight.repo_slug) {
    console.error(`  repo slug: ${preflight.repo_slug}`);
  }
  console.error(`  base branch: ${preflight.base_branch}`);
  console.error(`  work branch: ${preflight.work_branch}`);
  console.error(`  provider: ${preflight.provider}`);
  console.error(`  real provider enabled: ${preflight.real_provider_enabled ? 'yes' : 'no'}`);
  console.error(`  apply enabled: ${preflight.apply_enabled ? 'yes' : 'no'}`);
  console.error(`  commit enabled: ${preflight.commit_enabled ? 'yes' : 'no'}`);
  console.error(`  push enabled: ${preflight.push_enabled ? 'yes' : 'no'}`);
  console.error(`  PR creation enabled: ${preflight.pr_creation_enabled ? 'yes' : 'no'}`);
  if (preflight.missing_env_vars.length > 0) {
    console.error(`  missing env vars / opt-ins:`);
    for (const item of preflight.missing_env_vars) {
      console.error(`    - ${item}`);
    }
  }
  if (preflight.detected_risks.length > 0) {
    console.error(`  detected risks:`);
    for (const risk of preflight.detected_risks) {
      console.error(`    - ${risk}`);
    }
  }
}

function setupProcessEnv(config: MvpRunConfig, runsDir: string): void {
  process.env.ALLOW_REAL_BLOCK_RUN_AI = 'true';
  process.env.ALLOW_REAL_PROVIDER =
    config.provider === 'fake' ? 'true' : config.allow_real_provider ? 'true' : '';
  process.env.ALLOW_REAL_PROVIDER_RUN =
    config.provider === 'fake' ? '' : config.allow_real_provider ? 'true' : '';
  process.env.ALLOW_REAL_REPO_APPLY = config.allow_real_repo_apply ? 'true' : '';
  process.env.ALLOW_REAL_REPO_COMMIT = config.allow_real_repo_commit ? 'true' : '';
  process.env.ALLOW_REAL_REPO_PUSH = config.allow_real_repo_push ? 'true' : '';
  process.env.ALLOW_GITHUB_PR_CREATE = config.allow_github_pr_create ? 'true' : '';
  process.env.REAL_REPO_ENABLE_REVIEWER_FIX_LOOP = '1';
  process.env.RUNS_DIR = runsDir;

  if (config.provider === 'fake') {
    const arrays = buildMvpRunFakeResponses(config.tasks);
    process.env.REAL_BLOCK_TASK_KIMI_FAKE_RESPONSES = JSON.stringify(arrays.kimi);
    process.env.REAL_BLOCK_TASK_REVIEWER_FAKE_RESPONSES = JSON.stringify(arrays.reviewer);
    process.env.REAL_BLOCK_TASK_FIX_KIMI_FAKE_RESPONSES = JSON.stringify(arrays.fixKimi);
    process.env.REAL_BLOCK_TASK_SECOND_REVIEWER_FAKE_RESPONSES = JSON.stringify(arrays.secondReviewer);
  }
}

function deriveTaskStatus(taskResult: RealBlockRunTaskResult): MvpRunTaskReport['status'] {
  switch (taskResult.status) {
    case 'accepted':
      return 'passed';
    case 'fixed_and_accepted':
      return 'passed_with_caveats';
    case 'blocked':
      return 'blocked';
    case 'fix_required':
      return 'needs_human';
    case 'failed':
      return 'failed';
    case 'blocked_skipped':
      return 'skipped';
    default:
      return 'failed';
  }
}

function buildTaskReport(taskResult: RealBlockRunTaskResult): MvpRunTaskReport {
  const providerAttempts = taskResult.providerAttempts ?? [];
  const recoveryAttempts = providerAttempts.filter((a) => !a.ok).length;
  return {
    id: taskResult.taskId,
    title: taskResult.title,
    status: deriveTaskStatus(taskResult),
    final_status: taskResult.finalStatus,
    reason: taskResult.reason ? redactSecrets(taskResult.reason) : undefined,
    provider_attempts: providerAttempts.length,
    recovery_attempts: recoveryAttempts,
    commit_sha: taskResult.originalCommitSha,
    fix_commit_sha: taskResult.fixCommitSha,
  };
}

function deriveVerdict(blockState: RealBlockRunState | null): {
  verdict: MvpRunVerdict;
  classification?: string;
  reason: string;
  nextHumanAction?: string;
} {
  if (!blockState) {
    return {
      verdict: 'MVP_RUN_FAILED',
      classification: 'ORCHESTRATOR_BUG',
      reason: 'Block runner produced no state.',
      nextHumanAction: 'Inspect logs and rerun with the same config.',
    };
  }

  const stoppedReason = blockState.summary.stoppedReason ?? 'unknown';

  if (blockState.status === 'completed') {
    return {
      verdict: 'MVP_RUN_PASSED',
      reason: `All ${blockState.summary.totalTasks} tasks completed successfully.`,
      nextHumanAction: 'Review the generated commits and PR if created.',
    };
  }

  if (blockState.status === 'completed_with_caveats') {
    return {
      verdict: 'MVP_RUN_PASSED_WITH_CAVEATS',
      reason: `Completed with caveats: ${stoppedReason}`,
      nextHumanAction: 'Review skipped/blocked tasks in the report.',
    };
  }

  const lastResult = blockState.taskResults[blockState.taskResults.length - 1];
  const lastTaskReason = lastResult?.reason ?? stoppedReason;
  const lastTaskId = lastResult?.taskId ?? 'unknown';

  if (blockState.status === 'blocked') {
    const isProviderBadOutput =
      stoppedReason.includes('Guardrails failed') ||
      stoppedReason.includes('outside allow_modify') ||
      stoppedReason.includes('exceeds max_lines_changed');

    if (isProviderBadOutput) {
      return {
        verdict: 'MVP_RUN_FAILED',
        classification: 'PROVIDER_BAD_OUTPUT',
        reason: `Task ${lastTaskId}: provider output violated guardrails: ${lastTaskReason}`,
        nextHumanAction: 'Check the guardrails recovery limit or tighten task instructions.',
      };
    }

    if (lastResult?.status === 'fix_required') {
      return {
        verdict: 'MVP_RUN_NEEDS_HUMAN',
        classification: 'REVIEWER_FIX_REQUIRED',
        reason: `Task ${lastTaskId}: reviewer requested fixes but max attempts reached: ${lastTaskReason}`,
        nextHumanAction: 'Apply the requested fixes manually and resume with --resume.',
      };
    }

    return {
      verdict: 'MVP_RUN_NEEDS_HUMAN',
      classification: 'SAFETY_POLICY_BLOCK',
      reason: `Task ${lastTaskId} blocked: ${lastTaskReason}`,
      nextHumanAction: 'Review the safety note and decide whether to override or adjust the task.',
    };
  }

  return {
    verdict: 'MVP_RUN_FAILED',
    classification: 'ORCHESTRATOR_BUG',
    reason: `Task ${lastTaskId} failed: ${lastTaskReason}`,
    nextHumanAction: 'Inspect the report and rerun after fixing the root cause.',
  };
}

export async function runMvpRun(
  config: MvpRunConfig,
  configPath: string,
  options: { resume?: boolean } = {}
): Promise<MvpRunResult> {
  const startedAt = nowIso();
  const startTime = Date.now();
  const command = `npx tsx src/cli.ts mvp-run ${configPath}${options.resume ? ' --resume' : ''}`;

  const reportDir = getMvpRunReportDir(config.report_dir, config.run_id);
  ensureDir(reportDir);

  const runsDir = join(reportDir, 'runs');
  ensureDir(runsDir);
  setupProcessEnv(config, runsDir);

  const runtimeValidation = validateMvpRunRuntime(config);
  const preflight = buildPreflight(config, runtimeValidation);
  printPreflight(preflight);

  if (!runtimeValidation.ok) {
    const reason = `Runtime validation failed: ${runtimeValidation.reasons.join('; ')}`;
    console.error(`[mvp-run] ${reason}`);
    const result: MvpRunResult = {
      config,
      command,
      config_path: resolve(configPath),
      started_at: startedAt,
      finished_at: nowIso(),
      duration_ms: Date.now() - startTime,
      verdict: 'MVP_RUN_FAILED',
      classification: runtimeValidation.classification,
      reason,
      preflight,
      task_results: [],
      tasks_total: config.tasks.length,
      tasks_passed: 0,
      tasks_failed: 0,
      tasks_blocked: 0,
      tasks_skipped: 0,
      tasks_caveats: 0,
      commits: [],
      branch: config.work_branch,
      pushed: false,
      caveats: [],
      failure_classification: runtimeValidation.classification,
      next_human_action: 'Set the missing environment variables or opt-ins and rerun.',
      report_dir: reportDir,
    };
    writeMvpRunReports(result);
    return result;
  }

  if (!config.allow_real_repo_apply) {
    const reason = 'Execution skipped: apply is disabled in safe mode. No repository mutation was performed.';
    console.error(`[mvp-run] ${reason}`);
    const result: MvpRunResult = {
      config,
      command,
      config_path: resolve(configPath),
      started_at: startedAt,
      finished_at: nowIso(),
      duration_ms: Date.now() - startTime,
      verdict: 'MVP_RUN_PASSED_WITH_CAVEATS',
      reason,
      preflight,
      task_results: [],
      tasks_total: config.tasks.length,
      tasks_passed: 0,
      tasks_failed: 0,
      tasks_blocked: 0,
      tasks_skipped: 0,
      tasks_caveats: 0,
      commits: [],
      branch: config.work_branch,
      pushed: false,
      caveats: ['No tasks were executed because apply/commit/push are disabled.', 'Enable apply and rerun to execute tasks autonomously.'],
      next_human_action: 'Enable allow_real_repo_apply/commit/push to run tasks, or use --resume after a partial run.',
      report_dir: reportDir,
    };
    writeMvpRunReports(result);
    return result;
  }

  if (!config.allow_real_repo_commit || !config.allow_real_repo_push) {
    const reason = 'Current engine requires commit and push to be enabled when apply is enabled.';
    console.error(`[mvp-run] ${reason}`);
    const result: MvpRunResult = {
      config,
      command,
      config_path: resolve(configPath),
      started_at: startedAt,
      finished_at: nowIso(),
      duration_ms: Date.now() - startTime,
      verdict: 'MVP_RUN_FAILED',
      classification: 'CONFIG_ERROR',
      reason,
      preflight,
      task_results: [],
      tasks_total: config.tasks.length,
      tasks_passed: 0,
      tasks_failed: 0,
      tasks_blocked: 0,
      tasks_skipped: 0,
      tasks_caveats: 0,
      commits: [],
      branch: config.work_branch,
      pushed: false,
      caveats: [],
      failure_classification: 'CONFIG_ERROR',
      next_human_action: 'Enable allow_real_repo_commit and allow_real_repo_push, or disable apply for a safe dry run.',
      report_dir: reportDir,
    };
    writeMvpRunReports(result);
    return result;
  }

  const repoPrep = prepareSandboxRepo(config.repo_path, config.base_branch);
  if (!repoPrep.ok) {
    const reason = `Repo preparation failed: ${repoPrep.issues.join('; ')}`;
    console.error(`[mvp-run] ${reason}`);
    const result: MvpRunResult = {
      config,
      command,
      config_path: resolve(configPath),
      started_at: startedAt,
      finished_at: nowIso(),
      duration_ms: Date.now() - startTime,
      verdict: 'MVP_RUN_FAILED',
      classification: 'CONFIG_ERROR',
      reason,
      preflight,
      task_results: [],
      tasks_total: config.tasks.length,
      tasks_passed: 0,
      tasks_failed: 0,
      tasks_blocked: 0,
      tasks_skipped: 0,
      tasks_caveats: 0,
      commits: [],
      branch: config.work_branch,
      pushed: false,
      caveats: [],
      next_human_action: 'Fix the repo path / base branch and rerun.',
      report_dir: reportDir,
    };
    writeMvpRunReports(result);
    return result;
  }

  if (options.resume) {
    const checkout = spawnSync('git', ['checkout', config.work_branch], {
      cwd: config.repo_path,
      encoding: 'utf-8',
      shell: false,
    });
    if (checkout.status !== 0) {
      const reason = `Resume failed: could not checkout work branch ${config.work_branch}: ${checkout.stderr}`;
      console.error(`[mvp-run] ${reason}`);
      const result: MvpRunResult = {
        config,
        command,
        config_path: resolve(configPath),
        started_at: startedAt,
        finished_at: nowIso(),
        duration_ms: Date.now() - startTime,
        verdict: 'MVP_RUN_FAILED',
        classification: 'CONFIG_ERROR',
        reason,
        preflight,
        task_results: [],
        tasks_total: config.tasks.length,
        tasks_passed: 0,
        tasks_failed: 0,
        tasks_blocked: 0,
        tasks_skipped: 0,
        tasks_caveats: 0,
        commits: [],
        branch: config.work_branch,
        pushed: false,
        caveats: [],
        next_human_action: 'Ensure the work branch exists or run without --resume.',
        report_dir: reportDir,
      };
      writeMvpRunReports(result);
      return result;
    }
  } else {
    const branchPrep = prepareScenarioWorkBranch(config.repo_path, config.base_branch, config.work_branch);
    if (!branchPrep.ok) {
      const reason = `Work branch preparation failed: ${branchPrep.issues.join('; ')}`;
      console.error(`[mvp-run] ${reason}`);
      const result: MvpRunResult = {
        config,
        command,
        config_path: resolve(configPath),
        started_at: startedAt,
        finished_at: nowIso(),
        duration_ms: Date.now() - startTime,
        verdict: 'MVP_RUN_FAILED',
        classification: 'CONFIG_ERROR',
        reason,
        preflight,
        task_results: [],
        tasks_total: config.tasks.length,
        tasks_passed: 0,
        tasks_failed: 0,
        tasks_blocked: 0,
        tasks_skipped: 0,
        tasks_caveats: 0,
        commits: [],
        branch: config.work_branch,
        pushed: false,
        caveats: [],
        next_human_action: 'Resolve the branch conflict and rerun.',
        report_dir: reportDir,
      };
      writeMvpRunReports(result);
      return result;
    }
  }

  const block = buildMvpRunBlock(config);
  const blockPath = join(reportDir, 'block.json');
  writeFileSync(blockPath, JSON.stringify(block, null, 2), 'utf-8');

  console.error(`[mvp-run] Starting block run: ${config.run_id}`);
  const { exitCode, blockState } = await runRealBlockRunAI(blockPath, {
    resume: options.resume ?? false,
    fresh: !options.resume,
  });

  const taskReports = blockState?.taskResults.map(buildTaskReport) ?? [];
  const pushed = taskReports.some((t) => t.commit_sha) && config.allow_real_repo_push && exitCode === 0;
  const commitsAhead = getCommitsAhead(config.repo_path, config.base_branch, config.work_branch);

  const verdictResult = deriveVerdict(blockState);
  const caveats: string[] = [];
  if (!config.allow_github_pr_create) {
    caveats.push('PR creation was not requested.');
  }
  if (!config.allow_real_repo_push) {
    caveats.push('Push was not enabled; commits are local only.');
  }

  let prResult: MvpRunResult['pr'] | undefined;
  if (config.allow_github_pr_create && blockState?.status !== 'failed') {
    const reportSummary = `${verdictResult.verdict}: ${verdictResult.reason}`;
    prResult = await createMvpRunPr(config, process.env.GITHUB_TOKEN ?? '', reportSummary);
    if (!prResult.created && prResult.classification) {
      caveats.push(`PR creation failed: ${prResult.reason}`);
    }
  } else if (!config.allow_github_pr_create) {
    prResult = { created: false, reason: 'PR creation not attempted' };
  } else {
    prResult = { created: false, reason: 'PR creation not attempted because the block failed' };
  }

  const passed = taskReports.filter((t) => t.status === 'passed').length;
  const caveatsCount = taskReports.filter((t) => t.status === 'passed_with_caveats').length;
  const failed = taskReports.filter((t) => t.status === 'failed').length;
  const blocked = taskReports.filter((t) => t.status === 'blocked').length;
  const skipped = taskReports.filter((t) => t.status === 'skipped').length;
  const needsHuman = taskReports.filter((t) => t.status === 'needs_human').length;

  const result: MvpRunResult = {
    config,
    command,
    config_path: resolve(configPath),
    started_at: startedAt,
    finished_at: nowIso(),
    duration_ms: Date.now() - startTime,
    verdict: verdictResult.verdict,
    classification: verdictResult.classification,
    reason: verdictResult.reason,
    preflight,
    task_results: taskReports,
    tasks_total: config.tasks.length,
    tasks_passed: passed,
    tasks_failed: failed + needsHuman,
    tasks_blocked: blocked,
    tasks_skipped: skipped,
    tasks_caveats: caveatsCount,
    commits: commitsAhead,
    branch: config.work_branch,
    pushed,
    pr: prResult,
    caveats,
    failure_classification: verdictResult.classification,
    next_human_action: verdictResult.nextHumanAction,
    report_dir: reportDir,
    block_state_path: blockState?.statePath,
  };

  writeMvpRunReports(result);
  return result;
}
