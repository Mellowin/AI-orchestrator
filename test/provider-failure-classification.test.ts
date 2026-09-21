import { describe, test } from 'node:test';
import assert from 'node:assert';
import {
  sanitizeProviderMessage,
  extractProviderErrorBody,
  classifyProviderHttpFailure,
  classifyProviderTransportFailure,
  exhausted,
  type StructuredProviderFailure,
} from '../src/provider-failure.js';
import {
  ProviderHttpError,
  ProviderCallFailedError,
  normalizeProviderCallError,
  callProviderWithRetry,
  createRealProviderCall,
  type FetchFn,
  type ProviderCallFn,
} from '../src/provider-call.js';
import { KimiProviderError } from '../src/providers/kimi/kimi-provider-error.js';
import { runReviewerGateWithProvider } from '../src/reviewer-provider-runner.js';
import type { ReviewerEvidence, ReviewerEvidenceInput } from '../src/reviewer-evidence.js';

function buildEvidence(overrides: Partial<ReviewerEvidenceInput> = {}): ReviewerEvidence {
  return {
    repoPath: '.',
    taskId: 't1',
    taskGoal: 'goal',
    branchName: 'ai/test',
    commitSha: 'a'.repeat(40),
    shortCommitSha: 'aaaaaaa',
    changedFiles: ['src/test.ts'],
    diffStat: '1 file changed, 1 insertion(+)',
    commitExists: true,
    checkSummary: { test: 'pass' },
    safety: {
      commitShaIsFullLength: true,
      branchIsNotMain: true,
      hasChangedFiles: true,
    },
    ...overrides,
  };
}

