import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BlockDefinition } from '../block/block-types.js';
import { buildScenarioBlock } from './block-builder.js';
import { classifyScenarioResult } from './classifier.js';
import { buildFakeResponseArrays } from './fake-response-builder.js';
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

function buildChildEnv(
  config: AcceptanceMatrixConfig,
  scenario: AcceptanceScenarioConfig,
  runsDir: string
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };

  // Required opt-ins for real-block-run-ai and its child real-repo-run-ai.
  env.ALLOW_REAL_BLOCK_RUN_AI = 'true';
  env.ALLOW_REAL_PROVIDER = 'true';
  env.ALLOW_REAL_REPO_APPLY = 'true';
  env.ALLOW_REAL_REPO_COMMIT = 'true';
  env.ALLOW_REAL_REPO_PUSH = 'true';
  env.REAL_REPO_ENABLE_REVIEWER_FIX_LOOP = '1';
  env.RUNS_DIR = runsDir;

  if (config.provider === 'fake') {
    env.KIMI_API_KEY = env.KIMI_API_KEY || 'fake-api-key-for-acceptance-matrix';
    env.KIMI_BASE_URL = env.KIMI_BASE_URL || 'https://api.moonshot.ai/v1';
  } else {
    env.KIMI_API_KEY = env.KIMI_API_KEY || '';
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

function runPrCreate(
  blockPath: string,
  env: NodeJS.ProcessEnv
): { created: boolean; number?: number; url?: string; reason: string } {
  const result = spawnSync(
    process.execPath,
    [tsxCliPath, cliPath, 'block-pr-create', blockPath],
    {
      cwd: projectRoot,
      env,
      encoding: 'utf-8',
      shell: false,
      timeout: 120000,
    }
  );

  const output = `${result.stdout || ''}\n${result.stderr || ''}`;
  const dryRun = env.BLOCK_PR_CREATE_DRY_RUN === 'true';

  if (result.status !== 0) {
    const reason = redactSecrets(output.trim()) || 'block-pr-create exited with non-zero code';
    return { created: false, reason };
  }

  if (dryRun) {
    return { created: true, reason: 'Dry-run: PR would be created' };
  }

  const created = output.includes('PR created: yes');
  const numberMatch = output.match(/PR number:\s*(\d+)/);
  const urlMatch = output.match(/PR URL:\s*(\S+)/);
  return {
    created,
    number: numberMatch ? parseInt(numberMatch[1], 10) : undefined,
    url: urlMatch ? urlMatch[1] : undefined,
    reason: created ? 'PR created' : 'PR creation declined or blocked',
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

function getCommitList(repoPath: string, branch: string): string[] {
  const result = spawnSync(
    'git',
    ['rev-list', branch],
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

  const sandboxPrep = prepareSandboxRepo(config.sandbox_repo_path, 'main');
  if (!sandboxPrep.ok) {
    const err = `Sandbox preparation failed: ${sandboxPrep.issues.join('; ')}`;
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
      const prEnv: NodeJS.ProcessEnv = { ...env };
      if (config.sandbox_repo_slug) {
        prEnv.GITHUB_REPOSITORY = config.sandbox_repo_slug;
      }
      const pr = runPrCreate(blockPath, prEnv);
      prResult = {
        created: pr.created,
        number: pr.number,
        url: pr.url,
        reason: pr.reason,
      };
      if (!pr.created) {
        if (classification.status === 'passed') {
          classification.status = 'passed_with_caveats';
          classification.classification = 'HUMAN_TOKEN_PERMISSION_ERROR';
          classification.reason = `${classification.reason}; PR creation failed: ${pr.reason}`;
        }
      }
      writeFileSync(join(evidenceDir, 'pr-create-output.txt'), redactSecrets(`${pr.created} ${pr.reason}`), 'utf-8');
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
      commits: getCommitList(config.sandbox_repo_path, scenario.work_branch),
      pr: prResult,
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
