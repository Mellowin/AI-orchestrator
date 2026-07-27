import type { ProviderAttempt } from './types.js';

export type ProviderRole = 'coder' | 'reviewer';

export interface ProviderCallInput {
  role: ProviderRole;
  prompt: string;
  model: string;
  provider: string;
}

export interface ProviderCallResult {
  role: ProviderRole;
  text: string;
  provider: string;
  model: string;
}

export type ProviderCallFn = (input: ProviderCallInput) => Promise<ProviderCallResult>;

export function buildProviderCallInput(
  role: string,
  prompt: string,
  provider: string,
  model: string
): ProviderCallInput {
  if (role !== 'coder' && role !== 'reviewer') {
    throw new Error('Invalid role: expected coder or reviewer');
  }
  if (typeof prompt !== 'string' || prompt.length === 0) {
    throw new Error('Invalid prompt: expected non-empty string');
  }
  if (typeof provider !== 'string' || provider.length === 0) {
    throw new Error('Invalid provider: expected non-empty string');
  }
  if (typeof model !== 'string' || model.length === 0) {
    throw new Error('Invalid model: expected non-empty string');
  }
  return { role, prompt, provider, model };
}

export function normalizeProviderCallResult(result: unknown): ProviderCallResult {
  if (typeof result !== 'object' || result === null) {
    throw new Error('Invalid result: expected object');
  }
  const r = result as Record<string, unknown>;

  const role = r.role;
  if (role !== 'coder' && role !== 'reviewer') {
    throw new Error('Invalid result.role: expected coder or reviewer');
  }

  const text = r.text;
  if (typeof text !== 'string') {
    throw new Error('Invalid result.text: expected string');
  }

  const provider = r.provider;
  if (typeof provider !== 'string' || provider.length === 0) {
    throw new Error('Invalid result.provider: expected non-empty string');
  }

  const model = r.model;
  if (typeof model !== 'string' || model.length === 0) {
    throw new Error('Invalid result.model: expected non-empty string');
  }

  return { role, text: text.trim(), provider, model };
}

export interface ProviderCallErrorInfo {
  message: string;
  isRetryable: boolean;
}

export function normalizeProviderCallError(error: unknown): ProviderCallErrorInfo {
  let rawMessage: string;

  if (error instanceof Error) {
    rawMessage = error.message;
  } else if (typeof error === 'string') {
    rawMessage = error;
  } else {
    rawMessage = 'Unknown provider call error';
  }

  // Redact obvious secret-like values
  let message = rawMessage
    .replace(/sk-[^\s]*/g, '[REDACTED]')
    .replace(/Bearer\s+[^\s]*/gi, 'Bearer [REDACTED]')
    .trim();

  if (message.length === 0) {
    message = 'Unknown provider call error';
  }

  const lower = message.toLowerCase();

  // Parse HTTP status codes from messages like "Provider returned status 429"
  const statusMatch = lower.match(/status\s+(\d{3})/);
  const httpStatus = statusMatch ? parseInt(statusMatch[1], 10) : undefined;

  const isAuthError =
    lower.includes('api key') ||
    lower.includes('unauthorized') ||
    lower.includes('authentication') ||
    lower.includes('forbidden') ||
    lower.includes('access denied');

  const isClientError = httpStatus !== undefined && httpStatus >= 400 && httpStatus < 500;
  const isServerError = httpStatus !== undefined && httpStatus >= 500 && httpStatus < 600;
  const isRateLimit = httpStatus === 429 || lower.includes('rate limit') || lower.includes('too many requests');

  const isSchemaValidationError =
    lower.includes('kimioutput.files must be an array') ||
    lower.includes('kimioutput must be an object') ||
    lower.includes('kimioutput.files[') ||
    lower.includes('invalid kimi json output') ||
    lower.includes('invalid kimioutput') ||
    lower.includes('fenced block not closed') ||
    lower.includes('empty fenced block') ||
    lower.includes('malformed fenced block') ||
    lower.includes('unsupported fenced block') ||
    lower.includes('invalid reviewer json output') ||
    lower.includes('reviewverdict');

  const isRetryable =
    isRateLimit ||
    isServerError ||
    lower.includes('timeout') ||
    lower.includes('temporarily unavailable') ||
    lower.includes('econnreset') ||
    lower.includes('etimedout') ||
    lower.includes('fetch failed') ||
    lower.includes('network') ||
    lower.includes('invalid kimi json output') ||
    lower.includes('invalid reviewer json output') ||
    lower.includes('malformed fenced block') ||
    lower.includes('fenced block not closed') ||
    lower.includes('empty fenced block') ||
    isSchemaValidationError;

  // 4xx errors (except rate limit 429) are not retryable
  const isNonRetryableClientError = isClientError && !isRateLimit;

  return {
    message,
    isRetryable: isRetryable && !isAuthError && !isNonRetryableClientError,
  };
}

