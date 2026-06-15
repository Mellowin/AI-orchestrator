import { createKimiClient } from './kimi-client.js';
import { redactSecrets } from './sandbox-preflight-repair.js';

export interface RealProviderSmokeResult {
  ok: boolean;
  provider: string;
  mode: 'real-provider-smoke';
  responseParsed: boolean;
  message?: string;
  error?: string;
}

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

function validateSmokeEnv(env: NodeJS.ProcessEnv): { apiKey: string; baseUrl: string; model: string } {
  const allowReal = getEnv(env, 'ALLOW_REAL_PROVIDER');
  if (allowReal !== 'true') {
    throw new Error('ALLOW_REAL_PROVIDER=true is required');
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

function extractJsonFromText(text: string): unknown {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    // try fenced json block
    const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenceMatch && fenceMatch[1]) {
      return JSON.parse(fenceMatch[1].trim());
    }
    throw new Error('Provider response is not valid JSON');
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
  return { ok: true, message: obj.message };
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

  const { apiKey, baseUrl, model } = validateSmokeEnv(env);

  const client = createKimiClient({
    apiKey,
    model,
    baseUrl,
    fetchFn,
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
    };
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
}