describe('provider-failure classification', () => {
  test('401 -> AUTH_INVALID, pause_recommended, non-retryable', () => {
    const c = classifyProviderHttpFailure({ status: 401 });
    assert.strictEqual(c.failure_kind, 'AUTH_INVALID');
    assert.strictEqual(c.retryable, false);
    assert.strictEqual(c.pause_recommended, true);
  });

  test('401 with expired evidence -> AUTH_EXPIRED', () => {
    const c = classifyProviderHttpFailure({
      status: 401,
      errorBody: { code: 'token_expired', message: 'API key expired' },
    });
    assert.strictEqual(c.failure_kind, 'AUTH_EXPIRED');
    assert.strictEqual(c.pause_recommended, true);
  });

  test('403 with quota body -> QUOTA_EXHAUSTED, pause_recommended', () => {
    const body = extractProviderErrorBody(
      JSON.stringify({ error: { code: 'insufficient_quota', message: 'You exceeded your quota' } })
    );
    assert.ok(body);
    const c = classifyProviderHttpFailure({ status: 403, errorBody: body });
    assert.strictEqual(c.failure_kind, 'QUOTA_EXHAUSTED');
    assert.strictEqual(c.retryable, false);
    assert.strictEqual(c.pause_recommended, true);
  });

  test('403 with permission body -> PERMISSION_DENIED, pause_recommended', () => {
    const body = extractProviderErrorBody(
      JSON.stringify({ error: { type: 'permission_error', message: 'Access denied for this scope' } })
    );
    const c = classifyProviderHttpFailure({ status: 403, errorBody: body });
    assert.strictEqual(c.failure_kind, 'PERMISSION_DENIED');
    assert.strictEqual(c.retryable, false);
    assert.strictEqual(c.pause_recommended, true);
  });

  test('403 with no body evidence -> UNKNOWN_PROVIDER_FAILURE (not quota), pause_recommended', () => {
    const c = classifyProviderHttpFailure({ status: 403, errorBody: null });
    assert.strictEqual(c.failure_kind, 'UNKNOWN_PROVIDER_FAILURE');
    assert.strictEqual(c.retryable, false);
    assert.strictEqual(c.pause_recommended, true);
  });

  test('429 -> RATE_LIMITED, retryable; exhausted -> pause_recommended', () => {
    const c = classifyProviderHttpFailure({ status: 429 });
    assert.strictEqual(c.failure_kind, 'RATE_LIMITED');
    assert.strictEqual(c.retryable, true);
    assert.strictEqual(c.pause_recommended, false);

    const failure: StructuredProviderFailure = {
      provider: 'kimi',
      role: 'reviewer',
      http_status: 429,
      failure_kind: c.failure_kind,
      retryable: c.retryable,
      pause_recommended: c.pause_recommended,
      sanitized_message: 'Provider returned status 429',
    };
    const spent = exhausted(failure);
    assert.strictEqual(spent.retryable, false);
    assert.strictEqual(spent.pause_recommended, true);
  });

  test('timeout -> TRANSIENT_NETWORK retryable; exhausted -> pause_recommended', () => {
    const c = classifyProviderTransportFailure('timeout');
    assert.strictEqual(c.failure_kind, 'TRANSIENT_NETWORK');
    assert.strictEqual(c.retryable, true);
    assert.strictEqual(c.pause_recommended, false);

    const spent = exhausted({
      provider: 'kimi',
      role: 'coder',
      http_status: null,
      failure_kind: c.failure_kind,
      retryable: c.retryable,
      pause_recommended: c.pause_recommended,
      sanitized_message: 'Provider request timed out after 1000 ms',
    });
    assert.strictEqual(spent.retryable, false);
    assert.strictEqual(spent.pause_recommended, true);
  });

  test('500 -> PROVIDER_5XX retryable; exhausted -> pause_recommended', () => {
    const c = classifyProviderHttpFailure({ status: 500 });
    assert.strictEqual(c.failure_kind, 'PROVIDER_5XX');
    assert.strictEqual(c.retryable, true);
    assert.strictEqual(c.pause_recommended, false);

    const spent = exhausted({
      provider: 'kimi',
      role: 'coder',
      http_status: 500,
      failure_kind: c.failure_kind,
      retryable: c.retryable,
      pause_recommended: c.pause_recommended,
      sanitized_message: 'Provider returned status 500',
    });
    assert.strictEqual(spent.retryable, false);
    assert.strictEqual(spent.pause_recommended, true);
  });

  test('400 malformed -> BAD_REQUEST, not pause_recommended, non-retryable', () => {
    const c = classifyProviderHttpFailure({
      status: 400,
      errorBody: { code: 'invalid_request_error', message: 'messages is required' },
    });
    assert.strictEqual(c.failure_kind, 'BAD_REQUEST');
    assert.strictEqual(c.retryable, false);
    assert.strictEqual(c.pause_recommended, false);
  });

  test('400/413 context-length evidence -> CONTEXT_LIMIT, not credential/quota, not pause_recommended', () => {
    const c400 = classifyProviderHttpFailure({
      status: 400,
      errorBody: { code: 'context_length_exceeded', message: 'maximum context length is 8192 tokens' },
    });
    assert.strictEqual(c400.failure_kind, 'CONTEXT_LIMIT');
    assert.strictEqual(c400.retryable, false);
    assert.strictEqual(c400.pause_recommended, false);

    const c413 = classifyProviderHttpFailure({
      status: 413,
      errorBody: { message: 'request too large: context length exceeded' },
    });
    assert.strictEqual(c413.failure_kind, 'CONTEXT_LIMIT');
    assert.strictEqual(c413.pause_recommended, false);
  });

  test('exhausted preserves explicit pause_recommended on non-transient kinds', () => {
    const spent = exhausted({
      provider: 'kimi',
      role: 'reviewer',
      http_status: 401,
      failure_kind: 'AUTH_INVALID',
      retryable: false,
      pause_recommended: true,
      sanitized_message: 'Provider returned status 401',
    });
    assert.strictEqual(spent.retryable, false);
    assert.strictEqual(spent.pause_recommended, true);

    const badRequest = exhausted({
      provider: 'kimi',
      role: 'coder',
      http_status: 400,
      failure_kind: 'BAD_REQUEST',
      retryable: false,
      pause_recommended: false,
      sanitized_message: 'Provider returned status 400',
    });
    assert.strictEqual(badRequest.pause_recommended, false);
  });
});

