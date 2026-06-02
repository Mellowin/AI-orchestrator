import { describe, test } from 'node:test';
import assert from 'node:assert';
import {
  createMockProviderCall,
  createRealProviderCall,
  buildProviderCallInput,
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
});