export interface ProviderRetryDecision {
  shouldRetry: boolean;
  delayMs: number;
}

export function getProviderRetryDecision(
  errorInfo: ProviderCallErrorInfo,
  attempt: number,
  maxAttempts = 4
): ProviderRetryDecision {
  if (attempt < 1) {
    throw new Error('attempt must be >= 1');
  }
  if (!errorInfo.isRetryable) {
    return { shouldRetry: false, delayMs: 0 };
  }
  if (attempt >= maxAttempts) {
    return { shouldRetry: false, delayMs: 0 };
  }
  const delayMs = 1000 * Math.pow(2, attempt - 1);
  return { shouldRetry: true, delayMs };
}

export interface ProviderRetryConfig {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_BASE_DELAY_MS = 1000;
const DEFAULT_MAX_DELAY_MS = 10000;
const MIN_ATTEMPTS = 1;
const MAX_ATTEMPTS = 6;
const MIN_DELAY_MS = 0;

function parseRetryEnvInt(
  value: string | undefined,
  defaultValue: number,
  min: number,
  max: number,
  name: string
): number {
  if (value === undefined || value.trim() === '') {
    return defaultValue;
  }
  const num = Number(value.trim());
  if (!Number.isInteger(num)) {
    throw new Error(`${name} must be an integer, got "${value}"`);
  }
  if (num < min || num > max) {
    throw new Error(`${name} must be between ${min} and ${max}, got ${num}`);
  }
  return num;
}

export function resolveProviderRetryConfig(): ProviderRetryConfig {
  return {
    maxAttempts: parseRetryEnvInt(
      process.env.REAL_PROVIDER_MAX_ATTEMPTS,
      DEFAULT_MAX_ATTEMPTS,
      MIN_ATTEMPTS,
      MAX_ATTEMPTS,
      'REAL_PROVIDER_MAX_ATTEMPTS'
    ),
    baseDelayMs: parseRetryEnvInt(
      process.env.REAL_PROVIDER_RETRY_BASE_MS,
      DEFAULT_BASE_DELAY_MS,
      MIN_DELAY_MS,
      DEFAULT_MAX_DELAY_MS,
      'REAL_PROVIDER_RETRY_BASE_MS'
    ),
    maxDelayMs: parseRetryEnvInt(
      process.env.REAL_PROVIDER_RETRY_MAX_MS,
      DEFAULT_MAX_DELAY_MS,
      MIN_DELAY_MS,
      60000,
      'REAL_PROVIDER_RETRY_MAX_MS'
    ),
  };
}

export type RecoveryPromptBuilder = (basePrompt: string, lastError: string) => string;

export interface CallProviderWithRetryOptions<T = string> {
  providerCall: ProviderCallFn;
  provider: string;
  model: string;
  basePrompt: string;
  buildRecoveryPrompt?: RecoveryPromptBuilder;
  parseOutput?: (text: string) => T;
  taskId: string;
  config?: Partial<ProviderRetryConfig>;
  logPrefix?: string;
  sleepFn?: (ms: number) => Promise<void>;
}

export interface CallProviderWithRetryResult<T = string> {
  text: string;
  output?: T;
  providerAttempts: ProviderAttempt[];
}

export function buildRecoveryPrompt(basePrompt: string, parseError: string): string {
  const safeError = parseError.replace(/sk-[^\s]*/g, '[REDACTED]').replace(/Bearer\s+[^\s]*/gi, 'Bearer [REDACTED]');
  return [
    'The previous response was invalid and could not be parsed.',
    `Parse error: ${safeError}`,
    '',
    'Return ONLY valid JSON.',
    'Do not use Markdown fences.',
    'Do not include prose, explanations, or comments.',
    'Do not truncate the output.',
    'Use exactly this schema:',
    '',
    '{',
    '  "mode": "file_update",',
    '  "files": [',
    '    {',
    '      "path": "relative/path/from/repo",',
    '      "content": "full file content after changes"',
    '    }',
    '  ],',
    '  "notes": "short optional note"',
    '}',
    '',
    'Any response that is not a valid JSON object with a "files" array will be rejected.',
    'Keep changes minimal and precise.',
    'If the required output would be too large to return safely, return empty files with a note explaining why instead of partial JSON.',
    '',
    basePrompt,
  ].join('\n');
}

export class ProviderCallFailedError extends Error {
  constructor(
    message: string,
    public readonly providerAttempts: ProviderAttempt[]
  ) {
    super(message);
    this.name = 'ProviderCallFailedError';
  }
}

export async function callProviderWithRetry<T = string>(
  options: CallProviderWithRetryOptions<T>
): Promise<CallProviderWithRetryResult<T>> {
  const {
    providerCall,
    provider,
    model,
    basePrompt,
    buildRecoveryPrompt: buildRecovery = buildRecoveryPrompt,
    parseOutput,
    taskId,
    config: customConfig,
    logPrefix = '[real-repo-run-ai]',
    sleepFn = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  } = options;

  const resolvedConfig: ProviderRetryConfig = {
    maxAttempts: customConfig?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
    baseDelayMs: customConfig?.baseDelayMs ?? DEFAULT_BASE_DELAY_MS,
    maxDelayMs: customConfig?.maxDelayMs ?? DEFAULT_MAX_DELAY_MS,
  };

  if (resolvedConfig.maxAttempts < MIN_ATTEMPTS || resolvedConfig.maxAttempts > MAX_ATTEMPTS) {
    throw new Error(`maxAttempts must be between ${MIN_ATTEMPTS} and ${MAX_ATTEMPTS}`);
  }
  if (resolvedConfig.baseDelayMs < MIN_DELAY_MS) {
    throw new Error('baseDelayMs must be non-negative');
  }
  if (resolvedConfig.maxDelayMs < MIN_DELAY_MS) {
    throw new Error('maxDelayMs must be non-negative');
  }

  const providerAttempts: ProviderAttempt[] = [];
  let lastError: Error | undefined;
  let lastErrorMessage = '';

  for (let attempt = 1; attempt <= resolvedConfig.maxAttempts; attempt++) {
    const useRecoveryPrompt = attempt > 1;
    const prompt = useRecoveryPrompt ? buildRecovery(basePrompt, lastErrorMessage) : basePrompt;

    try {
      const result = await providerCall(buildProviderCallInput('coder', prompt, provider, model));
      const normalized = normalizeProviderCallResult(result);
      if (parseOutput !== undefined) {
        const parsed = parseOutput(normalized.text);
        providerAttempts.push({
          attempt,
          ok: true,
          recovery_prompt: useRecoveryPrompt,
          raw_text_length: normalized.text.length,
        });
        return { text: normalized.text, output: parsed, providerAttempts };
      }
      providerAttempts.push({
        attempt,
        ok: true,
        recovery_prompt: useRecoveryPrompt,
        raw_text_length: normalized.text.length,
      });
      return { text: normalized.text, providerAttempts };
    } catch (err) {
      const info = normalizeProviderCallError(err);
      lastError = err instanceof Error ? err : new Error(info.message);
      lastErrorMessage = info.message;
      providerAttempts.push({
        attempt,
        ok: false,
        reason: info.message,
        retryable: info.isRetryable,
        recovery_prompt: useRecoveryPrompt,
      });

      const decision = getProviderRetryDecision(info, attempt, resolvedConfig.maxAttempts);
      if (decision.shouldRetry) {
        const delayMs = Math.min(decision.delayMs, resolvedConfig.maxDelayMs);
        console.error(`${logPrefix} Provider attempt ${attempt}/${resolvedConfig.maxAttempts} failed for task ${taskId}: ${info.message}`);
        console.error(`${logPrefix} Retrying in ${delayMs}ms...`);
        await sleepFn(delayMs);
        continue;
      }

      console.error(`${logPrefix} Provider attempt ${attempt}/${resolvedConfig.maxAttempts} failed for task ${taskId}: ${info.message}`);
      if (!info.isRetryable) {
        console.error(`${logPrefix} Error is not retryable; stopping.`);
      } else {
        console.error(`${logPrefix} Max attempts reached; stopping.`);
      }
      break;
    }
  }

  throw new ProviderCallFailedError(
    lastError?.message ?? 'Provider call failed after retries',
    providerAttempts
  );
}

export function createMockProviderCall(responseText: string): ProviderCallFn {
  return async (input: ProviderCallInput): Promise<ProviderCallResult> => {
    return {
      role: input.role,
      text: responseText,
      provider: input.provider,
      model: input.model,
    };
  };
}

export type FetchFn = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string }
) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

