import { config } from '../../config.js';
import type { FinalReviewCallFn } from './types.js';
import {
  createRealProviderCall,
  buildProviderCallInput,
  normalizeProviderCallResult,
  normalizeProviderCallError,
  callProviderWithRetry,
  ProviderCallFailedError,
  resolveProviderRetryConfig,
  type ProviderCallFn,
} from '../../provider-call.js';
import type { FetchFn } from '../../provider-call.js';

export interface BuildOpenAIReviewCallFnOptions {
  /** OpenAI API key. Defaults to OPENAI_API_KEY from the environment. */
  apiKey?: string;
  /** Chat model. Defaults to OPENAI_REVIEW_MODEL from the environment (or gpt-4o). */
  model?: string;
  /** Fetch implementation. Defaults to globalThis.fetch. */
  fetchFn?: typeof globalThis.fetch;
  /** Single request timeout in milliseconds. Defaults to 180000. */
  requestTimeoutMs?: number;
  /** If set, the returned function returns this string without making a network call. */
  fakeResponse?: string;
}

export interface BuildKimiReviewCallFnOptions {
  /** Kimi API key. Defaults to KIMI_API_KEY from the environment. */
  apiKey?: string;
  /** Kimi base URL. Defaults to KIMI_BASE_URL from the environment (or https://api.moonshot.cn/v1). */
  baseUrl?: string;
  /** Chat model. Defaults to KIMI_MODEL from the environment (or kimi-k2.6). */
  model?: string;
  /** User-Agent header. Defaults to KIMI_USER_AGENT from the environment. */
  userAgent?: string;
  /** Fetch implementation. Defaults to globalThis.fetch. */
  fetchFn?: FetchFn;
  /** Single request timeout in milliseconds. Defaults to 180000. */
  requestTimeoutMs?: number;
  /** If set, the returned function returns this string without making a network call. */
  fakeResponse?: string;
}

type OpenAIChatResponse = {
  choices?: Array<{
    message?: {
      content?: string;
    };
  }>;
};

const finalReviewSchema = {
  type: 'json_schema',
  json_schema: {
    name: 'FinalMissionReview',
    strict: true,
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        verdict: {
          type: 'string',
          enum: ['approved', 'approved_with_caveats', 'needs_changes', 'rejected'],
        },
        summary: { type: 'string' },
        caveats: { type: 'array', items: { type: 'string' } },
        unauthorized_files: { type: 'array', items: { type: 'string' } },
        acceptance_gaps: { type: 'array', items: { type: 'string' } },
      },
      required: ['verdict', 'summary', 'caveats', 'unauthorized_files', 'acceptance_gaps'],
    },
  },
};

function redactSecrets(message: string): string {
  return message
    .replace(/sk-[a-zA-Z0-9_-]+/g, '[REDACTED]')
    .replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]')
    .trim();
}

export function buildOpenAIReviewCallFn(options: BuildOpenAIReviewCallFnOptions = {}): FinalReviewCallFn {
  if (options.fakeResponse !== undefined) {
    return async () => options.fakeResponse as string;
  }

  const apiKey = options.apiKey ?? config.openaiApiKey;
  const model = options.model ?? config.openaiReviewModel;

  if (!apiKey || apiKey.trim().length === 0) {
    throw new Error('OPENAI_API_KEY is required for real multitask final review');
  }
  if (!model || model.trim().length === 0) {
    throw new Error('OpenAI review model is required');
  }

  const fetchFn = options.fetchFn ?? globalThis.fetch;
  const url = 'https://api.openai.com/v1/chat/completions';

  const requestTimeoutMs = options.requestTimeoutMs ?? 180000;

  const providerCall: ProviderCallFn = async (input) => {
    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => controller.abort(), requestTimeoutMs);
    try {
      const response = await fetchFn(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: input.prompt }],
          temperature: 0,
          response_format: finalReviewSchema,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`OpenAI final review request failed: status ${response.status}`);
      }

      const data = (await response.json()) as OpenAIChatResponse;
      const content = data.choices?.[0]?.message?.content;
      if (typeof content !== 'string') {
        throw new Error('OpenAI final review response did not contain content');
      }
      return {
        role: input.role,
        text: content,
        provider: 'openai',
        model: input.model,
      };
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        throw new Error(`OpenAI final review request timed out after ${requestTimeoutMs} ms`);
      }
      throw err;
    } finally {
      clearTimeout(timeoutHandle);
    }
  };

  return async (prompt: string): Promise<string> => {
    try {
      const result = await callProviderWithRetry({
        providerCall,
        provider: 'openai',
        model,
        basePrompt: prompt,
        taskId: 'final-review',
        role: 'reviewer',
        config: resolveProviderRetryConfig(),
        buildRecoveryPrompt: (base) => base,
      });
      return result.text;
    } catch (err) {
      if (err instanceof ProviderCallFailedError) {
        const info = normalizeProviderCallError(err);
        throw new Error(`OpenAI final review request failed: ${info.message}`);
      }
      const info = normalizeProviderCallError(err);
      throw new Error(`OpenAI final review request failed: ${info.message}`);
    }
  };
}

