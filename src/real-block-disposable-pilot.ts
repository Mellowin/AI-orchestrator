import { readFileSync, existsSync } from 'node:fs';
import { resolve, join, isAbsolute, dirname } from 'node:path';
import { redactSecrets } from './sandbox-preflight-repair.js';

export type CommandRunner = (
  args: string[],
  env: NodeJS.ProcessEnv
) => Promise<{ exitCode: number; stdout: string; stderr: string }>;

export interface DisposablePilotInput {
  blockPath: string;
  provider: string;
  timeoutMs: number;
  projectRoot: string;
  env: NodeJS.ProcessEnv;
  runCommand: CommandRunner;
}

export interface DisposablePilotTaskProbeResult {
  taskId: string;
  ok: boolean;
  reviewerDecision?: string;
  exitCode: number;
  skipped?: boolean;
  stdout?: string;
}

export interface DisposablePilotSafety {
  projectRepoClean: boolean;
  workflowChanged: boolean;
  mainMergePerformed: boolean;
  tokenLeakDetected: boolean;
}

export interface DisposablePilotResult {
  ok: boolean;
  blockId?: string;
  repoPath?: string;
  provider?: string;
  preflight?: { ok: boolean; exitCode: number };
  taskProbes?: DisposablePilotTaskProbeResult[];
  run?: { exitCode: number; status?: string; stateFile?: string };
  report?: { exitCode: number };
  safety?: DisposablePilotSafety;
  error?: string;
}

interface BlockDefinition {
  block_id: string;
  repo_path: string;
  base_branch: string;
  work_branch: string;
  tasks?: Array<{
    task_id: string;
    status?: string;
  }>;
}

function isAllowRealProvider(env: NodeJS.ProcessEnv): boolean {
  return env.ALLOW_REAL_PROVIDER === 'true' || env.ALLOW_REAL_PROVIDER === '1';
}

function hasMutationOptIns(env: NodeJS.ProcessEnv): boolean {
  return (
    env.REAL_BLOCK_RUN_AI === '1' &&
    env.ALLOW_REAL_REPO_APPLY === 'true' &&
    env.ALLOW_REAL_REPO_COMMIT === 'true' &&
    env.ALLOW_REAL_REPO_PUSH === 'true'
  );
}

