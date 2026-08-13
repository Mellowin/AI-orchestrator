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
  callProviderWithRetry,
  ProviderCallFailedError,
  resolveProviderRetryConfig,
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

      try {
        const retryResult = await callProviderWithRetry<string>({
          providerCall: callFn,
          provider: 'kimi',
          model,
          basePrompt: prompt,
          taskId: input.task_id,
          role: 'reviewer',
          config: resolveProviderRetryConfig(),
          buildRecoveryPrompt: (base) => base,
        });
        const normalized = normalizeProviderCallResult({
          role: 'reviewer',
          text: retryResult.text,
          provider: 'kimi',
          model,
        });
        return parseReviewerDecisionText(normalized.text).decision;
      } catch (err) {
        if (err instanceof ProviderCallFailedError) {
          const info = normalizeProviderCallError(err);
          throw new Error(`Kimi reviewer failed: ${info.message}`);
        }
        const info = normalizeProviderCallError(err);
        throw new Error(`Kimi reviewer failed: ${info.message}`);
      }
    },
  };
}

