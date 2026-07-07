import { describe, test } from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  runRealReviewerContractSmoke,
  formatRealReviewerContractSmokeReport,
  parseRealReviewerContractSmokeTimeoutMs,
} from '../src/real-reviewer-contract-smoke.js';

const PROJECT_ROOT = process.cwd();
const TSX_CLI_PATH = join(PROJECT_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const CLI_PATH = join(PROJECT_ROOT, 'src', 'cli.ts');
const SOURCE_PATH = join(PROJECT_ROOT, 'src', 'real-reviewer-contract-smoke.ts');
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

function makeAcceptedResponse(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    decision: 'accepted',
    confidence: 'high',
    blocking_issues: [],
    non_blocking_issues: [],
    review_summary: 'Reviewer contract smoke accepted',
    fix_task: null,
    next_action: 'advance_to_next_task',
    ...overrides,
  });
}

function makeRejectedResponse(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    decision: 'rejected',
    confidence: 'medium',
    blocking_issues: ['Style issue'],
    non_blocking_issues: [],
    review_summary: 'Needs style fix',
    fix_task: 'Apply consistent formatting',
    next_action: 'send_fix_to_coder',
    ...overrides,
  });
}

function makeBlockedForHumanResponse(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    decision: 'rejected',
    confidence: 'low',
    blocking_issues: ['Serious concern'],
    non_blocking_issues: [],
    review_summary: 'Blocked for human review',
    fix_task: null,
    next_action: 'block_for_human',
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

function makeDelayedFetch(content: string, delayMs: number): typeof fetch {
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
      if (signal) {
        signal.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(new Error('Aborted'));
        });
      }
    });
  }) as unknown as typeof fetch;
}

