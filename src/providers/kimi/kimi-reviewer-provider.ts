import type {
  ReviewerProvider,
  ReviewInput,
  ReviewerDecision,
  ProviderConfig,
  ProviderId,
} from '../provider-types.js';
import {
  createRealProviderCall,
  buildProviderCallInput,
  normalizeProviderCallResult,
  normalizeProviderCallError,
} from '../../provider-call.js';
import type { FetchFn } from '../../provider-call.js';
import { buildReviewerPrompt } from '../../reviewer/reviewer-prompt.js';
import { parseReviewerDecisionText } from '../../reviewer/reviewer-output-parser.js';

export interface KimiReviewerProviderOptions {
  allowReal?: boolean;
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  userAgent?: string;
  fakeResponse?: string;
  fetchFn?: FetchFn;
}

export function createKimiReviewerProvider(
  config: ProviderConfig,
  options: KimiReviewerProviderOptions = {}
): ReviewerProvider {
  const apiKey = options.apiKey ?? config.apiKey ?? '';
  const baseUrl = options.baseUrl ?? config.baseUrl ?? '';
  const model = options.model ?? config.model;
  const userAgent = options.userAgent ?? config.userAgent;
  const fakeResponse = options.fakeResponse;
  const fetchFn = options.fetchFn;
  const allowReal = options.allowReal ?? false;

  return {
    id: 'kimi' as ProviderId,
    role: 'reviewer',

    async reviewCommit(input: ReviewInput): Promise<ReviewerDecision> {
      if (fakeResponse !== undefined) {
        return parseReviewerDecisionText(fakeResponse).decision;
      }

      if (!allowReal) {
        throw new Error('Kimi reviewer real call requires ALLOW_KIMI_REVIEWER=true');
      }

      if (!apiKey) {
        throw new Error('Kimi reviewer requires KIMI_API_KEY');
      }

      if (!baseUrl) {
        throw new Error('Kimi reviewer requires KIMI_BASE_URL');
      }

      const prompt = buildReviewerPrompt(input);

      const callFn = createRealProviderCall({
        provider: 'kimi',
        apiKey,
        baseUrl,
        fetchFn: fetchFn ?? (globalThis.fetch as unknown as FetchFn),
        model,
        userAgent,
      });

      const providerInput = buildProviderCallInput('reviewer', prompt, 'kimi', model);

      try {
        const result = await callFn(providerInput);
        const normalized = normalizeProviderCallResult(result);
        return parseReviewerDecisionText(normalized.text).decision;
      } catch (err) {
        const info = normalizeProviderCallError(err);
        throw new Error(`Kimi reviewer failed: ${info.message}`);
      }
    },
  };
}

