import type { AIClient } from './ai-client.js';
import { createMockAIClient } from './ai-client.js';
import { createKimiClient, type KimiClientOptions } from './kimi-client.js';
import type { AIConfig } from './config.js';

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

export function createAIClientFromConfig(aiConfig: AIConfig): AIClient {
  if (aiConfig.provider === 'mock') {
    return createAIClient({
      provider: 'mock',
      mockResponse: aiConfig.mockResponse,
    });
  }

  if (aiConfig.provider === 'kimi') {
    return createAIClient({
      provider: 'kimi',
      kimi: {
        apiKey: aiConfig.kimiApiKey,
        model: aiConfig.kimiModel,
        baseUrl: aiConfig.kimiBaseUrl,
        userAgent: aiConfig.kimiUserAgent || undefined,
      },
    });
  }

  const exhaustiveCheck: never = aiConfig.provider;
  throw new Error(`Unsupported AI provider: ${exhaustiveCheck}`);
}
