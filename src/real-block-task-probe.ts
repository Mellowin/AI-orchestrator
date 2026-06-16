import { loadBlockDefinition } from './block/block-loader.js';
import type { BlockDefinition, BlockTaskDefinition } from './block/block-types.js';
import { createKimiClient } from './kimi-client.js';
import { createMockAIClient } from './ai-client.js';
import { redactSecrets } from './sandbox-preflight-repair.js';
import { validateReviewerDecision } from './reviewer/reviewer-schema.js';
import { validateRealBlockFile } from './real-block-validate.js';
import { normalizeRealProviderSmokeProvider } from './real-provider-smoke.js';

export interface CoderProbeResult {
  ok: boolean;
  contractValid: boolean;
  summaryPreview?: string;
  fileCount?: number;
  paths?: string[];
  responsePreview?: string;
  error?: string;
}

export interface ReviewerProbeResult {
  ok: boolean;
  contractValid: boolean;
  decision?: string;
  summaryPreview?: string;
  responsePreview?: string;
  error?: string;
}

export interface RealBlockTaskProbeReport {
  ok: boolean;
  mode: 'real-block-task-probe';
  blockPath: string;
  blockId: string;
  taskId: string;
  provider: string;
  timeoutMs: number;
  coder: CoderProbeResult;
  reviewer: ReviewerProbeResult;
  mutated: false;
  reasons: string[];
  nextCommands: string[];
}

const DEFAULT_TIMEOUT_MS = 15000;
const MIN_TIMEOUT_MS = 1000;
const MAX_TIMEOUT_MS = 60000;
const MAX_RESPONSE_PREVIEW_CHARS = 500;
const MAX_SUMMARY_LENGTH = 300;
const MAX_CONTENT_LENGTH = 2000;

function getEnv(env: NodeJS.ProcessEnv, name: string): string | undefined {
  return env[name]?.trim();
}

function isOptInEnabled(value: string | undefined): boolean {
  return value === 'true' || value === '1';
}

export function parseRealBlockTaskProbeTimeoutMs(
  env: NodeJS.ProcessEnv,
  overrideMs?: number
): number {
  let raw: string | undefined;
  if (overrideMs !== undefined) {
    raw = String(overrideMs);
  } else {
    raw = getEnv(env, 'REAL_BLOCK_TASK_PROBE_TIMEOUT_MS');
  }

  if (raw === undefined || raw === '') {
    return DEFAULT_TIMEOUT_MS;
  }

  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error('Invalid timeout: must be a non-negative integer');
  }
  if (parsed === 0) {
    throw new Error('Invalid timeout: timeout must be greater than 0');
  }
  if (parsed < MIN_TIMEOUT_MS) {
    return MIN_TIMEOUT_MS;
  }
  if (parsed > MAX_TIMEOUT_MS) {
    return MAX_TIMEOUT_MS;
  }
  return parsed;
}

function looksLikeSecret(value: string): boolean {
  const lower = value.toLowerCase();
  return (
    /^\s*(sk-|pk-|Bearer|ghp_|github_pat_)/.test(value) ||
    /(secret|token|key|password)/i.test(lower)
  );
}

function containsSecretLike(value: unknown): boolean {
  if (typeof value === 'string') {
    return looksLikeSecret(value);
  }
  if (Array.isArray(value)) {
    return value.some(containsSecretLike);
  }
  return false;
}

function redactSecretLike(text: string): string {
  return redactSecrets(text)
    .replace(/(\b|^)(sk-|pk-|Bearer|ghp_|github_pat_)\S+/gi, '$1$2[REDACTED]')
    .replace(/\b(secret|token|key|password)\b\s*\S*/gi, '[REDACTED]');
}

function makeBoundedPreview(text: string): string {
  const clamped =
    text.length > MAX_RESPONSE_PREVIEW_CHARS
      ? text.slice(0, MAX_RESPONSE_PREVIEW_CHARS) + '...'
      : text;
  return redactSecretLike(clamped);
}

function extractJsonFromText(text: string): unknown {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenceMatch && fenceMatch[1]) {
      try {
        return JSON.parse(fenceMatch[1].trim());
      } catch {
        throw new Error(`Provider response is not valid JSON. Preview: ${makeBoundedPreview(text)}`);
      }
    }
    throw new Error(`Provider response is not valid JSON. Preview: ${makeBoundedPreview(text)}`);
  }
}

interface ProbeContractFile {
  path: string;
  content: string;
}

