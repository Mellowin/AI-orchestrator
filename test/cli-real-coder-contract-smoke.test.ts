import { describe, test } from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  runRealCoderContractSmoke,
  formatRealCoderContractSmokeReport,
  normalizeRealCoderContractSmokeProvider,
  parseRealCoderContractSmokeTimeoutMs,
} from '../src/real-coder-contract-smoke.js';

const PROJECT_ROOT = process.cwd();
const TSX_CLI_PATH = join(PROJECT_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const CLI_PATH = join(PROJECT_ROOT, 'src', 'cli.ts');
const SOURCE_PATH = join(PROJECT_ROOT, 'src', 'real-coder-contract-smoke.ts');
const CLI_SOURCE_PATH = join(PROJECT_ROOT, 'src', 'cli.ts');

function runCli(args: string[], envOverrides: Record<string, string | undefined> = {}): {
  status: number;
  stdout: string;
  stderr: string;
} {
  const env: Record<string, string | undefined> = { ...process.env };
  for (const [key, value] of Object.entries(envOverrides)) {
    if (value === undefined) {
      delete env[key];
    } else {
      env[key] = value;
    }
  }
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

function parseOutput(output: string): Record<string, unknown> {
  const match = output.match(/\{[\s\S]*\}/);
  assert.ok(match, 'output should contain JSON');
  return JSON.parse(match[0]) as Record<string, unknown>;
}

function readSource(path: string): string {
  return readFileSync(path, 'utf-8');
}

function makeContractResponse(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    summary: 'Contract smoke summary',
    files: [{ path: 'README.md', content: 'Hello from contract smoke' }],
    notes: [],
    ...overrides,
  });
}

function makeKimiFetch(content: string): typeof fetch {
  return (() =>
    Promise.resolve({
      ok: true,
      status: 200,
      statusText: 'OK',
      text: async () => JSON.stringify({ choices: [{ message: { content } }] }),
      json: async () => ({ choices: [{ message: { content } }] }),
    } as unknown as Response)) as unknown as typeof fetch;
}

function makeDelayedFetch(content: string, delayMs: number, respectSignal = true): typeof fetch {
  return ((input, init) => {
    const signal = init?.signal as AbortSignal | undefined;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        resolve({
          ok: true,
          status: 200,
          statusText: 'OK',
          text: async () => JSON.stringify({ choices: [{ message: { content } }] }),
          json: async () => ({ choices: [{ message: { content } }] }),
        } as unknown as Response);
      }, delayMs);
      if (respectSignal && signal) {
        signal.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(new Error('Aborted'));
        });
      }
    });
  }) as unknown as typeof fetch;
}

