import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { createAIClient } from '../ai-client-factory.js';
import { validateFileList } from '../guardrails.js';
import { parseKimiOutputJson } from '../kimi-output-validator.js';
import { applyFileUpdates } from '../patch-engine.js';
import type { FileUpdate } from '../types.js';
import type { AutopilotRunConfig } from './types.js';

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
  return spawnSync;
}

function runCommand(
  command: string,
  args: string[],
  cwd: string,
  spawnFn: typeof spawnSync
): { ok: boolean; output: string } {
  const result = spawnFn(command, args, { cwd, encoding: 'utf-8', shell: false });
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`.trim();
  return { ok: result.status === 0, output };
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

function runLocalChecks(
  repoPath: string,
  failingFile: string | undefined,
  spawnFn: typeof spawnSync
): { ok: boolean; output: string } {
  const typecheck = runCommand('npm', ['run', 'typecheck'], repoPath, spawnFn);
  if (!typecheck.ok) {
    return { ok: false, output: `typecheck failed:\n${typecheck.output}` };
  }

  const build = runCommand('npm', ['run', 'build'], repoPath, spawnFn);
  if (!build.ok) {
    return { ok: false, output: `build failed:\n${build.output}` };
  }

  if (failingFile) {
    const test = runCommand('npx', ['tsx', '--test', failingFile], repoPath, spawnFn);
    if (!test.ok) {
      return { ok: false, output: `targeted test failed:\n${test.output}` };
    }
  }

  return { ok: true, output: 'all local checks passed' };
}
