import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BlockDefinition } from '../block/block-types.js';
import { buildScenarioBlock } from './block-builder.js';
import { classifyScenarioResult } from './classifier.js';
import { validateAcceptanceMatrixRuntime } from './env-validator.js';
import { buildFakeResponseArrays } from './fake-response-builder.js';
import { createAcceptanceMatrixPr } from './pr-creator.js';
import { countProviderAttempts } from './provider-attempts-counter.js';
import {
  prepareSandboxRepo,
  prepareScenarioWorkBranch,
} from './sandbox-preparer.js';
import type {
  AcceptanceMatrixConfig,
  AcceptanceMatrixResult,
  AcceptanceScenarioConfig,
  AcceptanceScenarioResult,
  FailureClassification,
  ScenarioStatus,
} from './types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '..', '..');
const tsxCliPath = resolve(projectRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const cliPath = resolve(projectRoot, 'src', 'cli.ts');

interface BlockRunOutput {
  exitCode: number;
  stdout: string;
  stderr: string;
  statePath: string | null;
  state: Record<string, unknown> | null;
}

function redactSecrets(text: string): string {
  return text
    .replace(/sk-[a-zA-Z0-9]*/g, '[REDACTED]')
    .replace(/Bearer\s+[\S]+/gi, 'Bearer [REDACTED]')
    .replace(/ghp_[a-zA-Z0-9]*/g, '[REDACTED]')
    .replace(/github_pat_[a-zA-Z0-9_-]*/g, '[REDACTED]');
}

function nowIso(): string {
  return new Date().toISOString();
}

function ensureDir(dir: string): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

function getStatePathFromBlock(block: BlockDefinition, runsDir: string): string {
  return join(runsDir, 'block', block.block_id, 'state.json');
}

function loadBlockStateFromPath(statePath: string): Record<string, unknown> | null {
  if (!existsSync(statePath)) return null;
  try {
    const raw = readFileSync(statePath, 'utf-8');
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function resumeCompletedNoopMarkerFound(stdout: string, stderr: string): boolean {
  const marker = 'Resume mode: block already completed.';
  return stdout.includes(marker) || stderr.includes(marker);
}

function buildChildEnv(
  config: AcceptanceMatrixConfig,
  scenario: AcceptanceScenarioConfig,
  runsDir: string
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };

  // Sandbox repo mutation opt-ins must come from config, not from runner magic.
  env.ALLOW_REAL_BLOCK_RUN_AI = 'true';
  env.ALLOW_REAL_PROVIDER =
    config.provider === 'fake' || config.allow_real_provider ? 'true' : '';
  env.ALLOW_REAL_REPO_APPLY = config.allow_real_repo_apply ? 'true' : '';
  env.ALLOW_REAL_REPO_COMMIT = config.allow_real_repo_commit ? 'true' : '';
  env.ALLOW_REAL_REPO_PUSH = config.allow_real_repo_push ? 'true' : '';
  env.REAL_REPO_ENABLE_REVIEWER_FIX_LOOP = '1';
  env.RUNS_DIR = runsDir;

  // In fake mode we never call a real provider; use a placeholder key only if
  // the real one is absent so the readiness check passes.
  if (config.provider === 'fake') {
    env.KIMI_API_KEY = env.KIMI_API_KEY || 'fake-api-key-for-acceptance-matrix';
    env.KIMI_BASE_URL = env.KIMI_BASE_URL || 'https://api.moonshot.ai/v1';
  }

  // Merge scenario-level env overrides.
  if (scenario.env) {
    for (const [key, value] of Object.entries(scenario.env)) {
      env[key] = value;
    }
  }

  const useFakeResponses =
    config.provider === 'fake' || scenario.unsafe_response_mode === 'fake_deterministic';

  if (useFakeResponses) {
    const arrays = buildFakeResponseArrays(scenario.type);
    env.REAL_BLOCK_TASK_KIMI_FAKE_RESPONSES = JSON.stringify(arrays.kimi);
    env.REAL_BLOCK_TASK_REVIEWER_FAKE_RESPONSES = JSON.stringify(arrays.reviewer);
    env.REAL_BLOCK_TASK_FIX_KIMI_FAKE_RESPONSES = JSON.stringify(arrays.fixKimi);
    env.REAL_BLOCK_TASK_SECOND_REVIEWER_FAKE_RESPONSES = JSON.stringify(arrays.secondReviewer);
  }

  return env;
}

function runBlock(
  blockPath: string,
  env: NodeJS.ProcessEnv,
  statePath: string,
  timeoutMs = 300000
): BlockRunOutput {
  const result = spawnSync(
    process.execPath,
    [tsxCliPath, cliPath, 'real-block-run-ai', blockPath, '--fresh'],
    {
      cwd: projectRoot,
      env,
      encoding: 'utf-8',
      shell: false,
      timeout: timeoutMs,
    }
  );

  const stdout = result.stdout || '';
  const stderr = result.stderr || '';
  const exitCode = result.status ?? 1;

  return {
    exitCode,
    stdout,
    stderr,
    statePath,
    state: loadBlockStateFromPath(statePath),
  };
}

function runBlockResume(
  blockPath: string,
  env: NodeJS.ProcessEnv,
  statePath: string,
  timeoutMs = 300000
): BlockRunOutput {
  const result = spawnSync(
    process.execPath,
    [tsxCliPath, cliPath, 'real-block-run-ai', blockPath, '--resume'],
    {
      cwd: projectRoot,
      env,
      encoding: 'utf-8',
      shell: false,
      timeout: timeoutMs,
    }
  );

  return {
    exitCode: result.status ?? 1,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    statePath,
    state: loadBlockStateFromPath(statePath),
  };
}

function runBlockReport(statePath: string, env: NodeJS.ProcessEnv): { stdout: string; stderr: string } {
  const result = spawnSync(
    process.execPath,
    [tsxCliPath, cliPath, 'real-block-run-ai-report', statePath],
    {
      cwd: projectRoot,
      env,
      encoding: 'utf-8',
      shell: false,
      timeout: 60000,
    }
  );
  return {
    stdout: result.stdout || '',
    stderr: result.stderr || '',
  };
}

function captureGitLog(repoPath: string): string {
  const result = spawnSync(
    'git',
    ['log', '--oneline', '--decorate', '--graph', '-n', '50'],
    { cwd: repoPath, encoding: 'utf-8', shell: false }
  );
  return result.stdout || '';
}

function getCommitsAhead(
  repoPath: string,
  baseBranch: string,
  workBranch: string
): string[] {
  const result = spawnSync(
    'git',
    ['rev-list', `${baseBranch}..${workBranch}`],
    { cwd: repoPath, encoding: 'utf-8', shell: false }
  );
  if (result.status !== 0) return [];
  return result.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
}

export async function runAcceptanceMatrix(
  config: AcceptanceMatrixConfig
): Promise<AcceptanceMatrixResult> {
  const startedAt = nowIso();
  const startTime = Date.now();
  const results: AcceptanceScenarioResult[] = [];

  ensureDir(config.report_dir);

  const runtimeValidation = validateAcceptanceMatrixRuntime(config);
  console.error('[acceptance-matrix] Runtime env check:');
  console.error(`  KIMI_API_KEY: ${runtimeValidation.report.kimi_api_key}`);
  console.error(`  GITHUB_TOKEN: ${runtimeValidation.report.github_token}`);
  if (!runtimeValidation.ok) {
    const reasons = runtimeValidation.reasons.join('; ');
    console.error(`[acceptance-matrix] Runtime validation failed: ${reasons}`);
    const firstScenario = config.scenarios[0];
    const failureResult: AcceptanceScenarioResult = {
      type: firstScenario?.type ?? 'golden_real_multitask',
      label: firstScenario?.label ?? 'first scenario',
      status: 'failed',
      classification: config.allow_github_pr_create && runtimeValidation.report.github_token === 'missing'
        ? 'HUMAN_TOKEN_PERMISSION_ERROR'
        : 'CONFIG_ERROR',
      reason: `Runtime validation failed: ${reasons}`,
      evidence_dir: config.report_dir,
      duration_ms: Date.now() - startTime,
    };
    const finishedAt = nowIso();
    return {
      config,
      started_at: startedAt,
      finished_at: finishedAt,
      duration_ms: Date.now() - startTime,
      summary: {
        total: config.scenarios.length,
        passed: 0,
        passed_with_caveats: 0,
        failed: 1,
        skipped: config.scenarios.length - 1,
      },
      results: [failureResult],
      report_dir: config.report_dir,
      orchestrator_exit_code: 1,
    };
  }

  // Prepare every unique base branch configured by the scenarios.
  const baseBranches = [...new Set(config.scenarios.map((s) => s.base_branch))];
  for (const baseBranch of baseBranches) {
    const sandboxPrep = prepareSandboxRepo(config.sandbox_repo_path, baseBranch);
    if (!sandboxPrep.ok) {
      const err = `Sandbox preparation failed for base ${baseBranch}: ${sandboxPrep.issues.join('; ')}`;
      results.push({
        type: config.scenarios[0]?.type ?? 'golden_real_multitask',
        label: config.scenarios[0]?.label ?? 'first scenario',
        status: 'failed',
        classification: 'CONFIG_ERROR',
        reason: err,
        evidence_dir: config.report_dir,
        duration_ms: Date.now() - startTime,
      });
      const finishedAt = nowIso();
      return {
        config,
        started_at: startedAt,
        finished_at: finishedAt,
        duration_ms: Date.now() - startTime,
        summary: { total: config.scenarios.length, passed: 0, passed_with_caveats: 0, failed: 1, skipped: config.scenarios.length - 1 },
        results,
        report_dir: config.report_dir,
        orchestrator_exit_code: 1,
      };
    }
  }

  let stopMatrix = false;

  for (const scenario of config.scenarios) {
    const scenarioStart = Date.now();
    const evidenceDir = join(config.report_dir, `scenario-${scenario.type}-${scenarioStart}`);
    ensureDir(evidenceDir);

    if (stopMatrix) {
      results.push({
        type: scenario.type,
        label: scenario.label ?? scenario.type,
        status: 'skipped',
        reason: 'Skipped because a previous scenario stopped the matrix',
        evidence_dir: evidenceDir,
        duration_ms: 0,
      });
      continue;
    }

    if (config.provider === 'kimi' && !config.allow_real_provider) {
      results.push({
        type: scenario.type,
        label: scenario.label ?? scenario.type,
        status: 'skipped',
        reason: 'Real provider not allowed by config.allow_real_provider',
        evidence_dir: evidenceDir,
        duration_ms: 0,
      });
      continue;
    }

    const branchPrep = prepareScenarioWorkBranch(
      config.sandbox_repo_path,
      scenario.base_branch,
      scenario.work_branch
    );
    if (!branchPrep.ok) {
      results.push({
        type: scenario.type,
        label: scenario.label ?? scenario.type,
        status: 'failed',
        classification: 'ORCHESTRATOR_BUG',
        reason: `Work branch preparation failed: ${branchPrep.issues.join('; ')}`,
        evidence_dir: evidenceDir,
        duration_ms: Date.now() - scenarioStart,
      });
      if (config.stop_on_orchestrator_bug) stopMatrix = true;
      if (scenario.stop_on_failure) stopMatrix = true;
      continue;
    }

    const block = buildScenarioBlock(scenario, config.sandbox_repo_path, config.provider);
    const blockPath = join(evidenceDir, 'block.json');
    writeFileSync(blockPath, JSON.stringify(block, null, 2), 'utf-8');

    const runsDir = join(evidenceDir, 'runs');
    const statePath = getStatePathFromBlock(block, runsDir);
    const env = buildChildEnv(config, scenario, runsDir);

    const run = runBlock(blockPath, env, statePath);
    const classification = classifyScenarioResult(scenario, run.exitCode, run.state);

    // Write captured runner output.
    writeFileSync(join(evidenceDir, 'stdout.txt'), redactSecrets(run.stdout), 'utf-8');
    writeFileSync(join(evidenceDir, 'stderr.txt'), redactSecrets(run.stderr), 'utf-8');

    // Write block state snapshot if available.
    if (run.state) {
      writeFileSync(join(evidenceDir, 'state.json'), JSON.stringify(run.state, null, 2), 'utf-8');
      const report = runBlockReport(statePath, env);
      writeFileSync(join(evidenceDir, 'report.txt'), redactSecrets(report.stdout), 'utf-8');
    }

    // Capture git log.
    writeFileSync(join(evidenceDir, 'git-log.txt'), captureGitLog(config.sandbox_repo_path), 'utf-8');

    let prResult: AcceptanceScenarioResult['pr'] | undefined;
    if (config.allow_github_pr_create && classification.status !== 'failed') {
      const githubToken = process.env.GITHUB_TOKEN ?? '';
      const pr = await createAcceptanceMatrixPr(config, scenario, githubToken);
      prResult = {
        created: pr.created,
        number: pr.number,
        url: pr.url,
        draft: pr.draft,
        reason: pr.reason,
      };
      if (!pr.created && classification.status === 'passed') {
        classification.status = 'passed_with_caveats';
        classification.classification = pr.classification ?? 'GITHUB_API_ERROR';
        classification.reason = `${classification.reason}; PR creation failed: ${pr.reason}`;
      }
      writeFileSync(join(evidenceDir, 'pr-create-output.txt'), redactSecrets(pr.reason), 'utf-8');
    }

    // Collect commits ahead of base (not the entire branch history).
    const commitsAhead = getCommitsAhead(
      config.sandbox_repo_path,
      scenario.base_branch,
      scenario.work_branch
    );

    // Resume no-op proof for scenarios that complete with caveats (e.g. blocked_continue).
    let resumeResult: AcceptanceScenarioResult['resume'] | undefined;
    const statusAfterFirstRun = (run.state?.status as string) ?? null;
    if (
      scenario.type === 'blocked_continue' &&
      statusAfterFirstRun === 'completed_with_caveats'
    ) {
      const providerAttemptsBefore = countProviderAttempts(run.state);
      const commitsBeforeResume = getCommitsAhead(
        config.sandbox_repo_path,
        scenario.base_branch,
        scenario.work_branch
      );
      const resumeRun = runBlockResume(blockPath, env, statePath);
      writeFileSync(join(evidenceDir, 'resume-stdout.txt'), redactSecrets(resumeRun.stdout), 'utf-8');
      writeFileSync(join(evidenceDir, 'resume-stderr.txt'), redactSecrets(resumeRun.stderr), 'utf-8');
      const commitsAfterResume = getCommitsAhead(
        config.sandbox_repo_path,
        scenario.base_branch,
        scenario.work_branch
      );
      const resumeStatus = (resumeRun.state?.status as string) ?? 'unknown';
      const providerAttemptsAfter = countProviderAttempts(resumeRun.state);
      const providerRerun = providerAttemptsAfter > providerAttemptsBefore;
      const noopMarkerFound = resumeCompletedNoopMarkerFound(resumeRun.stdout, resumeRun.stderr);
      const noNewCommits = commitsAfterResume.length === commitsBeforeResume.length;
      const resumeOk =
        resumeRun.exitCode === 0 && noNewCommits && !providerRerun && noopMarkerFound;
      resumeResult = {
        exit_code: resumeRun.exitCode,
        status: resumeStatus,
        commit_count_ahead_before: commitsBeforeResume.length,
        commit_count_ahead_after: commitsAfterResume.length,
        provider_attempts_before: providerAttemptsBefore,
        provider_attempts_after: providerAttemptsAfter,
        provider_rerun: providerRerun,
        completed_noop_marker_found: noopMarkerFound,
        reason: resumeOk
          ? 'Resume on completed_with_caveats was a no-op: no new commits, provider not rerun, marker found'
          : `Resume produced unexpected result (exit=${resumeRun.exitCode}, commits before=${commitsBeforeResume.length}, after=${commitsAfterResume.length}, provider_attempts before=${providerAttemptsBefore}, after=${providerAttemptsAfter}, provider_rerun=${providerRerun}, noop_marker=${noopMarkerFound})`,
      };
    }

    const result: AcceptanceScenarioResult = {
      type: scenario.type,
      label: scenario.label ?? scenario.type,
      status: classification.status,
      expected: classification.expected,
      classification: classification.classification,
      reason: classification.reason,
      evidence_dir: evidenceDir,
      block_path: blockPath,
      state_path: run.state ? statePath : undefined,
      commits_ahead: commitsAhead,
      commit_count_ahead: commitsAhead.length,
      pr: prResult,
      resume: resumeResult,
      duration_ms: Date.now() - scenarioStart,
    };
    results.push(result);

    if (classification.status === 'failed') {
      if (config.stop_on_orchestrator_bug && classification.classification === 'ORCHESTRATOR_BUG') {
        stopMatrix = true;
      }
      if (scenario.stop_on_failure) {
        stopMatrix = true;
      }
    }
  }

  const finishedAt = nowIso();
  const duration = Date.now() - startTime;
  const summary = {
    total: results.length,
    passed: results.filter((r) => r.status === 'passed').length,
    passed_with_caveats: results.filter((r) => r.status === 'passed_with_caveats').length,
    failed: results.filter((r) => r.status === 'failed').length,
    skipped: results.filter((r) => r.status === 'skipped').length,
  };

  const orchestratorExitCode = summary.failed > 0 || summary.passed_with_caveats > 0 ? 1 : 0;

  return {
    config,
    started_at: startedAt,
    finished_at: finishedAt,
    duration_ms: duration,
    summary,
    results,
    report_dir: config.report_dir,
    orchestrator_exit_code: orchestratorExitCode,
  };
}
