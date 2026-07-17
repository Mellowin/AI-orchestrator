import { config } from '../../config.js';
import type { FinalReviewCallFn } from './types.js';

export interface BuildOpenAIReviewCallFnOptions {
  /** OpenAI API key. Defaults to OPENAI_API_KEY from the environment. */
  apiKey?: string;
  /** Chat model. Defaults to OPENAI_REVIEW_MODEL from the environment (or gpt-4o). */
  model?: string;
  /** Fetch implementation. Defaults to globalThis.fetch. */
  fetchFn?: typeof globalThis.fetch;
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

  return async (prompt: string): Promise<string> => {
    const response = await fetchFn(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0,
        response_format: finalReviewSchema,
      }),
    });

    if (!response.ok) {
      throw new Error(`OpenAI final review request failed: ${response.status}`);
    }

    const data = (await response.json()) as OpenAIChatResponse;
    const content = data.choices?.[0]?.message?.content;
    if (typeof content !== 'string') {
      throw new Error('OpenAI final review response did not contain content');
    }
    return content;
  };
}

export function buildProductionFinalReviewCallFn(
  options?: BuildOpenAIReviewCallFnOptions
): FinalReviewCallFn {
  try {
    return buildOpenAIReviewCallFn(options);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Final reviewer is not available: ${redactSecrets(message)}`);
  }
}

export type { FinalReviewCallFn };
