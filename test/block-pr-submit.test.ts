import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { writeFileSync, readFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { submitBlockPr } from '../src/block/block-pr-submit.js';
import { initBlockState, getBlockRunDir, saveBlockState } from '../src/block/block-state-manager.js';
import type { BlockDefinition, BlockState } from '../src/block/block-types.js';

function createTempRepoWithBareOrigin(workBranch: string): { repoPath: string; barePath: string } {
  const repoPath = join(tmpdir(), `repo-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const barePath = join(tmpdir(), `bare-${Date.now()}-${Math.random().toString(36).slice(2)}.git`);
  mkdirSync(repoPath, { recursive: true });
  mkdirSync(barePath, { recursive: true });

  spawnSync('git', ['init', '--bare'], { cwd: barePath, shell: false, encoding: 'utf-8' });
  spawnSync('git', ['init'], { cwd: repoPath, shell: false, encoding: 'utf-8' });
  spawnSync('git', ['config', 'user.email', 'test@test.com'], { cwd: repoPath, shell: false, encoding: 'utf-8' });
  spawnSync('git', ['config', 'user.name', 'Test'], { cwd: repoPath, shell: false, encoding: 'utf-8' });
  spawnSync('git', ['remote', 'add', 'origin', barePath], { cwd: repoPath, shell: false, encoding: 'utf-8' });
  writeFileSync(join(repoPath, 'readme.txt'), 'hello');
  spawnSync('git', ['add', 'readme.txt'], { cwd: repoPath, shell: false, encoding: 'utf-8' });
  spawnSync('git', ['commit', '-m', 'init', '--no-gpg-sign'], { cwd: repoPath, shell: false, encoding: 'utf-8' });
  spawnSync('git', ['checkout', '-b', workBranch], { cwd: repoPath, shell: false, encoding: 'utf-8' });
  spawnSync('git', ['push', '-u', 'origin', workBranch], { cwd: repoPath, shell: false, encoding: 'utf-8' });

  return { repoPath, barePath };
}

function createFakeFetch(scenarios: Array<{
  url: string;
  method: string;
  response: { ok: boolean; status: number; json: () => unknown; text: () => string };
}>): typeof fetch {
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

describe('block-pr-submit', () => {
  let blockJsonPath: string;
  let blockId: string;
  let repoPath: string;
  let barePath: string;

  const originalEnv = { ...process.env };

  beforeEach(() => {
    blockId = `pr-submit-${Date.now()}`;
    process.env.ALLOW_BLOCK_PR_SUBMIT = 'true';
    process.env.ALLOW_BLOCK_PR_CREATE = 'true';
    process.env.ALLOW_GITHUB_PR_CREATE = 'true';
    process.env.GITHUB_TOKEN = 'ghp_testtoken1234567890';
    process.env.GITHUB_REPOSITORY = 'test-owner/test-repo';
    process.env.BLOCK_PR_SUBMIT_DRY_RUN = 'true';
    delete process.env.ALLOW_BLOCK_PR_CREATE_DUPLICATE;
    delete process.env.BLOCK_PR_CREATE_DRY_RUN;
    delete process.env.ALLOW_GITHUB_PR_STATUS;
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
      if (existsSync(barePath)) {
        rmSync(barePath, { recursive: true, force: true });
      }
    } catch {
      // ignore
    }
  });

  function createDefinition(tasks: BlockDefinition['tasks']): BlockDefinition {
    return {
      block_id: blockId,
      title: 'PR Submit Test Block',
      repo_path: repoPath,
      base_branch: 'main',
      work_branch: 'feature/test',
      providers: {
        coder: { provider: 'fake', model: 'default' },
        reviewer: { provider: 'fake', model: 'default' },
      },
      review_policy: {
        require_deterministic_checks: true,
        max_fix_attempts: 3,
        reviewer_mode: 'single',
      },
      tasks,
    };
  }

  function setupBlock(def: BlockDefinition, state: BlockState) {
    blockJsonPath = join(tmpdir(), `${blockId}.json`);
    writeFileSync(blockJsonPath, JSON.stringify(def), 'utf-8');
    saveBlockState(state);
  }

  function completedState(): BlockState {
    return {
      block_id: blockId,
      title: 'PR Submit Test Block',
      base_branch: 'main',
      work_branch: 'feature/test',
      status: 'completed',
      current_task_id: null,
      tasks: [
        {
          task_id: 'task-1',
          status: 'accepted',
          commit_sha: 'a'.repeat(40),
          pushed_ref: 'origin/feature/test',
          reviewer_decision: 'accepted',
          reviewer_summary: 'Looks good',
          fix_attempts: 0,
          blocking_issues: [],
          check_failure_summary: '',
        },
      ],
      review_policy: {
        require_deterministic_checks: true,
        max_fix_attempts: 3,
        reviewer_mode: 'single',
      },
    };
  }

  it('dry-run default does not call GitHub API', async () => {
    const { repoPath: rp, barePath: bp } = createTempRepoWithBareOrigin('feature/test');
    repoPath = rp;
    barePath = bp;
    const def = createDefinition([
      { task_id: 'task-1', title: 'T1', goal: 'g', allowed_files: ['readme.txt'], denied_files: [], max_lines_changed: 100, checks: [] },
    ]);
    const state = completedState();
    setupBlock(def, state);

    let fetchCalled = false;
    const fakeFetch = createFakeFetch([]);
    const wrappedFetch = async (...args: Parameters<typeof fetch>) => {
      fetchCalled = true;
      return fakeFetch(...args);
    };

    const result = await submitBlockPr({ blockDefinitionPath: blockJsonPath, fetchFn: wrappedFetch });

    assert.strictEqual(result.dry_run, true);
    assert.strictEqual(result.pr_created, false);
    assert.strictEqual(fetchCalled, false);
    assert.ok(existsSync(result.output_path));
    assert.ok(result.safety_findings.some((f) => f.includes('Dry-run: PR create validation passed')));
  });

  it('missing ALLOW_BLOCK_PR_SUBMIT blocks command', async () => {
    delete process.env.ALLOW_BLOCK_PR_SUBMIT;
    const def = createDefinition([]);
    setupBlock(def, completedState());

    await assert.rejects(
      async () => submitBlockPr({ blockDefinitionPath: blockJsonPath }),
      /ALLOW_BLOCK_PR_SUBMIT=true is required/
    );
  });

  it('non-completed block blocks submission', async () => {
    const { repoPath: rp, barePath: bp } = createTempRepoWithBareOrigin('feature/test');
    repoPath = rp;
    barePath = bp;
    const def = createDefinition([
      { task_id: 'task-1', title: 'T1', goal: 'g', allowed_files: ['readme.txt'], denied_files: [], max_lines_changed: 100, checks: [] },
    ]);
    const state = completedState();
    state.status = 'fixing';
    setupBlock(def, state);

    await assert.rejects(
      async () => submitBlockPr({ blockDefinitionPath: blockJsonPath }),
      /Block status must be completed/
    );
  });

  it('main work branch blocks submission', async () => {
    const def = createDefinition([
      { task_id: 'task-1', title: 'T1', goal: 'g', allowed_files: ['readme.txt'], denied_files: [], max_lines_changed: 100, checks: [] },
    ]);
    def.work_branch = 'main';
    const state = completedState();
    state.work_branch = 'main';
    setupBlock(def, state);

    await assert.rejects(
      async () => submitBlockPr({ blockDefinitionPath: blockJsonPath }),
      /work_branch must not be "main"/
    );
  });

  it('real mode calls fake fetch exactly to create draft PR with draft true', async () => {
    const { repoPath: rp, barePath: bp } = createTempRepoWithBareOrigin('feature/test');
    repoPath = rp;
    barePath = bp;
    const def = createDefinition([
      { task_id: 'task-1', title: 'T1', goal: 'g', allowed_files: ['readme.txt'], denied_files: [], max_lines_changed: 100, checks: [] },
    ]);
    const state = completedState();
    setupBlock(def, state);

    process.env.BLOCK_PR_SUBMIT_DRY_RUN = 'false';
    process.env.ALLOW_BLOCK_PR_CREATE = 'true';
    process.env.ALLOW_GITHUB_PR_CREATE = 'true';

    let postCount = 0;
    const fakeFetch = createFakeFetch([
      {
        url: '/pulls?',
        method: 'GET',
        response: {
          ok: true,
          status: 200,
          json: () => [],
          text: () => '[]',
        },
      },
      {
        url: '/pulls',
        method: 'POST',
        response: {
          ok: true,
          status: 201,
          json: () => ({ number: 42, html_url: `https://github.com/test-owner/test-repo/pull/42` }),
          text: () => '',
        },
      },
    ]);
    const wrappedFetch = async (...args: Parameters<typeof fetch>) => {
      const init = args[1] as RequestInit | undefined;
      if (init?.method === 'POST') postCount++;
      return fakeFetch(...args);
    };

    const result = await submitBlockPr({ blockDefinitionPath: blockJsonPath, fetchFn: wrappedFetch });

    assert.strictEqual(result.dry_run, false);
    assert.strictEqual(result.pr_created, true);
    assert.strictEqual(result.pr_number, 42);
    assert.strictEqual(postCount, 1);
    assert.ok(result.pr_url?.includes('/pull/42'));
    assert.ok(existsSync(result.output_path));
  });

  it('real mode writes report with PR number/URL', async () => {
    const { repoPath: rp, barePath: bp } = createTempRepoWithBareOrigin('feature/test');
    repoPath = rp;
    barePath = bp;
    const def = createDefinition([
      { task_id: 'task-1', title: 'T1', goal: 'g', allowed_files: ['readme.txt'], denied_files: [], max_lines_changed: 100, checks: [] },
    ]);
    const state = completedState();
    setupBlock(def, state);

    process.env.BLOCK_PR_SUBMIT_DRY_RUN = 'false';

    const fakeFetch = createFakeFetch([
      {
        url: '/pulls?',
        method: 'GET',
        response: {
          ok: true,
          status: 200,
          json: () => [],
          text: () => '[]',
        },
      },
      {
        url: '/pulls',
        method: 'POST',
        response: {
          ok: true,
          status: 201,
          json: () => ({ number: 99, html_url: `https://github.com/test-owner/test-repo/pull/99` }),
          text: () => '',
        },
      },
    ]);

    const result = await submitBlockPr({ blockDefinitionPath: blockJsonPath, fetchFn: fakeFetch });

    assert.strictEqual(result.pr_created, true);
    assert.strictEqual(result.pr_number, 99);
    const report = readFileSync(result.output_path, 'utf-8');
    assert.ok(report.includes('99'));
    assert.ok(report.includes('PR URL:'));
    assert.ok(report.includes('Draft PR created'));
  });

  it('duplicate PR guard prevents second creation', async () => {
    const { repoPath: rp, barePath: bp } = createTempRepoWithBareOrigin('feature/test');
    repoPath = rp;
    barePath = bp;
    const def = createDefinition([
      { task_id: 'task-1', title: 'T1', goal: 'g', allowed_files: ['readme.txt'], denied_files: [], max_lines_changed: 100, checks: [] },
    ]);
    const state = completedState();
    setupBlock(def, state);

    process.env.BLOCK_PR_SUBMIT_DRY_RUN = 'false';

    const fakeFetch = createFakeFetch([
      {
        url: '/pulls?',
        method: 'GET',
        response: {
          ok: true,
          status: 200,
          json: () => [],
          text: () => '[]',
        },
      },
      {
        url: '/pulls',
        method: 'POST',
        response: {
          ok: true,
          status: 201,
          json: () => ({ number: 77, html_url: `https://github.com/test-owner/test-repo/pull/77` }),
          text: () => '',
        },
      },
    ]);

    const r1 = await submitBlockPr({ blockDefinitionPath: blockJsonPath, fetchFn: fakeFetch });
    assert.strictEqual(r1.pr_created, true);

    // Second attempt without duplicate override should fail
    await assert.rejects(
      async () => submitBlockPr({ blockDefinitionPath: blockJsonPath, fetchFn: fakeFetch }),
      /PR already created/
    );
  });

  it('token-like values are redacted from output/report', async () => {
    const { repoPath: rp, barePath: bp } = createTempRepoWithBareOrigin('feature/test');
    repoPath = rp;
    barePath = bp;
    const def = createDefinition([
      { task_id: 'task-1', title: 'T1', goal: 'g', allowed_files: ['readme.txt'], denied_files: [], max_lines_changed: 100, checks: [] },
    ]);
    const state = completedState();
    setupBlock(def, state);

    const result = await submitBlockPr({ blockDefinitionPath: blockJsonPath });

    const report = readFileSync(result.output_path, 'utf-8');
    assert.strictEqual(report.includes('ghp_testtoken'), false);
    assert.strictEqual(report.includes('GITHUB_TOKEN'), false);
    assert.strictEqual(report.includes('Bearer ghp_'), false);
  });

  it('existing open PR returns existing PR safely without duplicate error', async () => {
    const { repoPath: rp, barePath: bp } = createTempRepoWithBareOrigin('feature/test');
    repoPath = rp;
    barePath = bp;
    const def = createDefinition([
      { task_id: 'task-1', title: 'T1', goal: 'g', allowed_files: ['readme.txt'], denied_files: [], max_lines_changed: 100, checks: [] },
    ]);
    const state = completedState();
    setupBlock(def, state);

    process.env.BLOCK_PR_SUBMIT_DRY_RUN = 'false';

    const fakeFetch = createFakeFetch([
      {
        url: '/pulls?',
        method: 'GET',
        response: {
          ok: true,
          status: 200,
          json: () => [{ number: 55, html_url: 'https://github.com/test-owner/test-repo/pull/55' }],
          text: () => '[{"number":55}]',
        },
      },
    ]);

    const result = await submitBlockPr({ blockDefinitionPath: blockJsonPath, fetchFn: fakeFetch });

    assert.strictEqual(result.pr_created, false);
    assert.strictEqual(result.pr_number, 55);
    assert.ok(result.pr_url?.includes('/pull/55'));
  });

  it('no provider calls are made', async () => {
    const { repoPath: rp, barePath: bp } = createTempRepoWithBareOrigin('feature/test');
    repoPath = rp;
    barePath = bp;
    const def = createDefinition([
      { task_id: 'task-1', title: 'T1', goal: 'g', allowed_files: ['readme.txt'], denied_files: [], max_lines_changed: 100, checks: [] },
    ]);
    const state = completedState();
    setupBlock(def, state);

    // No AI provider env vars set; submit should not call any provider
    const result = await submitBlockPr({ blockDefinitionPath: blockJsonPath });
    assert.strictEqual(result.dry_run, true);
    assert.strictEqual(result.safety_findings.some((f) => f.includes('provider')), false);
  });
});