export function buildKimiReviewCallFn(options: BuildKimiReviewCallFnOptions = {}): FinalReviewCallFn {
  if (options.fakeResponse !== undefined) {
    return async () => options.fakeResponse as string;
  }

  const apiKey = options.apiKey ?? config.ai.kimiApiKey ?? process.env.KIMI_API_KEY?.trim();
  const baseUrl = options.baseUrl ?? config.ai.kimiBaseUrl ?? process.env.KIMI_BASE_URL?.trim() ?? 'https://api.moonshot.ai/v1';
  const model = options.model ?? config.ai.kimiModel ?? process.env.KIMI_MODEL?.trim() ?? 'kimi-k2.6';
  const userAgent = options.userAgent ?? config.ai.kimiUserAgent ?? process.env.KIMI_USER_AGENT?.trim();

  if (!apiKey || apiKey.trim().length === 0) {
    throw new Error('KIMI_API_KEY is required for Kimi multitask final review');
  }
  if (!baseUrl || baseUrl.trim().length === 0) {
    throw new Error('KIMI_BASE_URL is required for Kimi multitask final review');
  }

  const fetchFn = options.fetchFn ?? (globalThis.fetch as unknown as FetchFn);

  const callFn = createRealProviderCall({
    provider: 'kimi',
    apiKey,
    baseUrl,
    fetchFn,
    model,
    userAgent,
    requestTimeoutMs: options.requestTimeoutMs,
  });

  return async (prompt: string): Promise<string> => {
    try {
      const result = await callProviderWithRetry({
        providerCall: callFn,
        provider: 'kimi',
        model,
        basePrompt: prompt,
        taskId: 'final-review',
        role: 'reviewer',
        config: resolveProviderRetryConfig(),
        buildRecoveryPrompt: (base) => base,
      });
      return result.text;
    } catch (err) {
      if (err instanceof ProviderCallFailedError) {
        const info = normalizeProviderCallError(err);
        throw new Error(`Kimi final review request failed: ${info.message}`);
      }
      const info = normalizeProviderCallError(err);
      throw new Error(`Kimi final review request failed: ${info.message}`);
    }
  };
}

export function buildProductionFinalReviewCallFn(
  openAIOptions?: BuildOpenAIReviewCallFnOptions,
  kimiOptions?: BuildKimiReviewCallFnOptions
): FinalReviewCallFn {
  const openAIErrors: string[] = [];
  try {
    return buildOpenAIReviewCallFn(openAIOptions);
  } catch (err) {
    openAIErrors.push(err instanceof Error ? err.message : String(err));
  }

  try {
    const resolvedKimiOptions: BuildKimiReviewCallFnOptions = { ...kimiOptions };
    if (openAIOptions?.fetchFn !== undefined && resolvedKimiOptions.fetchFn === undefined) {
      resolvedKimiOptions.fetchFn = openAIOptions.fetchFn as unknown as FetchFn;
    }
    return buildKimiReviewCallFn(resolvedKimiOptions);
  } catch (err) {
    const kimiMessage = err instanceof Error ? err.message : String(err);
    const message = `OpenAI: ${openAIErrors.join('; ')}; Kimi: ${kimiMessage}`;
    throw new Error(`Final reviewer is not available: ${redactSecrets(message)}`);
  }
}

export type { FinalReviewCallFn };
