import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createAIClient } from '../ai-client-factory.js';
import { validateFileList } from '../guardrails.js';
import { parseKimiOutputJson } from '../kimi-output-validator.js';
import { applyFileUpdates } from '../patch-engine.js';
import { redactSecrets } from '../sandbox-preflight-repair.js';
import { validateRepoCiContract } from '../ci-contract.js';
import { ALWAYS_DENIED_FILES, type CiMaintenanceScope } from './ci-maintenance-scope.js';
import {
  resolveNpmRun,
  resolveTsxTest,
  type ToolingResolverOptions,
} from './tooling-resolution.js';
import type { FileUpdate } from '../types.js';
import type { AutopilotRunConfig } from './types.js';

const MAX_EVIDENCE_OUTPUT_CHARS = 20000;
const SMOKE_COMMAND_TIMEOUT_MS = 300000;

export interface LocalCheckEvidence {
  check: string;
  command: string;
  args: string[];
  cwd: string;
  ok: boolean;
  exit_status: number | null;
  signal: string | null;
  spawn_error: string | null;
  stdout: string;
  stderr: string;
}

export interface RepairAttemptContext {
  repoPath: string;
  fixTaskMd: string;
  failingFile?: string;
  reportDir: string;
  attempt: number;
  /**
   * Deterministic system-authorized CI-maintenance scope derived from the
   * diagnosis. Kept strictly separate from the task writable scope.
   */
  maintenanceScope?: CiMaintenanceScope;
  /** Exact missing npm script names proven by failed-job logs. */
  missingNpmScripts?: string[];
}

export interface RepairAttemptOptions {
  createAIClientFn?: typeof createAIClient;
  spawnFn?: typeof spawnSync;
  /** Deterministic per-attempt mock provider responses (tests). */
  mockResponses?: string[];
  /** Tooling resolution overrides (tests). */
  tooling?: ToolingResolverOptions;
}

export interface RepairAttemptResult {
  ok: boolean;
  applied: boolean;
  committed: boolean;
  pushed: boolean;
  reason: string;
  files: string[];
}

function defaultSpawnFn(): typeof spawnSync {
  return spawnSync;
}

function capOutput(text: string): string {
  return text.length > MAX_EVIDENCE_OUTPUT_CHARS
    ? `${text.slice(0, MAX_EVIDENCE_OUTPUT_CHARS)}\n...[truncated]`
    : text;
}

function runCommand(
  check: string,
  command: string,
  args: string[],
  cwd: string,
  spawnFn: typeof spawnSync,
  env: NodeJS.ProcessEnv,
  timeoutMs?: number
): LocalCheckEvidence {
  const result = spawnFn(command, args, {
    cwd,
    encoding: 'utf-8',
    shell: false,
    env,
    ...(timeoutMs !== undefined ? { timeout: timeoutMs } : {}),
  });
  const stdout = capOutput(
    Buffer.isBuffer(result.stdout) ? result.stdout.toString('utf-8') : (result.stdout ?? '')
  );
  const stderr = capOutput(
    Buffer.isBuffer(result.stderr) ? result.stderr.toString('utf-8') : (result.stderr ?? '')
  );
  const rawError = result.error as NodeJS.ErrnoException | null | undefined;
  const spawnError =
    rawError !== null && rawError !== undefined
      ? redactSecrets(rawError.code ? `${rawError.code}: ${rawError.message ?? String(rawError)}` : (rawError.message ?? String(rawError)))
      : null;
  const exitStatus = typeof result.status === 'number' ? result.status : null;
  const signal = typeof result.signal === 'string' ? result.signal : null;
  const ok = spawnError === null && signal === null && exitStatus === 0;
  return {
    check,
    command,
    args,
    cwd,
    ok,
    exit_status: exitStatus,
    signal,
    spawn_error: spawnError,
    stdout: redactSecrets(stdout),
    stderr: redactSecrets(stderr),
  };
}

function resolutionFailureEvidence(check: string, resolution: { error: string | null }): LocalCheckEvidence {
  return {
    check,
    command: '(unresolved)',
    args: [],
    cwd: '',
    ok: false,
    exit_status: null,
    signal: null,
    spawn_error: resolution.error ?? `${check}: tool resolution failed`,
    stdout: '',
    stderr: '',
  };
}

function describeCheckFailure(evidence: LocalCheckEvidence): string {
  if (evidence.spawn_error !== null) {
    return `${evidence.check} failed: command failed to start: ${evidence.spawn_error}`;
  }
  if (evidence.signal !== null) {
    return `${evidence.check} failed: terminated by signal ${evidence.signal}:\n${
      evidence.stderr || evidence.stdout || '(no output)'
    }`;
  }
  return `${evidence.check} failed (exit ${evidence.exit_status ?? 'unknown'}):\n${
    evidence.stderr || evidence.stdout || '(no output)'
  }`;
}

