import type { AIClient } from './ai-client.js';

export interface KimiClientOptions {
  apiKey: string;
  model: string;
  baseUrl?: string;
  fetchFn?: typeof fetch;
  userAgent?: string;
}

function isObject(val: unknown): val is Record<string, unknown> {
  return typeof val === 'object' && val !== null && !Array.isArray(val);
}

function validateKimiResponse(value: unknown): string {
  if (!isObject(value)) {
    throw new Error('Invalid Kimi API response shape');
  }
  const choices = value.choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    throw new Error('Invalid Kimi API response shape');
  }
  const first = choices[0];
  if (!isObject(first)) {
    throw new Error('Invalid Kimi API response shape');
  }
  const message = first.message;
  if (!isObject(message)) {
    throw new Error('Invalid Kimi API response shape');
  }
  const content = message.content;
  if (typeof content !== 'string') {
    throw new Error('Invalid Kimi API response shape');
  }
  return content;
}

export class KimiClient implements AIClient {
  constructor(private readonly options: KimiClientOptions) {
    if (options.apiKey.trim().length === 0) {
      throw new Error('Kimi API key is required');
    }
    if (options.model.trim().length === 0) {
      throw new Error('Kimi model is required');
    }
  }

  async generate(prompt: string): Promise<string> {
    if (prompt.trim().length === 0) {
      throw new Error('Prompt is empty');
    }

    const baseUrl = (
      this.options.baseUrl ?? 'https://api.moonshot.ai/v1'
    ).replace(/\/$/, '');
    const url = `${baseUrl}/chat/completions`;

    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.options.apiKey}`,
      'Content-Type': 'application/json',
    };
    const userAgent = this.options.userAgent?.trim();
    if (userAgent) {
      headers['User-Agent'] = userAgent;
    }

    const response = await (this.options.fetchFn ?? fetch)(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: this.options.model,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      const shortBody = text.length > 500 ? text.slice(0, 500) + '...' : text;
      throw new Error(
        `Kimi API request failed: ${response.status} ${response.statusText}: ${shortBody}`
      );
    }

    let json: unknown;
    try {
      json = await response.json();
    } catch {
      throw new Error('Invalid Kimi API response shape');
    }

    return validateKimiResponse(json);
  }
}

export function createKimiClient(options: KimiClientOptions): AIClient {
  return new KimiClient(options);
}
