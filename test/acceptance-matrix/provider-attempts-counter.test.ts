import { describe, test } from 'node:test';
import assert from 'node:assert';
import { countProviderAttempts } from '../../src/acceptance-matrix/provider-attempts-counter.js';

describe('acceptance-matrix provider-attempts-counter', () => {
  test('returns 0 for null state', () => {
    assert.strictEqual(countProviderAttempts(null), 0);
  });

  test('counts taskResults[].providerAttempts', () => {
    const state = {
      taskResults: [
        { taskId: 'a', providerAttempts: [{ attempt: 1 }, { attempt: 2 }] },
        { taskId: 'b', providerAttempts: [{ attempt: 1 }] },
      ],
    };
    assert.strictEqual(countProviderAttempts(state), 3);
  });

  test('counts taskResults[].provider_attempts snake_case fallback', () => {
    const state = {
      taskResults: [
        { taskId: 'a', provider_attempts: [{ attempt: 1 }] },
        { taskId: 'b', provider_attempts: [{ attempt: 1 }, { attempt: 2 }, { attempt: 3 }] },
      ],
    };
    assert.strictEqual(countProviderAttempts(state), 4);
  });

  test('prefers task results over top-level provider_attempts', () => {
    const state = {
      provider_attempts: [{ attempt: 1 }, { attempt: 2 }, { attempt: 3 }, { attempt: 4 }],
      taskResults: [{ taskId: 'a', providerAttempts: [{ attempt: 1 }] }],
    };
    assert.strictEqual(countProviderAttempts(state), 1);
  });

  test('falls back to top-level provider_attempts when taskResults are empty', () => {
    const state = {
      provider_attempts: [{ attempt: 1 }, { attempt: 2 }],
      taskResults: [],
    };
    assert.strictEqual(countProviderAttempts(state), 2);
  });

  test('returns 0 when no attempts are present', () => {
    const state = {
      taskResults: [{ taskId: 'a' }],
    };
    assert.strictEqual(countProviderAttempts(state), 0);
  });
});