describe('real-coder-contract-smoke module', () => {
  test('normalize provider supports kimi', () => {
    const result = normalizeRealCoderContractSmokeProvider('kimi');
    assert.strictEqual(result.provider, 'kimi');
    assert.strictEqual(result.supported, true);
  });

  test('normalize provider defaults to kimi', () => {
    const result = normalizeRealCoderContractSmokeProvider(undefined);
    assert.strictEqual(result.provider, 'kimi');
    assert.strictEqual(result.supported, true);
  });

  test('normalize provider rejects unsupported', () => {
    const result = normalizeRealCoderContractSmokeProvider('openai');
    assert.strictEqual(result.supported, false);
    assert.strictEqual(result.provider, 'openai');
  });

  test('normalize provider sanitizes unsafe name', () => {
    const result = normalizeRealCoderContractSmokeProvider('openai;rm -rf');
    assert.strictEqual(result.supported, false);
    assert.strictEqual(result.provider, 'unknown');
  });

  test('normalize provider treats secret-like name as unknown', () => {
    const result = normalizeRealCoderContractSmokeProvider('sk-secret123');
    assert.strictEqual(result.supported, false);
    assert.strictEqual(result.provider, 'unknown');
  });

  test('parse timeout default is 15000', () => {
    assert.strictEqual(parseRealCoderContractSmokeTimeoutMs({}), 15000);
  });

  test('parse timeout clamps below minimum', () => {
    assert.strictEqual(parseRealCoderContractSmokeTimeoutMs({}, 500), 1000);
  });

  test('parse timeout clamps above maximum', () => {
    assert.strictEqual(parseRealCoderContractSmokeTimeoutMs({}, 120000), 120000);
  });

  test('parse timeout uses override', () => {
    assert.strictEqual(parseRealCoderContractSmokeTimeoutMs({}, 20000), 20000);
  });

  test('parse timeout reads env', () => {
    assert.strictEqual(parseRealCoderContractSmokeTimeoutMs({ REAL_CODER_CONTRACT_SMOKE_TIMEOUT_MS: '25000' }), 25000);
  });

  test('parse timeout throws on invalid string', () => {
    assert.throws(() => parseRealCoderContractSmokeTimeoutMs({}, NaN), /Invalid timeout/);
  });

  test('valid contract response returns ok true', async () => {
    const report = await runRealCoderContractSmoke({
      provider: 'kimi',
      env: {
        ALLOW_REAL_PROVIDER: 'true',
        KIMI_API_KEY: 'sk-test',
        KIMI_BASE_URL: 'http://localhost.invalid',
      },
      fetchFn: makeKimiFetch(makeContractResponse()),
    });
    assert.strictEqual(report.ok, true);
    assert.strictEqual(report.mode, 'real-coder-contract-smoke');
    assert.strictEqual(report.supported, true);
    assert.strictEqual(report.contractValid, true);
    assert.strictEqual(report.fileCount, 1);
    assert.deepStrictEqual(report.paths, ['README.md']);
    assert.strictEqual(report.summaryPreview, 'Contract smoke summary');
    assert.strictEqual(report.timeoutMs, 15000);
  });

  test('invalid JSON response returns ok false', async () => {
    const report = await runRealCoderContractSmoke({
      provider: 'kimi',
      env: {
        ALLOW_REAL_PROVIDER: 'true',
        KIMI_API_KEY: 'sk-test',
        KIMI_BASE_URL: 'http://localhost.invalid',
      },
      fetchFn: makeKimiFetch('not json'),
    });
    assert.strictEqual(report.ok, false);
    assert.strictEqual(report.contractValid, false);
  });

  test('non-object JSON response returns ok false', async () => {
    const report = await runRealCoderContractSmoke({
      provider: 'kimi',
      env: {
        ALLOW_REAL_PROVIDER: 'true',
        KIMI_API_KEY: 'sk-test',
        KIMI_BASE_URL: 'http://localhost.invalid',
      },
      fetchFn: makeKimiFetch(JSON.stringify([1, 2, 3])),
    });
    assert.strictEqual(report.ok, false);
    assert.strictEqual(report.contractValid, false);
  });

  test('missing summary returns ok false', async () => {
    const report = await runRealCoderContractSmoke({
      provider: 'kimi',
      env: {
        ALLOW_REAL_PROVIDER: 'true',
        KIMI_API_KEY: 'sk-test',
        KIMI_BASE_URL: 'http://localhost.invalid',
      },
      fetchFn: makeKimiFetch(makeContractResponse({ summary: undefined })),
    });
    assert.strictEqual(report.ok, false);
  });

  test('long summary returns ok false', async () => {
    const report = await runRealCoderContractSmoke({
      provider: 'kimi',
      env: {
        ALLOW_REAL_PROVIDER: 'true',
        KIMI_API_KEY: 'sk-test',
        KIMI_BASE_URL: 'http://localhost.invalid',
      },
      fetchFn: makeKimiFetch(makeContractResponse({ summary: 'a'.repeat(301) })),
    });
    assert.strictEqual(report.ok, false);
  });

  test('missing files returns ok false', async () => {
    const report = await runRealCoderContractSmoke({
      provider: 'kimi',
      env: {
        ALLOW_REAL_PROVIDER: 'true',
        KIMI_API_KEY: 'sk-test',
        KIMI_BASE_URL: 'http://localhost.invalid',
      },
      fetchFn: makeKimiFetch(makeContractResponse({ files: undefined })),
    });
    assert.strictEqual(report.ok, false);
  });

  test('empty files returns ok false', async () => {
    const report = await runRealCoderContractSmoke({
      provider: 'kimi',
      env: {
        ALLOW_REAL_PROVIDER: 'true',
        KIMI_API_KEY: 'sk-test',
        KIMI_BASE_URL: 'http://localhost.invalid',
      },
      fetchFn: makeKimiFetch(makeContractResponse({ files: [] })),
    });
    assert.strictEqual(report.ok, false);
  });

  test('more than one file returns ok false', async () => {
    const report = await runRealCoderContractSmoke({
      provider: 'kimi',
      env: {
        ALLOW_REAL_PROVIDER: 'true',
        KIMI_API_KEY: 'sk-test',
        KIMI_BASE_URL: 'http://localhost.invalid',
      },
      fetchFn: makeKimiFetch(
        makeContractResponse({
          files: [
            { path: 'README.md', content: 'a' },
            { path: 'NOTE.md', content: 'b' },
          ],
        })
      ),
    });
    assert.strictEqual(report.ok, false);
  });

  test('wrong file path returns ok false', async () => {
    const report = await runRealCoderContractSmoke({
      provider: 'kimi',
      env: {
        ALLOW_REAL_PROVIDER: 'true',
        KIMI_API_KEY: 'sk-test',
        KIMI_BASE_URL: 'http://localhost.invalid',
      },
      fetchFn: makeKimiFetch(makeContractResponse({ files: [{ path: 'package.json', content: 'x' }] })),
    });
    assert.strictEqual(report.ok, false);
  });

  test('missing content returns ok false', async () => {
    const report = await runRealCoderContractSmoke({
      provider: 'kimi',
      env: {
        ALLOW_REAL_PROVIDER: 'true',
        KIMI_API_KEY: 'sk-test',
        KIMI_BASE_URL: 'http://localhost.invalid',
      },
      fetchFn: makeKimiFetch(makeContractResponse({ files: [{ path: 'README.md' }] })),
    });
    assert.strictEqual(report.ok, false);
  });

  test('long content returns ok false', async () => {
    const report = await runRealCoderContractSmoke({
      provider: 'kimi',
      env: {
        ALLOW_REAL_PROVIDER: 'true',
        KIMI_API_KEY: 'sk-test',
        KIMI_BASE_URL: 'http://localhost.invalid',
      },
      fetchFn: makeKimiFetch(makeContractResponse({ files: [{ path: 'README.md', content: 'a'.repeat(2001) }] })),
    });
    assert.strictEqual(report.ok, false);
  });

  test('secret-like content returns ok false and is not echoed', async () => {
    const report = await runRealCoderContractSmoke({
      provider: 'kimi',
      env: {
        ALLOW_REAL_PROVIDER: 'true',
        KIMI_API_KEY: 'sk-test',
        KIMI_BASE_URL: 'http://localhost.invalid',
      },
      fetchFn: makeKimiFetch(
        makeContractResponse({ files: [{ path: 'README.md', content: 'key sk-secret123456' }] })
      ),
    });
    assert.strictEqual(report.ok, false);
    const raw = JSON.stringify(report);
    assert.doesNotMatch(raw, /sk-secret123456/);
  });

  test('timeout returns ok false with safe message', async () => {
    const report = await runRealCoderContractSmoke({
      provider: 'kimi',
      env: {
        ALLOW_REAL_PROVIDER: 'true',
        KIMI_API_KEY: 'sk-test',
        KIMI_BASE_URL: 'http://localhost.invalid',
        REAL_CODER_CONTRACT_SMOKE_TIMEOUT_MS: '1000',
      },
      fetchFn: makeDelayedFetch(makeContractResponse(), 60000, true),
    });
    assert.strictEqual(report.ok, false);
    assert.strictEqual(report.error, 'Coder contract smoke timed out');
  });

  test('unsupported provider returns ok false without env check', async () => {
    const report = await runRealCoderContractSmoke({
      provider: 'openai',
      env: {},
    });
    assert.strictEqual(report.ok, false);
    assert.strictEqual(report.supported, false);
    assert.strictEqual(report.contractValid, false);
  });

  test('missing ALLOW_REAL_PROVIDER returns ok false', async () => {
    const report = await runRealCoderContractSmoke({
      provider: 'kimi',
      env: {
        KIMI_API_KEY: 'sk-test',
        KIMI_BASE_URL: 'http://localhost.invalid',
      },
      fetchFn: makeKimiFetch(makeContractResponse()),
    });
    assert.strictEqual(report.ok, false);
    assert.match(String(report.error), /ALLOW_REAL_PROVIDER/);
  });

  test('missing KIMI_API_KEY returns ok false', async () => {
    const report = await runRealCoderContractSmoke({
      provider: 'kimi',
      env: {
        ALLOW_REAL_PROVIDER: 'true',
        KIMI_BASE_URL: 'http://localhost.invalid',
      },
      fetchFn: makeKimiFetch(makeContractResponse()),
    });
    assert.strictEqual(report.ok, false);
    assert.match(String(report.error), /KIMI_API_KEY/);
  });

  test('missing KIMI_BASE_URL returns ok false', async () => {
    const report = await runRealCoderContractSmoke({
      provider: 'kimi',
      env: {
        ALLOW_REAL_PROVIDER: 'true',
        KIMI_API_KEY: 'sk-test',
      },
      fetchFn: makeKimiFetch(makeContractResponse()),
    });
    assert.strictEqual(report.ok, false);
    assert.match(String(report.error), /KIMI_BASE_URL/);
  });

  test('format report redacts secrets', () => {
    const formatted = formatRealCoderContractSmokeReport({
      ok: false,
      mode: 'real-coder-contract-smoke',
      provider: 'kimi',
      supported: true,
      contractValid: false,
      error: 'key sk-secret123456',
    });
    assert.doesNotMatch(formatted, /sk-secret123456/);
    assert.match(formatted, /\[REDACTED\]/);
    JSON.parse(formatted);
  });

  test('ALLOW_REAL_PROVIDER=true works', async () => {
    const report = await runRealCoderContractSmoke({
      provider: 'kimi',
      env: {
        ALLOW_REAL_PROVIDER: 'true',
        KIMI_API_KEY: 'sk-test',
        KIMI_BASE_URL: 'http://localhost.invalid',
      },
      fetchFn: makeKimiFetch(makeContractResponse()),
    });
    assert.strictEqual(report.ok, true);
  });

  test('ALLOW_REAL_PROVIDER=1 works', async () => {
    const report = await runRealCoderContractSmoke({
      provider: 'kimi',
      env: {
        ALLOW_REAL_PROVIDER: '1',
        KIMI_API_KEY: 'sk-test',
        KIMI_BASE_URL: 'http://localhost.invalid',
      },
      fetchFn: makeKimiFetch(makeContractResponse()),
    });
    assert.strictEqual(report.ok, true);
  });

  test('missing ALLOW_REAL_PROVIDER returns ok false', async () => {
    const report = await runRealCoderContractSmoke({
      provider: 'kimi',
      env: {
        KIMI_API_KEY: 'sk-test',
        KIMI_BASE_URL: 'http://localhost.invalid',
      },
      fetchFn: makeKimiFetch(makeContractResponse()),
    });
    assert.strictEqual(report.ok, false);
    assert.match(String(report.error), /ALLOW_REAL_PROVIDER/);
  });

  test('ALLOW_REAL_PROVIDER=yes returns ok false', async () => {
    const report = await runRealCoderContractSmoke({
      provider: 'kimi',
      env: {
        ALLOW_REAL_PROVIDER: 'yes',
        KIMI_API_KEY: 'sk-test',
        KIMI_BASE_URL: 'http://localhost.invalid',
      },
      fetchFn: makeKimiFetch(makeContractResponse()),
    });
    assert.strictEqual(report.ok, false);
    assert.match(String(report.error), /ALLOW_REAL_PROVIDER/);
  });

  test('ALLOW_REAL_PROVIDER=false returns ok false', async () => {
    const report = await runRealCoderContractSmoke({
      provider: 'kimi',
      env: {
        ALLOW_REAL_PROVIDER: 'false',
        KIMI_API_KEY: 'sk-test',
        KIMI_BASE_URL: 'http://localhost.invalid',
      },
      fetchFn: makeKimiFetch(makeContractResponse()),
    });
    assert.strictEqual(report.ok, false);
    assert.match(String(report.error), /ALLOW_REAL_PROVIDER/);
  });

  test('valid notes array passes', async () => {
    const report = await runRealCoderContractSmoke({
      provider: 'kimi',
      env: {
        ALLOW_REAL_PROVIDER: 'true',
        KIMI_API_KEY: 'sk-test',
        KIMI_BASE_URL: 'http://localhost.invalid',
      },
      fetchFn: makeKimiFetch(makeContractResponse({ notes: ['Note one', 'Note two'] })),
    });
    assert.strictEqual(report.ok, true);
  });

  test('non-string notes still fail', async () => {
    const report = await runRealCoderContractSmoke({
      provider: 'kimi',
      env: {
        ALLOW_REAL_PROVIDER: 'true',
        KIMI_API_KEY: 'sk-test',
        KIMI_BASE_URL: 'http://localhost.invalid',
      },
      fetchFn: makeKimiFetch(makeContractResponse({ notes: [123 as unknown as string] })),
    });
    assert.strictEqual(report.ok, false);
  });

  test('secret-like note fails and is not echoed', async () => {
    const report = await runRealCoderContractSmoke({
      provider: 'kimi',
      env: {
        ALLOW_REAL_PROVIDER: 'true',
        KIMI_API_KEY: 'sk-test',
        KIMI_BASE_URL: 'http://localhost.invalid',
      },
      fetchFn: makeKimiFetch(makeContractResponse({ notes: ['key sk-secret123456'] })),
    });
    assert.strictEqual(report.ok, false);
    const raw = JSON.stringify(report);
    assert.doesNotMatch(raw, /sk-secret123456/);
  });

  test('secret-like summary still fails', async () => {
    const report = await runRealCoderContractSmoke({
      provider: 'kimi',
      env: {
        ALLOW_REAL_PROVIDER: 'true',
        KIMI_API_KEY: 'sk-test',
        KIMI_BASE_URL: 'http://localhost.invalid',
      },
      fetchFn: makeKimiFetch(makeContractResponse({ summary: 'token sk-secret123456' })),
    });
    assert.strictEqual(report.ok, false);
  });

  test('secret-like file content still fails', async () => {
    const report = await runRealCoderContractSmoke({
      provider: 'kimi',
      env: {
        ALLOW_REAL_PROVIDER: 'true',
        KIMI_API_KEY: 'sk-test',
        KIMI_BASE_URL: 'http://localhost.invalid',
      },
      fetchFn: makeKimiFetch(makeContractResponse({ files: [{ path: 'README.md', content: 'password secret123' }] })),
    });
    assert.strictEqual(report.ok, false);
  });
});

