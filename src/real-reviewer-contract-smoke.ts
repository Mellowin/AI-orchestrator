import { createKimiClient } from './kimi-client.js';
import { createMockAIClient } from './ai-client.js';
import { redactSecrets } from './sandbox-preflight-repair.js';
import { validateReviewerDecision } from './reviewer/reviewer-schema.js';
import { normalizeRealProviderSmokeProvider } from './real-provider-smoke.js';

export interface RealReviewerContractSmokeReport {
  ok: boolean;
  mode: 'real-reviewer-contract-smoke';
  provider: string;
  supported: boolean;
  contractValid: boolean;
  decision?: string;
  summaryPreview?: string;
  timeoutMs?: number;
  responsePreview?: string;
  error?: string;
}

const DEFAULT_TIMEOUT_MS = 15000;
const MIN_TIMEOUT_MS = 1000;
const MAX_TIMEOUT_MS = 60000;
const MAX_RESPONSE_PREVIEW_CHARS = 500;

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

export function parseRealReviewerContractSmokeTimeoutMs(
  env: NodeJS.ProcessEnv,
  overrideMs?: number
): number {
  let raw: string | undefined;
  if (overrideMs !== undefined) {
    raw = String(overrideMs);
  } else {
    raw = getEnv(env, 'REAL_REVIEWER_CONTRACT_SMOKE_TIMEOUT_MS');
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

function validateReviewerEnv(env: NodeJS.ProcessEnv): { apiKey: string; baseUrl: string; model: string } {
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

function buildReviewerContractPrompt(): string {
  return (
    'You are a code reviewer doing a harmless contract smoke test. ' +
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
    'Do not include any secrets, tokens, or API keys in the response.'
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

export async function runRealReviewerContractSmoke(
  options: { provider?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number; fetchFn?: typeof fetch } = {}
): Promise<RealReviewerContractSmokeReport> {
  const env = options.env ?? process.env;
  const providerCheck = normalizeRealProviderSmokeProvider(options.provider);

  if (!providerCheck.supported) {
    return {
      ok: false,
      mode: 'real-reviewer-contract-smoke',
      provider: providerCheck.provider,
      supported: false,
      contractValid: false,
      error: providerCheck.error,
    };
  }

  let timeoutMs: number;
  try {
    timeoutMs = parseRealReviewerContractSmokeTimeoutMs(env, options.timeoutMs);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      mode: 'real-reviewer-contract-smoke',
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
    ({ apiKey, baseUrl, model } = validateReviewerEnv(env));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      mode: 'real-reviewer-contract-smoke',
      provider: providerCheck.provider,
      supported: true,
      contractValid: false,
      timeoutMs,
      error: redactSecrets(message),
    };
  }

  const fakeResponse = getEnv(env, 'REAL_REVIEWER_CONTRACT_SMOKE_FAKE_RESPONSE');
  let client: { generate(prompt: string): Promise<string> };
  if (fakeResponse !== undefined) {
    client = createMockAIClient(fakeResponse);
  } else {
    const effectiveFetch = createTimeoutFetch(timeoutMs, options.fetchFn ?? fetch);
    client = createKimiClient({ apiKey, model, baseUrl, fetchFn: effectiveFetch });
  }

  let raw: string | undefined;
  try {
    raw = await client.generate(buildReviewerContractPrompt());

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
      mode: 'real-reviewer-contract-smoke',
      provider: providerCheck.provider,
      supported: true,
      contractValid: true,
      decision: decision.decision,
      summaryPreview: decision.review_summary,
      timeoutMs,
    };
  } catch (err) {
    if (isAbortError(err)) {
      return {
        ok: false,
        mode: 'real-reviewer-contract-smoke',
        provider: providerCheck.provider,
        supported: true,
        contractValid: false,
        timeoutMs,
        error: 'Reviewer contract smoke timed out',
      };
    }
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      mode: 'real-reviewer-contract-smoke',
      provider: providerCheck.provider,
      supported: true,
      contractValid: false,
      timeoutMs,
      error: redactSecrets(message),
      responsePreview: makeBoundedPreview(raw ?? message),
    };
  }
}

export function formatRealReviewerContractSmokeReport(report: RealReviewerContractSmokeReport): string {
  return JSON.stringify(
    report,
    (_key, value) => (typeof value === 'string' ? redactSecretLike(value) : value),
    2
  );
}
