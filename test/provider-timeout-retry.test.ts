import { describe, test } from 'node:test';
import assert from 'node:assert';
import {
  createRealProviderCall,
  callProviderWithRetry,
  normalizeProviderCallError,
  type FetchFn,
} from '../src/provider-call.js';

const validKimiResponse = (text: string): FetchFn => async () => ({
  ok: true,
  status: 200,
  json: async () => ({ choices: [{ message: { content: text } }] }),
});

describe('provider-call timeout and retry', () => {
  test('createRealProviderCall aborts hanging fetch and throws sanitized timeout error', async () => {
    const fakeFetch: FetchFn = async (_url, init) => {
      return new Promise((_, reject) => {
        const onAbort = () => {
          const err = new Error('The operation was aborted');
          err.name = 'AbortError';
          reject(err);
        };
        if (init?.signal?.aborted) {
          onAbort();
          return;
        }
        init?.signal?.addEventListener('abort', onAbort);
      });
    };

    const callFn = createRealProviderCall({
      provider: 'kimi',
      apiKey: 'sk-test',
      baseUrl: 'https://api.example.com',
      fetchFn: fakeFetch,
      requestTimeoutMs: 5000,
    });

    await assert.rejects(
      async () =>
        callFn({
          role: 'reviewer',
          prompt: 'review',
          model: 'kimi-k2.6',
          provider: 'kimi',
        }),
      (err: Error) => {
        assert(err.message.includes('timed out'), `message was: ${err.message}`);
        assert(!err.message.includes('sk-test'));
        assert(!err.message.includes('Bearer'));
        const info = normalizeProviderCallError(err);
        assert.strictEqual(info.isRetryable, true);
        return true;
      }
    );
  });

  test('callProviderWithRetry recovers from internal timeout on second attempt', async () => {
    let calls = 0;
    const fakeFetch: FetchFn = async () => {
      calls++;
      if (calls === 1) {
        const err = new Error('The operation was aborted');
        err.name = 'AbortError';
        throw err;
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { content: 'ok' } }] }),
      };
    };

    const callFn = createRealProviderCall({
      provider: 'kimi',
      apiKey: 'sk-test',
      baseUrl: 'https://api.example.com',
      fetchFn: fakeFetch,
      requestTimeoutMs: 5000,
    });

    const result = await callProviderWithRetry({
      providerCall: callFn,
      provider: 'kimi',
      model: 'kimi-k2.6',
      basePrompt: 'hello',
      taskId: 't1',
      role: 'reviewer',
      config: { maxAttempts: 3, baseDelayMs: 0, maxDelayMs: 0 },
      sleepFn: async () => {},
      buildRecoveryPrompt: (base) => base,
    });

    assert.strictEqual(result.text, 'ok');
    assert.strictEqual(result.providerAttempts.length, 2);
    assert.strictEqual(result.providerAttempts[0].ok, false);
    assert.strictEqual(result.providerAttempts[0].retryable, true);
    assert.strictEqual(result.providerAttempts[1].ok, true);
  });

  test('HTTP 500 is retryable and eventually succeeds', async () => {
    let calls = 0;
    const fakeFetch: FetchFn = async () => {
      calls++;
      if (calls === 1) {
        return { ok: false, status: 503, json: async () => ({ error: 'overloaded' }) };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { content: 'accepted' } }] }),
      };
    };

    const callFn = createRealProviderCall({
      provider: 'kimi',
      apiKey: 'sk-test',
      baseUrl: 'https://api.example.com',
      fetchFn: fakeFetch,
      requestTimeoutMs: 5000,
    });

    const result = await callProviderWithRetry({
      providerCall: callFn,
      provider: 'kimi',
      model: 'kimi-k2.6',
      basePrompt: 'hello',
      taskId: 't1',
      role: 'reviewer',
      config: { maxAttempts: 3, baseDelayMs: 0, maxDelayMs: 0 },
      sleepFn: async () => {},
      buildRecoveryPrompt: (base) => base,
    });

    assert.strictEqual(result.text, 'accepted');
    assert.strictEqual(result.providerAttempts.length, 2);
  });

  test('HTTP 429 is retryable and eventually succeeds', async () => {
    let calls = 0;
    const fakeFetch: FetchFn = async () => {
      calls++;
      if (calls === 1) {
        return { ok: false, status: 429, json: async () => ({ error: 'rate limit' }) };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { content: 'accepted' } }] }),
      };
    };

    const callFn = createRealProviderCall({
      provider: 'kimi',
      apiKey: 'sk-test',
      baseUrl: 'https://api.example.com',
      fetchFn: fakeFetch,
      requestTimeoutMs: 5000,
    });

    const result = await callProviderWithRetry({
      providerCall: callFn,
      provider: 'kimi',
      model: 'kimi-k2.6',
      basePrompt: 'hello',
      taskId: 't1',
      role: 'reviewer',
      config: { maxAttempts: 3, baseDelayMs: 0, maxDelayMs: 0 },
      sleepFn: async () => {},
      buildRecoveryPrompt: (base) => base,
    });

    assert.strictEqual(result.text, 'accepted');
    assert.strictEqual(result.providerAttempts.length, 2);
  });

  test('HTTP 401 is not retried', async () => {
    const fakeFetch: FetchFn = async () => ({
      ok: false,
      status: 401,
      json: async () => ({ error: 'unauthorized' }),
    });

    const callFn = createRealProviderCall({
      provider: 'kimi',
      apiKey: 'sk-test',
      baseUrl: 'https://api.example.com',
      fetchFn: fakeFetch,
      requestTimeoutMs: 5000,
    });

    await assert.rejects(
      async () =>
        callProviderWithRetry({
          providerCall: callFn,
          provider: 'kimi',
          model: 'kimi-k2.6',
          basePrompt: 'hello',
          taskId: 't1',
          role: 'reviewer',
          config: { maxAttempts: 3, baseDelayMs: 0, maxDelayMs: 0 },
          sleepFn: async () => {},
          buildRecoveryPrompt: (base) => base,
        }),
      (err: Error) => {
        assert(err.message.includes('status 401'));
        return true;
      }
    );
  });
});
