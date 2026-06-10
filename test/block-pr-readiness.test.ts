import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { writeFileSync, readFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { checkBlockPrReadiness } from '../src/block/block-pr-readiness.js';
import { initBlockState, getBlockRunDir, saveBlockState } from '../src/block/block-state-manager.js';
import type { BlockDefinition, BlockState } from '../src/block/block-types.js';

function createDefinition(blockId: string, repoPath: string): BlockDefinition {
  return {
    block_id: blockId,
    title: 'PR Readiness Test Block',
    repo_path: repoPath,
    base_branch: 'feature/mvp-skeleton',
    work_branch: 'stage-6-11-pr-create-proof',
    providers: {
      coder: { provider: 'fake', model: 'default' },
      reviewer: { provider: 'fake', model: 'default' },
    },
    review_policy: {
      require_deterministic_checks: true,
      max_fix_attempts: 2,
      reviewer_mode: 'single',
    },
    tasks: [
      {
        task_id: 'doc-1',
        title: 'T1',
        goal: 'G1',
        allowed_files: ['a.txt'],
        denied_files: [],
        max_lines_changed: 50,
        checks: [],
      },
    ],
  };
}

function saveDefinition(def: BlockDefinition, path: string) {
  writeFileSync(path, JSON.stringify(def, null, 2));
}

function saveState(state: BlockState) {
  saveBlockState(state);
}

function createFakeFetch(
  scenarios: Array<{
    url: string;
    method: string;
    response: { ok: boolean; status: number; json: () => unknown; text: () => string };
  }>
): typeof fetch {
  return async (url: string | URL | Request, init?: RequestInit) => {
    const urlStr = String(url);
    const method = init?.method ?? 'GET';
    const match = scenarios.find((s) => urlStr.includes(s.url) && s.method === method);
    if (!match) {
      throw new Error(`Unexpected fetch: ${method} ${urlStr}`);
    }
    return match.response as Response;
  };
}

function makePrResponse(overrides: Record<string, unknown> = {}) {
  return {
    state: 'open',
    draft: true,
    merged: false,
    base: { ref: 'feature/mvp-skeleton' },
    head: { ref: 'stage-6-11-pr-create-proof', sha: 'abc123def456abc123def456abc123def456abcd' },
    html_url: 'https://github.com/test-owner/test-repo/pull/2',
    commits: 1,
    changed_files: 1,
    node_id: 'PR_node_123',
    ...overrides,
  };
}

function makeCheckRunsResponse(overrides: Record<string, unknown> = {}) {
  return {
    check_runs: [{ name: 'CI', status: 'completed', conclusion: 'success' }],
    ...overrides,
  };
}

describe('block-pr-readiness', () => {
  let blockJsonPath: string;
  let blockId: string;
  let repoPath: string;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    blockId = `pr-readiness-${Date.now()}`;
    repoPath = join(tmpdir(), `repo-${blockId}`);
    mkdirSync(repoPath, { recursive: true });
    process.env.ALLOW_BLOCK_PR_READINESS = 'true';
    process.env.GITHUB_REPOSITORY = 'test-owner/test-repo';
    process.env.BLOCK_PR_NUMBER = '2';
    process.env.GITHUB_TOKEN = 'ghp_testtoken1234567890';
  });

  afterEach(() => {
    process.env = originalEnv;
    try {
      const runDir = getBlockRunDir(blockId);
      if (existsSync(runDir)) {
        rmSync(runDir, { recursive: true, force: true });
      }
      if (existsSync(blockJsonPath)) {
        rmSync(blockJsonPath, { force: true });
      }
      if (existsSync(repoPath)) {
        rmSync(repoPath, { recursive: true, force: true });
      }
    } catch {
      // ignore cleanup errors
    }
  });

  async function setupBlock() {
    const def = createDefinition(blockId, repoPath);
    blockJsonPath = join(tmpdir(), `block-${blockId}.json`);
    saveDefinition(def, blockJsonPath);
    const state = initBlockState(def);
    state.status = 'completed';
    state.tasks[0].status = 'accepted';
    saveState(state);
  }

  it('default dry-run does not mutate PR', async () => {
    await setupBlock();
    // dry-run is default (BLOCK_PR_READINESS_DRY_RUN not set to 'false')
    const fakeFetch = createFakeFetch([
      {
        url: '/pulls/2',
        method: 'GET',
        response: { ok: true, status: 200, json: () => makePrResponse(), text: () => '' },
      },
      {
        url: '/check-runs',
        method: 'GET',
        response: { ok: true, status: 200, json: () => makeCheckRunsResponse(), text: () => '' },
      },
    ]);

    const result = await checkBlockPrReadiness({ blockDefinitionPath: blockJsonPath, fetchFn: fakeFetch });
    assert.strictEqual(result.dry_run, true);
    assert.strictEqual(result.marked_ready, false);
    assert.strictEqual(result.would_mark_ready, false);
    assert.strictEqual(result.readiness, 'ready');
  });

  it('missing GITHUB_REPOSITORY blocks', async () => {
    await setupBlock();
    delete process.env.GITHUB_REPOSITORY;
    await assert.rejects(
      async () => {
        await checkBlockPrReadiness({ blockDefinitionPath: blockJsonPath });
      },
      /GITHUB_REPOSITORY/
    );
  });

  it('missing BLOCK_PR_NUMBER blocks', async () => {
    await setupBlock();
    delete process.env.BLOCK_PR_NUMBER;
    await assert.rejects(
      async () => {
        await checkBlockPrReadiness({ blockDefinitionPath: blockJsonPath });
      },
      /BLOCK_PR_NUMBER/
    );
  });

  it('closed PR blocks readiness', async () => {
    await setupBlock();
    const fakeFetch = createFakeFetch([
      {
        url: '/pulls/2',
        method: 'GET',
        response: { ok: true, status: 200, json: () => makePrResponse({ state: 'closed' }), text: () => '' },
      },
      {
        url: '/check-runs',
        method: 'GET',
        response: { ok: true, status: 200, json: () => makeCheckRunsResponse(), text: () => '' },
      },
    ]);

    const result = await checkBlockPrReadiness({ blockDefinitionPath: blockJsonPath, fetchFn: fakeFetch });
    assert.strictEqual(result.readiness, 'not_ready');
    assert.ok(result.blocking_issues.some((i) => i.includes('PR is not open')), result.blocking_issues.join('; '));
  });

  it('merged PR blocks readiness', async () => {
    await setupBlock();
    const fakeFetch = createFakeFetch([
      {
        url: '/pulls/2',
        method: 'GET',
        response: { ok: true, status: 200, json: () => makePrResponse({ merged: true }), text: () => '' },
      },
      {
        url: '/check-runs',
        method: 'GET',
        response: { ok: true, status: 200, json: () => makeCheckRunsResponse(), text: () => '' },
      },
    ]);

    const result = await checkBlockPrReadiness({ blockDefinitionPath: blockJsonPath, fetchFn: fakeFetch });
    assert.strictEqual(result.readiness, 'not_ready');
    assert.ok(result.blocking_issues.some((i) => i.includes('already merged')), result.blocking_issues.join('; '));
  });

  it('non-draft PR blocks readiness', async () => {
    await setupBlock();
    const fakeFetch = createFakeFetch([
      {
        url: '/pulls/2',
        method: 'GET',
        response: { ok: true, status: 200, json: () => makePrResponse({ draft: false }), text: () => '' },
      },
      {
        url: '/check-runs',
        method: 'GET',
        response: { ok: true, status: 200, json: () => makeCheckRunsResponse(), text: () => '' },
      },
    ]);

    const result = await checkBlockPrReadiness({ blockDefinitionPath: blockJsonPath, fetchFn: fakeFetch });
    assert.strictEqual(result.readiness, 'not_ready');
    assert.ok(result.blocking_issues.some((i) => i.includes('not draft')), result.blocking_issues.join('; '));
  });

  it('main head branch blocks readiness', async () => {
    await setupBlock();
    const fakeFetch = createFakeFetch([
      {
        url: '/pulls/2',
        method: 'GET',
        response: {
          ok: true,
          status: 200,
          json: () => makePrResponse({ head: { ref: 'main', sha: 'abc123' } }),
          text: () => '',
        },
      },
      {
        url: '/check-runs',
        method: 'GET',
        response: { ok: true, status: 200, json: () => makeCheckRunsResponse(), text: () => '' },
      },
    ]);

    const result = await checkBlockPrReadiness({ blockDefinitionPath: blockJsonPath, fetchFn: fakeFetch });
    assert.strictEqual(result.readiness, 'not_ready');
    assert.ok(result.blocking_issues.some((i) => i.includes('main/master')), result.blocking_issues.join('; '));
  });

  it('master head branch blocks readiness', async () => {
    await setupBlock();
    const fakeFetch = createFakeFetch([
      {
        url: '/pulls/2',
        method: 'GET',
        response: {
          ok: true,
          status: 200,
          json: () => makePrResponse({ head: { ref: 'master', sha: 'abc123' } }),
          text: () => '',
        },
      },
      {
        url: '/check-runs',
        method: 'GET',
        response: { ok: true, status: 200, json: () => makeCheckRunsResponse(), text: () => '' },
      },
    ]);

    const result = await checkBlockPrReadiness({ blockDefinitionPath: blockJsonPath, fetchFn: fakeFetch });
    assert.strictEqual(result.readiness, 'not_ready');
    assert.ok(result.blocking_issues.some((i) => i.includes('main/master')), result.blocking_issues.join('; '));
  });

  it('CI failure blocks readiness', async () => {
    await setupBlock();
    const fakeFetch = createFakeFetch([
      {
        url: '/pulls/2',
        method: 'GET',
        response: { ok: true, status: 200, json: () => makePrResponse(), text: () => '' },
      },
      {
        url: '/check-runs',
        method: 'GET',
        response: {
          ok: true,
          status: 200,
          json: () =>
            makeCheckRunsResponse({
              check_runs: [{ name: 'CI', status: 'completed', conclusion: 'failure' }],
            }),
          text: () => '',
        },
      },
    ]);

    const result = await checkBlockPrReadiness({ blockDefinitionPath: blockJsonPath, fetchFn: fakeFetch });
    assert.strictEqual(result.readiness, 'not_ready');
    assert.ok(result.blocking_issues.some((i) => i.includes('CI/checks failed')), result.blocking_issues.join('; '));
  });

  it('CI pending blocks readiness', async () => {
    await setupBlock();
    const fakeFetch = createFakeFetch([
      {
        url: '/pulls/2',
        method: 'GET',
        response: { ok: true, status: 200, json: () => makePrResponse(), text: () => '' },
      },
      {
        url: '/check-runs',
        method: 'GET',
        response: {
          ok: true,
          status: 200,
          json: () =>
            makeCheckRunsResponse({
              check_runs: [{ name: 'CI', status: 'in_progress', conclusion: null }],
            }),
          text: () => '',
        },
      },
    ]);

    const result = await checkBlockPrReadiness({ blockDefinitionPath: blockJsonPath, fetchFn: fakeFetch });
    assert.strictEqual(result.readiness, 'not_ready');
    assert.ok(result.blocking_issues.some((i) => i.includes('CI/checks pending')), result.blocking_issues.join('; '));
  });

  it('CI success allows readiness', async () => {
    await setupBlock();
    const fakeFetch = createFakeFetch([
      {
        url: '/pulls/2',
        method: 'GET',
        response: { ok: true, status: 200, json: () => makePrResponse(), text: () => '' },
      },
      {
        url: '/check-runs',
        method: 'GET',
        response: {
          ok: true,
          status: 200,
          json: () =>
            makeCheckRunsResponse({
              check_runs: [
                { name: 'CI', status: 'completed', conclusion: 'success' },
                { name: 'Lint', status: 'completed', conclusion: 'success' },
              ],
            }),
          text: () => '',
        },
      },
    ]);

    const result = await checkBlockPrReadiness({ blockDefinitionPath: blockJsonPath, fetchFn: fakeFetch });
    assert.strictEqual(result.readiness, 'ready');
    assert.strictEqual(result.checks_status, 'success');
    assert.strictEqual(result.blocking_issues.length, 0);
  });

  it('real mark-ready path requires explicit flags and token', async () => {
    await setupBlock();
    process.env.BLOCK_PR_READINESS_DRY_RUN = 'false';
    process.env.ALLOW_GITHUB_MARK_READY = 'true';
    // GITHUB_TOKEN is already set in beforeEach

    const fakeFetch = createFakeFetch([
      {
        url: '/pulls/2',
        method: 'GET',
        response: { ok: true, status: 200, json: () => makePrResponse(), text: () => '' },
      },
      {
        url: '/check-runs',
        method: 'GET',
        response: { ok: true, status: 200, json: () => makeCheckRunsResponse(), text: () => '' },
      },
      {
        url: '/graphql',
        method: 'POST',
        response: { ok: true, status: 200, json: () => ({ errors: [{ message: 'Validation failed' }] }), text: () => '' },
      },
    ]);

    const result = await checkBlockPrReadiness({ blockDefinitionPath: blockJsonPath, fetchFn: fakeFetch });
    assert.strictEqual(result.would_mark_ready, true);
    assert.strictEqual(result.marked_ready, false);
    assert.strictEqual(result.readiness, 'not_ready');
    assert.ok(result.blocking_issues.some((i) => i.includes('Failed to mark PR ready')), result.blocking_issues.join('; '));
  });

  it('missing node_id blocks mark-ready safely', async () => {
    await setupBlock();
    process.env.BLOCK_PR_READINESS_DRY_RUN = 'false';
    process.env.ALLOW_GITHUB_MARK_READY = 'true';

    const fakeFetch = createFakeFetch([
      {
        url: '/pulls/2',
        method: 'GET',
        response: { ok: true, status: 200, json: () => makePrResponse({ node_id: '' }), text: () => '' },
      },
      {
        url: '/check-runs',
        method: 'GET',
        response: { ok: true, status: 200, json: () => makeCheckRunsResponse(), text: () => '' },
      },
    ]);

    const result = await checkBlockPrReadiness({ blockDefinitionPath: blockJsonPath, fetchFn: fakeFetch });
    assert.strictEqual(result.readiness, 'not_ready');
    assert.strictEqual(result.would_mark_ready, true);
    assert.strictEqual(result.marked_ready, false);
    assert.ok(result.blocking_issues.some((i) => i.includes('node_id missing')), result.blocking_issues.join('; '));
  });

  it('GraphQL errors in response block mark-ready safely', async () => {
    await setupBlock();
    process.env.BLOCK_PR_READINESS_DRY_RUN = 'false';
    process.env.ALLOW_GITHUB_MARK_READY = 'true';

    const fakeFetch = createFakeFetch([
      {
        url: '/pulls/2',
        method: 'GET',
        response: { ok: true, status: 200, json: () => makePrResponse(), text: () => '' },
      },
      {
        url: '/check-runs',
        method: 'GET',
        response: { ok: true, status: 200, json: () => makeCheckRunsResponse(), text: () => '' },
      },
      {
        url: '/graphql',
        method: 'POST',
        response: { ok: true, status: 200, json: () => ({ errors: [{ message: 'Some GraphQL error' }] }), text: () => '' },
      },
    ]);

    const result = await checkBlockPrReadiness({ blockDefinitionPath: blockJsonPath, fetchFn: fakeFetch });
    assert.strictEqual(result.would_mark_ready, true);
    assert.strictEqual(result.marked_ready, false);
    assert.strictEqual(result.readiness, 'not_ready');
    assert.ok(result.blocking_issues.some((i) => i.includes('Failed to mark PR ready')), result.blocking_issues.join('; '));
  });

  it('mark-ready fake fetch mutation happens only with explicit gates', async () => {
    await setupBlock();
    process.env.BLOCK_PR_READINESS_DRY_RUN = 'false';
    delete process.env.ALLOW_GITHUB_MARK_READY;
    // GITHUB_TOKEN is set

    const fakeFetch = createFakeFetch([
      {
        url: '/pulls/2',
        method: 'GET',
        response: { ok: true, status: 200, json: () => makePrResponse(), text: () => '' },
      },
      {
        url: '/check-runs',
        method: 'GET',
        response: { ok: true, status: 200, json: () => makeCheckRunsResponse(), text: () => '' },
      },
    ]);

    const result = await checkBlockPrReadiness({ blockDefinitionPath: blockJsonPath, fetchFn: fakeFetch });
    assert.strictEqual(result.readiness, 'ready');
    assert.strictEqual(result.would_mark_ready, false);
    assert.strictEqual(result.marked_ready, false);
  });

  it('token-like values are redacted from report', async () => {
    await setupBlock();
    const tokenLike = 'github_pat_1234567890abcdef1234567890abcdef12345678';
    const fakeFetch = createFakeFetch([
      {
        url: '/pulls/2',
        method: 'GET',
        response: {
          ok: true,
          status: 200,
          json: () => makePrResponse({ html_url: `https://github.com/test-owner/test-repo/pull/2?token=${tokenLike}` }),
          text: () => '',
        },
      },
      {
        url: '/check-runs',
        method: 'GET',
        response: { ok: true, status: 200, json: () => makeCheckRunsResponse(), text: () => '' },
      },
    ]);

    const result = await checkBlockPrReadiness({ blockDefinitionPath: blockJsonPath, fetchFn: fakeFetch });
    const report = readFileSync(result.output_path, 'utf-8');
    assert.ok(!report.includes(tokenLike), 'token leaked in report');
    assert.ok(report.includes('[REDACTED]'), 'token was not redacted in report');
  });

  it('base branch mismatch blocks readiness', async () => {
    await setupBlock();
    const fakeFetch = createFakeFetch([
      {
        url: '/pulls/2',
        method: 'GET',
        response: { ok: true, status: 200, json: () => makePrResponse({ base: { ref: 'wrong-base' } }), text: () => '' },
      },
      {
        url: '/check-runs',
        method: 'GET',
        response: { ok: true, status: 200, json: () => makeCheckRunsResponse(), text: () => '' },
      },
    ]);

    const result = await checkBlockPrReadiness({ blockDefinitionPath: blockJsonPath, fetchFn: fakeFetch });
    assert.strictEqual(result.readiness, 'not_ready');
    assert.ok(result.blocking_issues.some((i) => i.includes('base branch mismatch')), result.blocking_issues.join('; '));
  });

  it('missing ALLOW_BLOCK_PR_READINESS blocks', async () => {
    await setupBlock();
    delete process.env.ALLOW_BLOCK_PR_READINESS;
    await assert.rejects(
      async () => {
        await checkBlockPrReadiness({ blockDefinitionPath: blockJsonPath });
      },
      /ALLOW_BLOCK_PR_READINESS/
    );
  });
});