function parseJsonSafely(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function validateBlockDefinition(block: unknown): BlockDefinition {
  if (block === null || typeof block !== 'object') {
    throw new Error('Block definition must be an object');
  }
  const b = block as Record<string, unknown>;
  if (typeof b.block_id !== 'string' || b.block_id.trim() === '') {
    throw new Error('Block definition missing required field: block_id');
  }
  if (typeof b.repo_path !== 'string' || b.repo_path.trim() === '') {
    throw new Error('Block definition missing required field: repo_path');
  }
  if (typeof b.base_branch !== 'string' || b.base_branch.trim() === '') {
    throw new Error('Block definition missing required field: base_branch');
  }
  if (typeof b.work_branch !== 'string' || b.work_branch.trim() === '') {
    throw new Error('Block definition missing required field: work_branch');
  }
  const lowerWorkBranch = b.work_branch.toLowerCase();
  if (lowerWorkBranch === 'main' || lowerWorkBranch === 'master') {
    throw new Error('work_branch must not be main or master');
  }
  return {
    block_id: b.block_id,
    repo_path: b.repo_path,
    base_branch: b.base_branch,
    work_branch: b.work_branch,
    tasks: Array.isArray(b.tasks)
      ? b.tasks.map((t) => ({
          task_id: String((t as Record<string, unknown>).task_id ?? ''),
          status: String((t as Record<string, unknown>).status ?? 'pending'),
        }))
      : undefined,
  };
}

function validateRepoPath(repoPath: string, projectRoot: string): void {
  const resolvedRepo = resolve(repoPath);
  const resolvedProject = resolve(projectRoot);
  if (!existsSync(resolvedRepo)) {
    throw new Error(`repo_path does not exist: ${repoPath}`);
  }
  if (resolvedRepo === resolvedProject) {
    throw new Error('repo_path must not be the current project repo');
  }
  const prefix = resolvedProject.endsWith('/') ? resolvedProject : `${resolvedProject}\\`;
  if (resolvedRepo === resolvedProject || resolvedRepo.startsWith(prefix)) {
    throw new Error('repo_path must not be inside the current project repo');
  }
}

function getRunsDir(projectRoot: string, env: NodeJS.ProcessEnv): string {
  const raw = env.RUNS_DIR || 'runs';
  if (isAbsolute(raw)) {
    return raw;
  }
  return resolve(projectRoot, raw);
}

function getStateFilePath(blockId: string, projectRoot: string, env: NodeJS.ProcessEnv): string {
  return join(getRunsDir(projectRoot, env), 'block', blockId, 'state.json');
}

function looksLikeTokenLeak(text: string): boolean {
  return (
    /\bsk-[a-zA-Z0-9_-]+\b/.test(text) ||
    /\bpk-[a-zA-Z0-9_-]+\b/.test(text) ||
    /\bBearer\s+[a-zA-Z0-9_-]+\b/.test(text) ||
    /\bKIMI_API_KEY\b/.test(text)
  );
}

async function runGitStatus(projectRoot: string): Promise<string> {
  const { spawnSync } = await import('node:child_process');
  const result = spawnSync('git', ['status', '--short'], {
    cwd: projectRoot,
    encoding: 'utf-8',
    shell: false,
  });
  return result.stdout || '';
}

async function runWorkflowDiff(projectRoot: string): Promise<string> {
  const { spawnSync } = await import('node:child_process');
  const result = spawnSync('git', ['diff', '--', '.github/workflows/'], {
    cwd: projectRoot,
    encoding: 'utf-8',
    shell: false,
  });
  return result.stdout || '';
}

function redactResult(result: DisposablePilotResult): DisposablePilotResult {
  const redact = (value: unknown): unknown => {
    if (typeof value === 'string') {
      return redactSecrets(value);
    }
    if (Array.isArray(value)) {
      return value.map(redact);
    }
    if (value !== null && typeof value === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        out[k] = redact(v);
      }
      return out;
    }
    return value;
  };
  return redact(result) as DisposablePilotResult;
}

