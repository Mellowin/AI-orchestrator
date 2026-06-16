import { createKimiClient } from './kimi-client.js';
import { redactSecrets } from './sandbox-preflight-repair.js';

export interface RealProviderSmokeResult {
  ok: boolean;
  provider: string;
  mode: 'real-provider-smoke';
  responseParsed: boolean;
  message?: string;
  error?: string;
  timeoutMs?: number;
}

const DEFAULT_SMOKE_TIMEOUT_MS = 15000;
const MIN_SMOKE_TIMEOUT_MS = 1000;
const MAX_SMOKE_TIMEOUT_MS = 60000;
const MAX_RESPONSE_PREVIEW_CHARS = 500;
const MAX_MESSAGE_LENGTH = 200;

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

function isOptInEnabled(value: string | undefined): boolean {
  return value === 'true' || value === '1';
}

export function normalizeRealProviderSmokeProvider(raw: string | undefined): {
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
    error: 'Unsupported provider for real-provider-smoke: only kimi is supported',
  };
}

export function parseRealProviderSmokeTimeoutMs(env: NodeJS.ProcessEnv): number {
  const raw = getEnv(env, 'REAL_PROVIDER_SMOKE_TIMEOUT_MS');
  if (raw === undefined || raw === '') {
    return DEFAULT_SMOKE_TIMEOUT_MS;
  }

  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error('Invalid REAL_PROVIDER_SMOKE_TIMEOUT_MS: must be a non-negative integer');
  }
  if (parsed === 0) {
    throw new Error('Invalid REAL_PROVIDER_SMOKE_TIMEOUT_MS: timeout must be greater than 0');
  }
  if (parsed < MIN_SMOKE_TIMEOUT_MS) {
    return MIN_SMOKE_TIMEOUT_MS;
  }
  if (parsed > MAX_SMOKE_TIMEOUT_MS) {
    return MAX_SMOKE_TIMEOUT_MS;
  }
  return parsed;
}

function validateSmokeEnv(env: NodeJS.ProcessEnv): { apiKey: string; baseUrl: string; model: string; userAgent?: string } {
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
  const userAgent = getEnv(env, 'KIMI_USER_AGENT');
  return { apiKey, baseUrl, model, userAgent };
}

function makeBoundedPreview(text: string): string {
  const clamped = text.length > MAX_RESPONSE_PREVIEW_CHARS
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

function validateSmokeResponse(value: unknown): { ok: boolean; message: string } {
  if (typeof value !== 'object' || value === null) {
    throw new Error('Provider response JSON is not an object');
  }
  const obj = value as Record<string, unknown>;
  if (obj.ok !== true) {
    throw new Error('Provider response did not acknowledge smoke request');
  }
  if (typeof obj.message !== 'string') {
    throw new Error('Provider response is missing message');
  }
  if (obj.message.length > MAX_MESSAGE_LENGTH) {
    throw new Error('Provider response message is too long');
  }
  return { ok: true, message: obj.message };
}

function createTimeoutFetch(timeoutMs: number, underlyingFetch: typeof fetch): typeof fetch {
  return (input, init) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const promise = underlyingFetch(input, {
      ...init,
      signal: controller.signal,
    });
    promise.then(
      () => clearTimeout(timer),
      () => clearTimeout(timer)
    );
    return promise;
  };
}

function isAbortError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (err.name === 'AbortError') return true;
  const lower = err.message.toLowerCase();
  return lower.includes('timed out') || lower.includes('aborted');
}

export async function runRealProviderSmoke(
  provider: string,
  fetchFn?: typeof fetch,
  env: NodeJS.ProcessEnv = process.env
): Promise<RealProviderSmokeResult> {
  const providerCheck = normalizeRealProviderSmokeProvider(provider);
  if (!providerCheck.supported) {
    return {
      ok: false,
      provider: providerCheck.provider,
      mode: 'real-provider-smoke',
      responseParsed: false,
      error: providerCheck.error,
    };
  }

  let timeoutMs: number;
  try {
    timeoutMs = parseRealProviderSmokeTimeoutMs(env);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      provider,
      mode: 'real-provider-smoke',
      responseParsed: false,
      error: redactSecrets(message),
    };
  }

  const { apiKey, baseUrl, model, userAgent } = validateSmokeEnv(env);

  const effectiveFetch = createTimeoutFetch(
    timeoutMs,
    fetchFn ?? (globalThis.fetch as unknown as typeof fetch)
  );

  const client = createKimiClient({
    apiKey,
    model,
    baseUrl,
    userAgent,
    fetchFn: effectiveFetch,
  });

  const prompt =
    'Return ONLY valid JSON with no markdown and no extra text: {"ok":true,"message":"provider smoke ok"}';

  try {
    const raw = await client.generate(prompt);
    const parsed = extractJsonFromText(raw);
    const { message } = validateSmokeResponse(parsed);
    return {
      ok: true,
      provider,
      mode: 'real-provider-smoke',
      responseParsed: true,
      message,
      timeoutMs,
    };
  } catch (err) {
    if (isAbortError(err)) {
      return {
        ok: false,
        provider,
        mode: 'real-provider-smoke',
        responseParsed: false,
        error: 'Provider smoke timed out',
        timeoutMs,
      };
    }
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      provider,
      mode: 'real-provider-smoke',
      responseParsed: false,
      error: redactSecrets(message),
      timeoutMs,
    };
  }
}
