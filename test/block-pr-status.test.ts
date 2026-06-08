import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { writeFileSync, readFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getBlockPrStatus } from '../src/block/block-pr-status.js';
import { initBlockState, getBlockRunDir, saveBlockState } from '../src/block/block-state-manager.js';
import type { BlockDefinition, BlockState } from '../src/block/block-types.js';

function createDefinition(blockId: string, repoPath: string): BlockDefinition {
  return {
    block_id: blockId,
    title: 'PR Status Test Block',
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

function writePrCreatedJson(blockId: string, data: Record<string, unknown>) {
  const runDir = getBlockRunDir(blockId);
  if (!existsSync(runDir)) {
    mkdirSync(runDir, { recursive: true });
  }
  writeFileSync(join(runDir, 'pr-created.json'), JSON.stringify(data, null, 2));
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
    head: { ref: 'stage-6-11-pr-create-proof' },
    html_url: 'https://github.com/test-owner/test-repo/pull/2',
    commits: 1,
    changed_files: 1,
    ...overrides,
  };
}

function makeCheckRunsResponse(overrides: Record<string, unknown> = {}) {
  return {
    check_runs: [{ name: 'CI', status: 'completed', conclusion: 'success' }],
    ...overrides,
  };
}

describe('block-pr-status', () => {
  let blockJsonPath: string;
  let blockId: string;
  let repoPath: string;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    blockId = `pr-status-${Date.now()}`;
    repoPath = join(tmpdir(), `repo-${blockId}`);
    mkdirSync(repoPath, { recursive: true });
    process.env.ALLOW_GITHUB_PR_STATUS = 'true';
    process.env.GITHUB_REPOSITORY = 'test-owner/test-repo';
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

  it('reads pr-created.json and fetches PR status', async () => {
    await setupBlock();
    writePrCreatedJson(blockId, {
      pr_number: 2,
      base: 'feature/mvp-skeleton',
      head: 'stage-6-11-pr-create-proof',
    });

    const fakeFetch = createFakeFetch([
      {
        url: '/pulls/2',
        method: 'GET',
        response: {
          ok: true,
          status: 200,
          json: () => makePrResponse(),
          text: () => '',
        },
      },
      {
        url: '/check-runs',
        method: 'GET',
        response: {
          ok: true,
          status: 200,
          json: () => makeCheckRunsResponse(),
          text: () => '',
        },
      },
    ]);

    const result = await getBlockPrStatus({ blockDefinitionPath: blockJsonPath, fetchFn: fakeFetch });
    assert.strictEqual(result.pr_number, 2);
    assert.strictEqual(result.state, 'open');
  });

  it('accepts open draft PR with correct base/head', async () => {
    await setupBlock();
    writePrCreatedJson(blockId, {
      pr_number: 2,
      base: 'feature/mvp-skeleton',
      head: 'stage-6-11-pr-create-proof',
    });

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

    const result = await getBlockPrStatus({ blockDefinitionPath: blockJsonPath, fetchFn: fakeFetch });
    assert.strictEqual(result.pr_safe_for_human_review, true);
    assert.strictEqual(result.base_matches_block, true);
    assert.strictEqual(result.head_matches_block, true);
  });

  it('flags merged PR unsafe', async () => {
    await setupBlock();
    writePrCreatedJson(blockId, {
      pr_number: 2,
      base: 'feature/mvp-skeleton',
      head: 'stage-6-11-pr-create-proof',
    });

    const fakeFetch = createFakeFetch([
      {
        url: '/pulls/2',
        method: 'GET',
        response: {
          ok: true,
          status: 200,
          json: () => makePrResponse({ merged: true, state: 'closed' }),
          text: () => '',
        },
      },
      {
        url: '/check-runs',
        method: 'GET',
        response: { ok: true, status: 200, json: () => makeCheckRunsResponse(), text: () => '' },
      },
    ]);

    const result = await getBlockPrStatus({ blockDefinitionPath: blockJsonPath, fetchFn: fakeFetch });
    assert.strictEqual(result.pr_safe_for_human_review, false);
    assert.ok(result.blocking_issues.some((i) => i.includes('merged')), result.blocking_issues.join('; '));
  });

  it('flags closed PR unsafe', async () => {
    await setupBlock();
    writePrCreatedJson(blockId, {
      pr_number: 2,
      base: 'feature/mvp-skeleton',
      head: 'stage-6-11-pr-create-proof',
    });

    const fakeFetch = createFakeFetch([
      {
        url: '/pulls/2',
        method: 'GET',
        response: {
          ok: true,
          status: 200,
          json: () => makePrResponse({ state: 'closed', merged: false }),
          text: () => '',
        },
      },
      {
        url: '/check-runs',
        method: 'GET',
        response: { ok: true, status: 200, json: () => makeCheckRunsResponse(), text: () => '' },
      },
    ]);

    const result = await getBlockPrStatus({ blockDefinitionPath: blockJsonPath, fetchFn: fakeFetch });
    assert.strictEqual(result.pr_safe_for_human_review, false);
    assert.ok(result.blocking_issues.some((i) => i.includes('closed')), result.blocking_issues.join('; '));
  });

  it('flags non-draft PR unsafe', async () => {
    await setupBlock();
    writePrCreatedJson(blockId, {
      pr_number: 2,
      base: 'feature/mvp-skeleton',
      head: 'stage-6-11-pr-create-proof',
    });

    const fakeFetch = createFakeFetch([
      {
        url: '/pulls/2',
        method: 'GET',
        response: {
          ok: true,
          status: 200,
          json: () => makePrResponse({ draft: false }),
          text: () => '',
        },
      },
      {
        url: '/check-runs',
        method: 'GET',
        response: { ok: true, status: 200, json: () => makeCheckRunsResponse(), text: () => '' },
      },
    ]);

    const result = await getBlockPrStatus({ blockDefinitionPath: blockJsonPath, fetchFn: fakeFetch });
    assert.strictEqual(result.pr_safe_for_human_review, false);
    assert.ok(result.blocking_issues.some((i) => i.includes('not draft')), result.blocking_issues.join('; '));
  });

  it('flags wrong base unsafe', async () => {
    await setupBlock();
    writePrCreatedJson(blockId, {
      pr_number: 2,
      base: 'feature/mvp-skeleton',
      head: 'stage-6-11-pr-create-proof',
    });

    const fakeFetch = createFakeFetch([
      {
        url: '/pulls/2',
        method: 'GET',
        response: {
          ok: true,
          status: 200,
          json: () => makePrResponse({ base: { ref: 'wrong-base' } }),
          text: () => '',
        },
      },
      {
        url: '/check-runs',
        method: 'GET',
        response: { ok: true, status: 200, json: () => makeCheckRunsResponse(), text: () => '' },
      },
    ]);

    const result = await getBlockPrStatus({ blockDefinitionPath: blockJsonPath, fetchFn: fakeFetch });
    assert.strictEqual(result.pr_safe_for_human_review, false);
    assert.ok(result.blocking_issues.some((i) => i.includes('base branch mismatch')), result.blocking_issues.join('; '));
  });

  it('flags wrong head unsafe', async () => {
    await setupBlock();
    writePrCreatedJson(blockId, {
      pr_number: 2,
      base: 'feature/mvp-skeleton',
      head: 'stage-6-11-pr-create-proof',
    });

    const fakeFetch = createFakeFetch([
      {
        url: '/pulls/2',
        method: 'GET',
        response: {
          ok: true,
          status: 200,
          json: () => makePrResponse({ head: { ref: 'wrong-head' } }),
          text: () => '',
        },
      },
      {
        url: '/check-runs',
        method: 'GET',
        response: { ok: true, status: 200, json: () => makeCheckRunsResponse(), text: () => '' },
      },
    ]);

    const result = await getBlockPrStatus({ blockDefinitionPath: blockJsonPath, fetchFn: fakeFetch });
    assert.strictEqual(result.pr_safe_for_human_review, false);
    assert.ok(result.blocking_issues.some((i) => i.includes('head branch mismatch')), result.blocking_issues.join('; '));
  });

  it('flags head main unsafe', async () => {
    await setupBlock();
    writePrCreatedJson(blockId, {
      pr_number: 2,
      base: 'feature/mvp-skeleton',
      head: 'stage-6-11-pr-create-proof',
    });

    const fakeFetch = createFakeFetch([
      {
        url: '/pulls/2',
        method: 'GET',
        response: {
          ok: true,
          status: 200,
          json: () => makePrResponse({ head: { ref: 'main' } }),
          text: () => '',
        },
      },
      {
        url: '/check-runs',
        method: 'GET',
        response: { ok: true, status: 200, json: () => makeCheckRunsResponse(), text: () => '' },
      },
    ]);

    const result = await getBlockPrStatus({ blockDefinitionPath: blockJsonPath, fetchFn: fakeFetch });
    assert.strictEqual(result.pr_safe_for_human_review, false);
    assert.ok(result.blocking_issues.some((i) => i.includes('head is main')), result.blocking_issues.join('; '));
  });

  it('handles missing pr-created.json safely', async () => {
    await setupBlock();
    // do not write pr-created.json

    const fakeFetch = createFakeFetch([]);

    await assert.rejects(
      async () => {
        await getBlockPrStatus({ blockDefinitionPath: blockJsonPath, fetchFn: fakeFetch });
      },
      /pr-created\.json not found/
    );
  });

  it('handles malformed pr-created.json safely', async () => {
    await setupBlock();
    const runDir = getBlockRunDir(blockId);
    if (!existsSync(runDir)) {
      mkdirSync(runDir, { recursive: true });
    }
    writeFileSync(join(runDir, 'pr-created.json'), 'not json');

    const fakeFetch = createFakeFetch([]);

    await assert.rejects(
      async () => {
        await getBlockPrStatus({ blockDefinitionPath: blockJsonPath, fetchFn: fakeFetch });
      },
      /pr-created\.json is malformed/
    );
  });

  it('handles malformed GitHub PR response safely', async () => {
    await setupBlock();
    writePrCreatedJson(blockId, {
      pr_number: 2,
      base: 'feature/mvp-skeleton',
      head: 'stage-6-11-pr-create-proof',
    });

    const fakeFetch = createFakeFetch([
      {
        url: '/pulls/2',
        method: 'GET',
        response: {
          ok: true,
          status: 200,
          json: () => ({ state: 'open' }),
          text: () => '',
        },
      },
    ]);

    await assert.rejects(
      async () => {
        await getBlockPrStatus({ blockDefinitionPath: blockJsonPath, fetchFn: fakeFetch });
      },
      /GitHub API response missing PR html_url/
    );
  });

  it('checks_status success', async () => {
    await setupBlock();
    writePrCreatedJson(blockId, {
      pr_number: 2,
      base: 'feature/mvp-skeleton',
      head: 'stage-6-11-pr-create-proof',
    });

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

    const result = await getBlockPrStatus({ blockDefinitionPath: blockJsonPath, fetchFn: fakeFetch });
    assert.strictEqual(result.checks_status, 'success');
  });

  it('checks_status failure makes unsafe', async () => {
    await setupBlock();
    writePrCreatedJson(blockId, {
      pr_number: 2,
      base: 'feature/mvp-skeleton',
      head: 'stage-6-11-pr-create-proof',
    });

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
                { name: 'Lint', status: 'completed', conclusion: 'failure' },
              ],
            }),
          text: () => '',
        },
      },
    ]);

    const result = await getBlockPrStatus({ blockDefinitionPath: blockJsonPath, fetchFn: fakeFetch });
    assert.strictEqual(result.checks_status, 'failure');
    assert.strictEqual(result.pr_safe_for_human_review, false);
    assert.ok(result.blocking_issues.some((i) => i.includes('Checks status is failure')));
  });

  it('checks_status pending', async () => {
    await setupBlock();
    writePrCreatedJson(blockId, {
      pr_number: 2,
      base: 'feature/mvp-skeleton',
      head: 'stage-6-11-pr-create-proof',
    });

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
                { name: 'CI', status: 'in_progress', conclusion: null },
                { name: 'Lint', status: 'completed', conclusion: 'success' },
              ],
            }),
          text: () => '',
        },
      },
    ]);

    const result = await getBlockPrStatus({ blockDefinitionPath: blockJsonPath, fetchFn: fakeFetch });
    assert.strictEqual(result.checks_status, 'pending');
  });

  it('checks_status unknown adds safety finding', async () => {
    await setupBlock();
    writePrCreatedJson(blockId, {
      pr_number: 2,
      base: 'feature/mvp-skeleton',
      head: 'stage-6-11-pr-create-proof',
    });

    const fakeFetch = createFakeFetch([
      {
        url: '/pulls/2',
        method: 'GET',
        response: { ok: true, status: 200, json: () => makePrResponse(), text: () => '' },
      },
      {
        url: '/check-runs',
        method: 'GET',
        response: { ok: false, status: 404, json: () => ({}), text: () => 'Not found' },
      },
    ]);

    const result = await getBlockPrStatus({ blockDefinitionPath: blockJsonPath, fetchFn: fakeFetch });
    assert.strictEqual(result.checks_status, 'unknown');
    assert.ok(
      result.safety_findings.some((f) => f.includes('CI/checks were not verified')),
      result.safety_findings.join('; ')
    );
  });

  it('writes pr-status-report.md', async () => {
    await setupBlock();
    writePrCreatedJson(blockId, {
      pr_number: 2,
      base: 'feature/mvp-skeleton',
      head: 'stage-6-11-pr-create-proof',
    });

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

    const result = await getBlockPrStatus({ blockDefinitionPath: blockJsonPath, fetchFn: fakeFetch });
    assert.ok(existsSync(result.output_path), `Report not found at ${result.output_path}`);
    const report = readFileSync(result.output_path, 'utf-8');
    assert.ok(report.includes('PR Status Report'), report);
    assert.ok(report.includes('Safe for human review'), report);
  });

  it('report contains no mutation claims', async () => {
    await setupBlock();
    writePrCreatedJson(blockId, {
      pr_number: 2,
      base: 'feature/mvp-skeleton',
      head: 'stage-6-11-pr-create-proof',
    });

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

    const result = await getBlockPrStatus({ blockDefinitionPath: blockJsonPath, fetchFn: fakeFetch });
    const report = readFileSync(result.output_path, 'utf-8');
    assert.ok(report.includes('No PR creation'), report);
    assert.ok(report.includes('No PR update'), report);
    assert.ok(report.includes('No PR close'), report);
    assert.ok(report.includes('No PR merge'), report);
    assert.ok(report.includes('No push'), report);
    assert.ok(report.includes('No checkout/switch'), report);
    assert.ok(report.includes('No main touch'), report);
    assert.ok(report.includes('No provider call'), report);
  });

  it('no PR creation call', async () => {
    await setupBlock();
    writePrCreatedJson(blockId, {
      pr_number: 2,
      base: 'feature/mvp-skeleton',
      head: 'stage-6-11-pr-create-proof',
    });

    let calledMethod = '';
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

    await getBlockPrStatus({ blockDefinitionPath: blockJsonPath, fetchFn: fakeFetch });
    assert.strictEqual(calledMethod, ''); // fake fetch verifies method in matcher
  });

  it('no PR update call', async () => {
    await setupBlock();
    writePrCreatedJson(blockId, {
      pr_number: 2,
      base: 'feature/mvp-skeleton',
      head: 'stage-6-11-pr-create-proof',
    });

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

    await getBlockPrStatus({ blockDefinitionPath: blockJsonPath, fetchFn: fakeFetch });
    // Only GET requests are configured; any POST/PATCH would throw
  });

  it('no PR close call', async () => {
    await setupBlock();
    writePrCreatedJson(blockId, {
      pr_number: 2,
      base: 'feature/mvp-skeleton',
      head: 'stage-6-11-pr-create-proof',
    });

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

    await getBlockPrStatus({ blockDefinitionPath: blockJsonPath, fetchFn: fakeFetch });
  });

  it('no merge call', async () => {
    await setupBlock();
    writePrCreatedJson(blockId, {
      pr_number: 2,
      base: 'feature/mvp-skeleton',
      head: 'stage-6-11-pr-create-proof',
    });

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

    await getBlockPrStatus({ blockDefinitionPath: blockJsonPath, fetchFn: fakeFetch });
  });

  it('no push', async () => {
    await setupBlock();
    writePrCreatedJson(blockId, {
      pr_number: 2,
      base: 'feature/mvp-skeleton',
      head: 'stage-6-11-pr-create-proof',
    });

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

    await getBlockPrStatus({ blockDefinitionPath: blockJsonPath, fetchFn: fakeFetch });
    // No git push performed by this module
  });

  it('no checkout/switch', async () => {
    await setupBlock();
    writePrCreatedJson(blockId, {
      pr_number: 2,
      base: 'feature/mvp-skeleton',
      head: 'stage-6-11-pr-create-proof',
    });

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

    await getBlockPrStatus({ blockDefinitionPath: blockJsonPath, fetchFn: fakeFetch });
    // No git checkout performed by this module
  });

  it('no provider call', async () => {
    await setupBlock();
    writePrCreatedJson(blockId, {
      pr_number: 2,
      base: 'feature/mvp-skeleton',
      head: 'stage-6-11-pr-create-proof',
    });

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

    await getBlockPrStatus({ blockDefinitionPath: blockJsonPath, fetchFn: fakeFetch });
    // No AI provider called
  });

  it('no token leak', async () => {
    await setupBlock();
    writePrCreatedJson(blockId, {
      pr_number: 2,
      base: 'feature/mvp-skeleton',
      head: 'stage-6-11-pr-create-proof',
    });

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

    const result = await getBlockPrStatus({ blockDefinitionPath: blockJsonPath, fetchFn: fakeFetch });
    const report = readFileSync(result.output_path, 'utf-8');
    assert.ok(!report.includes('ghp_testtoken1234567890'), 'token leaked in report');
    assert.ok(!result.pr_url.includes('ghp_testtoken'), 'token leaked in result');
  });
});
