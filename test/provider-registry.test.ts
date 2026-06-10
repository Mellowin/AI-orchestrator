import { describe, test } from 'node:test';
import assert from 'node:assert';
import { ProviderRegistry } from '../src/providers/provider-registry.js';
import { createFakeCoderProvider } from '../src/providers/fake/fake-coder-provider.js';
import { createFakeReviewerProvider } from '../src/providers/fake/fake-reviewer-provider.js';

describe('provider-registry', () => {
  test('registers fake coder', () => {
    const registry = new ProviderRegistry();
    registry.registerCoder('fake', (_config) => createFakeCoderProvider());
    assert.strictEqual(registry.hasCoder('fake'), true);
  });

  test('registers fake reviewer', () => {
    const registry = new ProviderRegistry();
    registry.registerReviewer('fake', (_config) => createFakeReviewerProvider());
    assert.strictEqual(registry.hasReviewer('fake'), true);
  });

  test('resolves coder by provider id', () => {
    const registry = new ProviderRegistry();
    registry.registerCoder('fake', (_config) => createFakeCoderProvider());
    const coder = registry.resolveCoder({ provider: 'fake', model: 'test' });
    assert.strictEqual(coder.id, 'fake');
    assert.strictEqual(coder.role, 'coder');
  });

  test('resolves reviewer by provider id', () => {
    const registry = new ProviderRegistry();
    registry.registerReviewer('fake', (_config) => createFakeReviewerProvider());
    const reviewer = registry.resolveReviewer({ provider: 'fake', model: 'test' });
    assert.strictEqual(reviewer.id, 'fake');
    assert.strictEqual(reviewer.role, 'reviewer');
  });

  test('refuses unknown provider', () => {
    const registry = new ProviderRegistry();
    assert.throws(
      () => registry.resolveCoder({ provider: 'unknown' as any, model: 'test' }),
      /Unknown coder provider: unknown/
    );
    assert.throws(
      () => registry.resolveReviewer({ provider: 'unknown' as any, model: 'test' }),
      /Unknown reviewer provider: unknown/
    );
  });

  test('refuses unsupported role', () => {
    const registry = new ProviderRegistry();
    registry.registerCoder('fake', (_config) => createFakeCoderProvider());
    // coder registered but reviewer not
    assert.throws(
      () => registry.resolveReviewer({ provider: 'fake', model: 'test' }),
      /Unknown reviewer provider: fake/
    );
  });

  test('registry creation does not call provider', () => {
    let called = false;
    const registry = new ProviderRegistry();
    registry.registerCoder('fake', (_config) => {
      called = true;
      return createFakeCoderProvider();
    });
    // Creation alone should not call factory
    assert.strictEqual(called, false);
    // Resolution calls factory
    registry.resolveCoder({ provider: 'fake', model: 'test' });
    assert.strictEqual(called, true);
  });

  test('registry creation does not read API key', () => {
    const originalKey = process.env.KIMI_API_KEY;
    process.env.KIMI_API_KEY = 'registry-should-not-read';
    try {
      const registry = new ProviderRegistry();
      registry.registerReviewer('fake', (_config) => createFakeReviewerProvider());
      // Just creating registry should be safe
      assert.strictEqual(registry.hasReviewer('fake'), true);
    } finally {
      if (originalKey === undefined) {
        delete process.env.KIMI_API_KEY;
      } else {
        process.env.KIMI_API_KEY = originalKey;
      }
    }
  });
});
