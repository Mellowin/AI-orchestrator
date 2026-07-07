import { describe, test, beforeEach } from 'node:test';
import assert from 'node:assert';
import { validateAcceptanceMatrixRuntime } from '../../src/acceptance-matrix/env-validator.js';
import type { AcceptanceMatrixConfig } from '../../src/acceptance-matrix/types.js';

function baseConfig(): AcceptanceMatrixConfig {
  return {
    provider: 'fake',
    allow_real_provider: false,
    allow_github_pr_create: false,
    allow_real_repo_apply: true,
    allow_real_repo_commit: true,
    allow_real_repo_push: true,
    stop_on_orchestrator_bug: true,
    report_dir: 'tmp/reports',
    sandbox_repo_path: 'tmp/sandbox',
    sandbox_repo_slug: 'owner/repo',
    scenarios: [],
  };
}

describe('acceptance-matrix env-validator', () => {
  beforeEach(() => {
    delete process.env.KIMI_API_KEY;
    delete process.env.KIMI_BASE_URL;
    delete process.env.GITHUB_TOKEN;
  });

  test('fake mode passes without real tokens', () => {
    const result = validateAcceptanceMatrixRuntime(baseConfig());
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.report.kimi_api_key, 'missing');
    assert.strictEqual(result.report.github_token, 'missing');
  });

  test('real mode without KIMI_API_KEY fails', () => {
    const config = baseConfig();
    config.provider = 'kimi';
    config.allow_real_provider = true;
    const result = validateAcceptanceMatrixRuntime(config);
    assert.strictEqual(result.ok, false);
    assert.ok(result.reasons.some((r) => r.includes('KIMI_API_KEY')));
  });

  test('real mode with KIMI_API_KEY and BASE_URL passes', () => {
    process.env.KIMI_API_KEY = 'sk-real';
    process.env.KIMI_BASE_URL = 'https://api.moonshot.ai/v1';
    const config = baseConfig();
    config.provider = 'kimi';
    config.allow_real_provider = true;
    const result = validateAcceptanceMatrixRuntime(config);
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.report.kimi_api_key, 'present');
  });

  test('PR creation without GITHUB_TOKEN fails with permission classification', () => {
    const config = baseConfig();
    config.allow_github_pr_create = true;
    const result = validateAcceptanceMatrixRuntime(config);
    assert.strictEqual(result.ok, false);
    assert.ok(result.reasons.some((r) => r.includes('GITHUB_TOKEN')));
    assert.strictEqual(result.report.github_token, 'missing');
  });

  test('PR creation with token but no slug fails', () => {
    process.env.GITHUB_TOKEN = 'ghp_fake';
    const config = baseConfig();
    config.allow_github_pr_create = true;
    config.sandbox_repo_slug = '';
    const result = validateAcceptanceMatrixRuntime(config);
    assert.strictEqual(result.ok, false);
    assert.ok(result.reasons.some((r) => r.includes('sandbox_repo_slug')));
  });

  test('report never includes secret values', () => {
    process.env.KIMI_API_KEY = 'sk-super-secret-value';
    process.env.GITHUB_TOKEN = 'ghp_super_secret_value';
    const config = baseConfig();
    config.provider = 'kimi';
    config.allow_real_provider = true;
    config.allow_github_pr_create = true;
    const result = validateAcceptanceMatrixRuntime(config);
    const json = JSON.stringify(result);
    assert.ok(!json.includes('sk-super-secret-value'));
    assert.ok(!json.includes('ghp_super_secret_value'));
    assert.strictEqual(result.report.kimi_api_key, 'present');
    assert.strictEqual(result.report.github_token, 'present');
  });
});