function buildMockRepairResponse(config: AutopilotRunConfig, attempt: number, options: RepairAttemptOptions): string {
  const queued = options.mockResponses?.[attempt - 1];
  if (queued !== undefined && queued.length > 0) {
    return queued;
  }
  const override = process.env.AUTOPILOT_REPAIR_MOCK_RESPONSE;
  if (override !== undefined && override.length > 0) {
    return override;
  }

  const targetFile = config.repair.allowed_files?.[0] ?? 'src/fix.ts';
  const content = '// Autopilot mock repair update\n';
  return JSON.stringify({
    mode: 'file_update',
    files: [{ path: targetFile, content }],
    notes: 'Deterministic mock repair.',
  });
}

function buildKimiRepairPrompt(
  fixTaskMd: string,
  context: {
    failingFile?: string;
    taskAllowedFiles: string[];
    maintenanceScope?: CiMaintenanceScope;
    deniedFiles: string[];
  }
): string {
  const lines: string[] = [];
  lines.push('# CI Fix Task');
  lines.push('');
  lines.push(fixTaskMd);
  lines.push('');
  lines.push('# Instructions');
  lines.push('');
  lines.push('You are repairing the CI failure described above.');
  lines.push('Return ONLY valid JSON using the file_update schema.');
  lines.push('Return full file content, not diffs.');
  lines.push('Do not include markdown outside JSON.');
  lines.push('');
  lines.push('## TASK WRITABLE FILES');
  lines.push('');
  lines.push(
    context.taskAllowedFiles.length > 0
      ? context.taskAllowedFiles.join('\n')
      : '(none — task content scope is empty for this repair)'
  );
  lines.push('');
  lines.push('## SYSTEM-AUTHORIZED CI MAINTENANCE FILES/PATTERNS');
  lines.push('');
  if (context.maintenanceScope && context.maintenanceScope.files.length > 0) {
    lines.push(context.maintenanceScope.files.join('\n'));
    lines.push('');
    lines.push('Scope authorization evidence (deterministic):');
    lines.push(context.maintenanceScope.evidence);
  } else {
    lines.push('(none — no system-authorized maintenance scope for this failure)');
  }
  lines.push('');
  lines.push('## DENIED FILES');
  lines.push('');
  lines.push(
    context.deniedFiles.length > 0
      ? context.deniedFiles.join('\n')
      : '(none configured)'
  );
  lines.push('');
  lines.push('These files must NOT be modified. In particular `.github/workflows/**` is never');
  lines.push('authorized: do NOT propose workflow edits for a missing npm script failure.');
  lines.push('');
  lines.push('## REMOTE FAILURE');
  lines.push('');
  lines.push('See the CI Fix Task above: it lists the failed job(s), failed step(s), exact');
  lines.push('errors and log excerpts from the remote CI run.');
  if (context.failingFile) {
    lines.push('');
    lines.push(`Primary failing file: ${context.failingFile}`);
  }
  return lines.join('\n');
}

/**
 * Effective writable scope for this repair attempt: task writable scope UNION
 * the deterministic system-authorized CI-maintenance scope. Workflow files
 * are always denied on top (deny wins over allow).
 */
function buildEffectiveScope(
  config: AutopilotRunConfig,
  maintenanceScope?: CiMaintenanceScope
): { allowedFiles: string[]; deniedFiles: string[] } {
  const taskAllowed = config.repair.allowed_files ?? [];
  const maintenanceFiles = maintenanceScope?.files ?? [];
  const allowedFiles = Array.from(new Set([...taskAllowed, ...maintenanceFiles]));
  const deniedFiles = Array.from(new Set([...(config.repair.denied_files ?? []), ...ALWAYS_DENIED_FILES]));
  return { allowedFiles, deniedFiles };
}

/**
 * Deterministic post-repair validation for MISSING_NPM_SCRIPT repairs.
 *
 * Proves, before any commit/push:
 *   - every previously missing npm script now exists in package.json
 *     (via the deterministic CI contract validator, which also proves
 *     referenced local target files exist),
 *   - no workflow file was part of the repair (guardrails already denied
 *     them; asserted again here deterministically),
 *   - the relevant smoke command(s) (`npm run <script>` for each previously
 *     missing script) pass locally, executed via absolute Node/npm tooling.
 */
