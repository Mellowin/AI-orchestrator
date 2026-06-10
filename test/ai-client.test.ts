import { describe, test } from 'node:test';
import assert from 'node:assert';
import { MockAIClient, createMockAIClient } from '../src/ai-client.js';
import { createAIClient, createAIClientFromConfig } from '../src/ai-client-factory.js';
import type { AIConfig } from '../src/config.js';

describe('ai-client', () => {
  test('MockAIClient.generate returns configured response', async () => {
    const client = new MockAIClient('hello world');
    const result = await client.generate('prompt');
    assert.strictEqual(result, 'hello world');
  });

  test('MockAIClient.generate throws on empty prompt', async () => {
    const client = new MockAIClient('response');
    await assert.rejects(async () => client.generate(''), /Prompt is empty/);
    await assert.rejects(async () => client.generate('   '), /Prompt is empty/);
  });

  test('createMockAIClient creates a working MockAIClient', async () => {
    const client = createMockAIClient('fake');
    const result = await client.generate('test');
    assert.strictEqual(result, 'fake');
  });

  test('createAIClient with mock provider returns working client', async () => {
    const client = createAIClient({
      provider: 'mock',
      mockResponse: '{"mode":"file_update","files":[]}',
    });
    const result = await client.generate('write code');
    assert.strictEqual(result, '{"mode":"file_update","files":[]}');
  });

  test('createAIClient with mock provider requires mockResponse', () => {
    assert.throws(
      () => createAIClient({ provider: 'mock' }),
      /mockResponse is required/
    );
  });

  test('createAIClient with kimi provider returns KimiClient', async () => {
    const fakeFetch = async (): Promise<Response> => {
      return new Response(
        JSON.stringify({ choices: [{ message: { content: 'ok' } }] }),
        { status: 200, statusText: 'OK', headers: { 'Content-Type': 'application/json' } }
      );
    };

    const client = createAIClient({
      provider: 'kimi',
      kimi: { apiKey: 'test-key', model: 'kimi-k2.6', fetchFn: fakeFetch },
    });

    const result = await client.generate('hello');
    assert.strictEqual(result, 'ok');
  });

  test('createAIClient with kimi provider requires kimi options', () => {
    assert.throws(
      () => createAIClient({ provider: 'kimi' }),
      /kimi options are required/
    );
  });

  test('createAIClient with unsupported provider throws', () => {
    assert.throws(
      () =>
        createAIClient({
          provider: 'unsupported' as 'mock',
          mockResponse: 'x',
        }),
      /Unsupported AI provider/
    );
  });

  test('createAIClientFromConfig with mock config returns working client', async () => {
    const aiConfig: AIConfig = {
      provider: 'mock',
      mockResponse: 'mock-result',
      kimiApiKey: '',
      kimiModel: '',
      kimiBaseUrl: '',
      kimiUserAgent: '',
    };
    const client = createAIClientFromConfig(aiConfig);
    const result = await client.generate('prompt');
    assert.strictEqual(result, 'mock-result');
  });

  test('createAIClientFromConfig with kimi config creates client without throwing', () => {
    const aiConfig: AIConfig = {
      provider: 'kimi',
      mockResponse: '',
      kimiApiKey: 'secret',
      kimiModel: 'kimi-k2.6',
      kimiBaseUrl: 'https://api.moonshot.ai/v1',
      kimiUserAgent: '',
    };

    const client = createAIClientFromConfig(aiConfig);
    assert.ok(typeof client.generate === 'function');
  });

  test('createAIClientFromConfig with unsupported provider throws', () => {
    const aiConfig = {
      provider: 'unsupported' as 'mock',
      mockResponse: 'x',
      kimiApiKey: '',
      kimiModel: '',
      kimiBaseUrl: '',
      kimiUserAgent: '',
    };
    assert.throws(() => createAIClientFromConfig(aiConfig), /Unsupported AI provider/);
  });

  test('KimiClient does not expose API key in HTTP error', async () => {
    const secretKey = 'sk-test-secret-key-12345';
    const fakeFetch = async (): Promise<Response> => {
      return new Response('invalid credentials', {
        status: 401,
        statusText: 'Unauthorized',
      });
    };

    const client = createAIClient({
      provider: 'kimi',
      kimi: { apiKey: secretKey, model: 'kimi-k2.6', fetchFn: fakeFetch },
    });

    try {
      await client.generate('hello');
      assert.fail('Expected error');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      assert.ok(message.includes('401'), 'Should contain status code');
      assert.ok(
        !message.includes(secretKey),
        'Error message should not contain API key'
      );
    }
  });

  test('MockAIClient is deterministic for same input', async () => {
    const client = createMockAIClient('stable');
    const r1 = await client.generate('prompt');
    const r2 = await client.generate('prompt');
    assert.strictEqual(r1, r2);
  });
});