interface ProbeContractResponse {
  summary: string;
  files: ProbeContractFile[];
  notes?: string[];
}

function validateProbeCoderResponse(
  value: unknown,
  task: BlockTaskDefinition
): ProbeContractResponse {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Contract response JSON is not an object');
  }
  const obj = value as Record<string, unknown>;

  if (typeof obj.summary !== 'string') {
    throw new Error('Contract response is missing summary');
  }
  if (obj.summary.length > MAX_SUMMARY_LENGTH) {
    throw new Error('Contract response summary is too long');
  }
  if (looksLikeSecret(obj.summary)) {
    throw new Error('Contract response summary contains secret-like text');
  }

  if (!Array.isArray(obj.files)) {
    throw new Error('Contract response is missing files array');
  }
  if (obj.files.length !== 1) {
    throw new Error(`Contract response must contain exactly one file, got ${obj.files.length}`);
  }

  const file = obj.files[0];
  if (typeof file !== 'object' || file === null || Array.isArray(file)) {
    throw new Error('Contract response file is not an object');
  }
  const fileObj = file as Record<string, unknown>;

  if (typeof fileObj.path !== 'string') {
    throw new Error('Contract response file is missing path');
  }
  if (fileObj.path.length > 500) {
    throw new Error('Contract response file path is too long');
  }
  if (looksLikeSecret(fileObj.path)) {
    throw new Error('Contract response file path contains secret-like text');
  }

  const normalizedPath = fileObj.path.replace(/\\/g, '/');
  const allowed = task.allowed_files.map((p) => p.replace(/\\/g, '/'));
  const denied = task.denied_files.map((p) => p.replace(/\\/g, '/'));

  if (!allowed.some((p) => normalizedPath === p)) {
    throw new Error(
      `Proposed file path ${fileObj.path} is not in task allowed_files [${allowed.join(', ')}]`
    );
  }
  if (denied.some((p) => normalizedPath === p)) {
    throw new Error(`Proposed file path ${fileObj.path} is in task denied_files`);
  }

  if (typeof fileObj.content !== 'string') {
    throw new Error('Contract response file is missing content');
  }
  if (fileObj.content.length > MAX_CONTENT_LENGTH) {
    throw new Error('Contract response file content is too long');
  }
  if (looksLikeSecret(fileObj.content)) {
    throw new Error('Contract response file content contains secret-like text');
  }

  if (obj.notes !== undefined && !Array.isArray(obj.notes)) {
    throw new Error('Contract response notes must be an array of strings');
  }
  if (Array.isArray(obj.notes)) {
    for (const note of obj.notes) {
      if (typeof note !== 'string') {
        throw new Error('Contract response notes must be an array of strings');
      }
      if (looksLikeSecret(note)) {
        throw new Error('Contract response note contains secret-like text');
      }
    }
  }

  const notes = obj.notes === undefined ? [] : (obj.notes as string[]);
  return {
    summary: obj.summary,
    files: [{ path: fileObj.path, content: fileObj.content }],
    notes,
  };
}

function buildCoderProbePrompt(task: BlockTaskDefinition): string {
  return (
    'You are a coding assistant. Return ONLY valid JSON with no markdown and no extra text. ' +
    'The JSON must describe a patch plan with this exact shape: ' +
    '{"summary":"short description","files":[{"path":"<relative-file-path>","content":"new file content"}],"notes":[]}. ' +
    `Task goal: ${task.goal}\n` +
    `Allowed files you may modify: ${JSON.stringify(task.allowed_files)}\n` +
    `Denied files you must NOT modify: ${JSON.stringify(task.denied_files)}\n` +
    `Max lines changed allowed: ${task.max_lines_changed}\n` +
    `Checks the change must pass: ${JSON.stringify(task.checks)}\n` +
    'Rules: modify only files from allowed_files, do not include any files from denied_files, ' +
    'do not include any secrets, tokens, or API keys, return exactly one file in the files array.'
  );
}