function runMissingScriptPostValidation(
  repoPath: string,
  missingNpmScripts: string[],
  repairFiles: string[],
  spawnFn: typeof spawnSync,
  tooling: ToolingResolverOptions,
  env: NodeJS.ProcessEnv
): { ok: boolean; output: string; checks: LocalCheckEvidence[] } {
  const checks: LocalCheckEvidence[] = [];

  const workflowTouched = repairFiles.filter((f) => f.startsWith('.github/workflows/'));
  if (workflowTouched.length > 0) {
    return {
      ok: false,
      output: `Repair touched workflow files (never authorized): ${workflowTouched.join(', ')}`,
      checks,
    };
  }

  let contract;
  try {
    contract = validateRepoCiContract(repoPath);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return { ok: false, output: `CI contract validation errored: ${reason}`, checks };
  }
  if (!contract.ok) {
    return {
      ok: false,
      output: `CI contract still broken after repair:\n${contract.violations.map((v) => v.message).join('\n')}`,
      checks,
    };
  }

  const stillMissing = missingNpmScripts.filter((script) => {
    try {
      const pkg = JSON.parse(readFileSync(join(repoPath, 'package.json'), 'utf-8')) as {
        scripts?: Record<string, string>;
      };
      return !(pkg.scripts && script in pkg.scripts);
    } catch {
      return true;
    }
  });
  if (stillMissing.length > 0) {
    return {
      ok: false,
      output: `Previously missing npm scripts still missing after repair: ${stillMissing.join(', ')}`,
      checks,
    };
  }

  for (const script of missingNpmScripts) {
    const resolution = resolveNpmRun(repoPath, script, tooling);
    if (resolution.error !== null) {
      const evidence = resolutionFailureEvidence(`smoke:${script}`, resolution);
      checks.push(evidence);
      return { ok: false, output: describeCheckFailure(evidence), checks };
    }
    const evidence = runCommand(
      `smoke:${script}`,
      resolution.command,
      resolution.args,
      repoPath,
      spawnFn,
      env,
      SMOKE_COMMAND_TIMEOUT_MS
    );
    checks.push(evidence);
    if (!evidence.ok) {
      return { ok: false, output: describeCheckFailure(evidence), checks };
    }
  }

  return { ok: true, output: 'missing-script post-validation passed', checks };
}

export async function runRepairAttempt(
  config: AutopilotRunConfig,
  context: RepairAttemptContext,
  options: RepairAttemptOptions = {}
): Promise<RepairAttemptResult> {
  const spawnFn = options.spawnFn ?? defaultSpawnFn();
  const aiFactory = options.createAIClientFn ?? createAIClient;
  const tooling: ToolingResolverOptions = options.tooling ?? {};
  const env = tooling.env ?? process.env;
  const { repoPath, fixTaskMd, failingFile, reportDir, attempt } = context;

  const { allowedFiles, deniedFiles } = buildEffectiveScope(config, context.maintenanceScope);

  let rawResponse: string;

  try {
    if (config.repair.provider === 'mock') {
      rawResponse = buildMockRepairResponse(config, attempt, options);
    } else {
      if (!config.repair.allow_real_provider) {
        return {
          ok: false,
          applied: false,
          committed: false,
          pushed: false,
          reason: 'Real Kimi provider is not enabled (repair.allow_real_provider=false)',
          files: [],
        };
      }
      const apiKey = process.env.KIMI_API_KEY;
      const baseUrl = process.env.KIMI_BASE_URL;
      const model = process.env.KIMI_MODEL;
      if (!apiKey || !baseUrl || !model) {
        return {
          ok: false,
          applied: false,
          committed: false,
          pushed: false,
          reason: 'Missing KIMI_API_KEY, KIMI_BASE_URL, or KIMI_MODEL environment variable',
          files: [],
        };
      }
      const client = aiFactory({
        provider: 'kimi',
        kimi: { apiKey, baseUrl, model },
      });
      const prompt = buildKimiRepairPrompt(fixTaskMd, {
        failingFile,
        taskAllowedFiles: config.repair.allowed_files ?? [],
        maintenanceScope: context.maintenanceScope,
        deniedFiles,
      });
      rawResponse = await client.generate(prompt);
    }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      applied: false,
      committed: false,
      pushed: false,
      reason: `Provider call failed: ${reason}`,
      files: [],
    };
  }

  let files: FileUpdate[];
  try {
    const parsed = parseKimiOutputJson(rawResponse);
    files = parsed.files;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      applied: false,
      committed: false,
      pushed: false,
      reason: `Failed to parse provider output: ${reason}`,
      files: [],
    };
  }

  const paths = files.map((f) => f.path);
  const guardrailsResult = validateFileList(paths, {
    allow_modify: allowedFiles,
    deny_modify: deniedFiles,
    auto_commit: false,
    auto_push: false,
    auto_merge: false,
  });

  if (!guardrailsResult.ok) {
    return {
      ok: false,
      applied: false,
      committed: false,
      pushed: false,
      reason: `Guardrails rejected proposed files: ${guardrailsResult.reason}`,
      files: paths,
    };
  }

  let applied = false;
  if (config.repair.allow_apply) {
    const runDir = join(reportDir, `repair-attempt-${attempt}`);
    applyFileUpdates(repoPath, files, runDir);
    applied = true;
  }

  const checkResult = runLocalChecks(repoPath, failingFile, spawnFn, tooling, env);
  persistLocalCheckEvidence(reportDir, attempt, checkResult.checks);
  if (!checkResult.ok) {
    return {
      ok: false,
      applied,
      committed: false,
      pushed: false,
      reason: `Local checks failed: ${checkResult.output}`,
      files: paths,
    };
  }

  // Deterministic post-repair validation for MISSING_NPM_SCRIPT repairs.
  const missingScripts = context.missingNpmScripts ?? [];
  if (missingScripts.length > 0) {
    const post = runMissingScriptPostValidation(repoPath, missingScripts, paths, spawnFn, tooling, env);
    persistLocalCheckEvidence(reportDir, attempt, [...checkResult.checks, ...post.checks]);
    if (!post.ok) {
      return {
        ok: false,
        applied,
        committed: false,
        pushed: false,
        reason: `Post-repair validation failed: ${post.output}`,
        files: paths,
      };
    }
  }

  let committed = false;
  let pushed = false;

  if (applied && config.repair.allow_commit) {
    const addResult = spawnFn('git', ['add', ...paths], { cwd: repoPath, encoding: 'utf-8', shell: false });
    if (addResult.status === 0) {
      const commitResult = spawnFn(
        'git',
        ['commit', '-m', `ai-orchestrator: autopilot repair attempt ${attempt}`],
        { cwd: repoPath, encoding: 'utf-8', shell: false }
      );
      committed = commitResult.status === 0;
    }

    if (committed && config.repair.allow_push) {
      const pushResult = spawnFn('git', ['push'], { cwd: repoPath, encoding: 'utf-8', shell: false });
      pushed = pushResult.status === 0;
    }
  }

  return {
    ok: true,
    applied,
    committed,
    pushed,
    reason: 'Repair attempt completed and local checks passed',
    files: paths,
  };
}

