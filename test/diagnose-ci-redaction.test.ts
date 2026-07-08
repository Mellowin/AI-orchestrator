import { describe, test } from 'node:test';
import assert from 'node:assert';
import { redactSecrets } from '../src/diagnose-ci/redaction.js';

describe('diagnose-ci redaction', () => {
  test('redacts GitHub personal access tokens', () => {
    const text = 'token github_pat_abc123xyz && ghp_abcdef123456 && gho_secret && ghs_secret && ghu_secret';
    const redacted = redactSecrets(text);
    assert.ok(!redacted.includes('github_pat_abc123xyz'));
    assert.ok(!redacted.includes('ghp_abcdef123456'));
    assert.ok(!redacted.includes('gho_secret'));
    assert.ok(!redacted.includes('ghs_secret'));
    assert.ok(!redacted.includes('ghu_secret'));
  });

  test('redacts Bearer and Authorization headers', () => {
    const text = 'Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9\nAuthorization: token ghp_abc123';
    const redacted = redactSecrets(text);
    assert.ok(!redacted.includes('eyJhbGciOi'));
    assert.ok(!redacted.includes('ghp_abc123'));
    assert.ok(redacted.includes('Authorization: ***'));
  });

  test('redacts OpenAI-like and Kimi API keys', () => {
    const text = 'sk-abcdefghijklmnopqrstuvwxyz1234567890\nKIMI_API_KEY=super-secret-value\nOPENAI_API_KEY=another-secret';
    const redacted = redactSecrets(text);
    assert.ok(!redacted.includes('sk-abcdefghijklmnopqrstuvwxyz1234567890'));
    assert.ok(!redacted.includes('super-secret-value'));
    assert.ok(!redacted.includes('another-secret'));
    assert.ok(redacted.includes('KIMI_API_KEY=***'));
    assert.ok(redacted.includes('OPENAI_API_KEY=***'));
  });

  test('returns empty string for non-string input', () => {
    // @ts-expect-error testing invalid input type
    assert.strictEqual(redactSecrets(12345), '');
  });
});
