import { createKimiClient } from './kimi-client.js';
import { createMockAIClient } from './ai-client.js';
import { redactSecrets } from './sandbox-preflight-repair.js';

export interface RealCoderContractSmokeReport {
  ok: boolean;
  mode: 'real-coder-contract-smoke';
  provider: string;
  supported: boolean;
  contractValid: boolean;
  summaryPreview?: string;
  fileCount?: number;
  paths?: string[];
  timeoutMs?: number;
  responsePreview?: string;
  error?: string;
}

const DEFAULT_TIMEOUT_MS = 15000;
const MIN_TIMEOUT_MS = 1000;
const MAX_TIMEOUT_MS = 60000;
const MAX_RESPONSE_PREVIEW_CHARS = 500;
const MAX_SUMMARY_LENGTH = 300;
const MAX_CONTENT_LENGTH = 2000;
const EXPECTED_FILE_PATH = 'README.md';

const SAFE_PROVIDER_NAME_PATTERN = /^[A-Za-z0-9_-]{1,40}$/;
const SUPPORTED_PROVIDERS = new Set(['kimi']);

function looksLikeSecret(value: string): boolean {
  const lower = value.toLowerCase();
  return (
    /^\s*(sk-|pk-|Bearer|ghp_|github_pat_)/.test(value) ||
    /(secret|token|key|password)/i.test(lower)
  );
}

function getEnv(env: NodeJS.ProcessEnv, name: string): string | undefined {
  return env[name]?.trim();
}

export function normalizeRealCoderContractSmokeProvider(raw: string | undefined): {
  provider: string;
  supported: boolean;
  error?: string;
} {
  const name = raw?.trim() ?? 'kimi';
  const isSafeShape = SAFE_PROVIDER_NAME_PATTERN.test(name) && !looksLikeSecret(name);
  const safeName = isSafeShape ? name : 'unknown';

  if (SUPPORTED_PROVIDERS.has(name)) {
    return { provider: name, supported: true };
  }

  return {
    provider: safeName,
    supported: false,
    error: 'Unsupported provider for real-coder-contract-smoke: only kimi is supported',
  };
}

export function parseRealCoderContractSmokeTimeoutMs(
  env: NodeJS.ProcessEnv,
  overrideMs?: number
): number {
  let raw: string | undefined;
  if (overrideMs !== undefined) {
    raw = String(overrideMs);
  } else {
    raw = getEnv(env, 'REAL_CODER_CONTRACT_SMOKE_TIMEOUT_MS');
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

function isOptInEnabled(value: string | undefined): boolean {
  return value === 'true' || value === '1';
}

function validateContractEnv(env: NodeJS.ProcessEnv): { apiKey: string; baseUrl: string; model: string } {
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

function makeBoundedPreview(text: string): string {
  const clamped =
    text.length > MAX_RESPONSE_PREVIEW_CHARS
      ? text.slice(0, MAX_RESPONSE_PREVIEW_CHARS) + '...'
      : text;
  return redactSecrets(clamped);
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

interface ContractFile {
  path: string;
  content: string;
}

interface ContractResponse {
  summary: string;
  files: ContractFile[];
  notes?: string[];
}

function validateContractResponse(value: unknown): ContractResponse {
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
  if (fileObj.path !== EXPECTED_FILE_PATH) {
    throw new Error(`Contract response file path must be ${EXPECTED_FILE_PATH}, got ${fileObj.path}`);
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

function buildCoderContractPrompt(): string {
  return (
    'Return ONLY valid JSON with no markdown and no extra text. ' +
    'The JSON must describe a tiny patch plan with this exact shape: ' +
    `{"summary":"short description","files":[{"path":"${EXPECTED_FILE_PATH}","content":"Hello from contract smoke"}],"notes":[]}. ` +
    'The summary must be 300 characters or less. ' +
    'The files array must contain exactly one object. ' +
    'The file content must be 2000 characters or less. ' +
    'Do not include any secrets, tokens, or API keys.'
  );
}

export async function runRealCoderContractSmoke(
  options: { provider?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number; fetchFn?: typeof fetch } = {}
): Promise<RealCoderContractSmokeReport> {
  const env = options.env ?? process.env;
  const providerCheck = normalizeRealCoderContractSmokeProvider(options.provider);

  if (!providerCheck.supported) {
    return {
      ok: false,
      mode: 'real-coder-contract-smoke',
      provider: providerCheck.provider,
      supported: false,
      contractValid: false,
      error: providerCheck.error,
    };
  }

  let timeoutMs: number;
  try {
    timeoutMs = parseRealCoderContractSmokeTimeoutMs(env, options.timeoutMs);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      mode: 'real-coder-contract-smoke',
      provider: providerCheck.provider,
      supported: true,
      contractValid: false,
      error: redactSecrets(message),
    };
  }

  let apiKey: string;
  let baseUrl: string;
  let model: string;
  try {
    ({ apiKey, baseUrl, model } = validateContractEnv(env));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      mode: 'real-coder-contract-smoke',
      provider: providerCheck.provider,
      supported: true,
      contractValid: false,
      timeoutMs,
      error: redactSecrets(message),
    };
  }

  const fakeResponse = getEnv(env, 'REAL_CODER_CONTRACT_SMOKE_FAKE_RESPONSE');
  let client: { generate(prompt: string): Promise<string> };
  if (fakeResponse !== undefined) {
    client = createMockAIClient(fakeResponse);
  } else {
    const effectiveFetch = createTimeoutFetch(
      timeoutMs,
      options.fetchFn ?? fetch
    );
    client = createKimiClient({ apiKey, model, baseUrl, fetchFn: effectiveFetch });
  }

  try {
    const raw = await client.generate(buildCoderContractPrompt());
    const parsed = extractJsonFromText(raw);
    const contract = validateContractResponse(parsed);
    return {
      ok: true,
      mode: 'real-coder-contract-smoke',
      provider: providerCheck.provider,
      supported: true,
      contractValid: true,
      summaryPreview: contract.summary,
      fileCount: contract.files.length,
      paths: contract.files.map((f) => f.path),
      timeoutMs,
    };
  } catch (err) {
    if (isAbortError(err)) {
      return {
        ok: false,
        mode: 'real-coder-contract-smoke',
        provider: providerCheck.provider,
        supported: true,
        contractValid: false,
        timeoutMs,
        error: 'Coder contract smoke timed out',
      };
    }
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      mode: 'real-coder-contract-smoke',
      provider: providerCheck.provider,
      supported: true,
      contractValid: false,
      timeoutMs,
      error: redactSecrets(message),
      responsePreview: makeBoundedPreview(message),
    };
  }
}

export function formatRealCoderContractSmokeReport(report: RealCoderContractSmokeReport): string {
  return redactSecrets(JSON.stringify(report, null, 2));
}