describe('provider-failure sanitization', () => {
  test('sanitizeProviderMessage redacts sk- and Bearer tokens', () => {
    const sanitized = sanitizeProviderMessage(
      'key sk-TESTKEY123abcdef used with Bearer abcdefsecrettoken failed'
    );
    assert.ok(!sanitized.includes('sk-TESTKEY123abcdef'), `leaked: ${sanitized}`);
    assert.ok(!sanitized.includes('abcdefsecrettoken'), `leaked: ${sanitized}`);
  });

  test('sanitizeProviderMessage caps length at 500 chars', () => {
    const sanitized = sanitizeProviderMessage('x'.repeat(2000));
    assert.ok(sanitized.length <= 500);
  });

  test('ProviderHttpError message redacts secrets from body evidence', () => {
    const err = new ProviderHttpError(403, {
      providerErrorCode: 'insufficient_quota',
      providerErrorMessage: 'quota exceeded for key sk-TESTKEY123abcdef',
    });
    assert.ok(err.message.startsWith('Provider returned status 403'));
    assert.ok(err.message.includes('insufficient_quota'));
    assert.ok(!err.message.includes('sk-TESTKEY123abcdef'), `leaked: ${err.message}`);
    assert.strictEqual(err.httpStatus, 403);
    assert.strictEqual(err.providerErrorCode, 'insufficient_quota');
  });

  test('extractProviderErrorBody sanitizes message and reads only whitelisted fields', () => {
    const body = extractProviderErrorBody(
      JSON.stringify({
        error: {
          code: 'insufficient_quota',
          type: 'quota_error',
          message: 'quota for sk-TESTKEY123abcdef exceeded',
          debug: 'sk-TESTKEY123abcdef raw internals',
        },
      })
    );
    assert.ok(body);
    assert.strictEqual(body.code, 'insufficient_quota');
    assert.strictEqual(body.type, 'quota_error');
    assert.ok(body.message);
    assert.ok(!body.message.includes('sk-TESTKEY123abcdef'), `leaked: ${body.message}`);
    assert.ok(!('debug' in body), 'non-whitelisted fields must be dropped');
  });

  test('extractProviderErrorBody tolerates top-level code/type/message', () => {
    const body = extractProviderErrorBody(
      JSON.stringify({ code: 'rate_limit', type: 'throttle', message: 'slow down' })
    );
    assert.deepStrictEqual(body, { code: 'rate_limit', type: 'throttle', message: 'slow down' });
  });

  test('extractProviderErrorBody ignores non-JSON bodies and never returns raw text', () => {
    assert.strictEqual(extractProviderErrorBody('<html>502 Bad Gateway</html>'), null);
    assert.strictEqual(extractProviderErrorBody('plain text error'), null);
    assert.strictEqual(extractProviderErrorBody(''), null);
    assert.strictEqual(extractProviderErrorBody('{"unrelated": true}'), null);
  });
});

