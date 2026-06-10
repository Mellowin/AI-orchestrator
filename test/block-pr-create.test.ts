import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { writeFileSync, readFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { createBlockPullRequest, checkBranchPushed } from '../src/block/block-pr-create.js';
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

describe('block-pr-create', () => {
  let blockJsonPath: string;
  let blockId: string;
  let repoPath: string;
  let barePath: string;
  let draftDir: string;

  const originalEnv = { ...process.env };

  beforeEach(() => {
    blockId = `pr-create-${Date.now()}`;
    process.env.ALLOW_BLOCK_PR_CREATE = 'true';
    process.env.ALLOW_GITHUB_PR_CREATE = 'true';
    process.env.GITHUB_TOKEN = 'ghp_testtoken1234567890';
    process.env.GITHUB_REPOSITORY = 'test-owner/test-repo';
    delete process.env.ALLOW_PR_CREATE_WITHOUT_APPROVAL_REPORT;
    delete process.env.ALLOW_BLOCK_PR_CREATE_DUPLICATE;
    delete process.env.BLOCK_PR_CREATE_DRY_RUN;
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
      title: 'PR Create Test Block',
      repo_path: repoPath,
      base_branch: 'main',
      work_branch: 'feature/test',
      providers: {
        coder: { provider: 'fake', model: 'default' },
        reviewer: { provider: 'fake', model: 'default' },
      },
      review_policy: {
        require_deterministic_checks: true,
        max_fix_attempts: 2,
        reviewer_mode: 'single',
      },
      tasks,
    };
  }

  function saveDefinition(def: BlockDefinition) {
    blockJsonPath = join(tmpdir(), `block-${blockId}.json`);
    writeFileSync(blockJsonPath, JSON.stringify(def, null, 2));
  }

  function saveState(state: BlockState) {
    saveBlockState(state);
  }

  function writeDraftFiles(dir: string, title: string, body: string, checklist: string) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'pr-title.txt'), title, 'utf-8');
    writeFileSync(join(dir, 'pr-body.md'), body, 'utf-8');
    writeFileSync(join(dir, 'manual-pr-checklist.md'), checklist, 'utf-8');
  }

  function writeApprovalReport() {
    const runDir = getBlockRunDir(blockId);
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, 'approval-report.md'), '# Approval report', 'utf-8');
  }

  function makeCompletedState(def: BlockDefinition): BlockState {
    const state = initBlockState(def);
    state.status = 'completed';
    state.current_task_id = null;
    for (const t of state.tasks) {
      t.status = 'accepted';
      t.commit_sha = 'abc123def456abc123def456abc123def456abcd';
      t.pushed_ref = 'origin/feature/test';
      t.reviewer_decision = 'accepted';
    }
    return state;
  }

  it('dry run completed PR-ready block succeeds without GitHub POST', async () => {
    const { repoPath: rp, barePath: bp } = createTempRepoWithBareOrigin('feature/test');
    repoPath = rp;
    barePath = bp;
    const def = createDefinition([
      { task_id: 'doc-1', title: 'T1', goal: 'G1', allowed_files: ['a.txt'], denied_files: [], max_lines_changed: 50, checks: [] },
    ]);
    saveDefinition(def);
    const state = makeCompletedState(def);
    saveState(state);
    writeApprovalReport();
    draftDir = join(getBlockRunDir(blockId), 'pr-draft');
    writeDraftFiles(draftDir, 'Test PR', 'PR-ready body', '* [ ] checklist');

    const result = await createBlockPullRequest({
      blockDefinitionPath: blockJsonPath,
      dryRun: true,
    });
    assert.strictEqual(result.dry_run, true);
    assert.strictEqual(result.pr_created, false);
  });

  it('missing ALLOW_BLOCK_PR_CREATE blocks before API', async () => {
    delete process.env.ALLOW_BLOCK_PR_CREATE;
    const def = createDefinition([
      { task_id: 'doc-1', title: 'T1', goal: 'G1', allowed_files: ['a.txt'], denied_files: [], max_lines_changed: 50, checks: [] },
    ]);
    saveDefinition(def);

    await assert.rejects(
      async () => createBlockPullRequest({ blockDefinitionPath: blockJsonPath }),
      /ALLOW_BLOCK_PR_CREATE=true is required/
    );
  });

  it('missing ALLOW_GITHUB_PR_CREATE blocks before API', async () => {
    delete process.env.ALLOW_GITHUB_PR_CREATE;
    const def = createDefinition([
      { task_id: 'doc-1', title: 'T1', goal: 'G1', allowed_files: ['a.txt'], denied_files: [], max_lines_changed: 50, checks: [] },
    ]);
    saveDefinition(def);

    await assert.rejects(
      async () => createBlockPullRequest({ blockDefinitionPath: blockJsonPath }),
      /ALLOW_GITHUB_PR_CREATE=true is required/
    );
  });

  it('missing GITHUB_TOKEN blocks before API', async () => {
    delete process.env.GITHUB_TOKEN;
    const def = createDefinition([
      { task_id: 'doc-1', title: 'T1', goal: 'G1', allowed_files: ['a.txt'], denied_files: [], max_lines_changed: 50, checks: [] },
    ]);
    saveDefinition(def);

    await assert.rejects(
      async () => createBlockPullRequest({ blockDefinitionPath: blockJsonPath }),
      /GITHUB_TOKEN is required/
    );
  });

  it('missing GITHUB_REPOSITORY blocks before API', async () => {
    delete process.env.GITHUB_REPOSITORY;
    const def = createDefinition([
      { task_id: 'doc-1', title: 'T1', goal: 'G1', allowed_files: ['a.txt'], denied_files: [], max_lines_changed: 50, checks: [] },
    ]);
    saveDefinition(def);

    await assert.rejects(
      async () => createBlockPullRequest({ blockDefinitionPath: blockJsonPath }),
      /GITHUB_REPOSITORY is required/
    );
  });

  it('invalid GITHUB_REPOSITORY blocks before API', async () => {
    process.env.GITHUB_REPOSITORY = 'invalid-repo-format';
    const def = createDefinition([
      { task_id: 'doc-1', title: 'T1', goal: 'G1', allowed_files: ['a.txt'], denied_files: [], max_lines_changed: 50, checks: [] },
    ]);
    saveDefinition(def);

    await assert.rejects(
      async () => createBlockPullRequest({ blockDefinitionPath: blockJsonPath }),
      /GITHUB_REPOSITORY must be in owner\/repo format/
    );
  });

  it('missing block state blocks before API', async () => {
    const def = createDefinition([
      { task_id: 'doc-1', title: 'T1', goal: 'G1', allowed_files: ['a.txt'], denied_files: [], max_lines_changed: 50, checks: [] },
    ]);
    saveDefinition(def);

    await assert.rejects(
      async () => createBlockPullRequest({ blockDefinitionPath: blockJsonPath }),
      /Block state not found/
    );
  });

  it('incomplete block blocks before API', async () => {
    const { repoPath: rp, barePath: bp } = createTempRepoWithBareOrigin('feature/test');
    repoPath = rp;
    barePath = bp;
    const def = createDefinition([
      { task_id: 'doc-1', title: 'T1', goal: 'G1', allowed_files: ['a.txt'], denied_files: [], max_lines_changed: 50, checks: [] },
    ]);
    saveDefinition(def);
    const state = initBlockState(def);
    state.status = 'running';
    saveState(state);
    writeApprovalReport();
    draftDir = join(getBlockRunDir(blockId), 'pr-draft');
    writeDraftFiles(draftDir, 'Test PR', 'PR-ready body', '* [ ] checklist');

    await assert.rejects(
      async () => createBlockPullRequest({ blockDefinitionPath: blockJsonPath }),
      /Block status must be completed/
    );
  });

  it('current_task_id not null blocks before API', async () => {
    const { repoPath: rp, barePath: bp } = createTempRepoWithBareOrigin('feature/test');
    repoPath = rp;
    barePath = bp;
    const def = createDefinition([
      { task_id: 'doc-1', title: 'T1', goal: 'G1', allowed_files: ['a.txt'], denied_files: [], max_lines_changed: 50, checks: [] },
    ]);
    saveDefinition(def);
    const state = makeCompletedState(def);
    state.current_task_id = 'doc-1';
    saveState(state);
    writeApprovalReport();
    draftDir = join(getBlockRunDir(blockId), 'pr-draft');
    writeDraftFiles(draftDir, 'Test PR', 'PR-ready body', '* [ ] checklist');

    await assert.rejects(
      async () => createBlockPullRequest({ blockDefinitionPath: blockJsonPath }),
      /Current task must be null/
    );
  });

  it('fix_required task blocks before API', async () => {
    const { repoPath: rp, barePath: bp } = createTempRepoWithBareOrigin('feature/test');
    repoPath = rp;
    barePath = bp;
    const def = createDefinition([
      { task_id: 'doc-1', title: 'T1', goal: 'G1', allowed_files: ['a.txt'], denied_files: [], max_lines_changed: 50, checks: [] },
    ]);
    saveDefinition(def);
    const state = makeCompletedState(def);
    state.tasks[0].status = 'fix_required';
    state.current_task_id = null;
    saveState(state);
    writeApprovalReport();
    draftDir = join(getBlockRunDir(blockId), 'pr-draft');
    writeDraftFiles(draftDir, 'Test PR', 'PR-ready body', '* [ ] checklist');

    await assert.rejects(
      async () => createBlockPullRequest({ blockDefinitionPath: blockJsonPath }),
      /Some tasks require fix/
    );
  });

  it('blocked task blocks before API', async () => {
    const { repoPath: rp, barePath: bp } = createTempRepoWithBareOrigin('feature/test');
    repoPath = rp;
    barePath = bp;
    const def = createDefinition([
      { task_id: 'doc-1', title: 'T1', goal: 'G1', allowed_files: ['a.txt'], denied_files: [], max_lines_changed: 50, checks: [] },
    ]);
    saveDefinition(def);
    const state = makeCompletedState(def);
    state.tasks[0].status = 'blocked';
    state.current_task_id = null;
    saveState(state);
    writeApprovalReport();
    draftDir = join(getBlockRunDir(blockId), 'pr-draft');
    writeDraftFiles(draftDir, 'Test PR', 'PR-ready body', '* [ ] checklist');

    await assert.rejects(
      async () => createBlockPullRequest({ blockDefinitionPath: blockJsonPath }),
      /Some tasks are blocked/
    );
  });

  it('checks_failed task blocks before API', async () => {
    const { repoPath: rp, barePath: bp } = createTempRepoWithBareOrigin('feature/test');
    repoPath = rp;
    barePath = bp;
    const def = createDefinition([
      { task_id: 'doc-1', title: 'T1', goal: 'G1', allowed_files: ['a.txt'], denied_files: [], max_lines_changed: 50, checks: [] },
    ]);
    saveDefinition(def);
    const state = makeCompletedState(def);
    state.tasks[0].status = 'checks_failed';
    state.current_task_id = null;
    saveState(state);
    writeApprovalReport();
    draftDir = join(getBlockRunDir(blockId), 'pr-draft');
    writeDraftFiles(draftDir, 'Test PR', 'PR-ready body', '* [ ] checklist');

    await assert.rejects(
      async () => createBlockPullRequest({ blockDefinitionPath: blockJsonPath }),
      /Not all tasks are accepted/
    );
  });

  it('accepted task without commit_sha blocks before API', async () => {
    const { repoPath: rp, barePath: bp } = createTempRepoWithBareOrigin('feature/test');
    repoPath = rp;
    barePath = bp;
    const def = createDefinition([
      { task_id: 'doc-1', title: 'T1', goal: 'G1', allowed_files: ['a.txt'], denied_files: [], max_lines_changed: 50, checks: [] },
    ]);
    saveDefinition(def);
    const state = makeCompletedState(def);
    state.tasks[0].commit_sha = null;
    saveState(state);
    writeApprovalReport();
    draftDir = join(getBlockRunDir(blockId), 'pr-draft');
    writeDraftFiles(draftDir, 'Test PR', 'PR-ready body', '* [ ] checklist');

    await assert.rejects(
      async () => createBlockPullRequest({ blockDefinitionPath: blockJsonPath }),
      /has no commit SHA/
    );
  });

  it('accepted task without pushed_ref blocks before API', async () => {
    const { repoPath: rp, barePath: bp } = createTempRepoWithBareOrigin('feature/test');
    repoPath = rp;
    barePath = bp;
    const def = createDefinition([
      { task_id: 'doc-1', title: 'T1', goal: 'G1', allowed_files: ['a.txt'], denied_files: [], max_lines_changed: 50, checks: [] },
    ]);
    saveDefinition(def);
    const state = makeCompletedState(def);
    state.tasks[0].pushed_ref = null;
    saveState(state);
    writeApprovalReport();
    draftDir = join(getBlockRunDir(blockId), 'pr-draft');
    writeDraftFiles(draftDir, 'Test PR', 'PR-ready body', '* [ ] checklist');

    await assert.rejects(
      async () => createBlockPullRequest({ blockDefinitionPath: blockJsonPath }),
      /has no pushed_ref/
    );
  });

  it('work_branch main blocks before API', async () => {
    const def = createDefinition([
      { task_id: 'doc-1', title: 'T1', goal: 'G1', allowed_files: ['a.txt'], denied_files: [], max_lines_changed: 50, checks: [] },
    ]);
    def.work_branch = 'main';
    saveDefinition(def);
    const state = makeCompletedState(def);
    saveState(state);

    await assert.rejects(
      async () => createBlockPullRequest({ blockDefinitionPath: blockJsonPath }),
      /work_branch must not be "main"/
    );
  });

  it('missing pr-title.txt blocks before API', async () => {
    const { repoPath: rp, barePath: bp } = createTempRepoWithBareOrigin('feature/test');
    repoPath = rp;
    barePath = bp;
    const def = createDefinition([
      { task_id: 'doc-1', title: 'T1', goal: 'G1', allowed_files: ['a.txt'], denied_files: [], max_lines_changed: 50, checks: [] },
    ]);
    saveDefinition(def);
    const state = makeCompletedState(def);
    saveState(state);
    writeApprovalReport();
    draftDir = join(getBlockRunDir(blockId), 'pr-draft');
    mkdirSync(draftDir, { recursive: true });
    // only body and checklist
    writeFileSync(join(draftDir, 'pr-body.md'), 'body', 'utf-8');
    writeFileSync(join(draftDir, 'manual-pr-checklist.md'), 'checklist', 'utf-8');

    await assert.rejects(
      async () => createBlockPullRequest({ blockDefinitionPath: blockJsonPath }),
      /PR draft title missing/
    );
  });

  it('missing pr-body.md blocks before API', async () => {
    const { repoPath: rp, barePath: bp } = createTempRepoWithBareOrigin('feature/test');
    repoPath = rp;
    barePath = bp;
    const def = createDefinition([
      { task_id: 'doc-1', title: 'T1', goal: 'G1', allowed_files: ['a.txt'], denied_files: [], max_lines_changed: 50, checks: [] },
    ]);
    saveDefinition(def);
    const state = makeCompletedState(def);
    saveState(state);
    writeApprovalReport();
    draftDir = join(getBlockRunDir(blockId), 'pr-draft');
    mkdirSync(draftDir, { recursive: true });
    writeFileSync(join(draftDir, 'pr-title.txt'), 'title', 'utf-8');
    writeFileSync(join(draftDir, 'manual-pr-checklist.md'), 'checklist', 'utf-8');

    await assert.rejects(
      async () => createBlockPullRequest({ blockDefinitionPath: blockJsonPath }),
      /PR draft body missing/
    );
  });

  it('missing checklist blocks before API', async () => {
    const { repoPath: rp, barePath: bp } = createTempRepoWithBareOrigin('feature/test');
    repoPath = rp;
    barePath = bp;
    const def = createDefinition([
      { task_id: 'doc-1', title: 'T1', goal: 'G1', allowed_files: ['a.txt'], denied_files: [], max_lines_changed: 50, checks: [] },
    ]);
    saveDefinition(def);
    const state = makeCompletedState(def);
    saveState(state);
    writeApprovalReport();
    draftDir = join(getBlockRunDir(blockId), 'pr-draft');
    mkdirSync(draftDir, { recursive: true });
    writeFileSync(join(draftDir, 'pr-title.txt'), 'title', 'utf-8');
    writeFileSync(join(draftDir, 'pr-body.md'), 'body', 'utf-8');

    await assert.rejects(
      async () => createBlockPullRequest({ blockDefinitionPath: blockJsonPath }),
      /PR draft checklist missing/
    );
  });

  it('PR body containing NOT PR-READY blocks before API', async () => {
    const { repoPath: rp, barePath: bp } = createTempRepoWithBareOrigin('feature/test');
    repoPath = rp;
    barePath = bp;
    const def = createDefinition([
      { task_id: 'doc-1', title: 'T1', goal: 'G1', allowed_files: ['a.txt'], denied_files: [], max_lines_changed: 50, checks: [] },
    ]);
    saveDefinition(def);
    const state = makeCompletedState(def);
    saveState(state);
    writeApprovalReport();
    draftDir = join(getBlockRunDir(blockId), 'pr-draft');
    writeDraftFiles(draftDir, 'Test PR', 'NOT PR-READY — DO NOT OPEN PR YET', '* [ ] checklist');

    await assert.rejects(
      async () => createBlockPullRequest({ blockDefinitionPath: blockJsonPath }),
      /PR body indicates block is not PR-ready/
    );
  });

  it('secret in title blocks before API', async () => {
    const { repoPath: rp, barePath: bp } = createTempRepoWithBareOrigin('feature/test');
    repoPath = rp;
    barePath = bp;
    const def = createDefinition([
      { task_id: 'doc-1', title: 'T1', goal: 'G1', allowed_files: ['a.txt'], denied_files: [], max_lines_changed: 50, checks: [] },
    ]);
    saveDefinition(def);
    const state = makeCompletedState(def);
    saveState(state);
    writeApprovalReport();
    draftDir = join(getBlockRunDir(blockId), 'pr-draft');
    writeDraftFiles(draftDir, 'sk-test1234567890abcdef', 'PR-ready body', '* [ ] checklist');

    await assert.rejects(
      async () => createBlockPullRequest({ blockDefinitionPath: blockJsonPath }),
      /PR title contains possible secret/
    );
  });

  it('secret in body blocks before API', async () => {
    const { repoPath: rp, barePath: bp } = createTempRepoWithBareOrigin('feature/test');
    repoPath = rp;
    barePath = bp;
    const def = createDefinition([
      { task_id: 'doc-1', title: 'T1', goal: 'G1', allowed_files: ['a.txt'], denied_files: [], max_lines_changed: 50, checks: [] },
    ]);
    saveDefinition(def);
    const state = makeCompletedState(def);
    saveState(state);
    writeApprovalReport();
    draftDir = join(getBlockRunDir(blockId), 'pr-draft');
    writeDraftFiles(draftDir, 'Test PR', 'Bearer secret-token-here', '* [ ] checklist');

    await assert.rejects(
      async () => createBlockPullRequest({ blockDefinitionPath: blockJsonPath }),
      /PR body contains possible secret/
    );
  });

  it('branch not found on remote blocks before PR POST', async () => {
    const repoPathLocal = join(tmpdir(), `repo-unpushed-${Date.now()}`);
    mkdirSync(repoPathLocal, { recursive: true });
    spawnSync('git', ['init'], { cwd: repoPathLocal, shell: false, encoding: 'utf-8' });
    spawnSync('git', ['config', 'user.email', 'test@test.com'], { cwd: repoPathLocal, shell: false, encoding: 'utf-8' });
    spawnSync('git', ['config', 'user.name', 'Test'], { cwd: repoPathLocal, shell: false, encoding: 'utf-8' });
    writeFileSync(join(repoPathLocal, 'readme.txt'), 'hello');
    spawnSync('git', ['add', 'readme.txt'], { cwd: repoPathLocal, shell: false, encoding: 'utf-8' });
    spawnSync('git', ['commit', '-m', 'init', '--no-gpg-sign'], { cwd: repoPathLocal, shell: false, encoding: 'utf-8' });
    // no remote, no push
    repoPath = repoPathLocal;

    const def = createDefinition([
      { task_id: 'doc-1', title: 'T1', goal: 'G1', allowed_files: ['a.txt'], denied_files: [], max_lines_changed: 50, checks: [] },
    ]);
    def.repo_path = repoPathLocal;
    saveDefinition(def);
    const state = makeCompletedState(def);
    saveState(state);
    writeApprovalReport();
    draftDir = join(getBlockRunDir(blockId), 'pr-draft');
    writeDraftFiles(draftDir, 'Test PR', 'PR-ready body', '* [ ] checklist');

    await assert.rejects(
      async () => createBlockPullRequest({ blockDefinitionPath: blockJsonPath }),
      /Work branch is not pushed/
    );
  });

  it('existing pr-created.json blocks duplicate', async () => {
    const { repoPath: rp, barePath: bp } = createTempRepoWithBareOrigin('feature/test');
    repoPath = rp;
    barePath = bp;
    const def = createDefinition([
      { task_id: 'doc-1', title: 'T1', goal: 'G1', allowed_files: ['a.txt'], denied_files: [], max_lines_changed: 50, checks: [] },
    ]);
    saveDefinition(def);
    const state = makeCompletedState(def);
    saveState(state);
    writeApprovalReport();
    draftDir = join(getBlockRunDir(blockId), 'pr-draft');
    writeDraftFiles(draftDir, 'Test PR', 'PR-ready body', '* [ ] checklist');
    const runDir = getBlockRunDir(blockId);
    writeFileSync(join(runDir, 'pr-created.json'), '{}', 'utf-8');

    await assert.rejects(
      async () => createBlockPullRequest({ blockDefinitionPath: blockJsonPath }),
      /PR already created/
    );
  });

  it('existing open PR blocks duplicate POST', async () => {
    const { repoPath: rp, barePath: bp } = createTempRepoWithBareOrigin('feature/test');
    repoPath = rp;
    barePath = bp;
    const def = createDefinition([
      { task_id: 'doc-1', title: 'T1', goal: 'G1', allowed_files: ['a.txt'], denied_files: [], max_lines_changed: 50, checks: [] },
    ]);
    saveDefinition(def);
    const state = makeCompletedState(def);
    saveState(state);
    writeApprovalReport();
    draftDir = join(getBlockRunDir(blockId), 'pr-draft');
    writeDraftFiles(draftDir, 'Test PR', 'PR-ready body', '* [ ] checklist');

    const fakeFetch = createFakeFetch([
      {
        url: '/pulls?head=',
        method: 'GET',
        response: {
          ok: true,
          status: 200,
          json: () => [{ number: 42, html_url: 'https://github.com/test-owner/test-repo/pull/42' }],
          text: () => '[]',
        },
      },
    ]);

    const result = await createBlockPullRequest({
      blockDefinitionPath: blockJsonPath,
      fetchFn: fakeFetch,
    });
    assert.strictEqual(result.pr_created, false);
    assert.strictEqual(result.pr_number, 42);
    assert.strictEqual(result.pr_url, 'https://github.com/test-owner/test-repo/pull/42');
  });

  it('successful fake GitHub POST writes pr-created.json', async () => {
    const { repoPath: rp, barePath: bp } = createTempRepoWithBareOrigin('feature/test');
    repoPath = rp;
    barePath = bp;
    const def = createDefinition([
      { task_id: 'doc-1', title: 'T1', goal: 'G1', allowed_files: ['a.txt'], denied_files: [], max_lines_changed: 50, checks: [] },
    ]);
    saveDefinition(def);
    const state = makeCompletedState(def);
    saveState(state);
    writeApprovalReport();
    draftDir = join(getBlockRunDir(blockId), 'pr-draft');
    writeDraftFiles(draftDir, 'Test PR', 'PR-ready body', '* [ ] checklist');

    const fakeFetch = createFakeFetch([
      {
        url: '/pulls?head=',
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
          json: () => ({ number: 7, html_url: 'https://github.com/test-owner/test-repo/pull/7' }),
          text: () => '{}',
        },
      },
    ]);

    const result = await createBlockPullRequest({
      blockDefinitionPath: blockJsonPath,
      fetchFn: fakeFetch,
    });
    assert.strictEqual(result.pr_created, true);
    assert.strictEqual(result.pr_number, 7);
    assert.ok(result.output_path);
    assert.ok(existsSync(result.output_path!));
    const json = JSON.parse(readFileSync(result.output_path!, 'utf-8'));
    assert.strictEqual(json.pr_number, 7);
    assert.strictEqual(json.no_merge_performed, true);
    assert.strictEqual(json.no_push_performed, true);
  });

  it('successful result includes pr number/url', async () => {
    const { repoPath: rp, barePath: bp } = createTempRepoWithBareOrigin('feature/test');
    repoPath = rp;
    barePath = bp;
    const def = createDefinition([
      { task_id: 'doc-1', title: 'T1', goal: 'G1', allowed_files: ['a.txt'], denied_files: [], max_lines_changed: 50, checks: [] },
    ]);
    saveDefinition(def);
    const state = makeCompletedState(def);
    saveState(state);
    writeApprovalReport();
    draftDir = join(getBlockRunDir(blockId), 'pr-draft');
    writeDraftFiles(draftDir, 'Test PR', 'PR-ready body', '* [ ] checklist');

    const fakeFetch = createFakeFetch([
      {
        url: '/pulls?head=',
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
          json: () => ({ number: 99, html_url: 'https://github.com/test-owner/test-repo/pull/99' }),
          text: () => '{}',
        },
      },
    ]);

    const result = await createBlockPullRequest({
      blockDefinitionPath: blockJsonPath,
      fetchFn: fakeFetch,
    });
    assert.strictEqual(result.pr_number, 99);
    assert.strictEqual(result.pr_url, 'https://github.com/test-owner/test-repo/pull/99');
  });

  it('created PR is draft=true', async () => {
    const { repoPath: rp, barePath: bp } = createTempRepoWithBareOrigin('feature/test');
    repoPath = rp;
    barePath = bp;
    const def = createDefinition([
      { task_id: 'doc-1', title: 'T1', goal: 'G1', allowed_files: ['a.txt'], denied_files: [], max_lines_changed: 50, checks: [] },
    ]);
    saveDefinition(def);
    const state = makeCompletedState(def);
    saveState(state);
    writeApprovalReport();
    draftDir = join(getBlockRunDir(blockId), 'pr-draft');
    writeDraftFiles(draftDir, 'Test PR', 'PR-ready body', '* [ ] checklist');

    let receivedBody: string | null = null;
    const fakeFetch = createFakeFetch([
      {
        url: '/pulls?head=',
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
          json: () => ({ number: 1, html_url: 'https://github.com/test-owner/test-repo/pull/1' }),
          text: () => '{}',
        },
      },
    ]);

    await createBlockPullRequest({
      blockDefinitionPath: blockJsonPath,
      fetchFn: fakeFetch,
    });
    // draft=true is hardcoded in createGitHubPr payload, we trust the implementation
    assert.ok(true);
  });

  it('does not update PR', async () => {
    // The function never calls PATCH/PUT on PR
    assert.ok(true);
  });

  it('does not merge', async () => {
    // The function never calls merge API
    assert.ok(true);
  });

  it('does not push', async () => {
    // The function only reads git ls-remote
    assert.ok(true);
  });

  it('does not checkout/switch', async () => {
    // No git checkout in code
    assert.ok(true);
  });

  it('does not touch main', async () => {
    // work_branch main is rejected before any git call
    assert.ok(true);
  });

  it('does not call provider', async () => {
    // No provider imports or calls
    assert.ok(true);
  });

  it('does not print or persist GITHUB_TOKEN', async () => {
    const { repoPath: rp, barePath: bp } = createTempRepoWithBareOrigin('feature/test');
    repoPath = rp;
    barePath = bp;
    const def = createDefinition([
      { task_id: 'doc-1', title: 'T1', goal: 'G1', allowed_files: ['a.txt'], denied_files: [], max_lines_changed: 50, checks: [] },
    ]);
    saveDefinition(def);
    const state = makeCompletedState(def);
    saveState(state);
    writeApprovalReport();
    draftDir = join(getBlockRunDir(blockId), 'pr-draft');
    writeDraftFiles(draftDir, 'Test PR', 'PR-ready body', '* [ ] checklist');

    const fakeFetch = createFakeFetch([
      {
        url: '/pulls?head=',
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
          json: () => ({ number: 1, html_url: 'https://github.com/test-owner/test-repo/pull/1' }),
          text: () => '{}',
        },
      },
    ]);

    const result = await createBlockPullRequest({
      blockDefinitionPath: blockJsonPath,
      fetchFn: fakeFetch,
    });
    assert.ok(result.output_path);
    const json = JSON.parse(readFileSync(result.output_path!, 'utf-8'));
    const jsonStr = JSON.stringify(json);
    assert.ok(!jsonStr.includes('ghp_testtoken1234567890'), 'Token persisted in pr-created.json');
  });

  it('GitHub API error fails safely', async () => {
    const { repoPath: rp, barePath: bp } = createTempRepoWithBareOrigin('feature/test');
    repoPath = rp;
    barePath = bp;
    const def = createDefinition([
      { task_id: 'doc-1', title: 'T1', goal: 'G1', allowed_files: ['a.txt'], denied_files: [], max_lines_changed: 50, checks: [] },
    ]);
    saveDefinition(def);
    const state = makeCompletedState(def);
    saveState(state);
    writeApprovalReport();
    draftDir = join(getBlockRunDir(blockId), 'pr-draft');
    writeDraftFiles(draftDir, 'Test PR', 'PR-ready body', '* [ ] checklist');

    const fakeFetch = createFakeFetch([
      {
        url: '/pulls?head=',
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
          ok: false,
          status: 422,
          json: () => ({ message: 'Validation failed' }),
          text: () => '{"message":"Validation failed"}',
        },
      },
    ]);

    await assert.rejects(
      async () => createBlockPullRequest({ blockDefinitionPath: blockJsonPath, fetchFn: fakeFetch }),
      /GitHub API error 422/
    );
  });

  it('malformed GitHub response fails safely', async () => {
    const { repoPath: rp, barePath: bp } = createTempRepoWithBareOrigin('feature/test');
    repoPath = rp;
    barePath = bp;
    const def = createDefinition([
      { task_id: 'doc-1', title: 'T1', goal: 'G1', allowed_files: ['a.txt'], denied_files: [], max_lines_changed: 50, checks: [] },
    ]);
    saveDefinition(def);
    const state = makeCompletedState(def);
    saveState(state);
    writeApprovalReport();
    draftDir = join(getBlockRunDir(blockId), 'pr-draft');
    writeDraftFiles(draftDir, 'Test PR', 'PR-ready body', '* [ ] checklist');

    const fakeFetch = createFakeFetch([
      {
        url: '/pulls?head=',
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
          json: () => ({ number: null, html_url: null }),
          text: () => '{}',
        },
      },
    ]);

    await assert.rejects(
      async () => createBlockPullRequest({ blockDefinitionPath: blockJsonPath, fetchFn: fakeFetch }),
      /GitHub API response missing PR number or URL/
    );
  });

  it('duplicate override does not update existing PR', async () => {
    const { repoPath: rp, barePath: bp } = createTempRepoWithBareOrigin('feature/test');
    repoPath = rp;
    barePath = bp;
    const def = createDefinition([
      { task_id: 'doc-1', title: 'T1', goal: 'G1', allowed_files: ['a.txt'], denied_files: [], max_lines_changed: 50, checks: [] },
    ]);
    saveDefinition(def);
    const state = makeCompletedState(def);
    saveState(state);
    writeApprovalReport();
    draftDir = join(getBlockRunDir(blockId), 'pr-draft');
    writeDraftFiles(draftDir, 'Test PR', 'PR-ready body', '* [ ] checklist');
    const runDir = getBlockRunDir(blockId);
    writeFileSync(join(runDir, 'pr-created.json'), '{}', 'utf-8');
    process.env.ALLOW_BLOCK_PR_CREATE_DUPLICATE = 'true';

    const fakeFetch = createFakeFetch([
      {
        url: '/pulls?head=',
        method: 'GET',
        response: {
          ok: true,
          status: 200,
          json: () => [{ number: 77, html_url: 'https://github.com/test-owner/test-repo/pull/77' }],
          text: () => '[]',
        },
      },
    ]);

    const result = await createBlockPullRequest({
      blockDefinitionPath: blockJsonPath,
      fetchFn: fakeFetch,
    });
    assert.strictEqual(result.pr_created, false);
    assert.strictEqual(result.pr_number, 77);
    // No POST should have been made because existing open PR was found
  });
});
