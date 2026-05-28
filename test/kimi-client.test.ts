import { describe, test } from 'node:test';
import assert from 'node:assert';
import { KimiClient } from '../src/kimi-client.js';

describe('KimiClient', () => {
  test('empty prompt throws', async () => {
    const client = new KimiClient({
      apiKey: 'x',
      model: 'kimi-k2.6',
      fetchFn: async () => new Response(),
    });
    await assert.rejects(async () => client.generate('   '), /Prompt is empty/);
  });

  test('successful fake response', async () => {
    let receivedUrl = '';
    let receivedHeaders: Record<string, string> = {};
    let receivedBody: unknown = null;

    const fakeFetch = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      receivedUrl = String(url);
      receivedHeaders = {};
      if (init?.headers) {
        const h = init.headers as Record<string, string>;
        for (const [k, v] of Object.entries(h)) {
          receivedHeaders[k] = v;
        }
      }
      receivedBody = init?.body ? JSON.parse(String(init.body)) : null;
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: '{"mode":"file_update","files":[]}' } }],
        }),
        { status: 200, statusText: 'OK', headers: { 'Content-Type': 'application/json' } }
      );
    };

    const client = new KimiClient({ apiKey: 'x', model: 'kimi-k2.6', fetchFn: fakeFetch });
    const result = await client.generate('hello');
    assert.strictEqual(result, '{"mode":"file_update","files":[]}');
    assert(receivedUrl.endsWith('/chat/completions'), `URL: ${receivedUrl}`);
    assert.strictEqual(receivedHeaders['Authorization'], 'Bearer x');
    assert.strictEqual((receivedBody as Record<string, unknown>).model, 'kimi-k2.6');
    const messages = (receivedBody as Record<string, unknown>).messages as Array<Record<string, unknown>>;
    assert.strictEqual(messages[0].content, 'hello');
  });

  test('HTTP error', async () => {
    const fakeFetch = async (): Promise<Response> => {
      return new Response('bad key', { status: 401, statusText: 'Unauthorized' });
    };
    const client = new KimiClient({ apiKey: 'x', model: 'kimi-k2.6', fetchFn: fakeFetch });
    await assert.rejects(async () => client.generate('hello'), /Kimi API request failed: 401/);
  });

  test('sends custom User-Agent when provided', async () => {
    let receivedHeaders: Record<string, string> = {};

    const fakeFetch = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      receivedHeaders = {};
      if (init?.headers) {
        const h = init.headers as Record<string, string>;
        for (const [k, v] of Object.entries(h)) {
          receivedHeaders[k] = v;
        }
      }
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: 'ok' } }],
        }),
        { status: 200, statusText: 'OK', headers: { 'Content-Type': 'application/json' } }
      );
    };

    const client = new KimiClient({
      apiKey: 'x',
      model: 'kimi-k2.6',
      fetchFn: fakeFetch,
      userAgent: ' AI-Orchestrator-Test/1.0 ',
    });
    await client.generate('hello');
    assert.strictEqual(receivedHeaders['User-Agent'], 'AI-Orchestrator-Test/1.0');
  });

  test('does not send User-Agent when blank', async () => {
    let receivedHeaders: Record<string, string> = {};

    const fakeFetch = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      receivedHeaders = {};
      if (init?.headers) {
        const h = init.headers as Record<string, string>;
        for (const [k, v] of Object.entries(h)) {
          receivedHeaders[k] = v;
        }
      }
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: 'ok' } }],
        }),
        { status: 200, statusText: 'OK', headers: { 'Content-Type': 'application/json' } }
      );
    };

    const client = new KimiClient({
      apiKey: 'x',
      model: 'kimi-k2.6',
      fetchFn: fakeFetch,
      userAgent: '   ',
    });
    await client.generate('hello');
    assert.strictEqual(receivedHeaders['User-Agent'], undefined);
  });

  test('invalid response shape', async () => {
    const fakeFetch = async (): Promise<Response> => {
      return new Response(JSON.stringify({}), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
    const client = new KimiClient({ apiKey: 'x', model: 'kimi-k2.6', fetchFn: fakeFetch });
    await assert.rejects(async () => client.generate('hello'), /Invalid Kimi API response shape/);
  });
});
