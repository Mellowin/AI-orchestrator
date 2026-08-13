import { describe, test } from 'node:test';
import assert from 'node:assert';
import { buildKimiReviewCallFn, buildOpenAIReviewCallFn } from '../src/autopilot-one-click/multitask/reviewer-provider.js';
import type { FetchFn } from '../src/provider-call.js';

describe('final review provider timeout-safe retry', () => {
  const validFinalReview = JSON.stringify({
    verdict: 'approved',
    summary: 'Good',
    caveats: [],
    unauthorized_files: [],
    acceptance_gaps: [],
  });

  test('Kimi final review retries transport timeout then succeeds', async () => {
    let calls = 0;
    const fakeFetch: FetchFn = async (_url, init) => {
      calls++;
      if (calls === 1) {
        const err = new Error('The operation was aborted');
        err.name = 'AbortError';
        throw err;
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { content: validFinalReview } }] }),
      };
    };

    const callFn = buildKimiReviewCallFn({
      apiKey: 'sk-test',
      baseUrl: 'https://api.example.com',
      model: 'kimi-k2.6',
      fetchFn: fakeFetch,
      requestTimeoutMs: 5000,
    });

    const text = await callFn('review this mission');
    const parsed = JSON.parse(text);
    assert.strictEqual(parsed.verdict, 'approved');
    assert.strictEqual(calls, 2);
  });

  test('OpenAI final review retries 500 then succeeds', async () => {
    let calls = 0;
    const fakeFetch = async (_url: string, init?: { signal?: AbortSignal }) => {
      calls++;
      if (calls === 1) {
        return { ok: false, status: 503, json: async () => ({ error: 'overloaded' }) };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{ message: { content: validFinalReview } }],
        }),
      };
    };

    const callFn = buildOpenAIReviewCallFn({
      apiKey: 'sk-test',
      model: 'gpt-4o',
      fetchFn: fakeFetch as unknown as typeof globalThis.fetch,
      requestTimeoutMs: 5000,
    });

    const text = await callFn('review this mission');
    const parsed = JSON.parse(text);
    assert.strictEqual(parsed.verdict, 'approved');
    assert.strictEqual(calls, 2);
  });
});
