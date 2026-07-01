import { describe, test } from 'node:test';
import assert from 'node:assert';
import {
  createDraftPullRequest,
  type CreateDraftPullRequestInput,
} from '../src/github-pr-client.js';

describe('github-pr-client', () => {
  test('returns skipped_missing_token when token is missing', async () => {
    const result = await createDraftPullRequest({
      repoFullName: 'Mellowin/ai-orchestrator-sandbox',
      baseBranch: 'main',
      headBranch: 'feature',
      title: 'Test',
      body: 'Body',
      token: undefined,
    });
    assert.strictEqual(result.ok, false);
    if (result.ok) return;
    assert.strictEqual(result.status, 'skipped_missing_token');
  });

  test('returns skipped_missing_token when token is empty', async () => {
    const result = await createDraftPullRequest({
      repoFullName: 'Mellowin/ai-orchestrator-sandbox',
      baseBranch: 'main',
      headBranch: 'feature',
      title: 'Test',
      body: 'Body',
      token: '   ',
    });
    assert.strictEqual(result.ok, false);
    if (result.ok) return;
    assert.strictEqual(result.status, 'skipped_missing_token');
  });

  test('returns PR data on successful GitHub API response', async () => {
    const fakeFetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      assert.strictEqual(body.draft, true);
      assert.strictEqual(body.title, 'Test PR');
      return {
        ok: true,
        status: 201,
        json: async () => ({
          html_url: 'https://github.com/Mellowin/ai-orchestrator-sandbox/pull/42',
          number: 42,
          draft: true,
          base: { ref: 'stage-18-9-expense-base' },
          head: { ref: 'ai-stage-18-9-full-e2e' },
        }),
      } as Response;
    };

    const result = await createDraftPullRequest(
      {
        repoFullName: 'Mellowin/ai-orchestrator-sandbox',
        baseBranch: 'stage-18-9-expense-base',
        headBranch: 'ai-stage-18-9-full-e2e',
        title: 'Test PR',
        body: 'PR body',
        token: 'ghp_test_token',
      },
      { fetchFn: fakeFetch }
    );

    assert.strictEqual(result.ok, true);
    if (!result.ok) return;
    assert.strictEqual(result.url, 'https://github.com/Mellowin/ai-orchestrator-sandbox/pull/42');
    assert.strictEqual(result.number, 42);
    assert.strictEqual(result.draft, true);
    assert.strictEqual(result.base, 'stage-18-9-expense-base');
    assert.strictEqual(result.head, 'ai-stage-18-9-full-e2e');
  });

  test('returns failed status on GitHub API error', async () => {
    const fakeFetch = async () =>
      ({
        ok: false,
        status: 422,
        text: async () => JSON.stringify({ message: 'Validation failed' }),
      } as Response);

    const result = await createDraftPullRequest(
      {
        repoFullName: 'Mellowin/ai-orchestrator-sandbox',
        baseBranch: 'main',
        headBranch: 'feature',
        title: 'Test',
        body: 'Body',
        token: 'ghp_test_token',
      },
      { fetchFn: fakeFetch }
    );

    assert.strictEqual(result.ok, false);
    if (result.ok) return;
    assert.strictEqual(result.status, 'failed');
    assert.strictEqual(result.httpStatus, 422);
    assert.ok(result.message.includes('Validation failed'));
  });

  test('redacts token-like strings from error messages', async () => {
    const fakeFetch = async () => {
      throw new Error('Network error for token ghp_123456789012345678901234567890123456');
    };

    const result = await createDraftPullRequest(
      {
        repoFullName: 'Mellowin/ai-orchestrator-sandbox',
        baseBranch: 'main',
        headBranch: 'feature',
        title: 'Test',
        body: 'Body',
        token: 'ghp_123456789012345678901234567890123456',
      },
      { fetchFn: fakeFetch }
    );

    assert.strictEqual(result.ok, false);
    if (result.ok) return;
    assert.strictEqual(result.status, 'failed');
    assert.strictEqual(result.httpStatus, 0);
    assert.ok(!result.message.includes('ghp_123456789012345678901234567890123456'));
    assert.ok(result.message.includes('[REDACTED]'));
  });

  test('compare URL is not treated as PR', async () => {
    const result = await createDraftPullRequest({
      repoFullName: 'Mellowin/ai-orchestrator-sandbox',
      baseBranch: 'stage-18-9-expense-base',
      headBranch: 'ai-stage-18-9-full-e2e',
      title: 'Test',
      body: 'Body',
      token: undefined,
    });
    assert.strictEqual(result.ok, false);
    if (result.ok) return;
    assert.strictEqual(result.status, 'skipped_missing_token');
  });
});
