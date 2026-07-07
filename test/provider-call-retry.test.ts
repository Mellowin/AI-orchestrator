import { describe, test } from 'node:test';
import assert from 'node:assert';
import {
  normalizeProviderCallError,
  getProviderRetryDecision,
  resolveProviderRetryConfig,
  buildRecoveryPrompt,
  callProviderWithRetry,
  createMockProviderCall,
  type ProviderCallFn,
} from '../src/provider-call.js';

describe('provider-call retry', () => {
  test('normalizeProviderCallError marks fetch failed as retryable', () => {
    const info = normalizeProviderCallError(new Error('Provider call failed: fetch failed'));
    assert.strictEqual(info.isRetryable, true);
  });

  test('normalizeProviderCallError marks malformed fenced block as retryable', () => {
    const info = normalizeProviderCallError(new Error('Invalid Kimi JSON output: malformed fenced block'));
    assert.strictEqual(info.isRetryable, true);
  });

  test('normalizeProviderCallError marks invalid Kimi JSON output as retryable', () => {
    const info = normalizeProviderCallError(new Error('Invalid Kimi JSON output: Unexpected token'));
    assert.strictEqual(info.isRetryable, true);
  });

  test('normalizeProviderCallError marks HTTP 429 as retryable', () => {
    const info = normalizeProviderCallError(new Error('Provider returned status 429'));
    assert.strictEqual(info.isRetryable, true);
  });

  test('normalizeProviderCallError marks HTTP 500 as retryable', () => {
    const info = normalizeProviderCallError(new Error('Provider returned status 503'));
    assert.strictEqual(info.isRetryable, true);
  });

  test('normalizeProviderCallError marks HTTP 401 as not retryable', () => {
    const info = normalizeProviderCallError(new Error('Provider returned status 401'));
    assert.strictEqual(info.isRetryable, false);
  });

  test('normalizeProviderCallError marks HTTP 403 as not retryable', () => {
    const info = normalizeProviderCallError(new Error('Provider returned status 403'));
    assert.strictEqual(info.isRetryable, false);
  });

  test('normalizeProviderCallError redacts secrets in retryable parse errors', () => {
    const info = normalizeProviderCallError(new Error('Invalid Kimi JSON output: sk-leaked-token-here'));
    assert.strictEqual(info.isRetryable, true);
    assert(!info.message.includes('sk-leaked-token-here'));
    assert(info.message.includes('[REDACTED]'));
  });

  test('getProviderRetryDecision respects custom maxAttempts', () => {
    const decision = getProviderRetryDecision({ message: 'timeout', isRetryable: true }, 2, 3);
    assert.strictEqual(decision.shouldRetry, true);
    assert.strictEqual(decision.delayMs, 2000);
  });

  test('getProviderRetryDecision stops at custom maxAttempts', () => {
    const decision = getProviderRetryDecision({ message: 'timeout', isRetryable: true }, 3, 3);
    assert.strictEqual(decision.shouldRetry, false);
    assert.strictEqual(decision.delayMs, 0);
  });

  test('resolveProviderRetryConfig uses defaults', () => {
    const originalMax = process.env.REAL_PROVIDER_MAX_ATTEMPTS;
    const originalBase = process.env.REAL_PROVIDER_RETRY_BASE_MS;
    const originalMaxDelay = process.env.REAL_PROVIDER_RETRY_MAX_MS;
    delete process.env.REAL_PROVIDER_MAX_ATTEMPTS;
    delete process.env.REAL_PROVIDER_RETRY_BASE_MS;
    delete process.env.REAL_PROVIDER_RETRY_MAX_MS;
    try {
      const config = resolveProviderRetryConfig();
      assert.strictEqual(config.maxAttempts, 3);
      assert.strictEqual(config.baseDelayMs, 1000);
      assert.strictEqual(config.maxDelayMs, 10000);
    } finally {
      if (originalMax !== undefined) process.env.REAL_PROVIDER_MAX_ATTEMPTS = originalMax;
      if (originalBase !== undefined) process.env.REAL_PROVIDER_RETRY_BASE_MS = originalBase;
      if (originalMaxDelay !== undefined) process.env.REAL_PROVIDER_RETRY_MAX_MS = originalMaxDelay;
    }
  });

  test('resolveProviderRetryConfig reads env overrides', () => {
    const originalMax = process.env.REAL_PROVIDER_MAX_ATTEMPTS;
    const originalBase = process.env.REAL_PROVIDER_RETRY_BASE_MS;
    const originalMaxDelay = process.env.REAL_PROVIDER_RETRY_MAX_MS;
    process.env.REAL_PROVIDER_MAX_ATTEMPTS = '5';
    process.env.REAL_PROVIDER_RETRY_BASE_MS = '500';
    process.env.REAL_PROVIDER_RETRY_MAX_MS = '8000';
    try {
      const config = resolveProviderRetryConfig();
      assert.strictEqual(config.maxAttempts, 5);
      assert.strictEqual(config.baseDelayMs, 500);
      assert.strictEqual(config.maxDelayMs, 8000);
    } finally {
      if (originalMax !== undefined) process.env.REAL_PROVIDER_MAX_ATTEMPTS = originalMax;
      else delete process.env.REAL_PROVIDER_MAX_ATTEMPTS;
      if (originalBase !== undefined) process.env.REAL_PROVIDER_RETRY_BASE_MS = originalBase;
      else delete process.env.REAL_PROVIDER_RETRY_BASE_MS;
      if (originalMaxDelay !== undefined) process.env.REAL_PROVIDER_RETRY_MAX_MS = originalMaxDelay;
      else delete process.env.REAL_PROVIDER_RETRY_MAX_MS;
    }
  });

  test('resolveProviderRetryConfig rejects invalid env values', () => {
    const originalMax = process.env.REAL_PROVIDER_MAX_ATTEMPTS;
    process.env.REAL_PROVIDER_MAX_ATTEMPTS = 'not-a-number';
    try {
      assert.throws(() => resolveProviderRetryConfig(), /REAL_PROVIDER_MAX_ATTEMPTS must be an integer/);
    } finally {
      if (originalMax !== undefined) process.env.REAL_PROVIDER_MAX_ATTEMPTS = originalMax;
      else delete process.env.REAL_PROVIDER_MAX_ATTEMPTS;
    }
  });

  test('resolveProviderRetryConfig rejects out of range max attempts', () => {
    const originalMax = process.env.REAL_PROVIDER_MAX_ATTEMPTS;
    process.env.REAL_PROVIDER_MAX_ATTEMPTS = '99';
    try {
      assert.throws(() => resolveProviderRetryConfig(), /REAL_PROVIDER_MAX_ATTEMPTS must be between 1 and 6/);
    } finally {
      if (originalMax !== undefined) process.env.REAL_PROVIDER_MAX_ATTEMPTS = originalMax;
      else delete process.env.REAL_PROVIDER_MAX_ATTEMPTS;
    }
  });

  test('buildRecoveryPrompt includes strict JSON instructions', () => {
    const recovery = buildRecoveryPrompt('base prompt', 'malformed fenced block');
    assert(recovery.includes('Return ONLY valid JSON'));
    assert(recovery.includes('Do not use Markdown fences'));
    assert(recovery.includes('Do not include prose'));
    assert(recovery.includes('base prompt'));
  });

  test('buildRecoveryPrompt redacts secrets from parse error', () => {
    const recovery = buildRecoveryPrompt('base', 'error with sk-secret123');
    assert(!recovery.includes('sk-secret123'));
    assert(recovery.includes('[REDACTED]'));
  });

  test('callProviderWithRetry succeeds on first attempt', async () => {
    const mockFn = createMockProviderCall('ok');
    const result = await callProviderWithRetry({
      providerCall: mockFn,
      provider: 'mock',
      model: 'mock-model',
      basePrompt: 'hello',
      taskId: 't1',
      config: { maxAttempts: 3, baseDelayMs: 0, maxDelayMs: 0 },
      sleepFn: async () => {},
    });
    assert.strictEqual(result.text, 'ok');
    assert.strictEqual(result.providerAttempts.length, 1);
    assert.strictEqual(result.providerAttempts[0].ok, true);
    assert.strictEqual(result.providerAttempts[0].recovery_prompt, false);
  });

  test('callProviderWithRetry retries fetch failed and succeeds on second attempt', async () => {
    let calls = 0;
    const failingThenOk: ProviderCallFn = async (input) => {
      calls++;
      if (calls === 1) {
        throw new Error('fetch failed');
      }
      return { role: input.role, text: 'ok', provider: input.provider, model: input.model };
    };
    const result = await callProviderWithRetry({
      providerCall: failingThenOk,
      provider: 'kimi',
      model: 'kimi-k2.6',
      basePrompt: 'hello',
      taskId: 't1',
      config: { maxAttempts: 3, baseDelayMs: 0, maxDelayMs: 0 },
      sleepFn: async () => {},
    });
    assert.strictEqual(result.text, 'ok');
    assert.strictEqual(result.providerAttempts.length, 2);
    assert.strictEqual(result.providerAttempts[0].ok, false);
    assert.strictEqual(result.providerAttempts[0].retryable, true);
    assert.strictEqual(result.providerAttempts[1].ok, true);
    assert.strictEqual(result.providerAttempts[1].recovery_prompt, true);
  });

  test('callProviderWithRetry retries malformed JSON and succeeds with recovery prompt', async () => {
    let calls = 0;
    const failingThenOk: ProviderCallFn = async (input) => {
      calls++;
      if (calls === 1) {
        throw new Error('Invalid Kimi JSON output: malformed fenced block');
      }
      return { role: input.role, text: 'ok', provider: input.provider, model: input.model };
    };
    const result = await callProviderWithRetry({
      providerCall: failingThenOk,
      provider: 'kimi',
      model: 'kimi-k2.6',
      basePrompt: 'hello',
      taskId: 't1',
      config: { maxAttempts: 3, baseDelayMs: 0, maxDelayMs: 0 },
      sleepFn: async () => {},
    });
    assert.strictEqual(result.text, 'ok');
    assert.strictEqual(result.providerAttempts.length, 2);
    assert.strictEqual(result.providerAttempts[0].ok, false);
    assert.strictEqual(result.providerAttempts[1].ok, true);
    assert.strictEqual(result.providerAttempts[1].recovery_prompt, true);
  });

  test('callProviderWithRetry stops after max attempts and reports final failure', async () => {
    const alwaysFail: ProviderCallFn = async () => {
      throw new Error('fetch failed');
    };
    await assert.rejects(
      async () =>
        callProviderWithRetry({
          providerCall: alwaysFail,
          provider: 'kimi',
          model: 'kimi-k2.6',
          basePrompt: 'hello',
          taskId: 't1',
          config: { maxAttempts: 2, baseDelayMs: 0, maxDelayMs: 0 },
          sleepFn: async () => {},
        }),
      /fetch failed/
    );
  });

  test('callProviderWithRetry does not retry non-retryable errors', async () => {
    let calls = 0;
    const authError: ProviderCallFn = async () => {
      calls++;
      throw new Error('Provider returned status 401');
    };
    await assert.rejects(
      async () =>
        callProviderWithRetry({
          providerCall: authError,
          provider: 'kimi',
          model: 'kimi-k2.6',
          basePrompt: 'hello',
          taskId: 't1',
          config: { maxAttempts: 3, baseDelayMs: 0, maxDelayMs: 0 },
          sleepFn: async () => {},
        }),
      /Provider returned status 401/
    );
    assert.strictEqual(calls, 1);
  });

  test('callProviderWithRetry custom buildRecoveryPrompt is used on retries', async () => {
    let seenError = '';
    let calls = 0;
    const failingOnce: ProviderCallFn = async (input) => {
      calls++;
      if (calls === 1) {
        throw new Error('fetch failed');
      }
      return { role: input.role, text: 'ok', provider: input.provider, model: input.model };
    };
    const result = await callProviderWithRetry({
      providerCall: failingOnce,
      provider: 'kimi',
      model: 'kimi-k2.6',
      basePrompt: 'base',
      buildRecoveryPrompt: (_base, err) => {
        seenError = err;
        return 'recovery';
      },
      taskId: 't1',
      config: { maxAttempts: 2, baseDelayMs: 0, maxDelayMs: 0 },
      sleepFn: async () => {},
    });
    assert.strictEqual(result.text, 'ok');
    assert.strictEqual(seenError, 'fetch failed');
  });

  test('callProviderWithRetry validates maxAttempts bounds', async () => {
    await assert.rejects(
      async () =>
        callProviderWithRetry({
          providerCall: createMockProviderCall('ok'),
          provider: 'kimi',
          model: 'kimi-k2.6',
          basePrompt: 'hello',
          taskId: 't1',
          config: { maxAttempts: 0, baseDelayMs: 0, maxDelayMs: 0 },
          sleepFn: async () => {},
        }),
      /maxAttempts must be between 1 and 6/
    );
  });

  test('callProviderWithRetry validates delay values are non-negative', async () => {
    await assert.rejects(
      async () =>
        callProviderWithRetry({
          providerCall: createMockProviderCall('ok'),
          provider: 'kimi',
          model: 'kimi-k2.6',
          basePrompt: 'hello',
          taskId: 't1',
          config: { maxAttempts: 1, baseDelayMs: -1, maxDelayMs: 0 },
          sleepFn: async () => {},
        }),
      /baseDelayMs must be non-negative/
    );
  });
});
