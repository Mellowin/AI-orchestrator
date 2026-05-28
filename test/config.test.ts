import { spawnSync } from 'node:child_process';
import { describe, test } from 'node:test';
import assert from 'node:assert';
import { writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';

function runValidateConfig(envOverrides: Record<string, string>): { status: number; stderr: string } {
  const env = { ...process.env };
  delete env.AI_PROVIDER;
  delete env.MOCK_AI_RESPONSE;
  delete env.KIMI_API_KEY;
  delete env.KIMI_MODEL;
  delete env.KIMI_BASE_URL;
  delete env.OPENAI_API_KEY;
  delete env.MOCK_AI;
  Object.assign(env, envOverrides);

  const tmpFile = join(process.cwd(), 'tmp', 'config-smoke.ts');
  writeFileSync(tmpFile, `
import { config, validateConfig } from '../src/config.js';
validateConfig();
console.log(JSON.stringify({
  provider: config.ai.provider,
  mockAI: config.mockAI,
  kimiApiKey: config.kimiApiKey,
  kimiModel: config.kimiModel,
  kimiUserAgent: config.ai.kimiUserAgent,
}));
`, 'utf-8');

  const result = spawnSync(`npx tsx "${tmpFile}"`, {
    cwd: process.cwd(),
    env,
    encoding: 'utf-8',
    shell: true,
    timeout: 15000,
  });

  if (existsSync(tmpFile)) {
    unlinkSync(tmpFile);
  }

  return {
    status: result.status ?? 1,
    stderr: result.stderr || '',
    stdout: result.stdout || '',
  };
}

describe('config', () => {
  test('defaults to mock provider without env', () => {
    const result = runValidateConfig({});
    assert.strictEqual(result.status, 0, `Expected success, got stderr: ${result.stderr}`);
  });

  test('invalid provider fails', () => {
    const result = runValidateConfig({ AI_PROVIDER: 'openai' });
    assert.notStrictEqual(result.status, 0);
    assert(result.stderr.includes('AI_PROVIDER must be one of: mock, kimi'), `Got: ${result.stderr}`);
  });

  test('kimi provider requires api key and model', () => {
    const result1 = runValidateConfig({ AI_PROVIDER: 'kimi', KIMI_API_KEY: '' });
    assert.notStrictEqual(result1.status, 0);
    assert(result1.stderr.includes('KIMI_API_KEY is required when AI_PROVIDER=kimi'), `Got: ${result1.stderr}`);

    const result2 = runValidateConfig({ AI_PROVIDER: 'kimi', KIMI_API_KEY: 'x', KIMI_MODEL: '' });
    assert.notStrictEqual(result2.status, 0);
    assert(result2.stderr.includes('KIMI_MODEL is required when AI_PROVIDER=kimi'), `Got: ${result2.stderr}`);
  });

  test('kimi provider with valid keys succeeds', () => {
    const result = runValidateConfig({
      AI_PROVIDER: 'kimi',
      KIMI_API_KEY: 'x',
      KIMI_MODEL: 'moonshot-v1-8k',
    });
    assert.strictEqual(result.status, 0, `Expected success, got stderr: ${result.stderr}`);
  });

  test('kimi provider reads optional user agent', () => {
    const env = {
      AI_PROVIDER: 'kimi',
      KIMI_API_KEY: 'x',
      KIMI_MODEL: 'moonshot-v1-8k',
      KIMI_USER_AGENT: 'AI-Orchestrator-Test/1.0',
    };
    const result = runValidateConfig(env);
    assert.strictEqual(result.status, 0, `Expected success, got stderr: ${result.stderr}`);
    assert(result.stdout.includes('AI-Orchestrator-Test/1.0'), `Expected user agent in output, got: ${result.stdout}`);
  });
});