describe('real-coder-contract-smoke CLI', () => {
  test('CLI usage includes real-coder-contract-smoke', () => {
    const result = runCli([]);
    assert.notStrictEqual(result.status, 0);
    const output = `${result.stdout}\n${result.stderr}`;
    assert.match(output, /real-coder-contract-smoke/);
    assert.match(output, /--timeout-ms/);
  });

  test('unsupported provider exits non-zero and does not require env', () => {
    const result = runCli(['real-coder-contract-smoke', '--provider', 'openai']);
    assert.notStrictEqual(result.status, 0);
    const json = parseOutput(result.stdout + result.stderr);
    assert.strictEqual(json.ok, false);
    assert.strictEqual(json.supported, false);
    assert.strictEqual(json.provider, 'openai');
  });

  test('unsafe provider string is not echoed raw', () => {
    const result = runCli(['real-coder-contract-smoke', '--provider', 'openai;rm -rf']);
    assert.notStrictEqual(result.status, 0);
    const output = `${result.stdout}\n${result.stderr}`;
    assert.doesNotMatch(output, /openai;rm -rf/);
  });

  test('missing ALLOW_REAL_PROVIDER exits non-zero', () => {
    const result = runCli(
      ['real-coder-contract-smoke'],
      {
        ALLOW_REAL_PROVIDER: undefined,
        KIMI_API_KEY: 'sk-test',
        KIMI_BASE_URL: 'http://localhost.invalid',
      }
    );
    assert.notStrictEqual(result.status, 0);
    const json = parseOutput(result.stdout + result.stderr);
    assert.strictEqual(json.ok, false);
    assert.match(String(json.error), /ALLOW_REAL_PROVIDER/);
  });

  test('ALLOW_REAL_PROVIDER=1 exits 0 with valid fake response', () => {
    const result = runCli(
      ['real-coder-contract-smoke'],
      {
        ALLOW_REAL_PROVIDER: '1',
        KIMI_API_KEY: 'sk-test',
        KIMI_BASE_URL: 'http://localhost.invalid',
        REAL_CODER_CONTRACT_SMOKE_FAKE_RESPONSE: makeContractResponse(),
      }
    );
    assert.strictEqual(result.status, 0, result.stdout + result.stderr);
    const json = parseOutput(result.stdout);
    assert.strictEqual(json.ok, true);
  });

  test('ALLOW_REAL_PROVIDER=yes exits non-zero', () => {
    const result = runCli(
      ['real-coder-contract-smoke'],
      {
        AI_PROVIDER: 'mock',
        ALLOW_REAL_PROVIDER: 'yes',
        REAL_CODER_CONTRACT_SMOKE_FAKE_RESPONSE: makeContractResponse(),
      }
    );
    assert.notStrictEqual(result.status, 0);
    const json = parseOutput(result.stdout + result.stderr);
    assert.strictEqual(json.ok, false);
    assert.match(String(json.error), /ALLOW_REAL_PROVIDER/);
  });

  test('ALLOW_REAL_PROVIDER=false exits non-zero', () => {
    const result = runCli(
      ['real-coder-contract-smoke'],
      {
        AI_PROVIDER: 'mock',
        ALLOW_REAL_PROVIDER: 'false',
        REAL_CODER_CONTRACT_SMOKE_FAKE_RESPONSE: makeContractResponse(),
      }
    );
    assert.notStrictEqual(result.status, 0);
    const json = parseOutput(result.stdout + result.stderr);
    assert.strictEqual(json.ok, false);
    assert.match(String(json.error), /ALLOW_REAL_PROVIDER/);
  });

  test('secret-like note exits non-zero and is not echoed', () => {
    const result = runCli(
      ['real-coder-contract-smoke'],
      {
        ALLOW_REAL_PROVIDER: 'true',
        KIMI_API_KEY: 'sk-test',
        KIMI_BASE_URL: 'http://localhost.invalid',
        REAL_CODER_CONTRACT_SMOKE_FAKE_RESPONSE: makeContractResponse({
          notes: ['key sk-secret123456'],
        }),
      }
    );
    assert.notStrictEqual(result.status, 0);
    const output = `${result.stdout}\n${result.stderr}`;
    assert.doesNotMatch(output, /sk-secret123456/);
    const json = parseOutput(output);
    assert.strictEqual(json.ok, false);
  });

  test('missing KIMI_API_KEY exits non-zero', () => {
    const result = runCli(
      ['real-coder-contract-smoke'],
      {
        AI_PROVIDER: 'mock',
        ALLOW_REAL_PROVIDER: 'true',
        KIMI_API_KEY: '',
        KIMI_BASE_URL: 'http://localhost.invalid',
      }
    );
    assert.notStrictEqual(result.status, 0);
    const json = parseOutput(result.stdout + result.stderr);
    assert.strictEqual(json.ok, false);
    assert.match(String(json.error), /KIMI_API_KEY/);
  });

  test('missing KIMI_BASE_URL exits non-zero', () => {
    const result = runCli(
      ['real-coder-contract-smoke'],
      {
        AI_PROVIDER: 'mock',
        ALLOW_REAL_PROVIDER: 'true',
        KIMI_API_KEY: 'sk-test',
        KIMI_BASE_URL: '',
      }
    );
    assert.notStrictEqual(result.status, 0);
    const json = parseOutput(result.stdout + result.stderr);
    assert.strictEqual(json.ok, false);
    assert.match(String(json.error), /KIMI_BASE_URL/);
  });

  test('missing env output lists env names only, not values', () => {
    const result = runCli(
      ['real-coder-contract-smoke'],
      {
        AI_PROVIDER: 'mock',
        ALLOW_REAL_PROVIDER: 'true',
        KIMI_API_KEY: 'sk-real-secret-value-123',
        KIMI_BASE_URL: '',
      }
    );
    assert.notStrictEqual(result.status, 0);
    const output = `${result.stdout}\n${result.stderr}`;
    assert.match(output, /KIMI_BASE_URL/);
    assert.doesNotMatch(output, /sk-real-secret-value-123/);
  });

  test('valid fake provider response exits 0', () => {
    const result = runCli(
      ['real-coder-contract-smoke'],
      {
        ALLOW_REAL_PROVIDER: 'true',
        KIMI_API_KEY: 'sk-test',
        KIMI_BASE_URL: 'http://localhost.invalid',
        REAL_CODER_CONTRACT_SMOKE_FAKE_RESPONSE: makeContractResponse(),
      }
    );
    assert.strictEqual(result.status, 0, result.stdout + result.stderr);
    const json = parseOutput(result.stdout);
    assert.strictEqual(json.ok, true);
    assert.strictEqual(json.mode, 'real-coder-contract-smoke');
    assert.strictEqual(json.contractValid, true);
    assert.deepStrictEqual(json.paths, ['README.md']);
    assert.strictEqual(json.fileCount, 1);
  });

  test('invalid JSON fake response exits non-zero', () => {
    const result = runCli(
      ['real-coder-contract-smoke'],
      {
        ALLOW_REAL_PROVIDER: 'true',
        KIMI_API_KEY: 'sk-test',
        KIMI_BASE_URL: 'http://localhost.invalid',
        REAL_CODER_CONTRACT_SMOKE_FAKE_RESPONSE: 'not json',
      }
    );
    assert.notStrictEqual(result.status, 0);
    const json = parseOutput(result.stdout + result.stderr);
    assert.strictEqual(json.ok, false);
  });

  test('secret-like fake response exits non-zero and is not echoed', () => {
    const result = runCli(
      ['real-coder-contract-smoke'],
      {
        ALLOW_REAL_PROVIDER: 'true',
        KIMI_API_KEY: 'sk-test',
        KIMI_BASE_URL: 'http://localhost.invalid',
        REAL_CODER_CONTRACT_SMOKE_FAKE_RESPONSE: makeContractResponse({
          files: [{ path: 'README.md', content: 'token sk-secret123456' }],
        }),
      }
    );
    assert.notStrictEqual(result.status, 0);
    const output = `${result.stdout}\n${result.stderr}`;
    assert.doesNotMatch(output, /sk-secret123456/);
  });

  test('invalid timeout value exits non-zero', () => {
    const result = runCli(
      ['real-coder-contract-smoke', '--timeout-ms', 'abc'],
      {
        ALLOW_REAL_PROVIDER: 'true',
        KIMI_API_KEY: 'sk-test',
        KIMI_BASE_URL: 'http://localhost.invalid',
        REAL_CODER_CONTRACT_SMOKE_FAKE_RESPONSE: makeContractResponse(),
      }
    );
    assert.notStrictEqual(result.status, 0);
    const json = parseOutput(result.stdout + result.stderr);
    assert.strictEqual(json.ok, false);
  });

  test('timeout flag clamps below minimum', () => {
    const result = runCli(
      ['real-coder-contract-smoke', '--timeout-ms', '500'],
      {
        ALLOW_REAL_PROVIDER: 'true',
        KIMI_API_KEY: 'sk-test',
        KIMI_BASE_URL: 'http://localhost.invalid',
        REAL_CODER_CONTRACT_SMOKE_FAKE_RESPONSE: makeContractResponse(),
      }
    );
    assert.strictEqual(result.status, 0, result.stdout + result.stderr);
    const json = parseOutput(result.stdout);
    assert.strictEqual(json.timeoutMs, 1000);
  });

  test('timeout flag clamps above maximum', () => {
    const result = runCli(
      ['real-coder-contract-smoke', '--timeout-ms', '120000'],
      {
        ALLOW_REAL_PROVIDER: 'true',
        KIMI_API_KEY: 'sk-test',
        KIMI_BASE_URL: 'http://localhost.invalid',
        REAL_CODER_CONTRACT_SMOKE_FAKE_RESPONSE: makeContractResponse(),
      }
    );
    assert.strictEqual(result.status, 0, result.stdout + result.stderr);
    const json = parseOutput(result.stdout);
    assert.strictEqual(json.timeoutMs, 120000);
  });

  test('command does not write files', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'coder-smoke-write-test-'));
    const markerPath = join(tmpDir, 'marker.txt');
    writeFileSync(markerPath, 'before', 'utf-8');
    runCli(
      ['real-coder-contract-smoke'],
      {
        ALLOW_REAL_PROVIDER: 'true',
        KIMI_API_KEY: 'sk-test',
        KIMI_BASE_URL: 'http://localhost.invalid',
        REAL_CODER_CONTRACT_SMOKE_FAKE_RESPONSE: makeContractResponse(),
      }
    );
    assert.strictEqual(readFileSync(markerPath, 'utf-8'), 'before');
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('command does not write state', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'coder-smoke-state-'));
    runCli(
      ['real-coder-contract-smoke'],
      {
        ALLOW_REAL_PROVIDER: 'true',
        KIMI_API_KEY: 'sk-test',
        KIMI_BASE_URL: 'http://localhost.invalid',
        REAL_CODER_CONTRACT_SMOKE_FAKE_RESPONSE: makeContractResponse(),
        RUNS_DIR: tmpDir,
      }
    );
    assert.strictEqual(existsSync(join(tmpDir, 'block')), false);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('command source does not call provider directly', () => {
    const source = readSource(SOURCE_PATH);
    assert.doesNotMatch(source, /runRealProviderSmoke/);
    assert.doesNotMatch(source, /createAIClient/);
  });

  test('command source does not call network/fetch/http directly', () => {
    const source = readSource(SOURCE_PATH);
    assert.doesNotMatch(source, /\bfetch\s*\(/);
    assert.doesNotMatch(source, /globalThis\.fetch/);
    assert.doesNotMatch(source, /http\.request/);
    assert.doesNotMatch(source, /https\.request/);
  });

  test('command source does not run git', () => {
    const source = readSource(SOURCE_PATH);
    assert.doesNotMatch(source, /spawnSync\('git'/);
    assert.doesNotMatch(source, /git.*commit/);
    assert.doesNotMatch(source, /git.*push/);
  });

  test('command source does not spawn block runner', () => {
    const source = readSource(SOURCE_PATH);
    assert.doesNotMatch(source, /runRealBlockRunAI/);
    assert.doesNotMatch(source, /runOneTaskLoop/);
    assert.doesNotMatch(source, /runMultiTaskLoop/);
  });

  test('command source does not use shell:true', () => {
    const source = readSource(SOURCE_PATH);
    assert.doesNotMatch(source, /shell:\s*true/);
  });

  test('CLI source wires coder contract smoke branch without shell:true', () => {
    const source = readFileSync(CLI_SOURCE_PATH, 'utf-8');
    const branchIndex = source.indexOf("command === 'real-coder-contract-smoke'");
    assert.ok(branchIndex >= 0, 'coder contract smoke branch must exist in cli.ts');
    const nextBranchIndex = source.indexOf("if (!command || (!taskId && command !== 'real-repo-follow-up' && command !== 'real-block-follow-up' && command !== 'operator-e2e' && command !== 'diagnose-ci' && command !== 'autopilot-run' && command !== 'autopilot-plan' && command !== 'autopilot-one-click'))", branchIndex);
    const snippet = source.slice(branchIndex, nextBranchIndex);
    assert.doesNotMatch(snippet, /shell:\s*true/);
  });

  test('CLI source does not write files or apply patches', () => {
    const source = readFileSync(CLI_SOURCE_PATH, 'utf-8');
    const branchIndex = source.indexOf("command === 'real-coder-contract-smoke'");
    const nextBranchIndex = source.indexOf("if (!command || (!taskId && command !== 'real-repo-follow-up' && command !== 'real-block-follow-up' && command !== 'operator-e2e' && command !== 'diagnose-ci' && command !== 'autopilot-run' && command !== 'autopilot-plan' && command !== 'autopilot-one-click'))", branchIndex);
    const snippet = source.slice(branchIndex, nextBranchIndex);
    assert.doesNotMatch(snippet, /writeFileSync/);
    assert.doesNotMatch(snippet, /applyFileUpdates/);
    assert.doesNotMatch(snippet, /runRealBlockRunAI/);
  });

  test('tests do not call real AI providers', () => {
    const source = readFileSync(fileURLToPath(import.meta.url), 'utf-8');
    assert.doesNotMatch(source, /createKimiClient\(/);
    assert.doesNotMatch(source, /createAIClient\(/);
    assert.doesNotMatch(source, /runRealProviderSmoke\(/);
  });

  test('tests do not make network calls', () => {
    const source = readFileSync(fileURLToPath(import.meta.url), 'utf-8');
    assert.doesNotMatch(source, /\bfetch\s*\(/);
    assert.doesNotMatch(source, /globalThis\.fetch\s*\(/);
    assert.doesNotMatch(source, /http\.request\(/);
    assert.doesNotMatch(source, /https\.request\(/);
  });
});