export async function runDisposablePilot(
  input: DisposablePilotInput
): Promise<DisposablePilotResult> {
  const { blockPath, provider, timeoutMs, projectRoot, env, runCommand } = input;

  if (!isAllowRealProvider(env)) {
    return {
      ok: false,
      error: 'ALLOW_REAL_PROVIDER=true or ALLOW_REAL_PROVIDER=1 is required',
    };
  }

  if (!existsSync(blockPath)) {
    return { ok: false, error: `Block definition file not found: ${blockPath}` };
  }

  let block: BlockDefinition;
  try {
    const raw = readFileSync(blockPath, 'utf-8');
    const parsed = parseJsonSafely(raw);
    block = validateBlockDefinition(parsed);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: redactSecrets(message) };
  }

  try {
    validateRepoPath(block.repo_path, projectRoot);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: redactSecrets(message) };
  }

  const baseEnv = { ...env };
  const result: DisposablePilotResult = {
    ok: false,
    blockId: block.block_id,
    repoPath: resolve(block.repo_path),
    provider,
  };

  // Preflight
  const preflightResult = await runCommand(
    ['real-block-preflight', blockPath, '--provider', provider, '--timeout-ms', String(timeoutMs)],
    baseEnv
  );
  const preflightJson = parseJsonSafely(preflightResult.stdout) as Record<string, unknown> | undefined;
  result.preflight = {
    ok: preflightResult.exitCode === 0 && preflightJson?.ok === true,
    exitCode: preflightResult.exitCode,
  };

  if (!result.preflight.ok) {
    result.error = 'Preflight failed';
    result.safety = await computeSafety(projectRoot, result, false);
    return redactResult(result);
  }

  // Task probes
  const pendingTasks = (block.tasks ?? []).filter(
    (t) => (t.status ?? 'pending') === 'pending'
  );
  result.taskProbes = [];

  for (const task of pendingTasks) {
    const probeResult = await runCommand(
      [
        'real-block-task-probe',
        blockPath,
        '--provider',
        provider,
        '--task-id',
        task.task_id,
        '--timeout-ms',
        String(timeoutMs),
      ],
      baseEnv
    );
    const probeJson = parseJsonSafely(probeResult.stdout) as Record<string, unknown> | undefined;
    const decision = probeJson?.reviewer && typeof probeJson.reviewer === 'object'
      ? String((probeJson.reviewer as Record<string, unknown>).decision ?? '')
      : undefined;
    result.taskProbes.push({
      taskId: task.task_id,
      ok: probeResult.exitCode === 0 && probeJson?.ok === true,
      reviewerDecision: decision,
      exitCode: probeResult.exitCode,
      stdout: probeResult.stdout,
    });
  }

  const allProbesOk = result.taskProbes.every((p) => p.ok);
  if (!allProbesOk) {
    result.error = 'One or more task probes failed';
    result.safety = await computeSafety(projectRoot, result, false);
    return redactResult(result);
  }

  if (pendingTasks.length === 0) {
    result.error = 'No pending tasks to run';
    result.safety = await computeSafety(projectRoot, result, false);
    return redactResult(result);
  }

  if (!hasMutationOptIns(baseEnv)) {
    result.error =
      'Mutation opt-ins required: REAL_BLOCK_RUN_AI=1, ALLOW_REAL_REPO_APPLY=true, ALLOW_REAL_REPO_COMMIT=true, ALLOW_REAL_REPO_PUSH=true';
    result.safety = await computeSafety(projectRoot, result, false);
    return redactResult(result);
  }

  // Real block run
  const runResult = await runCommand(['real-block-run-ai', blockPath], baseEnv);
  const stateFile = getStateFilePath(block.block_id, projectRoot, baseEnv);
  result.run = {
    exitCode: runResult.exitCode,
    stateFile,
  };

  if (existsSync(stateFile)) {
    try {
      const stateRaw = readFileSync(stateFile, 'utf-8');
      const stateJson = parseJsonSafely(stateRaw) as Record<string, unknown> | undefined;
      if (stateJson && typeof stateJson.status === 'string') {
        result.run.status = stateJson.status;
      }
    } catch {
      // ignore state read errors
    }
  }

  // Report
  if (existsSync(stateFile)) {
    const reportResult = await runCommand(['real-block-run-ai-report', stateFile], baseEnv);
    result.report = { exitCode: reportResult.exitCode };
  } else {
    result.report = { exitCode: -1 };
  }

  result.ok = runResult.exitCode === 0 && result.run.status === 'completed';
  result.safety = await computeSafety(projectRoot, result, false);

  if (!result.safety.projectRepoClean || result.safety.workflowChanged) {
    result.ok = false;
    if (!result.error) {
      result.error = 'Project repo safety check failed';
    }
  }

  return redactResult(result);
}

async function computeSafety(
  projectRoot: string,
  result: DisposablePilotResult,
  mainMergePerformed: boolean
): Promise<DisposablePilotSafety> {
  const projectRepoClean = (await runGitStatus(projectRoot)).trim() === '';
  const workflowChanged = (await runWorkflowDiff(projectRoot)).trim() !== '';
  const summaryText = JSON.stringify(result);
  const tokenLeakDetected = looksLikeTokenLeak(summaryText);
  return {
    projectRepoClean,
    workflowChanged,
    mainMergePerformed,
    tokenLeakDetected,
  };
}
