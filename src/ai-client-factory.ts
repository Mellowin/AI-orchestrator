import type { AIClient } from './ai-client.js';
import { createMockAIClient } from './ai-client.js';
import { createKimiClient, type KimiClientOptions } from './kimi-client.js';

export type AIProvider = 'mock' | 'kimi';

export interface CreateAIClientOptions {
  provider: AIProvider;
  mockResponse?: string;
  kimi?: KimiClientOptions;
}

export function createAIClient(options: CreateAIClientOptions): AIClient {
  if (options.provider === 'mock') {
    if (options.mockResponse === undefined) {
      throw new Error('mockResponse is required for mock provider');
    }
    return createMockAIClient(options.mockResponse);
  }

  if (options.provider === 'kimi') {
    if (!options.kimi) {
      throw new Error('kimi options are required for kimi provider');
    }
    return createKimiClient(options.kimi);
  }

  const exhaustiveCheck: never = options.provider;
  throw new Error(`Unsupported AI provider: ${exhaustiveCheck}`);
}
