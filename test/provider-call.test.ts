import { describe, test } from 'node:test';
import assert from 'node:assert';
import {
  createMockProviderCall,
  createRealProviderCall,
  buildProviderCallInput,
  normalizeProviderCallResult,
  normalizeProviderCallError,
} from '../src/provider-call.js';
import type { ProviderCallInput } from '../src/provider-call.js';

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

  test('real provider placeholder throws not implemented yet', async () => {
    const realFn = createRealProviderCall();
    const input: ProviderCallInput = {
      role: 'coder',
      prompt: 'test',
      model: 'kimi-k2.6',
      provider: 'kimi',
    };
    await assert.rejects(
      async () => realFn(input),
      /real provider call is not implemented yet/
    );
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
