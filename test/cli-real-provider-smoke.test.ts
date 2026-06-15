import { describe, test } from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runRealProviderSmoke, normalizeRealProviderSmokeProvider } from '../src/real-provider-smoke.js';

const PROJECT_ROOT = process.cwd();
const TSX_CLI_PATH = join(PROJECT_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const CLI_PATH = join(PROJECT_ROOT, 'src', 'cli.ts');
const SOURCE_PATH = join(PROJECT_ROOT, 'src', 'real-provider-smoke.ts');
const CLI_SOURCE_PATH = join(PROJECT_ROOT, 'src', 'cli.ts');

const BASE_ENV = {
  ALLOW_REAL_PROVIDER: 'true',
  KIMI_API_KEY: 'sk-test',
  KIMI_BASE_URL: 'http://localhost.invalid',
  KIMI_MODEL: 'kimi-k2.6',
};

function runCli(args: string[], envOverrides: Record<string, string> = {}): {
  status: number;
  stdout: string;
  stderr: string;
} {
  const env = { ...process.env, ...envOverrides };
  const result = spawnSync(process.execPath, [TSX_CLI_PATH, CLI_PATH, ...args], {
    cwd: PROJECT_ROOT,
    env,
    encoding: 'utf-8',
    shell: false,
    timeout: 30000,
  });
  return {
    status: result.status ?? 1,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
  };
}

function readSource(path: string): string {
  return readFileSync(path, 'utf-8');
}

describe('real-provider-smoke CLI', () => {
  test('CLI usage includes real-provider-smoke', () => {
    const result = runCli([]);
    assert.notStrictEqual(result.status, 0);
    const output = `${result.stdout}\n${result.stderr}`;
    assert.match(output, /real-provider-smoke/);
  });

  test('missing ALLOW_REAL_PROVIDER exits non-zero', () => {
    const result = runCli(['real-provider-smoke'], {
      AI_PROVIDER: 'mock',
      ALLOW_REAL_PROVIDER: '',
      KIMI_API_KEY: 'sk-test',
      KIMI_BASE_URL: 'http://localhost.invalid',
    });
    assert.notStrictEqual(result.status, 0);
  });

  test('missing KIMI_API_KEY exits non-zero', () => {
    const result = runCli(['real-provider-smoke'], {
      AI_PROVIDER: 'mock',
      ALLOW_REAL_PROVIDER: 'true',
      KIMI_API_KEY: '',
      KIMI_BASE_URL: 'http://localhost.invalid',
    });
    assert.notStrictEqual(result.status, 0);
  });

  test('missing KIMI_BASE_URL exits non-zero', () => {
    const result = runCli(['real-provider-smoke'], {
      AI_PROVIDER: 'mock',
      ALLOW_REAL_PROVIDER: 'true',
      KIMI_API_KEY: 'sk-test',
      KIMI_BASE_URL: '',
    });
    assert.notStrictEqual(result.status, 0);
  });

  test('missing env does not call provider', async () => {
    let called = false;
    const fetchFn = async () => {
      called = true;
      return { ok: false, status: 500, statusText: 'should not reach', text: async () => '' } as unknown as Response;
    };
    await assert.rejects(async () => {
      await runRealProviderSmoke('kimi', fetchFn as unknown as typeof fetch, {});
    });
    assert.strictEqual(called, false);
  });

  test('missing env output is JSON parseable', () => {
    const result = runCli(['real-provider-smoke'], {
      AI_PROVIDER: 'mock',
      ALLOW_REAL_PROVIDER: '',
      KIMI_API_KEY: 'sk-test',
      KIMI_BASE_URL: 'http://localhost.invalid',
    });
    const output = result.stdout || result.stderr;
    const jsonMatch = output.match(/\{[\s\S]*\}/);
    assert.ok(jsonMatch, 'output should contain JSON');
    const parsed = JSON.parse(jsonMatch[0]);
    assert.strictEqual(parsed.ok, false);
    assert.strictEqual(parsed.mode, 'real-provider-smoke');
  });

  test('missing env output does not leak secret-like values', () => {
    const result = runCli(['real-provider-smoke'], {
      AI_PROVIDER: 'mock',
      ALLOW_REAL_PROVIDER: '',
      KIMI_API_KEY: 'sk-real-test-key-1234567890',
      KIMI_BASE_URL: 'http://localhost.invalid',
    });
    const output = `${result.stdout}\n${result.stderr}`;
    assert.doesNotMatch(output, /sk-real-test-key-1234567890/);
  });

  test('success with fake fetch exits 0 and returns parseable JSON', async () => {
    const fetchFn = async () =>
      ({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({
          choices: [{ message: { content: '{"ok":true,"message":"provider smoke ok"}' } }],
        }),
      }) as unknown as Response;

    const result = await runRealProviderSmoke('kimi', fetchFn, { ...BASE_ENV });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.provider, 'kimi');
    assert.strictEqual(result.mode, 'real-provider-smoke');
    assert.strictEqual(result.responseParsed, true);
    assert.strictEqual(result.message, 'provider smoke ok');
  });

  test('success output contains provider name and no API key', async () => {
    const fetchFn = async () =>
      ({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({
          choices: [{ message: { content: '{"ok":true,"message":"provider smoke ok"}' } }],
        }),
      }) as unknown as Response;

    const result = await runRealProviderSmoke('kimi', fetchFn, { ...BASE_ENV });
    const json = JSON.stringify(result);
    assert.match(json, /"provider":\s*"kimi"/);
    assert.doesNotMatch(json, /sk-test/);
  });

  test('provider failure exits non-zero with redacted output', async () => {
    const fetchFn = async () =>
      ({
        ok: false,
        status: 401,
        statusText: 'Unauthorized',
        text: async () => 'Bearer sk-leaked-key-1234567890 is invalid',
      }) as unknown as Response;

    const result = await runRealProviderSmoke('kimi', fetchFn, { ...BASE_ENV });
    assert.strictEqual(result.ok, false);
    assert.ok(result.error);
    assert.doesNotMatch(result.error, /sk-leaked-key-1234567890/);
    assert.match(result.error, /\[REDACTED\]/);
  });

  test('provider failure does not print raw headers', async () => {
    const fetchFn = async () =>
      ({
        ok: false,
        status: 401,
        statusText: 'Unauthorized',
        text: async () => 'unauthorized',
      }) as unknown as Response;

    const result = await runRealProviderSmoke('kimi', fetchFn, { ...BASE_ENV });
    assert.strictEqual(result.ok, false);
    assert.doesNotMatch(result.error, /Authorization/);
    assert.doesNotMatch(result.error, /Bearer/);
  });

  test('provider failure does not print raw full response body', async () => {
    const longBody = 'x'.repeat(2000);
    const fetchFn = async () =>
      ({
        ok: false,
        status: 500,
        statusText: 'Error',
        text: async () => longBody,
      }) as unknown as Response;

    const result = await runRealProviderSmoke('kimi', fetchFn, { ...BASE_ENV });
    assert.strictEqual(result.ok, false);
    assert.ok(result.error);
    assert.ok(result.error.length < longBody.length, 'error must be bounded, not raw body');
  });

  test('command does not write files', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'provider-smoke-test-'));
    const beforeStat = existsSync(tmpDir) ? statSync(tmpDir).mtimeMs : 0;
    const fetchFn = async () =>
      ({
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{ message: { content: '{"ok":true,"message":"ok"}' } }],
        }),
      }) as unknown as Response;

    await runRealProviderSmoke('kimi', fetchFn, { ...BASE_ENV, RUNS_DIR: join(tmpDir, 'runs') });
    assert.strictEqual(existsSync(join(tmpDir, 'runs')), false, 'must not create runs dir');
    if (beforeStat) {
      assert.strictEqual(statSync(tmpDir).mtimeMs, beforeStat, 'temp dir must not be modified');
    }
  });

  test('command does not create block state', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'provider-smoke-state-'));
    const fetchFn = async () =>
      ({
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{ message: { content: '{"ok":true,"message":"ok"}' } }],
        }),
      }) as unknown as Response;

    await runRealProviderSmoke('kimi', fetchFn, { ...BASE_ENV, RUNS_DIR: join(tmpDir, 'runs') });
    assert.strictEqual(existsSync(join(tmpDir, 'runs', 'block')), false);
  });

  test('source does not spawn block runner', () => {
    const source = readSource(SOURCE_PATH);
    assert.doesNotMatch(source, /real-block-run-ai/);
  });

  test('source does not import git manager', () => {
    const source = readSource(SOURCE_PATH);
    assert.doesNotMatch(source, /git-manager/);
  });

  test('source does not use shell:true', () => {
    const source = readSource(SOURCE_PATH);
    assert.doesNotMatch(source, /shell:\s*true/);
  });

  test('source does not call fetch/http directly without injection', () => {
    const source = readSource(SOURCE_PATH);
    assert.doesNotMatch(source, /\bglobalThis\.fetch\b/);
    assert.doesNotMatch(source, /\bfetch\s*\(/);
  });

  test('CLI source does not use shell:true for smoke branch', () => {
    const source = readFileSync(CLI_SOURCE_PATH, 'utf-8');
    const smokeIndex = source.indexOf("command === 'real-provider-smoke'");
    assert.ok(smokeIndex >= 0, 'smoke branch must exist in cli.ts');
    const nextBranchIndex = source.indexOf("command === 'provider-preview'", smokeIndex);
    const snippet = source.slice(smokeIndex, nextBranchIndex);
    assert.doesNotMatch(snippet, /shell:\s*true/);
  });

  test('default provider is kimi', async () => {
    const normalized = normalizeRealProviderSmokeProvider(undefined);
    assert.strictEqual(normalized.provider, 'kimi');
    assert.strictEqual(normalized.supported, true);
  });

  test('--provider kimi is accepted', async () => {
    const normalized = normalizeRealProviderSmokeProvider('kimi');
    assert.strictEqual(normalized.provider, 'kimi');
    assert.strictEqual(normalized.supported, true);
  });

  test('--provider openai exits non-zero', async () => {
    const result = await runRealProviderSmoke('openai', undefined, {});
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.provider, 'openai');
  });

  test('unsupported provider exits before env validation', async () => {
    const result = await runRealProviderSmoke('openai', undefined, {
      ALLOW_REAL_PROVIDER: '',
      KIMI_API_KEY: '',
      KIMI_BASE_URL: '',
    });
    assert.strictEqual(result.ok, false);
    assert.match(result.error, /Unsupported provider/i);
  });

  test('unsupported provider does not call provider/fetch', async () => {
    let called = false;
    const fetchFn = async () => {
      called = true;
      return {} as unknown as Response;
    };
    const result = await runRealProviderSmoke('openai', fetchFn as unknown as typeof fetch, {});
    assert.strictEqual(result.ok, false);
    assert.strictEqual(called, false);
  });

  test('unsupported provider output is JSON parseable', async () => {
    const result = await runRealProviderSmoke('openai', undefined, {});
    const json = JSON.stringify(result);
    const parsed = JSON.parse(json);
    assert.strictEqual(parsed.ok, false);
    assert.strictEqual(parsed.mode, 'real-provider-smoke');
  });

  test('unsupported provider output contains deterministic error', async () => {
    const result = await runRealProviderSmoke('openai', undefined, {});
    assert.match(result.error, /Unsupported provider for real-provider-smoke: only kimi is supported/);
  });

  test('unsupported safe provider name is shown safely', async () => {
    const result = await runRealProviderSmoke('openai', undefined, {});
    assert.strictEqual(result.provider, 'openai');
  });

  test('unsafe provider string is not echoed raw', async () => {
    const result = await runRealProviderSmoke('openai;rm -rf', undefined, {});
    assert.strictEqual(result.provider, 'unknown');
    assert.doesNotMatch(result.error, /openai;rm -rf/);
    assert.doesNotMatch(JSON.stringify(result), /openai;rm -rf/);
  });

  test('secret-like provider string is redacted or replaced with unknown', async () => {
    const result = await runRealProviderSmoke('sk-secret', undefined, {});
    assert.strictEqual(result.provider, 'unknown');
    assert.doesNotMatch(JSON.stringify(result), /sk-secret/);
  });

  test('very long provider string is not echoed raw', async () => {
    const longName = 'a'.repeat(100);
    const result = await runRealProviderSmoke(longName, undefined, {});
    assert.strictEqual(result.provider, 'unknown');
    assert.doesNotMatch(JSON.stringify(result), new RegExp(longName));
  });

  test('unsupported provider does not require KIMI_API_KEY', async () => {
    const result = await runRealProviderSmoke('openai', undefined, {
      ALLOW_REAL_PROVIDER: 'true',
      KIMI_BASE_URL: 'http://localhost.invalid',
    });
    assert.strictEqual(result.ok, false);
    assert.match(result.error, /Unsupported provider/i);
  });

  test('unsupported provider does not require KIMI_BASE_URL', async () => {
    const result = await runRealProviderSmoke('openai', undefined, {
      ALLOW_REAL_PROVIDER: 'true',
      KIMI_API_KEY: 'sk-test',
    });
    assert.strictEqual(result.ok, false);
    assert.match(result.error, /Unsupported provider/i);
  });
});
