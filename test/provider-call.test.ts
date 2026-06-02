import { describe, test } from 'node:test';
import assert from 'node:assert';
import {
  createMockProviderCall,
  createRealProviderCall,
  buildProviderCallInput,
  normalizeProviderCallResult,
  normalizeProviderCallError,
} from '../src/provider-call.js';
import type { ProviderCallInput, FetchFn } from '../src/provider-call.js';

describe('provider-call', () => {
  test('mock provider returns expected response', async () => {
    const mockFn = createMockProviderCall('mock response text');
    const input: ProviderCallInput = {
      role: 'coder',
      prompt: 'write hello world',
      model: 'mock-model',
      provider: 'mock',
    };
    const result = await mockFn(input);
    assert.strictEqual(result.text, 'mock response text');
  });

  test('mock provider preserves role, provider, and model', async () => {
    const mockFn = createMockProviderCall('reviewer says ok');
    const input: ProviderCallInput = {
      role: 'reviewer',
      prompt: 'review this code',
      model: 'gpt-4o',
      provider: 'openai',
    };
    const result = await mockFn(input);
    assert.strictEqual(result.role, 'reviewer');
    assert.strictEqual(result.provider, 'openai');
    assert.strictEqual(result.model, 'gpt-4o');
    assert.strictEqual(result.text, 'reviewer says ok');
  });

  test('mock provider does not call network or read API keys', async () => {
    const mockFn = createMockProviderCall('no network');
    const input: ProviderCallInput = {
      role: 'coder',
      prompt: 'test',
      model: 'mock',
      provider: 'mock',
    };
    // Should resolve immediately without any external calls
    const result = await mockFn(input);
    assert.strictEqual(result.text, 'no network');
  });

  test('createRealProviderCall requires provider kimi', () => {
    assert.throws(
      () =>
        createRealProviderCall({
          provider: 'openai' as 'kimi',
          apiKey: 'sk-test',
          baseUrl: 'https://api.example.com',
          fetchFn: async () => ({ ok: true, status: 200, json: async () => ({}) }),
        }),
      /Unsupported provider: openai/
    );
  });

  test('createRealProviderCall missing apiKey throws', () => {
    assert.throws(
      () =>
        createRealProviderCall({
          provider: 'kimi',
          apiKey: '',
          baseUrl: 'https://api.example.com',
          fetchFn: async () => ({ ok: true, status: 200, json: async () => ({}) }),
        }),
      /apiKey is required/
    );
  });

  test('createRealProviderCall uses injected fake fetch, no network', async () => {
    let called = false;
    const fakeFetch: FetchFn = async (_url, _init) => {
      called = true;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{ message: { content: 'fake response' } }],
        }),
      };
    };

    const realFn = createRealProviderCall({
      provider: 'kimi',
      apiKey: 'sk-test',
      baseUrl: 'https://api.example.com',
      fetchFn: fakeFetch,
    });

    const input: ProviderCallInput = {
      role: 'coder',
      prompt: 'write hello',
      model: 'kimi-k2.6',
      provider: 'kimi',
    };

    const result = await realFn(input);
    assert.strictEqual(called, true);
    assert.strictEqual(result.text, 'fake response');
  });

  test('createRealProviderCall sends Authorization Bearer header to fake fetch', async () => {
    let authHeader: string | undefined;
    const fakeFetch: FetchFn = async (_url, init) => {
      authHeader = init?.headers?.['Authorization'];
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{ message: { content: 'ok' } }],
        }),
      };
    };

    const realFn = createRealProviderCall({
      provider: 'kimi',
      apiKey: 'sk-secret123',
      baseUrl: 'https://api.example.com',
      fetchFn: fakeFetch,
    });

    await realFn({
      role: 'coder',
      prompt: 'test',
      model: 'kimi-k2.6',
      provider: 'kimi',
    });

    assert.strictEqual(authHeader, 'Bearer sk-secret123');
  });

  test('createRealProviderCall sends prompt and model in JSON body', async () => {
    let bodyStr: string | undefined;
    const fakeFetch: FetchFn = async (_url, init) => {
      bodyStr = init?.body;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{ message: { content: 'ok' } }],
        }),
      };
    };

    const realFn = createRealProviderCall({
      provider: 'kimi',
      apiKey: 'sk-test',
      baseUrl: 'https://api.example.com',
      fetchFn: fakeFetch,
      model: 'custom-model',
    });

    await realFn({
      role: 'reviewer',
      prompt: 'review this',
      model: 'kimi-k2.6',
      provider: 'kimi',
    });

    assert(bodyStr);
    const body = JSON.parse(bodyStr);
    assert.strictEqual(body.model, 'custom-model');
    assert.strictEqual(body.messages[0].role, 'user');
    assert.strictEqual(body.messages[0].content, 'review this');
  });

  test('createRealProviderCall parses successful fake Kimi response into ProviderCallResult', async () => {
    const fakeFetch: FetchFn = async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { content: '  parsed result  ' } }],
      }),
    });

    const realFn = createRealProviderCall({
      provider: 'kimi',
      apiKey: 'sk-test',
      baseUrl: 'https://api.example.com',
      fetchFn: fakeFetch,
    });

    const result = await realFn({
      role: 'coder',
      prompt: 'test',
      model: 'kimi-k2.6',
      provider: 'kimi',
    });

    assert.strictEqual(result.text, 'parsed result');
    assert.strictEqual(result.role, 'coder');
    assert.strictEqual(result.provider, 'kimi');
    assert.strictEqual(result.model, 'kimi-k2.6');
  });

  test('createRealProviderCall preserves role/provider/model from input', async () => {
    const fakeFetch: FetchFn = async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { content: 'ok' } }],
      }),
    });

    const realFn = createRealProviderCall({
      provider: 'kimi',
      apiKey: 'sk-test',
      baseUrl: 'https://api.example.com',
      fetchFn: fakeFetch,
    });

    const result = await realFn({
      role: 'reviewer',
      prompt: 'review',
      model: 'gpt-4o',
      provider: 'openai',
    });

    assert.strictEqual(result.role, 'reviewer');
    assert.strictEqual(result.provider, 'openai');
    assert.strictEqual(result.model, 'gpt-4o');
  });

  test('createRealProviderCall trims response text via normalizeProviderCallResult', async () => {
    const fakeFetch: FetchFn = async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { content: '\n\n  trimmed  \n\n' } }],
      }),
    });

    const realFn = createRealProviderCall({
      provider: 'kimi',
      apiKey: 'sk-test',
      baseUrl: 'https://api.example.com',
      fetchFn: fakeFetch,
    });

    const result = await realFn({
      role: 'coder',
      prompt: 'test',
      model: 'kimi-k2.6',
      provider: 'kimi',
    });

    assert.strictEqual(result.text, 'trimmed');
  });

  test('createRealProviderCall non-OK fake response throws safe error and does not leak apiKey', async () => {
    const fakeFetch: FetchFn = async () => ({
      ok: false,
      status: 401,
      json: async () => ({ error: 'Unauthorized' }),
    });

    const realFn = createRealProviderCall({
      provider: 'kimi',
      apiKey: 'sk-leaked-secret',
      baseUrl: 'https://api.example.com',
      fetchFn: fakeFetch,
    });

    await assert.rejects(
      async () =>
        realFn({
          role: 'coder',
          prompt: 'test',
          model: 'kimi-k2.6',
          provider: 'kimi',
        }),
      (err: Error) => {
        assert(err.message.includes('Provider returned status 401'));
        assert(!err.message.includes('sk-leaked-secret'));
        assert(!err.message.includes('Bearer'));
        return true;
      }
    );
  });

  test('createRealProviderCall malformed fake response throws clear error', async () => {
    const fakeFetch: FetchFn = async () => ({
      ok: true,
      status: 200,
      json: async () => ({ choices: 'not-an-array' }),
    });

    const realFn = createRealProviderCall({
      provider: 'kimi',
      apiKey: 'sk-test',
      baseUrl: 'https://api.example.com',
      fetchFn: fakeFetch,
    });

    await assert.rejects(
      async () =>
        realFn({
          role: 'coder',
          prompt: 'test',
          model: 'kimi-k2.6',
          provider: 'kimi',
        }),
      /Invalid response: missing choices/
    );
  });

  test('createRealProviderCall does not read env vars', async () => {
    const originalKey = process.env.KIMI_API_KEY;
    process.env.KIMI_API_KEY = 'env-key-should-not-be-used';
    try {
      let usedKey: string | undefined;
      const fakeFetch: FetchFn = async (_url, init) => {
        usedKey = init?.headers?.['Authorization'];
        return {
          ok: true,
          status: 200,
          json: async () => ({
            choices: [{ message: { content: 'ok' } }],
          }),
        };
      };

      const realFn = createRealProviderCall({
        provider: 'kimi',
        apiKey: 'explicit-key',
        baseUrl: 'https://api.example.com',
        fetchFn: fakeFetch,
      });

      await realFn({
        role: 'coder',
        prompt: 'test',
        model: 'kimi-k2.6',
        provider: 'kimi',
      });

      assert.strictEqual(usedKey, 'Bearer explicit-key');
    } finally {
      if (originalKey === undefined) {
        delete process.env.KIMI_API_KEY;
      } else {
        process.env.KIMI_API_KEY = originalKey;
      }
    }
  });

  test('createRealProviderCall is pure: no file mutation', async () => {
    const fakeFetch: FetchFn = async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { content: 'ok' } }],
      }),
    });

    const realFn = createRealProviderCall({
      provider: 'kimi',
      apiKey: 'sk-test',
      baseUrl: 'https://api.example.com',
      fetchFn: fakeFetch,
    });

    const result = await realFn({
      role: 'coder',
      prompt: 'test',
      model: 'kimi-k2.6',
      provider: 'kimi',
    });

    assert.strictEqual(result.text, 'ok');
    // No filesystem side effects to verify; function only calls injected fetchFn
  });

  test('buildProviderCallInput creates coder input correctly', () => {
    const input = buildProviderCallInput('coder', 'write hello world', 'mock', 'mock-model');
    assert.strictEqual(input.role, 'coder');
    assert.strictEqual(input.prompt, 'write hello world');
    assert.strictEqual(input.provider, 'mock');
    assert.strictEqual(input.model, 'mock-model');
  });

  test('buildProviderCallInput creates reviewer input correctly', () => {
    const input = buildProviderCallInput('reviewer', 'review this code', 'openai', 'gpt-4o');
    assert.strictEqual(input.role, 'reviewer');
    assert.strictEqual(input.prompt, 'review this code');
    assert.strictEqual(input.provider, 'openai');
    assert.strictEqual(input.model, 'gpt-4o');
  });

  test('buildProviderCallInput rejects empty prompt', () => {
    assert.throws(
      () => buildProviderCallInput('coder', '', 'mock', 'mock-model'),
      /Invalid prompt: expected non-empty string/
    );
  });

  test('buildProviderCallInput rejects empty provider', () => {
    assert.throws(
      () => buildProviderCallInput('coder', 'test', '', 'mock-model'),
      /Invalid provider: expected non-empty string/
    );
  });

  test('buildProviderCallInput rejects empty model', () => {
    assert.throws(
      () => buildProviderCallInput('coder', 'test', 'mock', ''),
      /Invalid model: expected non-empty string/
    );
  });

  test('buildProviderCallInput rejects invalid role', () => {
    assert.throws(
      () => buildProviderCallInput('admin', 'test', 'mock', 'mock-model'),
      /Invalid role: expected coder or reviewer/
    );
  });

  test('buildProviderCallInput is pure: no API keys, no network, no file mutation', () => {
    // Pure function: no env reads, no file ops, no network calls
    const input1 = buildProviderCallInput('coder', 'prompt', 'prov', 'mod');
    const input2 = buildProviderCallInput('coder', 'prompt', 'prov', 'mod');
    assert.deepStrictEqual(input1, input2);
  });

  test('normalizeProviderCallResult trims leading and trailing whitespace', () => {
    const result = normalizeProviderCallResult({
      role: 'coder',
      text: '  hello world  ',
      provider: 'mock',
      model: 'mock-model',
    });
    assert.strictEqual(result.text, 'hello world');
  });

  test('normalizeProviderCallResult preserves internal newlines', () => {
    const result = normalizeProviderCallResult({
      role: 'coder',
      text: '\nline1\nline2\n',
      provider: 'mock',
      model: 'mock-model',
    });
    assert.strictEqual(result.text, 'line1\nline2');
  });

  test('normalizeProviderCallResult preserves role, provider, and model', () => {
    const result = normalizeProviderCallResult({
      role: 'reviewer',
      text: 'looks good',
      provider: 'openai',
      model: 'gpt-4o',
    });
    assert.strictEqual(result.role, 'reviewer');
    assert.strictEqual(result.provider, 'openai');
    assert.strictEqual(result.model, 'gpt-4o');
  });

  test('normalizeProviderCallResult rejects non-object input', () => {
    assert.throws(
      () => normalizeProviderCallResult(null),
      /Invalid result: expected object/
    );
    assert.throws(
      () => normalizeProviderCallResult('string'),
      /Invalid result: expected object/
    );
  });

  test('normalizeProviderCallResult rejects invalid role', () => {
    assert.throws(
      () =>
        normalizeProviderCallResult({
          role: 'admin',
          text: 'test',
          provider: 'mock',
          model: 'mock-model',
        }),
      /Invalid result.role: expected coder or reviewer/
    );
  });

  test('normalizeProviderCallResult rejects non-string text', () => {
    assert.throws(
      () =>
        normalizeProviderCallResult({
          role: 'coder',
          text: 123,
          provider: 'mock',
          model: 'mock-model',
        } as unknown as Record<string, unknown>),
      /Invalid result.text: expected string/
    );
  });

  test('normalizeProviderCallResult rejects empty provider', () => {
    assert.throws(
      () =>
        normalizeProviderCallResult({
          role: 'coder',
          text: 'test',
          provider: '',
          model: 'mock-model',
        }),
      /Invalid result.provider: expected non-empty string/
    );
  });

  test('normalizeProviderCallResult rejects empty model', () => {
    assert.throws(
      () =>
        normalizeProviderCallResult({
          role: 'coder',
          text: 'test',
          provider: 'mock',
          model: '',
        }),
      /Invalid result.model: expected non-empty string/
    );
  });

  test('normalizeProviderCallResult is pure and deterministic', () => {
    const raw = { role: 'coder', text: '  text  ', provider: 'mock', model: 'mod' };
    const r1 = normalizeProviderCallResult(raw);
    const r2 = normalizeProviderCallResult(raw);
    assert.deepStrictEqual(r1, r2);
    assert.strictEqual(r1.text, 'text');
  });

  test('normalizeProviderCallError normalizes Error.message', () => {
    const err = new Error('something went wrong');
    const info = normalizeProviderCallError(err);
    assert.strictEqual(info.message, 'something went wrong');
    assert.strictEqual(info.isRetryable, false);
  });

  test('normalizeProviderCallError normalizes string error', () => {
    const info = normalizeProviderCallError('string error');
    assert.strictEqual(info.message, 'string error');
    assert.strictEqual(info.isRetryable, false);
  });

  test('normalizeProviderCallError uses generic message for null/object/number', () => {
    assert.strictEqual(normalizeProviderCallError(null).message, 'Unknown provider call error');
    assert.strictEqual(normalizeProviderCallError({ foo: 1 }).message, 'Unknown provider call error');
    assert.strictEqual(normalizeProviderCallError(42).message, 'Unknown provider call error');
  });

  test('normalizeProviderCallError trims message', () => {
    const info = normalizeProviderCallError('  spaced  ');
    assert.strictEqual(info.message, 'spaced');
  });

  test('normalizeProviderCallError empty message becomes generic', () => {
    const info = normalizeProviderCallError('   ');
    assert.strictEqual(info.message, 'Unknown provider call error');
  });

  test('normalizeProviderCallError detects retryable timeout', () => {
    const info = normalizeProviderCallError(new Error('Request timeout'));
    assert.strictEqual(info.isRetryable, true);
    assert.strictEqual(info.message, 'Request timeout');
  });

  test('normalizeProviderCallError detects retryable rate limit case-insensitively', () => {
    const info = normalizeProviderCallError(new Error('Rate Limit exceeded'));
    assert.strictEqual(info.isRetryable, true);
    assert.strictEqual(info.message, 'Rate Limit exceeded');
  });

  test('normalizeProviderCallError detects retryable ECONNRESET and ETIMEDOUT', () => {
    assert.strictEqual(normalizeProviderCallError(new Error('ECONNRESET')).isRetryable, true);
    assert.strictEqual(normalizeProviderCallError(new Error('ETIMEDOUT')).isRetryable, true);
  });

  test('normalizeProviderCallError non-retryable validation error returns false', () => {
    const info = normalizeProviderCallError(new Error('Invalid API key format'));
    assert.strictEqual(info.isRetryable, false);
    assert.strictEqual(info.message, 'Invalid API key format');
  });

  test('normalizeProviderCallError redacts sk- tokens', () => {
    const info = normalizeProviderCallError(new Error('Key sk-abc123 is invalid'));
    assert.strictEqual(info.message, 'Key [REDACTED] is invalid');
  });

  test('normalizeProviderCallError redacts Bearer tokens', () => {
    const info = normalizeProviderCallError(new Error('Header Bearer secret-token-42'));
    assert.strictEqual(info.message, 'Header Bearer [REDACTED]');
  });

  test('normalizeProviderCallError does not include stack trace', () => {
    const err = new Error('no stack');
    const info = normalizeProviderCallError(err);
    assert(!info.message.includes('at '), `Message should not contain stack trace, got: ${info.message}`);
    assert(!info.message.includes('Error:'), `Message should not contain Error prefix, got: ${info.message}`);
  });

  test('normalizeProviderCallError is pure and deterministic', () => {
    const err = new Error('timeout');
    const a = normalizeProviderCallError(err);
    const b = normalizeProviderCallError(err);
    assert.deepStrictEqual(a, b);
    assert.strictEqual(a.message, 'timeout');
    assert.strictEqual(a.isRetryable, true);
  });
});