export interface CreateRealProviderCallOptions {
  provider: 'kimi';
  apiKey: string;
  baseUrl: string;
  fetchFn: FetchFn;
  model?: string;
  userAgent?: string;
}

export function createRealProviderCall(options: CreateRealProviderCallOptions): ProviderCallFn {
  if (options.provider !== 'kimi') {
    throw new Error(`Unsupported provider: ${options.provider}`);
  }
  if (typeof options.apiKey !== 'string' || options.apiKey.length === 0) {
    throw new Error('apiKey is required');
  }
  if (typeof options.baseUrl !== 'string' || options.baseUrl.length === 0) {
    throw new Error('baseUrl is required');
  }
  const lowerBase = options.baseUrl.toLowerCase();
  if (!lowerBase.startsWith('http://') && !lowerBase.startsWith('https://')) {
    throw new Error('baseUrl must start with http:// or https://');
  }
  if (typeof options.fetchFn !== 'function') {
    throw new Error('fetchFn is required');
  }

  const baseUrl = options.baseUrl.replace(/\/+$/, '');

  return async (input: ProviderCallInput): Promise<ProviderCallResult> => {
    const response = await options.fetchFn(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${options.apiKey}`,
        ...(options.userAgent ? { 'User-Agent': options.userAgent } : {}),
      },
      body: JSON.stringify({
        model: options.model || input.model,
        messages: [{ role: 'user', content: input.prompt }],
      }),
    });

    if (!response.ok) {
      throw new Error(`Provider returned status ${response.status}`);
    }

    const data = await response.json();
    if (typeof data !== 'object' || data === null) {
      throw new Error('Invalid response: expected object');
    }

    const d = data as Record<string, unknown>;
    const choices = d.choices;
    if (!Array.isArray(choices) || choices.length === 0) {
      throw new Error('Invalid response: missing choices');
    }

    const firstChoice = choices[0];
    if (typeof firstChoice !== 'object' || firstChoice === null) {
      throw new Error('Invalid response: malformed choice');
    }

    const message = (firstChoice as Record<string, unknown>).message;
    if (typeof message !== 'object' || message === null) {
      throw new Error('Invalid response: missing message');
    }

    const content = (message as Record<string, unknown>).content;
    if (typeof content !== 'string') {
      throw new Error('Invalid response: missing content');
    }

    return normalizeProviderCallResult({
      role: input.role,
      text: content,
      provider: input.provider,
      model: input.model,
    });
  };
}