function buildReviewerProbePrompt(
  task: BlockTaskDefinition,
  coderPlan: ProbeContractResponse
): string {
  return (
    'You are a code reviewer. Review the proposed patch plan below. ' +
    'Return ONLY a single JSON object with no markdown and no extra text. ' +
    'Use this exact schema:\n' +
    '{\n' +
    '  "decision": "accepted" | "rejected",\n' +
    '  "confidence": "low" | "medium" | "high",\n' +
    '  "blocking_issues": ["..."],\n' +
    '  "non_blocking_issues": ["..."],\n' +
    '  "review_summary": "short summary",\n' +
    '  "fix_task": "..." | null,\n' +
    '  "next_action": "advance_to_next_task" | "send_fix_to_coder" | "block_for_human"\n' +
    '}\n' +
    'Rules: accepted must have empty blocking_issues and next_action "advance_to_next_task". ' +
    'rejected must have at least one blocking_issue or a non-empty fix_task, ' +
    'and next_action must be "send_fix_to_coder" or "block_for_human". ' +
    'Do not include any secrets, tokens, or API keys.\n\n' +
    `Task goal: ${task.goal}\n` +
    `Allowed files: ${JSON.stringify(task.allowed_files)}\n` +
    `Denied files: ${JSON.stringify(task.denied_files)}\n` +
    `Checks: ${JSON.stringify(task.checks)}\n\n` +
    `Proposed patch summary: ${coderPlan.summary}\n` +
    `Proposed files: ${JSON.stringify(coderPlan.files.map((f) => f.path))}\n`
  );
}

function createTimeoutFetch(timeoutMs: number, underlyingFetch: typeof fetch): typeof fetch {
  return (input, init) =>
    underlyingFetch(input, {
      ...init,
      signal: AbortSignal.timeout(timeoutMs),
    });
}

function isAbortError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (err.name === 'AbortError') return true;
  const lower = err.message.toLowerCase();
  return lower.includes('timed out') || lower.includes('aborted');
}

function validateProbeEnv(env: NodeJS.ProcessEnv): { apiKey: string; baseUrl: string; model: string } {
  const allowReal = getEnv(env, 'ALLOW_REAL_PROVIDER');
  if (!isOptInEnabled(allowReal)) {
    throw new Error('ALLOW_REAL_PROVIDER=true or ALLOW_REAL_PROVIDER=1 is required');
  }

  const apiKey = getEnv(env, 'KIMI_API_KEY');
  if (!apiKey) {
    throw new Error('KIMI_API_KEY env var is required');
  }

  const baseUrl = getEnv(env, 'KIMI_BASE_URL');
  if (!baseUrl) {
    throw new Error('KIMI_BASE_URL env var is required');
  }

  const model = getEnv(env, 'KIMI_MODEL') || 'kimi-k2.6';
  return { apiKey, baseUrl, model };
}

function selectTask(block: BlockDefinition, taskId?: string): BlockTaskDefinition {
  if (taskId !== undefined && taskId.trim() !== '') {
    const task = block.tasks.find((t) => t.task_id === taskId.trim());
    if (!task) {
      throw new Error(`Task ${taskId} not found in block`);
    }
    return task;
  }
  if (block.tasks.length === 0) {
    throw new Error('Block has no tasks');
  }
  return block.tasks[0];
}

function validateTaskSafety(block: BlockDefinition, task: BlockTaskDefinition): string[] {
  const reasons: string[] = [];
  if (block.work_branch === 'main') {
    reasons.push('work_branch must not be "main"');
  }
  if (block.work_branch === block.base_branch) {
    reasons.push('work_branch must not equal base_branch');
  }
  if (task.allowed_files.length === 0) {
    reasons.push('Task allowed_files must not be empty');
  }
  if (task.checks.length === 0) {
    reasons.push('Task checks must not be empty');
  }
  return reasons;
}

async function runCoderProbe(
  task: BlockTaskDefinition,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
  fetchFn?: typeof fetch
): Promise<CoderProbeResult> {
  const fakeResponse = getEnv(env, 'REAL_BLOCK_TASK_PROBE_FAKE_CODER_RESPONSE');
  let client: { generate(prompt: string): Promise<string> };
  if (fakeResponse !== undefined) {
    client = createMockAIClient(fakeResponse);
  } else {
    const { apiKey, baseUrl, model } = validateProbeEnv(env);
    const effectiveFetch = createTimeoutFetch(timeoutMs, fetchFn ?? fetch);
    client = createKimiClient({ apiKey, model, baseUrl, fetchFn: effectiveFetch });
  }

  try {
    const raw = await client.generate(buildCoderProbePrompt(task));
    if (looksLikeSecret(raw)) {
      throw new Error('Coder response contains secret-like text');
    }
    const parsed = extractJsonFromText(raw);
    const contract = validateProbeCoderResponse(parsed, task);
    return {
      ok: true,
      contractValid: true,
      summaryPreview: contract.summary,
      fileCount: contract.files.length,
      paths: contract.files.map((f) => f.path),
    };
  } catch (err) {
    if (isAbortError(err)) {
      return {
        ok: false,
        contractValid: false,
        error: 'Coder probe timed out',
      };
    }
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      contractValid: false,
      error: redactSecrets(message),
    };
  }
}