describe('provider-failure integration', () => {
  test('createRealProviderCall reads error body and throws ProviderHttpError with safe fields', async () => {
    const fakeFetch: FetchFn = async () => ({
      ok: false,
      status: 403,
      json: async () => ({}),
      text: async () =>
        JSON.stringify({
          error: { code: 'insufficient_quota', message: 'quota exceeded for sk-TESTKEY123abcdef' },
        }),
      headers: { 'retry-after': '2' },
    });
    const call = createRealProviderCall({
      provider: 'kimi',
      apiKey: 'sk-secret-under-test',
      baseUrl: 'https://api.example.com',
      fetchFn: fakeFetch,
    });
    await assert.rejects(
      async () => call({ role: 'reviewer', prompt: 'p', model: 'm', provider: 'kimi' }),
      (err: unknown) => {
        assert.ok(err instanceof ProviderHttpError);
        assert.strictEqual(err.httpStatus, 403);
        assert.strictEqual(err.providerErrorCode, 'insufficient_quota');
        assert.strictEqual(err.retryAfterMs, 2000);
        assert.ok(err.message.startsWith('Provider returned status 403'));
        assert.ok(!err.message.includes('sk-TESTKEY123abcdef'), `leaked: ${err.message}`);
        assert.ok(!err.message.includes('sk-secret-under-test'), `leaked: ${err.message}`);
        return true;
      }
    );
  });

  test('createRealProviderCall body read failure does not mask status error', async () => {
    const fakeFetch: FetchFn = async () => ({
      ok: false,
      status: 500,
      json: async () => ({}),
      text: async () => {
        throw new Error('stream exploded');
      },
    });
    const call = createRealProviderCall({
      provider: 'kimi',
      apiKey: 'sk-test',
      baseUrl: 'https://api.example.com',
      fetchFn: fakeFetch,
    });
    await assert.rejects(
      async () => call({ role: 'coder', prompt: 'p', model: 'm', provider: 'kimi' }),
      (err: unknown) => {
        assert.ok(err instanceof ProviderHttpError);
        assert.strictEqual(err.httpStatus, 500);
        assert.strictEqual(err.message, 'Provider returned status 500');
        return true;
      }
    );
  });

  test('normalizeProviderCallError classifies ProviderHttpError with structured fields', () => {
    const err = new ProviderHttpError(403, {
      providerErrorCode: 'insufficient_quota',
      providerErrorMessage: 'quota exceeded',
    });
    const info = normalizeProviderCallError(err);
    assert.strictEqual(info.isRetryable, false);
    assert.ok(info.failure);
    assert.strictEqual(info.failure.http_status, 403);
    assert.strictEqual(info.failure.failure_kind, 'QUOTA_EXHAUSTED');
    assert.strictEqual(info.failure.pause_recommended, true);
    assert.strictEqual(info.failure.provider_error_code, 'insufficient_quota');
  });

  test('normalizeProviderCallError keeps legacy isRetryable semantics and attaches failure for plain status errors', () => {
    const rateLimited = normalizeProviderCallError(new Error('Provider returned status 429'));
    assert.strictEqual(rateLimited.isRetryable, true);
    assert.strictEqual(rateLimited.failure?.failure_kind, 'RATE_LIMITED');

    const forbidden = normalizeProviderCallError(new Error('Provider returned status 403'));
    assert.strictEqual(forbidden.isRetryable, false);
    assert.strictEqual(forbidden.failure?.failure_kind, 'UNKNOWN_PROVIDER_FAILURE');

    const timeout = normalizeProviderCallError(new Error('Provider request timed out after 1000 ms'));
    assert.strictEqual(timeout.isRetryable, true);
    assert.strictEqual(timeout.failure?.failure_kind, 'TRANSIENT_NETWORK');
    assert.strictEqual(timeout.failure?.http_status, null);
  });

  test('normalizeProviderCallError does not attach failure to schema validation errors', () => {
    const info = normalizeProviderCallError(new Error('Invalid Kimi JSON output: malformed fenced block'));
    assert.strictEqual(info.isRetryable, true);
    assert.strictEqual(info.failure, undefined);
  });

  test('callProviderWithRetry attaches exhausted failure after 429 retry budget is spent', async () => {
    const alwaysRateLimited: ProviderCallFn = async () => {
      throw new ProviderHttpError(429, { providerErrorMessage: 'slow down' });
    };
    await assert.rejects(
      async () =>
        callProviderWithRetry({
          providerCall: alwaysRateLimited,
          provider: 'kimi',
          model: 'kimi-k2.6',
          basePrompt: 'hello',
          taskId: 't1',
          role: 'reviewer',
          config: { maxAttempts: 2, baseDelayMs: 0, maxDelayMs: 0 },
          sleepFn: async () => {},
        }),
      (err: unknown) => {
        assert.ok(err instanceof ProviderCallFailedError);
        assert.ok(err.failure);
        assert.strictEqual(err.failure.provider, 'kimi');
        assert.strictEqual(err.failure.role, 'reviewer');
        assert.strictEqual(err.failure.failure_kind, 'RATE_LIMITED');
        assert.strictEqual(err.failure.retryable, false);
        assert.strictEqual(err.failure.pause_recommended, true);
        return true;
      }
    );
  });

  test('callProviderWithRetry honors Retry-After hint for the next delay', async () => {
    const delays: number[] = [];
    const rateLimited: ProviderCallFn = async () => {
      throw new ProviderHttpError(429, { retryAfterMs: 5000 });
    };
    await assert.rejects(
      async () =>
        callProviderWithRetry({
          providerCall: rateLimited,
          provider: 'kimi',
          model: 'kimi-k2.6',
          basePrompt: 'hello',
          taskId: 't1',
          config: { maxAttempts: 2, baseDelayMs: 1000, maxDelayMs: 10000 },
          sleepFn: async (ms) => {
            delays.push(ms);
          },
        }),
      /Provider returned status 429/
    );
    assert.deepStrictEqual(delays, [5000]);
  });

  test('callProviderWithRetry attaches non-retryable auth failure without retry', async () => {
    let calls = 0;
    const authFail: ProviderCallFn = async () => {
      calls++;
      throw new ProviderHttpError(401, { providerErrorMessage: 'invalid api key' });
    };
    await assert.rejects(
      async () =>
        callProviderWithRetry({
          providerCall: authFail,
          provider: 'kimi',
          model: 'kimi-k2.6',
          basePrompt: 'hello',
          taskId: 't1',
          config: { maxAttempts: 3, baseDelayMs: 0, maxDelayMs: 0 },
          sleepFn: async () => {},
        }),
      (err: unknown) => {
        assert.ok(err instanceof ProviderCallFailedError);
        assert.strictEqual(err.failure?.failure_kind, 'AUTH_INVALID');
        assert.strictEqual(err.failure?.pause_recommended, true);
        return true;
      }
    );
    assert.strictEqual(calls, 1);
  });

  test('runReviewerGateWithProvider exposes provider_failure on blocked gate result', async () => {
    const failure: StructuredProviderFailure = {
      provider: 'kimi',
      role: 'reviewer',
      http_status: 403,
      failure_kind: 'QUOTA_EXHAUSTED',
      retryable: false,
      pause_recommended: true,
      sanitized_message: 'Provider returned status 403: insufficient_quota',
      provider_error_code: 'insufficient_quota',
    };
    const result = await runReviewerGateWithProvider({
      evidence: buildEvidence(),
      reviewer: async () => {
        throw new KimiProviderError('Kimi reviewer failed: Provider returned status 403', failure);
      },
      maxParseRetries: 2,
    });
    assert.strictEqual(result.gateResult.status, 'blocked');
    assert.strictEqual(result.gateResult.source, 'provider');
    assert.deepStrictEqual(result.gateResult.provider_failure, failure);
    assert.ok(
      result.gateResult.blockingIssues[0].startsWith('Reviewer provider failed:'),
      'blockingIssues format preserved'
    );
  });

  test('runReviewerGateWithProvider omits provider_failure for plain provider errors', async () => {
    const result = await runReviewerGateWithProvider({
      evidence: buildEvidence(),
      reviewer: async () => {
        throw new Error('some unstructured failure');
      },
      maxParseRetries: 2,
    });
    assert.strictEqual(result.gateResult.status, 'blocked');
    assert.strictEqual(result.gateResult.source, 'provider');
    assert.strictEqual(result.gateResult.provider_failure, undefined);
  });
});
