import dotenv from 'dotenv';
dotenv.config();

function validateMaxAttempts(raw: string | undefined): number {
  const defaultValue = 3;
  if (raw === undefined || raw.trim() === '') {
    return defaultValue;
  }
  const num = Number(raw);
  if (!Number.isInteger(num) || num < 1 || num > 10) {
    throw new Error(
      `Invalid MAX_ATTEMPTS: "${raw}". Must be an integer between 1 and 10.`
    );
  }
  return num;
}

export type AIProvider = 'mock' | 'kimi';

export interface AIConfig {
  provider: AIProvider;
  mockResponse: string;
  kimiApiKey: string;
  kimiModel: string;
  kimiBaseUrl: string;
}

function validateAIProvider(value: string | undefined): AIProvider {
  if (value === undefined || value.trim() === '') {
    return 'mock';
  }
  if (value === 'mock' || value === 'kimi') {
    return value;
  }
  throw new Error('AI_PROVIDER must be one of: mock, kimi');
}

function validateRequiredWhenKimi(
  provider: AIProvider,
  value: string | undefined,
  name: string
): string {
  if (provider === 'kimi') {
    if (value === undefined || value.trim() === '') {
      throw new Error(`${name} is required when AI_PROVIDER=kimi`);
    }
    return value;
  }
  return value ?? '';
}

const aiProvider = validateAIProvider(process.env.AI_PROVIDER);

export const config = {
  openaiApiKey: process.env.OPENAI_API_KEY,
  kimiApiKey: process.env.KIMI_API_KEY,
  kimiBaseURL: process.env.KIMI_BASE_URL || 'https://api.moonshot.cn/v1',
  kimiModel: process.env.KIMI_MODEL || 'kimi-k2.6',
  openaiReviewModel: process.env.OPENAI_REVIEW_MODEL || 'gpt-4o',
  maxAttempts: validateMaxAttempts(process.env.MAX_ATTEMPTS),
  runsDir: process.env.RUNS_DIR || './runs',
  mockAI: process.env.MOCK_AI === 'true' || false,
  ai: {
    provider: aiProvider,
    mockResponse: process.env.MOCK_AI_RESPONSE ?? '{"mode":"file_update","files":[]}',
    kimiApiKey: validateRequiredWhenKimi(aiProvider, process.env.KIMI_API_KEY, 'KIMI_API_KEY'),
    kimiModel: validateRequiredWhenKimi(aiProvider, process.env.KIMI_MODEL, 'KIMI_MODEL'),
    kimiBaseUrl: process.env.KIMI_BASE_URL ?? 'https://api.moonshot.ai/v1',
  } as AIConfig,
};

export function validateConfig(): void {
  if (!config.mockAI) {
    if (!config.kimiApiKey) {
      throw new Error('Missing KIMI_API_KEY. Set MOCK_AI=true to skip.');
    }
    if (!config.openaiApiKey) {
      throw new Error('Missing OPENAI_API_KEY. Set MOCK_AI=true to skip.');
    }
  }
}
