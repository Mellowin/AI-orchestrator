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
  const isRetryable =
    lower.includes('timeout') ||
    lower.includes('rate limit') ||
    lower.includes('temporarily unavailable') ||
    lower.includes('econnreset') ||
    lower.includes('etimedout');

  return { message, isRetryable };
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