async function runReviewerProbe(
  task: BlockTaskDefinition,
  coderPlan: ProbeContractResponse,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
  fetchFn?: typeof fetch
): Promise<ReviewerProbeResult> {
  const fakeResponse = getEnv(env, 'REAL_BLOCK_TASK_PROBE_FAKE_REVIEWER_RESPONSE');
  let client: { generate(prompt: string): Promise<string> };
  if (fakeResponse !== undefined) {
    client = createMockAIClient(fakeResponse);
  } else {
    const { apiKey, baseUrl, model } = validateProbeEnv(env);
    const effectiveFetch = createTimeoutFetch(timeoutMs, fetchFn ?? fetch);
    client = createKimiClient({ apiKey, model, baseUrl, fetchFn: effectiveFetch });
  }

  try {
    const raw = await client.generate(buildReviewerProbePrompt(task, coderPlan));
    if (looksLikeSecret(raw)) {
      throw new Error('Reviewer response contains secret-like text');
    }
    const parsed = extractJsonFromText(raw);
    const decision = validateReviewerDecision(parsed);

    if (
      containsSecretLike(decision.decision) ||
      containsSecretLike(decision.confidence) ||
      containsSecretLike(decision.review_summary) ||
      containsSecretLike(decision.fix_task) ||
      containsSecretLike(decision.blocking_issues) ||
      containsSecretLike(decision.non_blocking_issues) ||
      containsSecretLike(decision.next_action)
    ) {
      throw new Error('Reviewer decision contains secret-like text');
    }

    return {
      ok: true,
      contractValid: true,
      decision: decision.decision,
      summaryPreview: decision.review_summary,
    };
  } catch (err) {
    if (isAbortError(err)) {
      return {
        ok: false,
        contractValid: false,
        error: 'Reviewer probe timed out',
      };
    }
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      contractValid: false,
      error: redactSecrets(message),
    };
  }
}

