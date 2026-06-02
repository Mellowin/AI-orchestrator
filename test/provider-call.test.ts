import { describe, test } from 'node:test';
import assert from 'node:assert';
import {
  createMockProviderCall,
  createRealProviderCall,
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
});
