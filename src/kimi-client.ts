import type { AIClient } from './ai-client.js';

export interface KimiClientOptions {
  apiKey: string;
  model: string;
  baseUrl?: string;
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
    throw new Error('KimiClient.generate is not implemented yet');
  }
}

export function createKimiClient(options: KimiClientOptions): AIClient {
  return new KimiClient(options);
}
