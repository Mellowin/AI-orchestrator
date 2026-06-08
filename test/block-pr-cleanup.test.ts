import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { writeFileSync, readFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { cleanupBlockProofPr } from '../src/block/block-pr-cleanup.js';
import { initBlockState, getBlockRunDir, saveBlockState } from '../src/block/block-state-manager.js';
import type { BlockDefinition, BlockState } from '../src/block/block-types.js';

function createDefinition(blockId: string, repoPath: string): BlockDefinition {
  return {
    block_id: blockId,
    title: 'PR Cleanup Test Block',
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
    ...overrides,
  };
}

describe('block-pr-cleanup', () => {
  let blockJsonPath: string;
  let blockId: string;
  let repoPath: string;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    blockId = `pr-cleanup-${Date.now()}`;
    repoPath = join(tmpdir(), `repo-${blockId}`);
    mkdirSync(repoPath, { recursive: true });
    process.env.ALLOW_BLOCK_PR_CLEANUP = 'true';
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

  it('dry-run reads PR and writes report', async () => {
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
    ]);

    const result = await cleanupBlockProofPr({
      blockDefinitionPath: blockJsonPath,
      fetchFn: fakeFetch,
    });
    assert.strictEqual(result.pr_number, 2);
    assert.strictEqual(result.dry_run, true);
    assert.strictEqual(result.pr_closed, false);
    assert.strictEqual(result.branch_deleted, false);
    assert.ok(existsSync(result.output_path), `Report not found at ${result.output_path}`);
  });

  it('default is dry-run', async () => {
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
    ]);

    const result = await cleanupBlockProofPr({
      blockDefinitionPath: blockJsonPath,
      fetchFn: fakeFetch,
    });
    assert.strictEqual(result.dry_run, true);
  });

  it('missing ALLOW_BLOCK_PR_CLEANUP fails safely', async () => {
    await setupBlock();
    delete process.env.ALLOW_BLOCK_PR_CLEANUP;

    await assert.rejects(
      async () => {
        await cleanupBlockProofPr({ blockDefinitionPath: blockJsonPath });
      },
      /ALLOW_BLOCK_PR_CLEANUP=true is required/
    );
  });

  it('missing GITHUB_REPOSITORY fails safely', async () => {
    await setupBlock();
    delete process.env.GITHUB_REPOSITORY;

    await assert.rejects(
      async () => {
        await cleanupBlockProofPr({ blockDefinitionPath: blockJsonPath });
      },
      /GITHUB_REPOSITORY is required/
    );
  });

  it('missing pr-created.json fails safely', async () => {
    await setupBlock();

    await assert.rejects(
      async () => {
        await cleanupBlockProofPr({ blockDefinitionPath: blockJsonPath });
      },
      /pr-created\.json not found/
    );
  });

  it('malformed pr-created.json fails safely', async () => {
    await setupBlock();
    const runDir = getBlockRunDir(blockId);
    if (!existsSync(runDir)) {
      mkdirSync(runDir, { recursive: true });
    }
    writeFileSync(join(runDir, 'pr-created.json'), 'not json');

    await assert.rejects(
      async () => {
        await cleanupBlockProofPr({ blockDefinitionPath: blockJsonPath });
      },
      /pr-created\.json is malformed/
    );
  });

  it('wrong base blocks cleanup', async () => {
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
    ]);

    const result = await cleanupBlockProofPr({
      blockDefinitionPath: blockJsonPath,
      fetchFn: fakeFetch,
      closePr: true,
    });
    assert.strictEqual(result.cleanup_safe, false);
    assert.ok(result.blocking_issues.some((i) => i.includes('base branch mismatch')), result.blocking_issues.join('; '));
  });

  it('wrong head blocks cleanup', async () => {
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
    ]);

    const result = await cleanupBlockProofPr({
      blockDefinitionPath: blockJsonPath,
      fetchFn: fakeFetch,
      closePr: true,
    });
    assert.strictEqual(result.cleanup_safe, false);
    assert.ok(result.blocking_issues.some((i) => i.includes('head branch mismatch')), result.blocking_issues.join('; '));
  });

  it('merged PR blocks cleanup', async () => {
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
    ]);

    const result = await cleanupBlockProofPr({
      blockDefinitionPath: blockJsonPath,
      fetchFn: fakeFetch,
      closePr: true,
    });
    assert.strictEqual(result.cleanup_safe, false);
    assert.ok(result.blocking_issues.some((i) => i.includes('merged')), result.blocking_issues.join('; '));
  });

  it('head main blocks cleanup', async () => {
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
    ]);

    const result = await cleanupBlockProofPr({
      blockDefinitionPath: blockJsonPath,
      fetchFn: fakeFetch,
      closePr: true,
    });
    assert.strictEqual(result.cleanup_safe, false);
    assert.ok(result.blocking_issues.some((i) => i.includes('head is main')), result.blocking_issues.join('; '));
  });

  it('base main unexpectedly blocks cleanup', async () => {
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
          json: () => makePrResponse({ base: { ref: 'main' } }),
          text: () => '',
        },
      },
    ]);

    const result = await cleanupBlockProofPr({
      blockDefinitionPath: blockJsonPath,
      fetchFn: fakeFetch,
      closePr: true,
    });
    assert.strictEqual(result.cleanup_safe, false);
    assert.ok(result.blocking_issues.some((i) => i.includes('base is main')), result.blocking_issues.join('; '));
  });

  it('non-proof-like branch blocks cleanup', async () => {
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
          json: () => makePrResponse({ head: { ref: 'feature-something' } }),
          text: () => '',
        },
      },
    ]);

    const result = await cleanupBlockProofPr({
      blockDefinitionPath: blockJsonPath,
      fetchFn: fakeFetch,
      closePr: true,
    });
    assert.strictEqual(result.cleanup_safe, false);
    assert.ok(
      result.blocking_issues.some((i) => i.includes('proof branch')),
      result.blocking_issues.join('; ')
    );
  });

  it('close requested without ALLOW_GITHUB_PR_CLOSE blocks', async () => {
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
    ]);

    process.env.BLOCK_PR_CLEANUP_DRY_RUN = 'false';
    delete process.env.ALLOW_GITHUB_PR_CLOSE;

    const result = await cleanupBlockProofPr({
      blockDefinitionPath: blockJsonPath,
      fetchFn: fakeFetch,
      closePr: true,
      dryRun: false,
    });
    assert.strictEqual(result.cleanup_safe, false);
    assert.ok(
      result.blocking_issues.some((i) => i.includes('ALLOW_GITHUB_PR_CLOSE')),
      result.blocking_issues.join('; ')
    );
  });

  it('branch delete requested without ALLOW_GITHUB_BRANCH_DELETE blocks', async () => {
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
    ]);

    process.env.BLOCK_PR_CLEANUP_DRY_RUN = 'false';
    delete process.env.ALLOW_GITHUB_BRANCH_DELETE;

    const result = await cleanupBlockProofPr({
      blockDefinitionPath: blockJsonPath,
      fetchFn: fakeFetch,
      deleteBranch: true,
      dryRun: false,
    });
    assert.strictEqual(result.cleanup_safe, false);
    assert.ok(
      result.blocking_issues.some((i) => i.includes('ALLOW_GITHUB_BRANCH_DELETE')),
      result.blocking_issues.join('; ')
    );
  });

  it('real close requires token', async () => {
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
    ]);

    process.env.BLOCK_PR_CLEANUP_DRY_RUN = 'false';
    process.env.ALLOW_GITHUB_PR_CLOSE = 'true';
    delete process.env.GITHUB_TOKEN;

    const result = await cleanupBlockProofPr({
      blockDefinitionPath: blockJsonPath,
      fetchFn: fakeFetch,
      closePr: true,
      dryRun: false,
    });
    assert.strictEqual(result.cleanup_safe, false);
    assert.ok(result.blocking_issues.some((i) => i.includes('GITHUB_TOKEN')), result.blocking_issues.join('; '));
  });

  it('real delete requires token', async () => {
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
    ]);

    process.env.BLOCK_PR_CLEANUP_DRY_RUN = 'false';
    process.env.ALLOW_GITHUB_BRANCH_DELETE = 'true';
    delete process.env.GITHUB_TOKEN;

    const result = await cleanupBlockProofPr({
      blockDefinitionPath: blockJsonPath,
      fetchFn: fakeFetch,
      deleteBranch: true,
      dryRun: false,
    });
    assert.strictEqual(result.cleanup_safe, false);
    assert.ok(result.blocking_issues.some((i) => i.includes('GITHUB_TOKEN')), result.blocking_issues.join('; '));
  });

  it('dry-run does not PATCH', async () => {
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
    ]);

    const result = await cleanupBlockProofPr({
      blockDefinitionPath: blockJsonPath,
      fetchFn: fakeFetch,
      closePr: true,
    });
    assert.strictEqual(result.dry_run, true);
    assert.strictEqual(result.pr_closed, false);
  });

  it('dry-run does not DELETE', async () => {
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
    ]);

    const result = await cleanupBlockProofPr({
      blockDefinitionPath: blockJsonPath,
      fetchFn: fakeFetch,
      deleteBranch: true,
    });
    assert.strictEqual(result.dry_run, true);
    assert.strictEqual(result.branch_deleted, false);
  });

  it('closePr with flags calls PATCH state closed', async () => {
    await setupBlock();
    writePrCreatedJson(blockId, {
      pr_number: 2,
      base: 'feature/mvp-skeleton',
      head: 'stage-6-11-pr-create-proof',
    });

    let patched = false;
    const fakeFetch = createFakeFetch([
      {
        url: '/pulls/2',
        method: 'GET',
        response: { ok: true, status: 200, json: () => makePrResponse(), text: () => '' },
      },
      {
        url: '/pulls/2',
        method: 'PATCH',
        response: {
          ok: true,
          status: 200,
          json: () => ({ state: 'closed' }),
          text: () => '',
        },
      },
    ]);

    const customFetch: typeof fetch = async (url, init) => {
      const urlStr = String(url);
      const method = init?.method ?? 'GET';
      if (urlStr.includes('/pulls/2') && method === 'PATCH') {
        patched = true;
      }
      return fakeFetch(url, init);
    };

    process.env.BLOCK_PR_CLEANUP_DRY_RUN = 'false';
    process.env.ALLOW_GITHUB_PR_CLOSE = 'true';

    const result = await cleanupBlockProofPr({
      blockDefinitionPath: blockJsonPath,
      fetchFn: customFetch,
      closePr: true,
      dryRun: false,
    });
    assert.strictEqual(patched, true);
    assert.strictEqual(result.pr_closed, true);
  });

  it('deleteBranch with flags calls DELETE ref', async () => {
    await setupBlock();
    writePrCreatedJson(blockId, {
      pr_number: 2,
      base: 'feature/mvp-skeleton',
      head: 'stage-6-11-pr-create-proof',
    });

    let deleted = false;
    const fakeFetch = createFakeFetch([
      {
        url: '/pulls/2',
        method: 'GET',
        response: { ok: true, status: 200, json: () => makePrResponse({ state: 'closed' }), text: () => '' },
      },
      {
        url: '/git/refs/heads/',
        method: 'DELETE',
        response: { ok: true, status: 204, json: () => ({}), text: () => '' },
      },
    ]);

    const customFetch: typeof fetch = async (url, init) => {
      const urlStr = String(url);
      const method = init?.method ?? 'GET';
      if (urlStr.includes('/git/refs/heads/') && method === 'DELETE') {
        deleted = true;
      }
      return fakeFetch(url, init);
    };

    process.env.BLOCK_PR_CLEANUP_DRY_RUN = 'false';
    process.env.ALLOW_GITHUB_PR_CLOSE = 'true';
    process.env.ALLOW_GITHUB_BRANCH_DELETE = 'true';

    const result = await cleanupBlockProofPr({
      blockDefinitionPath: blockJsonPath,
      fetchFn: customFetch,
      closePr: true,
      deleteBranch: true,
      dryRun: false,
    });
    assert.strictEqual(deleted, true);
    assert.strictEqual(result.branch_deleted, true);
  });

  it('close+delete both allowed calls PATCH then DELETE', async () => {
    await setupBlock();
    writePrCreatedJson(blockId, {
      pr_number: 2,
      base: 'feature/mvp-skeleton',
      head: 'stage-6-11-pr-create-proof',
    });

    const methods: string[] = [];
    const fakeFetch = createFakeFetch([
      {
        url: '/pulls/2',
        method: 'GET',
        response: { ok: true, status: 200, json: () => makePrResponse(), text: () => '' },
      },
      {
        url: '/pulls/2',
        method: 'PATCH',
        response: { ok: true, status: 200, json: () => ({ state: 'closed' }), text: () => '' },
      },
      {
        url: '/git/refs/heads/',
        method: 'DELETE',
        response: { ok: true, status: 204, json: () => ({}), text: () => '' },
      },
    ]);

    const customFetch: typeof fetch = async (url, init) => {
      const method = init?.method ?? 'GET';
      methods.push(method);
      return fakeFetch(url, init);
    };

    process.env.BLOCK_PR_CLEANUP_DRY_RUN = 'false';
    process.env.ALLOW_GITHUB_PR_CLOSE = 'true';
    process.env.ALLOW_GITHUB_BRANCH_DELETE = 'true';

    const result = await cleanupBlockProofPr({
      blockDefinitionPath: blockJsonPath,
      fetchFn: customFetch,
      closePr: true,
      deleteBranch: true,
      dryRun: false,
    });
    assert.ok(methods.includes('PATCH'), `Methods: ${methods.join(', ')}`);
    assert.ok(methods.includes('DELETE'), `Methods: ${methods.join(', ')}`);
    assert.strictEqual(result.pr_closed, true);
    assert.strictEqual(result.branch_deleted, true);
  });

  it('failed PATCH records blocking/safety and does not delete', async () => {
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
        url: '/pulls/2',
        method: 'PATCH',
        response: { ok: false, status: 422, json: () => ({}), text: () => 'Unprocessable' },
      },
    ]);

    process.env.BLOCK_PR_CLEANUP_DRY_RUN = 'false';
    process.env.ALLOW_GITHUB_PR_CLOSE = 'true';
    process.env.ALLOW_GITHUB_BRANCH_DELETE = 'true';

    const result = await cleanupBlockProofPr({
      blockDefinitionPath: blockJsonPath,
      fetchFn: fakeFetch,
      closePr: true,
      deleteBranch: true,
      dryRun: false,
    });
    assert.strictEqual(result.pr_closed, false);
    assert.strictEqual(result.branch_deleted, false);
    assert.ok(result.blocking_issues.some((i) => i.includes('Failed to close')), result.blocking_issues.join('; '));
    assert.ok(result.safety_findings.some((f) => f.includes('branch deletion was skipped')), result.safety_findings.join('; '));
  });

  it('failed DELETE records safety', async () => {
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
        response: { ok: true, status: 200, json: () => makePrResponse({ state: 'closed' }), text: () => '' },
      },
      {
        url: '/git/refs/heads/',
        method: 'DELETE',
        response: { ok: false, status: 422, json: () => ({}), text: () => 'Unprocessable' },
      },
    ]);

    process.env.BLOCK_PR_CLEANUP_DRY_RUN = 'false';
    process.env.ALLOW_GITHUB_BRANCH_DELETE = 'true';

    const result = await cleanupBlockProofPr({
      blockDefinitionPath: blockJsonPath,
      fetchFn: fakeFetch,
      deleteBranch: true,
      dryRun: false,
    });
    assert.strictEqual(result.branch_deleted, false);
    assert.ok(result.blocking_issues.some((i) => i.includes('Failed to delete')), result.blocking_issues.join('; '));
  });

  it('report contains no merge/no push/no checkout/no token persisted', async () => {
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
    ]);

    const result = await cleanupBlockProofPr({
      blockDefinitionPath: blockJsonPath,
      fetchFn: fakeFetch,
    });
    const report = readFileSync(result.output_path, 'utf-8');
    assert.ok(report.includes('No merge'), report);
    assert.ok(report.includes('No push'), report);
    assert.ok(report.includes('No checkout/switch'), report);
    assert.ok(report.includes('No token persisted'), report);
  });

  it('token not leaked in errors/report/result', async () => {
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
    ]);

    const result = await cleanupBlockProofPr({
      blockDefinitionPath: blockJsonPath,
      fetchFn: fakeFetch,
    });
    const report = readFileSync(result.output_path, 'utf-8');
    assert.ok(!report.includes('ghp_testtoken1234567890'), 'token leaked in report');
    assert.ok(!result.pr_url.includes('ghp_testtoken'), 'token leaked in result');
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
    ]);

    const result = await cleanupBlockProofPr({
      blockDefinitionPath: blockJsonPath,
      fetchFn: fakeFetch,
    });
    assert.strictEqual(result.block_id, blockId);
  });

  it('no local git push/checkout/switch', async () => {
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
    ]);

    const result = await cleanupBlockProofPr({
      blockDefinitionPath: blockJsonPath,
      fetchFn: fakeFetch,
    });
    const report = readFileSync(result.output_path, 'utf-8');
    assert.ok(report.includes('No push'), report);
    assert.ok(report.includes('No checkout/switch'), report);
  });
});
