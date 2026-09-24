import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import crossSpawn from 'cross-spawn';
import { createAIClient } from '../ai-client-factory.js';
import { validateFileList } from '../guardrails.js';
import { parseKimiOutputJson } from '../kimi-output-validator.js';
import { applyFileUpdates } from '../patch-engine.js';
import { redactSecrets } from '../sandbox-preflight-repair.js';
import type { FileUpdate } from '../types.js';
import type { AutopilotRunConfig } from './types.js';

const MAX_EVIDENCE_OUTPUT_CHARS = 20000;

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
}

export interface RepairAttemptOptions {
  createAIClientFn?: typeof createAIClient;
  spawnFn?: typeof spawnSync;
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
  // cross-spawn resolves npm.cmd/npx.cmd on Windows and plain npm/npx on
  // Unix without going through a shell, keeping arguments structured.
  return crossSpawn.sync as unknown as typeof spawnSync;
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
  spawnFn: typeof spawnSync
): LocalCheckEvidence {
  const result = spawnFn(command, args, { cwd, encoding: 'utf-8', shell: false });
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

function buildMockRepairResponse(config: AutopilotRunConfig): string {
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

function buildKimiRepairPrompt(fixTaskMd: string, failingFile?: string): string {
  return (
    '# CI Fix Task\n\n' +
    fixTaskMd +
    '\n\n# Instructions\n\n' +
    'You are repairing the CI failure described above. ' +
    'Return ONLY valid JSON using the file_update schema. ' +
    'Return full file content, not diffs. ' +
    'Do not include markdown outside JSON. ' +
    'Do not modify files outside the allowed scope.\n' +
    (failingFile ? `\nPrimary failing file: ${failingFile}\n` : '')
  );
}

export async function runRepairAttempt(
  config: AutopilotRunConfig,
  context: RepairAttemptContext,
  options: RepairAttemptOptions = {}
): Promise<RepairAttemptResult> {
  const spawnFn = options.spawnFn ?? defaultSpawnFn();
  const aiFactory = options.createAIClientFn ?? createAIClient;
  const { repoPath, fixTaskMd, failingFile, reportDir, attempt } = context;

  let rawResponse: string;

  try {
    if (config.repair.provider === 'mock') {
      rawResponse = buildMockRepairResponse(config);
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
      const prompt = buildKimiRepairPrompt(fixTaskMd, failingFile);
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
    allow_modify: config.repair.allowed_files,
    deny_modify: config.repair.denied_files,
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

  const checkResult = runLocalChecks(repoPath, failingFile, spawnFn);
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

function runLocalChecks(
  repoPath: string,
  failingFile: string | undefined,
  spawnFn: typeof spawnSync
): { ok: boolean; output: string; checks: LocalCheckEvidence[] } {
  const checks: LocalCheckEvidence[] = [];

  const typecheck = runCommand('typecheck', 'npm', ['run', 'typecheck'], repoPath, spawnFn);
  checks.push(typecheck);
  if (!typecheck.ok) {
    return { ok: false, output: describeCheckFailure(typecheck), checks };
  }

  const build = runCommand('build', 'npm', ['run', 'build'], repoPath, spawnFn);
  checks.push(build);
  if (!build.ok) {
    return { ok: false, output: describeCheckFailure(build), checks };
  }

  if (failingFile) {
    const test = runCommand('targeted-test', 'npx', ['tsx', '--test', failingFile], repoPath, spawnFn);
    checks.push(test);
    if (!test.ok) {
      return { ok: false, output: describeCheckFailure(test), checks };
    }
  }

  return { ok: true, output: 'all local checks passed', checks };
}