export async function runRealBlockTaskProbe(options: {
  blockPath: string;
  provider?: string;
  taskId?: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  fetchFn?: typeof fetch;
}): Promise<RealBlockTaskProbeReport> {
  const env = options.env ?? process.env;
  const rawProvider = options.provider?.trim() ?? 'kimi';
  const providerCheck = normalizeRealProviderSmokeProvider(rawProvider);
  const provider = providerCheck.provider;

  let timeoutMs: number;
  try {
    timeoutMs = parseRealBlockTaskProbeTimeoutMs(env, options.timeoutMs);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      mode: 'real-block-task-probe',
      blockPath: options.blockPath,
      blockId: '',
      taskId: options.taskId ?? '',
      provider,
      timeoutMs: DEFAULT_TIMEOUT_MS,
      coder: { ok: false, contractValid: false, error: redactSecretLike(message) },
      reviewer: { ok: false, contractValid: false, error: redactSecretLike(message) },
      mutated: false,
      reasons: [redactSecretLike(message)],
      nextCommands: [],
    };
  }

  if (!providerCheck.supported) {
    return {
      ok: false,
      mode: 'real-block-task-probe',
      blockPath: options.blockPath,
      blockId: '',
      taskId: options.taskId ?? '',
      provider,
      timeoutMs,
      coder: { ok: false, contractValid: false, error: providerCheck.error },
      reviewer: { ok: false, contractValid: false, error: providerCheck.error },
      mutated: false,
      reasons: [providerCheck.error ?? 'Unsupported provider'],
      nextCommands: [],
    };
  }

  let block: BlockDefinition;
  try {
    block = loadBlockDefinition(options.blockPath);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      mode: 'real-block-task-probe',
      blockPath: options.blockPath,
      blockId: '',
      taskId: options.taskId ?? '',
      provider,
      timeoutMs,
      coder: { ok: false, contractValid: false, error: redactSecretLike(message) },
      reviewer: { ok: false, contractValid: false, error: redactSecretLike(message) },
      mutated: false,
      reasons: [redactSecretLike(message)],
      nextCommands: [],
    };
  }

  const validationReport = validateRealBlockFile(options.blockPath, { strict: true });
  if (!validationReport.ok) {
    const reasons: string[] = ['Strict block validation failed'];
    if (validationReport.reasons && validationReport.reasons.length > 0) {
      reasons.push(...validationReport.reasons);
    } else if (validationReport.warnings && validationReport.warnings.length > 0) {
      reasons.push(...validationReport.warnings);
    }
    return {
      ok: false,
      mode: 'real-block-task-probe',
      blockPath: options.blockPath,
      blockId: block.block_id,
      taskId: options.taskId ?? '',
      provider,
      timeoutMs,
      coder: { ok: false, contractValid: false },
      reviewer: { ok: false, contractValid: false },
      mutated: false,
      reasons: reasons.map((r) => redactSecretLike(r)),
      nextCommands: [],
    };
  }

  let task: BlockTaskDefinition;
  try {
    task = selectTask(block, options.taskId);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      mode: 'real-block-task-probe',
      blockPath: options.blockPath,
      blockId: block.block_id,
      taskId: options.taskId ?? '',
      provider,
      timeoutMs,
      coder: { ok: false, contractValid: false, error: redactSecretLike(message) },
      reviewer: { ok: false, contractValid: false, error: redactSecretLike(message) },
      mutated: false,
      reasons: [redactSecretLike(message)],
      nextCommands: [],
    };
  }

  const safetyReasons = validateTaskSafety(block, task);
  if (safetyReasons.length > 0) {
    return {
      ok: false,
      mode: 'real-block-task-probe',
      blockPath: options.blockPath,
      blockId: block.block_id,
      taskId: task.task_id,
      provider,
      timeoutMs,
      coder: { ok: false, contractValid: false },
      reviewer: { ok: false, contractValid: false },
      mutated: false,
      reasons: safetyReasons.map((r) => redactSecretLike(r)),
      nextCommands: [],
    };
  }

  let envError: string | undefined;
  try {
    validateProbeEnv(env);
  } catch (err) {
    envError = err instanceof Error ? err.message : String(err);
  }

  if (envError !== undefined) {
    return {
      ok: false,
      mode: 'real-block-task-probe',
      blockPath: options.blockPath,
      blockId: block.block_id,
      taskId: task.task_id,
      provider,
      timeoutMs,
      coder: { ok: false, contractValid: false, error: redactSecretLike(envError) },
      reviewer: { ok: false, contractValid: false, error: redactSecretLike(envError) },
      mutated: false,
      reasons: [redactSecretLike(envError)],
      nextCommands: [],
    };
  }

  const coderResult = await runCoderProbe(task, env, timeoutMs, options.fetchFn);
  if (!coderResult.ok) {
    return {
      ok: false,
      mode: 'real-block-task-probe',
      blockPath: options.blockPath,
      blockId: block.block_id,
      taskId: task.task_id,
      provider,
      timeoutMs,
      coder: coderResult,
      reviewer: { ok: false, contractValid: false, error: 'Skipped due to coder failure' },
      mutated: false,
      reasons: [
        'Coder probe failed',
        ...(coderResult.error ? [redactSecretLike(coderResult.error)] : []),
      ],
      nextCommands: [],
    };
  }

  const coderPlan: ProbeContractResponse = {
    summary: coderResult.summaryPreview ?? '',
    files: (coderResult.paths ?? []).map((p) => ({ path: p, content: '' })),
    notes: [],
  };
  const reviewerResult = await runReviewerProbe(task, coderPlan, env, timeoutMs, options.fetchFn);

  const ok = coderResult.ok && reviewerResult.ok;
  const reasons: string[] = [];
  if (!coderResult.ok) {
    reasons.push('Coder probe failed');
    if (coderResult.error) reasons.push(redactSecretLike(coderResult.error));
  }
  if (!reviewerResult.ok) {
    reasons.push('Reviewer probe failed');
    if (reviewerResult.error) reasons.push(redactSecretLike(reviewerResult.error));
  }

  const nextCommands = ok
    ? [
        `npx tsx src/cli.ts real-block-run-ai ${options.blockPath}`,
        `npx tsx src/cli.ts real-block-run-ai-report runs/block/${block.block_id}/state.json`,
      ]
    : [];

  return {
    ok,
    mode: 'real-block-task-probe',
    blockPath: options.blockPath,
    blockId: block.block_id,
    taskId: task.task_id,
    provider,
    timeoutMs,
    coder: coderResult,
    reviewer: reviewerResult,
    mutated: false,
    reasons: reasons.map((r) => redactSecretLike(r)),
    nextCommands,
  };
}

export function formatRealBlockTaskProbeReport(report: RealBlockTaskProbeReport): string {
  return JSON.stringify(
    report,
    (_key, value) => (typeof value === 'string' ? redactSecretLike(value) : value),
    2
  );
}
