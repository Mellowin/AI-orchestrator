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

  test('uses unencoded slash between owner and repo in API URL', async () => {
    let capturedUrl: string | undefined;
    const fakeFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      capturedUrl = typeof input === 'string' ? input : input.toString();
      if (init?.method === 'POST') {
        return {
          ok: true,
          status: 201,
          json: async () => ({
            html_url: 'https://github.com/Mellowin/ai-orchestrator-sandbox/pull/1',
            number: 1,
            draft: true,
            base: { ref: 'main' },
            head: { ref: 'feature' },
          }),
        } as Response;
      }
      return { ok: false, status: 404, text: async () => 'not found' } as Response;
    };

    await createDraftPullRequest(
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

    assert.ok(capturedUrl !== undefined);
    assert.ok(
      capturedUrl!.includes('/repos/Mellowin/ai-orchestrator-sandbox/pulls'),
      `URL should contain literal slash between owner and repo, got: ${capturedUrl}`
    );
    assert.ok(
      !capturedUrl!.includes('Mellowin%2F'),
      `URL should not encode owner/repo slash, got: ${capturedUrl}`
    );
  });

  test('returns existing PR when GitHub reports pull request already exists', async () => {
    const existingPr = {
      html_url: 'https://github.com/Mellowin/ai-orchestrator-sandbox/pull/7',
      number: 7,
      draft: true,
      base: { ref: 'stage-18-9b-expense-base' },
      head: { ref: 'ai-stage-18-9c-full-e2e' },
    };

    const fakeFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (init?.method === 'POST' && url.includes('/pulls')) {
        return {
          ok: false,
          status: 422,
          text: async () =>
            JSON.stringify({
              message: 'Validation Failed',
              errors: [
                {
                  resource: 'PullRequest',
                  code: 'custom',
                  message: 'A pull request already exists for Mellowin:ai-stage-18-9c-full-e2e.',
                },
              ],
            }),
        } as Response;
      }
      if (init?.method === 'GET' && url.includes('/pulls?head=')) {
        return {
          ok: true,
          status: 200,
          json: async () => [existingPr],
        } as Response;
      }
      return { ok: false, status: 404, text: async () => 'not found' } as Response;
    };

    const result = await createDraftPullRequest(
      {
        repoFullName: 'Mellowin/ai-orchestrator-sandbox',
        baseBranch: 'stage-18-9b-expense-base',
        headBranch: 'ai-stage-18-9c-full-e2e',
        title: 'Test',
        body: 'Body',
        token: 'ghp_test_token',
      },
      { fetchFn: fakeFetch }
    );

    assert.strictEqual(result.ok, true);
    if (!result.ok) return;
    assert.strictEqual(result.url, existingPr.html_url);
    assert.strictEqual(result.number, existingPr.number);
    assert.strictEqual(result.draft, true);
    assert.strictEqual(result.existed, true);
  });
});