function persistLocalCheckEvidence(reportDir: string, attempt: number, checks: LocalCheckEvidence[]): void {
  const dir = join(reportDir, `repair-attempt-${attempt}`);
  try {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(join(dir, 'local-checks.json'), JSON.stringify({ attempt, checks }, null, 2), 'utf-8');
  } catch {
    // Evidence persistence is best-effort; the reason string still carries the failure.
  }
}

/**
 * Local repair checks executed with absolute, PATH-independent tooling:
 *
 *   typecheck:  process.execPath <npm CLI> run typecheck
 *   build:      process.execPath <npm CLI> run build
 *   targeted:   process.execPath <tsx CLI> --test <failingFile>
 */
function runLocalChecks(
  repoPath: string,
  failingFile: string | undefined,
  spawnFn: typeof spawnSync,
  tooling: ToolingResolverOptions,
  env: NodeJS.ProcessEnv
): { ok: boolean; output: string; checks: LocalCheckEvidence[] } {
  const checks: LocalCheckEvidence[] = [];

  const typecheckResolution = resolveNpmRun(repoPath, 'typecheck', tooling);
  const typecheck =
    typecheckResolution.error !== null
      ? resolutionFailureEvidence('typecheck', typecheckResolution)
      : runCommand('typecheck', typecheckResolution.command, typecheckResolution.args, repoPath, spawnFn, env);
  checks.push(typecheck);
  if (!typecheck.ok) {
    return { ok: false, output: describeCheckFailure(typecheck), checks };
  }

  const buildResolution = resolveNpmRun(repoPath, 'build', tooling);
  const build =
    buildResolution.error !== null
      ? resolutionFailureEvidence('build', buildResolution)
      : runCommand('build', buildResolution.command, buildResolution.args, repoPath, spawnFn, env);
  checks.push(build);
  if (!build.ok) {
    return { ok: false, output: describeCheckFailure(build), checks };
  }

  if (failingFile) {
    const testResolution = resolveTsxTest(repoPath, failingFile, tooling);
    const test =
      testResolution.error !== null
        ? resolutionFailureEvidence('targeted-test', testResolution)
        : runCommand('targeted-test', testResolution.command, testResolution.args, repoPath, spawnFn, env);
    checks.push(test);
    if (!test.ok) {
      return { ok: false, output: describeCheckFailure(test), checks };
    }
  }

  return { ok: true, output: 'all local checks passed', checks };
}