describe('real-reviewer-contract-smoke module', () => {
  test('parse timeout default is 15000', () => {
    assert.strictEqual(parseRealReviewerContractSmokeTimeoutMs({}), 15000);
  });

  test('parse timeout rejects below minimum', () => {
    assert.throws(() => parseRealReviewerContractSmokeTimeoutMs({}, 500), /below minimum/);
  });

  test('parse timeout rejects above maximum', () => {
    assert.throws(() => parseRealReviewerContractSmokeTimeoutMs({}, 200000), /above maximum/);
  });

  test('parse timeout uses override', () => {
    assert.strictEqual(parseRealReviewerContractSmokeTimeoutMs({}, 25000), 25000);
  });

  test('parse timeout reads env', () => {
    assert.strictEqual(
      parseRealReviewerContractSmokeTimeoutMs({ REAL_REVIEWER_CONTRACT_SMOKE_TIMEOUT_MS: '20000' }),
      20000
    );
  });

  test('parse timeout throws on invalid string', () => {
    assert.throws(() => parseRealReviewerContractSmokeTimeoutMs({}, NaN), /Invalid timeout/);
  });

  test('valid accepted response returns ok true', async () => {
    const report = await runRealReviewerContractSmoke({
      provider: 'kimi',
      env: {
        ALLOW_REAL_PROVIDER: 'true',
        KIMI_API_KEY: 'sk-test',
        KIMI_BASE_URL: 'http://localhost.invalid',
      },
      fetchFn: makeKimiFetch(makeAcceptedResponse()),
    });
    assert.strictEqual(report.ok, true);
    assert.strictEqual(report.mode, 'real-reviewer-contract-smoke');
    assert.strictEqual(report.supported, true);
    assert.strictEqual(report.contractValid, true);
    assert.strictEqual(report.decision, 'accepted');
    assert.strictEqual(report.summaryPreview, 'Reviewer contract smoke accepted');
    assert.strictEqual(report.timeoutMs, 15000);
  });

  test('valid rejected response returns ok true', async () => {
    const report = await runRealReviewerContractSmoke({
      provider: 'kimi',
      env: {
        ALLOW_REAL_PROVIDER: 'true',
        KIMI_API_KEY: 'sk-test',
        KIMI_BASE_URL: 'http://localhost.invalid',
      },
      fetchFn: makeKimiFetch(makeRejectedResponse()),
    });
    assert.strictEqual(report.ok, true);
    assert.strictEqual(report.decision, 'rejected');
  });

  test('valid block_for_human response returns ok true', async () => {
    const report = await runRealReviewerContractSmoke({
      provider: 'kimi',
      env: {
        ALLOW_REAL_PROVIDER: 'true',
        KIMI_API_KEY: 'sk-test',
        KIMI_BASE_URL: 'http://localhost.invalid',
      },
      fetchFn: makeKimiFetch(makeBlockedForHumanResponse()),
    });
    assert.strictEqual(report.ok, true);
    assert.strictEqual(report.decision, 'rejected');
    assert.strictEqual(report.summaryPreview, 'Blocked for human review');
  });

  test('ALLOW_REAL_PROVIDER=1 works', async () => {
    const report = await runRealReviewerContractSmoke({
      provider: 'kimi',
      env: {
        ALLOW_REAL_PROVIDER: '1',
        KIMI_API_KEY: 'sk-test',
        KIMI_BASE_URL: 'http://localhost.invalid',
      },
      fetchFn: makeKimiFetch(makeAcceptedResponse()),
    });
    assert.strictEqual(report.ok, true);
  });

  test('missing ALLOW_REAL_PROVIDER returns ok false', async () => {
    const report = await runRealReviewerContractSmoke({
      provider: 'kimi',
      env: {
        KIMI_API_KEY: 'sk-test',
        KIMI_BASE_URL: 'http://localhost.invalid',
      },
      fetchFn: makeKimiFetch(makeAcceptedResponse()),
    });
    assert.strictEqual(report.ok, false);
    assert.match(String(report.error), /ALLOW_REAL_PROVIDER/);
  });

  test('ALLOW_REAL_PROVIDER=yes returns ok false', async () => {
    const report = await runRealReviewerContractSmoke({
      provider: 'kimi',
      env: {
        ALLOW_REAL_PROVIDER: 'yes',
        KIMI_API_KEY: 'sk-test',
        KIMI_BASE_URL: 'http://localhost.invalid',
      },
      fetchFn: makeKimiFetch(makeAcceptedResponse()),
    });
    assert.strictEqual(report.ok, false);
    assert.match(String(report.error), /ALLOW_REAL_PROVIDER/);
  });

  test('ALLOW_REAL_PROVIDER=false returns ok false', async () => {
    const report = await runRealReviewerContractSmoke({
      provider: 'kimi',
      env: {
        ALLOW_REAL_PROVIDER: 'false',
        KIMI_API_KEY: 'sk-test',
        KIMI_BASE_URL: 'http://localhost.invalid',
      },
      fetchFn: makeKimiFetch(makeAcceptedResponse()),
    });
    assert.strictEqual(report.ok, false);
    assert.match(String(report.error), /ALLOW_REAL_PROVIDER/);
  });

  test('missing KIMI_API_KEY returns ok false', async () => {
    const report = await runRealReviewerContractSmoke({
      provider: 'kimi',
      env: {
        ALLOW_REAL_PROVIDER: 'true',
        KIMI_BASE_URL: 'http://localhost.invalid',
      },
      fetchFn: makeKimiFetch(makeAcceptedResponse()),
    });
    assert.strictEqual(report.ok, false);
    assert.match(String(report.error), /KIMI_API_KEY/);
  });

  test('missing KIMI_BASE_URL returns ok false', async () => {
    const report = await runRealReviewerContractSmoke({
      provider: 'kimi',
      env: {
        ALLOW_REAL_PROVIDER: 'true',
        KIMI_API_KEY: 'sk-test',
      },
      fetchFn: makeKimiFetch(makeAcceptedResponse()),
    });
    assert.strictEqual(report.ok, false);
    assert.match(String(report.error), /KIMI_BASE_URL/);
  });

  test('unsupported provider returns ok false without env check', async () => {
    const report = await runRealReviewerContractSmoke({
      provider: 'openai',
      env: {},
    });
    assert.strictEqual(report.ok, false);
    assert.strictEqual(report.supported, false);
    assert.strictEqual(report.contractValid, false);
  });

  test('invalid JSON response returns ok false', async () => {
    const report = await runRealReviewerContractSmoke({
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
    const report = await runRealReviewerContractSmoke({
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

  test('missing decision returns ok false', async () => {
    const report = await runRealReviewerContractSmoke({
      provider: 'kimi',
      env: {
        ALLOW_REAL_PROVIDER: 'true',
        KIMI_API_KEY: 'sk-test',
        KIMI_BASE_URL: 'http://localhost.invalid',
      },
      fetchFn: makeKimiFetch(makeAcceptedResponse({ decision: undefined })),
    });
    assert.strictEqual(report.ok, false);
  });

  test('unknown decision returns ok false', async () => {
    const report = await runRealReviewerContractSmoke({
      provider: 'kimi',
      env: {
        ALLOW_REAL_PROVIDER: 'true',
        KIMI_API_KEY: 'sk-test',
        KIMI_BASE_URL: 'http://localhost.invalid',
      },
      fetchFn: makeKimiFetch(makeAcceptedResponse({ decision: 'approved' })),
    });
    assert.strictEqual(report.ok, false);
  });

  test('missing confidence returns ok false', async () => {
    const report = await runRealReviewerContractSmoke({
      provider: 'kimi',
      env: {
        ALLOW_REAL_PROVIDER: 'true',
        KIMI_API_KEY: 'sk-test',
        KIMI_BASE_URL: 'http://localhost.invalid',
      },
      fetchFn: makeKimiFetch(makeAcceptedResponse({ confidence: undefined })),
    });
    assert.strictEqual(report.ok, false);
  });

  test('missing blocking_issues returns ok false', async () => {
    const report = await runRealReviewerContractSmoke({
      provider: 'kimi',
      env: {
        ALLOW_REAL_PROVIDER: 'true',
        KIMI_API_KEY: 'sk-test',
        KIMI_BASE_URL: 'http://localhost.invalid',
      },
      fetchFn: makeKimiFetch(makeAcceptedResponse({ blocking_issues: undefined })),
    });
    assert.strictEqual(report.ok, false);
  });

  test('missing review_summary returns ok false', async () => {
    const report = await runRealReviewerContractSmoke({
      provider: 'kimi',
      env: {
        ALLOW_REAL_PROVIDER: 'true',
        KIMI_API_KEY: 'sk-test',
        KIMI_BASE_URL: 'http://localhost.invalid',
      },
      fetchFn: makeKimiFetch(makeAcceptedResponse({ review_summary: undefined })),
    });
    assert.strictEqual(report.ok, false);
  });

  test('missing next_action returns ok false', async () => {
    const report = await runRealReviewerContractSmoke({
      provider: 'kimi',
      env: {
        ALLOW_REAL_PROVIDER: 'true',
        KIMI_API_KEY: 'sk-test',
        KIMI_BASE_URL: 'http://localhost.invalid',
      },
      fetchFn: makeKimiFetch(makeAcceptedResponse({ next_action: undefined })),
    });
    assert.strictEqual(report.ok, false);
  });

  test('accepted with blocking issues returns ok false', async () => {
    const report = await runRealReviewerContractSmoke({
      provider: 'kimi',
      env: {
        ALLOW_REAL_PROVIDER: 'true',
        KIMI_API_KEY: 'sk-test',
        KIMI_BASE_URL: 'http://localhost.invalid',
      },
      fetchFn: makeKimiFetch(makeAcceptedResponse({ blocking_issues: ['Issue'] })),
    });
    assert.strictEqual(report.ok, false);
  });

  test('accepted with wrong next_action returns ok false', async () => {
    const report = await runRealReviewerContractSmoke({
      provider: 'kimi',
      env: {
        ALLOW_REAL_PROVIDER: 'true',
        KIMI_API_KEY: 'sk-test',
        KIMI_BASE_URL: 'http://localhost.invalid',
      },
      fetchFn: makeKimiFetch(makeAcceptedResponse({ next_action: 'send_fix_to_coder' })),
    });
    assert.strictEqual(report.ok, false);
  });

  test('rejected without blocking issues or fix_task returns ok false', async () => {
    const report = await runRealReviewerContractSmoke({
      provider: 'kimi',
      env: {
        ALLOW_REAL_PROVIDER: 'true',
        KIMI_API_KEY: 'sk-test',
        KIMI_BASE_URL: 'http://localhost.invalid',
      },
      fetchFn: makeKimiFetch(
        makeRejectedResponse({ blocking_issues: [], fix_task: null })
      ),
    });
    assert.strictEqual(report.ok, false);
  });

  test('secret-like raw response returns ok false and redacts', async () => {
    const report = await runRealReviewerContractSmoke({
      provider: 'kimi',
      env: {
        ALLOW_REAL_PROVIDER: 'true',
        KIMI_API_KEY: 'sk-test',
        KIMI_BASE_URL: 'http://localhost.invalid',
      },
      fetchFn: makeKimiFetch('key sk-secret123456'),
    });
    assert.strictEqual(report.ok, false);
    const raw = JSON.stringify(report);
    assert.doesNotMatch(raw, /sk-secret123456/);
  });

  test('secret-like review_summary returns ok false and redacts', async () => {
    const report = await runRealReviewerContractSmoke({
      provider: 'kimi',
      env: {
        ALLOW_REAL_PROVIDER: 'true',
        KIMI_API_KEY: 'sk-test',
        KIMI_BASE_URL: 'http://localhost.invalid',
      },
      fetchFn: makeKimiFetch(makeAcceptedResponse({ review_summary: 'key sk-secret123456' })),
    });
    assert.strictEqual(report.ok, false);
    const raw = JSON.stringify(report);
    assert.doesNotMatch(raw, /sk-secret123456/);
  });

  test('secret-like blocking issue returns ok false and redacts', async () => {
    const report = await runRealReviewerContractSmoke({
      provider: 'kimi',
      env: {
        ALLOW_REAL_PROVIDER: 'true',
        KIMI_API_KEY: 'sk-test',
        KIMI_BASE_URL: 'http://localhost.invalid',
      },
      fetchFn: makeKimiFetch(makeRejectedResponse({ blocking_issues: ['password secret123'] })),
    });
    assert.strictEqual(report.ok, false);
    const raw = JSON.stringify(report);
    assert.doesNotMatch(raw, /secret123/);
  });

  test('secret-like fix_task returns ok false and redacts', async () => {
    const report = await runRealReviewerContractSmoke({
      provider: 'kimi',
      env: {
        ALLOW_REAL_PROVIDER: 'true',
        KIMI_API_KEY: 'sk-test',
        KIMI_BASE_URL: 'http://localhost.invalid',
      },
      fetchFn: makeKimiFetch(makeRejectedResponse({ fix_task: 'token sk-secret123456' })),
    });
    assert.strictEqual(report.ok, false);
    const raw = JSON.stringify(report);
    assert.doesNotMatch(raw, /sk-secret123456/);
  });

  test('timeout returns ok false with safe message', async () => {
    const report = await runRealReviewerContractSmoke({
      provider: 'kimi',
      env: {
        ALLOW_REAL_PROVIDER: 'true',
        KIMI_API_KEY: 'sk-test',
        KIMI_BASE_URL: 'http://localhost.invalid',
        REAL_REVIEWER_CONTRACT_SMOKE_TIMEOUT_MS: '5000',
      },
      fetchFn: makeDelayedFetch(makeAcceptedResponse(), 60000),
    });
    assert.strictEqual(report.ok, false);
    assert.strictEqual(report.error, 'Reviewer contract smoke timed out');
  });

  test('format report redacts secrets', () => {
    const formatted = formatRealReviewerContractSmokeReport({
      ok: false,
      mode: 'real-reviewer-contract-smoke',
      provider: 'kimi',
      supported: true,
      contractValid: false,
      error: 'key sk-secret123456',
    });
    assert.doesNotMatch(formatted, /sk-secret123456/);
    assert.match(formatted, /\[REDACTED\]/);
    JSON.parse(formatted);
  });
});

describe('real-reviewer-contract-smoke CLI', () => {
  test('CLI usage includes real-reviewer-contract-smoke', () => {
    const result = runCli([]);
    assert.notStrictEqual(result.status, 0);
    const output = `${result.stdout}\n${result.stderr}`;
    assert.match(output, /real-reviewer-contract-smoke/);
    assert.match(output, /--timeout-ms/);
  });

  test('unsupported provider exits non-zero and does not require env', () => {
    const result = runCli(['real-reviewer-contract-smoke', '--provider', 'openai']);
    assert.notStrictEqual(result.status, 0);
    const json = parseOutput(result.stdout + result.stderr);
    assert.strictEqual(json.ok, false);
    assert.strictEqual(json.supported, false);
    assert.strictEqual(json.provider, 'openai');
  });

  test('unsafe provider string is not echoed raw', () => {
    const result = runCli(['real-reviewer-contract-smoke', '--provider', 'openai;rm -rf']);
    assert.notStrictEqual(result.status, 0);
    const output = `${result.stdout}\n${result.stderr}`;
    assert.doesNotMatch(output, /openai;rm -rf/);
  });

  test('missing ALLOW_REAL_PROVIDER exits non-zero', () => {
    const result = runCli(
      ['real-reviewer-contract-smoke'],
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

  test('ALLOW_REAL_PROVIDER=true works via CLI', () => {
    const result = runCli(
      ['real-reviewer-contract-smoke'],
      {
        ALLOW_REAL_PROVIDER: 'true',
        KIMI_API_KEY: 'sk-test',
        KIMI_BASE_URL: 'http://localhost.invalid',
        REAL_REVIEWER_CONTRACT_SMOKE_FAKE_RESPONSE: makeAcceptedResponse(),
      }
    );
    assert.strictEqual(result.status, 0, result.stdout + result.stderr);
    const json = parseOutput(result.stdout);
    assert.strictEqual(json.ok, true);
    assert.strictEqual(json.mode, 'real-reviewer-contract-smoke');
    assert.strictEqual(json.contractValid, true);
    assert.strictEqual(json.decision, 'accepted');
  });

  test('ALLOW_REAL_PROVIDER=1 exits 0 with valid fake response', () => {
    const result = runCli(
      ['real-reviewer-contract-smoke'],
      {
        ALLOW_REAL_PROVIDER: '1',
        KIMI_API_KEY: 'sk-test',
        KIMI_BASE_URL: 'http://localhost.invalid',
        REAL_REVIEWER_CONTRACT_SMOKE_FAKE_RESPONSE: makeAcceptedResponse(),
      }
    );
    assert.strictEqual(result.status, 0, result.stdout + result.stderr);
    const json = parseOutput(result.stdout);
    assert.strictEqual(json.ok, true);
  });

  test('ALLOW_REAL_PROVIDER=yes exits non-zero', () => {
    const result = runCli(
      ['real-reviewer-contract-smoke'],
      {
        AI_PROVIDER: 'mock',
        ALLOW_REAL_PROVIDER: 'yes',
        REAL_REVIEWER_CONTRACT_SMOKE_FAKE_RESPONSE: makeAcceptedResponse(),
      }
    );
    assert.notStrictEqual(result.status, 0);
    const json = parseOutput(result.stdout + result.stderr);
    assert.strictEqual(json.ok, false);
    assert.match(String(json.error), /ALLOW_REAL_PROVIDER/);
  });

  test('ALLOW_REAL_PROVIDER=false exits non-zero', () => {
    const result = runCli(
      ['real-reviewer-contract-smoke'],
      {
        AI_PROVIDER: 'mock',
        ALLOW_REAL_PROVIDER: 'false',
        REAL_REVIEWER_CONTRACT_SMOKE_FAKE_RESPONSE: makeAcceptedResponse(),
      }
    );
    assert.notStrictEqual(result.status, 0);
    const json = parseOutput(result.stdout + result.stderr);
    assert.strictEqual(json.ok, false);
    assert.match(String(json.error), /ALLOW_REAL_PROVIDER/);
  });

  test('missing KIMI_API_KEY exits non-zero', () => {
    const result = runCli(
      ['real-reviewer-contract-smoke'],
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
      ['real-reviewer-contract-smoke'],
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
      ['real-reviewer-contract-smoke'],
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

  test('valid rejected fake response exits 0', () => {
    const result = runCli(
      ['real-reviewer-contract-smoke'],
      {
        ALLOW_REAL_PROVIDER: 'true',
        KIMI_API_KEY: 'sk-test',
        KIMI_BASE_URL: 'http://localhost.invalid',
        REAL_REVIEWER_CONTRACT_SMOKE_FAKE_RESPONSE: makeRejectedResponse(),
      }
    );
    assert.strictEqual(result.status, 0, result.stdout + result.stderr);
    const json = parseOutput(result.stdout);
    assert.strictEqual(json.ok, true);
    assert.strictEqual(json.decision, 'rejected');
  });

  test('valid block_for_human fake response exits 0', () => {
    const result = runCli(
      ['real-reviewer-contract-smoke'],
      {
        ALLOW_REAL_PROVIDER: 'true',
        KIMI_API_KEY: 'sk-test',
        KIMI_BASE_URL: 'http://localhost.invalid',
        REAL_REVIEWER_CONTRACT_SMOKE_FAKE_RESPONSE: makeBlockedForHumanResponse(),
      }
    );
    assert.strictEqual(result.status, 0, result.stdout + result.stderr);
    const json = parseOutput(result.stdout);
    assert.strictEqual(json.ok, true);
    assert.strictEqual(json.decision, 'rejected');
  });

  test('invalid JSON fake response exits non-zero', () => {
    const result = runCli(
      ['real-reviewer-contract-smoke'],
      {
        ALLOW_REAL_PROVIDER: 'true',
        KIMI_API_KEY: 'sk-test',
        KIMI_BASE_URL: 'http://localhost.invalid',
        REAL_REVIEWER_CONTRACT_SMOKE_FAKE_RESPONSE: 'not json',
      }
    );
    assert.notStrictEqual(result.status, 0);
    const json = parseOutput(result.stdout + result.stderr);
    assert.strictEqual(json.ok, false);
  });

  test('missing decision fake response exits non-zero', () => {
    const result = runCli(
      ['real-reviewer-contract-smoke'],
      {
        ALLOW_REAL_PROVIDER: 'true',
        KIMI_API_KEY: 'sk-test',
        KIMI_BASE_URL: 'http://localhost.invalid',
        REAL_REVIEWER_CONTRACT_SMOKE_FAKE_RESPONSE: makeAcceptedResponse({ decision: undefined }),
      }
    );
    assert.notStrictEqual(result.status, 0);
    const json = parseOutput(result.stdout + result.stderr);
    assert.strictEqual(json.ok, false);
  });

  test('secret-like review_summary fake response exits non-zero and redacts', () => {
    const result = runCli(
      ['real-reviewer-contract-smoke'],
      {
        ALLOW_REAL_PROVIDER: 'true',
        KIMI_API_KEY: 'sk-test',
        KIMI_BASE_URL: 'http://localhost.invalid',
        REAL_REVIEWER_CONTRACT_SMOKE_FAKE_RESPONSE: makeAcceptedResponse({
          review_summary: 'key sk-secret123456',
        }),
      }
    );
    assert.notStrictEqual(result.status, 0);
    const output = `${result.stdout}\n${result.stderr}`;
    assert.doesNotMatch(output, /sk-secret123456/);
    assert.match(output, /\[REDACTED\]/);
  });

  test('invalid timeout value exits non-zero', () => {
    const result = runCli(
      ['real-reviewer-contract-smoke', '--timeout-ms', 'abc'],
      {
        ALLOW_REAL_PROVIDER: 'true',
        KIMI_API_KEY: 'sk-test',
        KIMI_BASE_URL: 'http://localhost.invalid',
        REAL_REVIEWER_CONTRACT_SMOKE_FAKE_RESPONSE: makeAcceptedResponse(),
      }
    );
    assert.notStrictEqual(result.status, 0);
    const json = parseOutput(result.stdout + result.stderr);
    assert.strictEqual(json.ok, false);
  });

  test('timeout flag rejects below minimum', () => {
    const result = runCli(
      ['real-reviewer-contract-smoke', '--timeout-ms', '500'],
      {
        ALLOW_REAL_PROVIDER: 'true',
        KIMI_API_KEY: 'sk-test',
        KIMI_BASE_URL: 'http://localhost.invalid',
        REAL_REVIEWER_CONTRACT_SMOKE_FAKE_RESPONSE: makeAcceptedResponse(),
      }
    );
    assert.notStrictEqual(result.status, 0);
    const json = parseOutput(result.stdout + result.stderr);
    assert.strictEqual(json.ok, false);
    assert.match(String(json.error), /below minimum/);
  });

  test('timeout flag accepts valid custom value', () => {
    const result = runCli(
      ['real-reviewer-contract-smoke', '--timeout-ms', '25000'],
      {
        ALLOW_REAL_PROVIDER: 'true',
        KIMI_API_KEY: 'sk-test',
        KIMI_BASE_URL: 'http://localhost.invalid',
        REAL_REVIEWER_CONTRACT_SMOKE_FAKE_RESPONSE: makeAcceptedResponse(),
      }
    );
    assert.strictEqual(result.status, 0, result.stdout + result.stderr);
    const json = parseOutput(result.stdout);
    assert.strictEqual(json.timeoutMs, 25000);
  });

  test('timeout env overrides default', () => {
    const result = runCli(
      ['real-reviewer-contract-smoke'],
      {
        ALLOW_REAL_PROVIDER: 'true',
        KIMI_API_KEY: 'sk-test',
        KIMI_BASE_URL: 'http://localhost.invalid',
        REAL_REVIEWER_CONTRACT_SMOKE_FAKE_RESPONSE: makeAcceptedResponse(),
        REAL_REVIEWER_CONTRACT_SMOKE_TIMEOUT_MS: '30000',
      }
    );
    assert.strictEqual(result.status, 0, result.stdout + result.stderr);
    const json = parseOutput(result.stdout);
    assert.strictEqual(json.timeoutMs, 30000);
  });

  test('command does not write files', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'reviewer-smoke-write-test-'));
    const markerPath = join(tmpDir, 'marker.txt');
    writeFileSync(markerPath, 'before', 'utf-8');
    runCli(
      ['real-reviewer-contract-smoke'],
      {
        ALLOW_REAL_PROVIDER: 'true',
        KIMI_API_KEY: 'sk-test',
        KIMI_BASE_URL: 'http://localhost.invalid',
        REAL_REVIEWER_CONTRACT_SMOKE_FAKE_RESPONSE: makeAcceptedResponse(),
      }
    );
    assert.strictEqual(readFileSync(markerPath, 'utf-8'), 'before');
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('command does not write state', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'reviewer-smoke-state-'));
    runCli(
      ['real-reviewer-contract-smoke'],
      {
        ALLOW_REAL_PROVIDER: 'true',
        KIMI_API_KEY: 'sk-test',
        KIMI_BASE_URL: 'http://localhost.invalid',
        REAL_REVIEWER_CONTRACT_SMOKE_FAKE_RESPONSE: makeAcceptedResponse(),
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

  test('CLI source wires reviewer contract smoke branch without shell:true', () => {
    const source = readFileSync(CLI_SOURCE_PATH, 'utf-8');
    const branchIndex = source.indexOf("command === 'real-reviewer-contract-smoke'");
    assert.ok(branchIndex >= 0, 'reviewer contract smoke branch must exist in cli.ts');
    const nextBranchIndex = source.indexOf("if (!command || (!taskId && command !== 'real-repo-follow-up' && command !== 'real-block-follow-up' && command !== 'operator-e2e'))", branchIndex);
    const snippet = source.slice(branchIndex, nextBranchIndex);
    assert.doesNotMatch(snippet, /shell:\s*true/);
  });

  test('CLI source does not write files or apply patches', () => {
    const source = readFileSync(CLI_SOURCE_PATH, 'utf-8');
    const branchIndex = source.indexOf("command === 'real-reviewer-contract-smoke'");
    const nextBranchIndex = source.indexOf("if (!command || (!taskId && command !== 'real-repo-follow-up' && command !== 'real-block-follow-up' && command !== 'operator-e2e'))", branchIndex);
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
