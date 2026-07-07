import { describe, test } from 'node:test';
import assert from 'node:assert';
import {
  createAcceptanceMatrixPr,
  type GithubPrCreatorDeps,
} from '../../src/acceptance-matrix/pr-creator.js';
import type {
  AcceptanceMatrixConfig,
  AcceptanceScenarioConfig,
} from '../../src/acceptance-matrix/types.js';

function makeConfig(overrides?: Partial<AcceptanceMatrixConfig>): AcceptanceMatrixConfig {
  return {
    provider: 'fake',
    allow_real_provider: false,
    allow_github_pr_create: true,
    allow_real_repo_apply: true,
    allow_real_repo_commit: true,
    allow_real_repo_push: true,
    stop_on_orchestrator_bug: true,
    report_dir: '/tmp/report',
    sandbox_repo_path: '/tmp/repo',
    sandbox_repo_slug: 'owner/repo',
    scenarios: [],
    ...overrides,
  };
}

function makeScenario(overrides?: Partial<AcceptanceScenarioConfig>): AcceptanceScenarioConfig {
  return {
    type: 'golden_real_multitask',
    label: 'golden',
    base_branch: 'main',
    work_branch: 'feature-x',
    unsafe_response_mode: 'none',
    ...overrides,
  };
}

describe('acceptance-matrix pr-creator', () => {
  test('creates a draft PR with correct base and head', async () => {
    const captured: { url?: string; body?: unknown; headers?: Record<string, string> } = {};
    const deps: GithubPrCreatorDeps = {
      postJson: async (url, headers, body) => {
        captured.url = url;
        captured.body = body;
        captured.headers = headers;
        return {
          status: 201,
          body: { number: 42, html_url: 'https://github.com/owner/repo/pull/42', draft: true },
        };
      },
    };

    const config = makeConfig();
    const scenario = makeScenario({ base_branch: 'develop', work_branch: 'feature-y' });
    const result = await createAcceptanceMatrixPr(config, scenario, 'ghp_faketoken', deps);

    assert.strictEqual(result.created, true);
    assert.strictEqual(result.number, 42);
    assert.strictEqual(result.url, 'https://github.com/owner/repo/pull/42');
    assert.strictEqual(result.draft, true);
    assert.strictEqual(result.classification, undefined);

    assert.strictEqual(captured.url, 'https://api.github.com/repos/owner/repo/pulls');
    const body = captured.body as Record<string, unknown>;
    assert.strictEqual(body.base, 'develop');
    assert.strictEqual(body.head, 'feature-y');
    assert.strictEqual(body.draft, true);
    assert.ok(typeof body.title === 'string');
    assert.ok(typeof body.body === 'string');

    assert.ok(captured.headers);
    assert.strictEqual(captured.headers?.Authorization, 'Bearer ghp_faketoken');
  });

  test('missing token is HUMAN_TOKEN_PERMISSION_ERROR', async () => {
    const deps: GithubPrCreatorDeps = {
      postJson: async () => ({ status: 500, body: {} }),
    };

    const config = makeConfig();
    const scenario = makeScenario();
    const result = await createAcceptanceMatrixPr(config, scenario, '', deps);

    assert.strictEqual(result.created, false);
    assert.strictEqual(result.classification, 'HUMAN_TOKEN_PERMISSION_ERROR');
    assert.ok(result.reason.includes('GITHUB_TOKEN is missing'));
  });

  test('401 response is HUMAN_TOKEN_PERMISSION_ERROR', async () => {
    const deps: GithubPrCreatorDeps = {
      postJson: async () => ({
        status: 401,
        body: { message: 'Bad credentials' },
      }),
    };

    const config = makeConfig();
    const scenario = makeScenario();
    const result = await createAcceptanceMatrixPr(config, scenario, 'ghp_faketoken', deps);

    assert.strictEqual(result.created, false);
    assert.strictEqual(result.classification, 'HUMAN_TOKEN_PERMISSION_ERROR');
    assert.ok(result.reason.includes('Bad credentials'));
  });

  test('403 response is HUMAN_TOKEN_PERMISSION_ERROR', async () => {
    const deps: GithubPrCreatorDeps = {
      postJson: async () => ({
        status: 403,
        body: { message: 'Resource not accessible by integration' },
      }),
    };

    const config = makeConfig();
    const scenario = makeScenario();
    const result = await createAcceptanceMatrixPr(config, scenario, 'ghp_faketoken', deps);

    assert.strictEqual(result.created, false);
    assert.strictEqual(result.classification, 'HUMAN_TOKEN_PERMISSION_ERROR');
  });

  test('422 response is GITHUB_API_ERROR', async () => {
    const deps: GithubPrCreatorDeps = {
      postJson: async () => ({
        status: 422,
        body: { message: 'Validation Failed', errors: ['No commits between main and feature-x'] },
      }),
    };

    const config = makeConfig();
    const scenario = makeScenario();
    const result = await createAcceptanceMatrixPr(config, scenario, 'ghp_faketoken', deps);

    assert.strictEqual(result.created, false);
    assert.strictEqual(result.classification, 'GITHUB_API_ERROR');
    assert.ok(result.reason.includes('Validation Failed'));
  });

  test('disabled by config returns CONFIG_ERROR', async () => {
    const deps: GithubPrCreatorDeps = {
      postJson: async () => ({ status: 201, body: { number: 1, html_url: 'x', draft: true } }),
    };

    const config = makeConfig({ allow_github_pr_create: false });
    const scenario = makeScenario();
    const result = await createAcceptanceMatrixPr(config, scenario, 'ghp_faketoken', deps);

    assert.strictEqual(result.created, false);
    assert.strictEqual(result.classification, 'CONFIG_ERROR');
  });

  test('missing sandbox_repo_slug returns CONFIG_ERROR', async () => {
    const deps: GithubPrCreatorDeps = {
      postJson: async () => ({ status: 201, body: { number: 1, html_url: 'x', draft: true } }),
    };

    const config = makeConfig({ sandbox_repo_slug: undefined });
    const scenario = makeScenario();
    const result = await createAcceptanceMatrixPr(config, scenario, 'ghp_faketoken', deps);

    assert.strictEqual(result.created, false);
    assert.strictEqual(result.classification, 'CONFIG_ERROR');
  });

  test('reason never contains the raw token', async () => {
    const deps: GithubPrCreatorDeps = {
      postJson: async () => ({
        status: 422,
        body: { message: 'error with ghp_supersecrettoken value' },
      }),
    };

    const config = makeConfig();
    const scenario = makeScenario();
    const result = await createAcceptanceMatrixPr(config, scenario, 'ghp_supersecrettoken', deps);

    assert.strictEqual(result.created, false);
    assert.ok(!result.reason.includes('ghp_supersecrettoken'));
  });
});
