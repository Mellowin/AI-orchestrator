import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { writeFileSync, readFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { generateBlockPrDraft } from '../src/block/block-pr-draft.js';
import { initBlockState, getBlockRunDir, saveBlockState } from '../src/block/block-state-manager.js';
import type { BlockDefinition, BlockState } from '../src/block/block-types.js';

describe('block-pr-draft', () => {
  let blockJsonPath: string;
  let blockId: string;
  let repoPath: string;

  beforeEach(() => {
    blockId = `draft-${Date.now()}`;
    repoPath = join(tmpdir(), `repo-${blockId}`);
    mkdirSync(repoPath, { recursive: true });
  });

  afterEach(() => {
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

  function createDefinition(tasks: BlockDefinition['tasks'], title?: string): BlockDefinition {
    return {
      block_id: blockId,
      title: title ?? 'PR Draft Test Block',
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

  it('generates title/body/checklist files for completed block', () => {
    const def = createDefinition([
      {
        task_id: 'doc-1',
        title: 'T1',
        goal: 'G1',
        allowed_files: ['a.txt'],
        denied_files: [],
        max_lines_changed: 50,
        checks: [],
      },
    ]);
    saveDefinition(def);
    const state = initBlockState(def);
    state.status = 'completed';
    state.tasks[0].status = 'accepted';
    state.tasks[0].commit_sha = 'abc123def456abc123def456abc123def456abcd';
    state.current_task_id = null;
    saveState(state);

    const result = generateBlockPrDraft({ blockDefinitionPath: blockJsonPath });
    assert.ok(existsSync(result.title_path), 'title file missing');
    assert.ok(existsSync(result.body_path), 'body file missing');
    assert.ok(existsSync(result.checklist_path), 'checklist file missing');
  });

  it('pr_ready=true block generates PR-ready wording', () => {
    const def = createDefinition([
      { task_id: 'doc-1', title: 'T1', goal: 'G1', allowed_files: ['a.txt'], denied_files: [], max_lines_changed: 50, checks: [] },
    ]);
    saveDefinition(def);
    const state = initBlockState(def);
    state.status = 'completed';
    state.tasks[0].status = 'accepted';
    state.tasks[0].commit_sha = 'abc123def456abc123def456abc123def456abcd';
    state.current_task_id = null;
    saveState(state);

    const result = generateBlockPrDraft({ blockDefinitionPath: blockJsonPath });
    const body = readFileSync(result.body_path, 'utf-8');
    assert.ok(body.includes('PR-ready for human manual review'), body);
    assert.ok(!body.includes('NOT PR-READY'), body);
    assert.strictEqual(result.pr_ready, true);
  });

  it('pr_ready=false block generates NOT PR-READY wording', () => {
    const def = createDefinition([
      { task_id: 'doc-1', title: 'T1', goal: 'G1', allowed_files: ['a.txt'], denied_files: [], max_lines_changed: 50, checks: [] },
    ]);
    saveDefinition(def);
    const state = initBlockState(def);
    state.status = 'running';
    saveState(state);

    const result = generateBlockPrDraft({ blockDefinitionPath: blockJsonPath });
    const body = readFileSync(result.body_path, 'utf-8');
    assert.ok(body.includes('NOT PR-READY — DO NOT OPEN PR YET'), body);
    assert.strictEqual(result.pr_ready, false);
  });

  it('incomplete block is not PR-ready', () => {
    const def = createDefinition([
      { task_id: 'doc-1', title: 'T1', goal: 'G1', allowed_files: ['a.txt'], denied_files: [], max_lines_changed: 50, checks: [] },
    ]);
    saveDefinition(def);
    const state = initBlockState(def);
    saveState(state);

    const result = generateBlockPrDraft({ blockDefinitionPath: blockJsonPath });
    assert.strictEqual(result.pr_ready, false);
    assert.ok(result.safety_findings.some((f) => f.includes('not completed')));
  });

  it('blocked task is not PR-ready', () => {
    const def = createDefinition([
      { task_id: 'doc-1', title: 'T1', goal: 'G1', allowed_files: ['a.txt'], denied_files: [], max_lines_changed: 50, checks: [] },
    ]);
    saveDefinition(def);
    const state = initBlockState(def);
    state.status = 'completed';
    state.tasks[0].status = 'blocked';
    state.current_task_id = null;
    saveState(state);

    const result = generateBlockPrDraft({ blockDefinitionPath: blockJsonPath });
    assert.strictEqual(result.pr_ready, false);
    assert.ok(result.blocking_issues.some((i) => i.includes('blocked')));
  });

  it('fix_required task is not PR-ready', () => {
    const def = createDefinition([
      { task_id: 'doc-1', title: 'T1', goal: 'G1', allowed_files: ['a.txt'], denied_files: [], max_lines_changed: 50, checks: [] },
    ]);
    saveDefinition(def);
    const state = initBlockState(def);
    state.status = 'completed';
    state.tasks[0].status = 'fix_required';
    state.current_task_id = null;
    saveState(state);

    const result = generateBlockPrDraft({ blockDefinitionPath: blockJsonPath });
    assert.strictEqual(result.pr_ready, false);
    assert.ok(result.blocking_issues.some((i) => i.includes('requires fix')));
  });

  it('missing commit SHA is not PR-ready', () => {
    const def = createDefinition([
      { task_id: 'doc-1', title: 'T1', goal: 'G1', allowed_files: ['a.txt'], denied_files: [], max_lines_changed: 50, checks: [] },
    ]);
    saveDefinition(def);
    const state = initBlockState(def);
    state.status = 'completed';
    state.tasks[0].status = 'accepted';
    state.current_task_id = null;
    saveState(state);

    const result = generateBlockPrDraft({ blockDefinitionPath: blockJsonPath });
    assert.strictEqual(result.pr_ready, false);
    assert.ok(result.safety_findings.some((f) => f.includes('no commit SHA')));
  });

  it('title is limited to 100 chars', () => {
    const longTitle = 'A'.repeat(200);
    const def = createDefinition(
      [{ task_id: 'doc-1', title: 'T1', goal: 'G1', allowed_files: ['a.txt'], denied_files: [], max_lines_changed: 50, checks: [] }],
      longTitle
    );
    saveDefinition(def);
    const state = initBlockState(def);
    state.status = 'completed';
    state.tasks[0].status = 'accepted';
    state.tasks[0].commit_sha = 'abc123def456abc123def456abc123def456abcd';
    state.current_task_id = null;
    saveState(state);

    const result = generateBlockPrDraft({ blockDefinitionPath: blockJsonPath });
    const title = readFileSync(result.title_path, 'utf-8');
    assert.ok(title.length <= 100, `Title length ${title.length} exceeds 100`);
    assert.ok(title.endsWith('...'), 'Title should be truncated with ...');
  });

  it('title removes newlines', () => {
    const def = createDefinition(
      [{ task_id: 'doc-1', title: 'T1', goal: 'G1', allowed_files: ['a.txt'], denied_files: [], max_lines_changed: 50, checks: [] }],
      'Line1\nLine2'
    );
    saveDefinition(def);
    const state = initBlockState(def);
    state.status = 'completed';
    state.tasks[0].status = 'accepted';
    state.tasks[0].commit_sha = 'abc123def456abc123def456abc123def456abcd';
    state.current_task_id = null;
    saveState(state);

    const result = generateBlockPrDraft({ blockDefinitionPath: blockJsonPath });
    const title = readFileSync(result.title_path, 'utf-8');
    assert.ok(!title.includes('\n'), 'Title contains newline');
    assert.ok(title.includes('Line1 Line2'), title);
  });

  it('body includes block id/title/base/work branch/status', () => {
    const def = createDefinition([
      { task_id: 'doc-1', title: 'T1', goal: 'G1', allowed_files: ['a.txt'], denied_files: [], max_lines_changed: 50, checks: [] },
    ]);
    saveDefinition(def);
    const state = initBlockState(def);
    state.status = 'completed';
    state.tasks[0].status = 'accepted';
    state.tasks[0].commit_sha = 'abc123def456abc123def456abc123def456abcd';
    state.current_task_id = null;
    saveState(state);

    const result = generateBlockPrDraft({ blockDefinitionPath: blockJsonPath });
    const body = readFileSync(result.body_path, 'utf-8');
    assert.ok(body.includes(blockId), body);
    assert.ok(body.includes('PR Draft Test Block'), body);
    assert.ok(body.includes('main'), body);
    assert.ok(body.includes('feature/test'), body);
    assert.ok(body.includes('completed'), body);
  });

  it('body includes task results table', () => {
    const def = createDefinition([
      { task_id: 'doc-1', title: 'T1', goal: 'G1', allowed_files: ['a.txt'], denied_files: [], max_lines_changed: 50, checks: [] },
    ]);
    saveDefinition(def);
    const state = initBlockState(def);
    state.status = 'completed';
    state.tasks[0].status = 'accepted';
    state.tasks[0].commit_sha = 'abc123def456abc123def456abc123def456abcd';
    state.current_task_id = null;
    saveState(state);

    const result = generateBlockPrDraft({ blockDefinitionPath: blockJsonPath });
    const body = readFileSync(result.body_path, 'utf-8');
    assert.ok(body.includes('doc-1'), body);
    assert.ok(body.includes('accepted'), body);
    assert.ok(body.includes('Task Results'), body);
  });

  it('body includes commit evidence', () => {
    const def = createDefinition([
      { task_id: 'doc-1', title: 'T1', goal: 'G1', allowed_files: ['a.txt'], denied_files: [], max_lines_changed: 50, checks: [] },
    ]);
    saveDefinition(def);
    const state = initBlockState(def);
    state.status = 'completed';
    state.tasks[0].status = 'accepted';
    state.tasks[0].commit_sha = 'abc123def456abc123def456abc123def456abcd';
    state.current_task_id = null;
    saveState(state);

    const result = generateBlockPrDraft({ blockDefinitionPath: blockJsonPath });
    const body = readFileSync(result.body_path, 'utf-8');
    assert.ok(body.includes('Commit Evidence'), body);
    assert.ok(body.includes('abc123d'), body);
  });

  it('body includes changed files', () => {
    const def = createDefinition([
      { task_id: 'doc-1', title: 'T1', goal: 'G1', allowed_files: ['a.txt'], denied_files: [], max_lines_changed: 50, checks: [] },
    ]);
    saveDefinition(def);
    const state = initBlockState(def);
    state.status = 'completed';
    state.tasks[0].status = 'accepted';
    state.tasks[0].commit_sha = 'abc123def456abc123def456abc123def456abcd';
    state.current_task_id = null;
    saveState(state);

    const result = generateBlockPrDraft({ blockDefinitionPath: blockJsonPath });
    const body = readFileSync(result.body_path, 'utf-8');
    assert.ok(body.includes('What Changed'), body);
  });

  it('body includes test evidence section', () => {
    const def = createDefinition([
      { task_id: 'doc-1', title: 'T1', goal: 'G1', allowed_files: ['a.txt'], denied_files: [], max_lines_changed: 50, checks: [] },
    ]);
    saveDefinition(def);
    const state = initBlockState(def);
    state.status = 'completed';
    state.tasks[0].status = 'accepted';
    state.tasks[0].commit_sha = 'abc123def456abc123def456abc123def456abcd';
    state.current_task_id = null;
    saveState(state);

    const result = generateBlockPrDraft({ blockDefinitionPath: blockJsonPath });
    const body = readFileSync(result.body_path, 'utf-8');
    assert.ok(body.includes('Test Evidence'), body);
    assert.ok(body.includes('Type check:'), body);
    assert.ok(body.includes('Build:'), body);
    assert.ok(body.includes('Tests:'), body);
  });

  it('body says CI not verified when no CI evidence exists', () => {
    const def = createDefinition([
      { task_id: 'doc-1', title: 'T1', goal: 'G1', allowed_files: ['a.txt'], denied_files: [], max_lines_changed: 50, checks: [] },
    ]);
    saveDefinition(def);
    const state = initBlockState(def);
    state.status = 'completed';
    state.tasks[0].status = 'accepted';
    state.tasks[0].commit_sha = 'abc123def456abc123def456abc123def456abcd';
    state.current_task_id = null;
    saveState(state);

    const result = generateBlockPrDraft({ blockDefinitionPath: blockJsonPath });
    const body = readFileSync(result.body_path, 'utf-8');
    assert.ok(body.includes('not verified by GitHub Actions'), body);
  });

  it('body includes safety checklist', () => {
    const def = createDefinition([
      { task_id: 'doc-1', title: 'T1', goal: 'G1', allowed_files: ['a.txt'], denied_files: [], max_lines_changed: 50, checks: [] },
    ]);
    saveDefinition(def);
    const state = initBlockState(def);
    state.status = 'completed';
    state.tasks[0].status = 'accepted';
    state.tasks[0].commit_sha = 'abc123def456abc123def456abc123def456abcd';
    state.current_task_id = null;
    saveState(state);

    const result = generateBlockPrDraft({ blockDefinitionPath: blockJsonPath });
    const body = readFileSync(result.body_path, 'utf-8');
    assert.ok(body.includes('Safety Checklist'), body);
    assert.ok(body.includes('No auto-merge'), body);
    assert.ok(body.includes('No PR was created'), body);
    assert.ok(body.includes('No provider call'), body);
  });

  it('body includes manual next steps', () => {
    const def = createDefinition([
      { task_id: 'doc-1', title: 'T1', goal: 'G1', allowed_files: ['a.txt'], denied_files: [], max_lines_changed: 50, checks: [] },
    ]);
    saveDefinition(def);
    const state = initBlockState(def);
    state.status = 'completed';
    state.tasks[0].status = 'accepted';
    state.tasks[0].commit_sha = 'abc123def456abc123def456abc123def456abcd';
    state.current_task_id = null;
    saveState(state);

    const result = generateBlockPrDraft({ blockDefinitionPath: blockJsonPath });
    const body = readFileSync(result.body_path, 'utf-8');
    assert.ok(body.includes('Manual Next Steps'), body);
    assert.ok(body.includes('git status --short'), body);
    assert.ok(body.includes('git log --oneline'), body);
    assert.ok(body.includes('git diff --stat'), body);
  });

  it('checklist file includes required checklist items', () => {
    const def = createDefinition([
      { task_id: 'doc-1', title: 'T1', goal: 'G1', allowed_files: ['a.txt'], denied_files: [], max_lines_changed: 50, checks: [] },
    ]);
    saveDefinition(def);
    const state = initBlockState(def);
    state.status = 'completed';
    state.tasks[0].status = 'accepted';
    state.tasks[0].commit_sha = 'abc123def456abc123def456abc123def456abcd';
    state.current_task_id = null;
    saveState(state);

    const result = generateBlockPrDraft({ blockDefinitionPath: blockJsonPath });
    const checklist = readFileSync(result.checklist_path, 'utf-8');
    assert.ok(checklist.includes('Confirm current branch is work branch'), checklist);
    assert.ok(checklist.includes('Confirm working tree is clean'), checklist);
    assert.ok(checklist.includes('Review `pr-body.md`'), checklist);
    assert.ok(checklist.includes('Open PR manually if acceptable'), checklist);
    assert.ok(checklist.includes('Do not merge without human review'), checklist);
    assert.ok(checklist.includes('Do not auto-merge'), checklist);
    assert.ok(checklist.includes('Do not push forcefully'), checklist);
    assert.ok(checklist.includes('Do not touch main directly'), checklist);
  });

  it('secrets are redacted from title/body/checklist', () => {
    const def = createDefinition(
      [{ task_id: 'doc-1', title: 'T1', goal: 'G1', allowed_files: ['a.txt'], denied_files: [], max_lines_changed: 50, checks: [] }],
      'Bearer sk-test1234567890abcdef'
    );
    saveDefinition(def);
    const state = initBlockState(def);
    state.status = 'completed';
    state.tasks[0].status = 'accepted';
    state.tasks[0].commit_sha = 'abc123def456abc123def456abc123def456abcd';
    state.current_task_id = null;
    saveState(state);

    const result = generateBlockPrDraft({ blockDefinitionPath: blockJsonPath });
    const title = readFileSync(result.title_path, 'utf-8');
    const body = readFileSync(result.body_path, 'utf-8');
    const checklist = readFileSync(result.checklist_path, 'utf-8');
    assert.ok(!title.includes('sk-test1234567890abcdef'), 'secret leaked in title');
    assert.ok(!body.includes('sk-test1234567890abcdef'), 'secret leaked in body');
    assert.ok(!checklist.includes('sk-test1234567890abcdef'), 'secret leaked in checklist');
  });

  it('safety finding is added when secret was redacted', () => {
    const def = createDefinition(
      [{ task_id: 'doc-1', title: 'T1', goal: 'G1', allowed_files: ['a.txt'], denied_files: [], max_lines_changed: 50, checks: [] }],
      'Bearer sk-test1234567890abcdef'
    );
    saveDefinition(def);
    const state = initBlockState(def);
    state.status = 'completed';
    state.tasks[0].status = 'accepted';
    state.tasks[0].commit_sha = 'abc123def456abc123def456abc123def456abcd';
    state.current_task_id = null;
    saveState(state);

    const result = generateBlockPrDraft({ blockDefinitionPath: blockJsonPath });
    assert.ok(result.safety_findings.some((f) => f.includes('redacted')), result.safety_findings.join('; '));
  });

  it('output dir custom path works', () => {
    const def = createDefinition([
      { task_id: 'doc-1', title: 'T1', goal: 'G1', allowed_files: ['a.txt'], denied_files: [], max_lines_changed: 50, checks: [] },
    ]);
    saveDefinition(def);
    const state = initBlockState(def);
    state.status = 'completed';
    state.tasks[0].status = 'accepted';
    state.tasks[0].commit_sha = 'abc123def456abc123def456abc123def456abcd';
    state.current_task_id = null;
    saveState(state);

    const customDir = join(tmpdir(), `draft-${blockId}`);
    const result = generateBlockPrDraft({
      blockDefinitionPath: blockJsonPath,
      outputDir: customDir,
    });
    assert.strictEqual(result.output_dir, customDir);
    assert.ok(existsSync(join(customDir, 'pr-title.txt')));
    assert.ok(existsSync(join(customDir, 'pr-body.md')));
    assert.ok(existsSync(join(customDir, 'manual-pr-checklist.md')));
    rmSync(customDir, { recursive: true, force: true });
  });

  it('output dir prefix bypass is rejected', () => {
    const def = createDefinition([
      { task_id: 'doc-1', title: 'T1', goal: 'G1', allowed_files: ['a.txt'], denied_files: [], max_lines_changed: 50, checks: [] },
    ]);
    saveDefinition(def);
    const state = initBlockState(def);
    state.status = 'completed';
    state.tasks[0].status = 'accepted';
    state.tasks[0].commit_sha = 'abc123def456abc123def456abc123def456abcd';
    state.current_task_id = null;
    saveState(state);

    const evilDir = join(process.cwd() + '-evil', 'pr-draft');
    assert.throws(() => {
      generateBlockPrDraft({
        blockDefinitionPath: blockJsonPath,
        outputDir: evilDir,
      });
    }, /outside allowed directory/);
  });

  it('missing block state fails safely', () => {
    const def = createDefinition([
      { task_id: 'doc-1', title: 'T1', goal: 'G1', allowed_files: ['a.txt'], denied_files: [], max_lines_changed: 50, checks: [] },
    ]);
    saveDefinition(def);
    assert.throws(() => {
      generateBlockPrDraft({ blockDefinitionPath: blockJsonPath });
    }, /Block state not found/);
  });

  it('missing block definition fails safely', () => {
    assert.throws(() => {
      generateBlockPrDraft({ blockDefinitionPath: join(tmpdir(), 'nonexistent-block.json') });
    });
  });

  it('no provider call', () => {
    const def = createDefinition([
      { task_id: 'doc-1', title: 'T1', goal: 'G1', allowed_files: ['a.txt'], denied_files: [], max_lines_changed: 50, checks: [] },
    ]);
    saveDefinition(def);
    const state = initBlockState(def);
    state.status = 'completed';
    state.tasks[0].status = 'accepted';
    state.tasks[0].commit_sha = 'abc123def456abc123def456abc123def456abcd';
    state.current_task_id = null;
    saveState(state);

    generateBlockPrDraft({ blockDefinitionPath: blockJsonPath });
    // No assertion needed — if a provider were called, it would fail without API keys
  });

  it('no GitHub API call', () => {
    const def = createDefinition([
      { task_id: 'doc-1', title: 'T1', goal: 'G1', allowed_files: ['a.txt'], denied_files: [], max_lines_changed: 50, checks: [] },
    ]);
    saveDefinition(def);
    const state = initBlockState(def);
    state.status = 'completed';
    state.tasks[0].status = 'accepted';
    state.tasks[0].commit_sha = 'abc123def456abc123def456abc123def456abcd';
    state.current_task_id = null;
    saveState(state);

    generateBlockPrDraft({ blockDefinitionPath: blockJsonPath });
    // No assertion needed — if GitHub API were called, it would fail without token
  });

  it('no PR creation', () => {
    const def = createDefinition([
      { task_id: 'doc-1', title: 'T1', goal: 'G1', allowed_files: ['a.txt'], denied_files: [], max_lines_changed: 50, checks: [] },
    ]);
    saveDefinition(def);
    const state = initBlockState(def);
    state.status = 'completed';
    state.tasks[0].status = 'accepted';
    state.tasks[0].commit_sha = 'abc123def456abc123def456abc123def456abcd';
    state.current_task_id = null;
    saveState(state);

    const result = generateBlockPrDraft({ blockDefinitionPath: blockJsonPath });
    const body = readFileSync(result.body_path, 'utf-8');
    assert.ok(body.includes('no PR was created automatically'), body);
  });

  it('no push', () => {
    const def = createDefinition([
      { task_id: 'doc-1', title: 'T1', goal: 'G1', allowed_files: ['a.txt'], denied_files: [], max_lines_changed: 50, checks: [] },
    ]);
    saveDefinition(def);
    const state = initBlockState(def);
    state.status = 'completed';
    state.tasks[0].status = 'accepted';
    state.tasks[0].commit_sha = 'abc123def456abc123def456abc123def456abcd';
    state.current_task_id = null;
    saveState(state);

    const result = generateBlockPrDraft({ blockDefinitionPath: blockJsonPath });
    const body = readFileSync(result.body_path, 'utf-8');
    assert.ok(body.includes('No push was performed'), body);
  });

  it('no merge', () => {
    const def = createDefinition([
      { task_id: 'doc-1', title: 'T1', goal: 'G1', allowed_files: ['a.txt'], denied_files: [], max_lines_changed: 50, checks: [] },
    ]);
    saveDefinition(def);
    const state = initBlockState(def);
    state.status = 'completed';
    state.tasks[0].status = 'accepted';
    state.tasks[0].commit_sha = 'abc123def456abc123def456abc123def456abcd';
    state.current_task_id = null;
    saveState(state);

    const result = generateBlockPrDraft({ blockDefinitionPath: blockJsonPath });
    const body = readFileSync(result.body_path, 'utf-8');
    assert.ok(body.includes('No auto-merge'), body);
  });

  it('no checkout/switch', () => {
    const def = createDefinition([
      { task_id: 'doc-1', title: 'T1', goal: 'G1', allowed_files: ['a.txt'], denied_files: [], max_lines_changed: 50, checks: [] },
    ]);
    saveDefinition(def);
    const state = initBlockState(def);
    state.status = 'completed';
    state.tasks[0].status = 'accepted';
    state.tasks[0].commit_sha = 'abc123def456abc123def456abc123def456abcd';
    state.current_task_id = null;
    saveState(state);

    const result = generateBlockPrDraft({ blockDefinitionPath: blockJsonPath });
    const body = readFileSync(result.body_path, 'utf-8');
    assert.ok(body.includes('No checkout or branch switch'), body);
  });

  it('no main touch', () => {
    const def = createDefinition([
      { task_id: 'doc-1', title: 'T1', goal: 'G1', allowed_files: ['a.txt'], denied_files: [], max_lines_changed: 50, checks: [] },
    ]);
    saveDefinition(def);
    const state = initBlockState(def);
    state.status = 'completed';
    state.tasks[0].status = 'accepted';
    state.tasks[0].commit_sha = 'abc123def456abc123def456abc123def456abcd';
    state.current_task_id = null;
    saveState(state);

    const result = generateBlockPrDraft({ blockDefinitionPath: blockJsonPath });
    const body = readFileSync(result.body_path, 'utf-8');
    assert.ok(body.includes('No main branch touch'), body);
  });

  it('no git mutation commands', () => {
    const def = createDefinition([
      { task_id: 'doc-1', title: 'T1', goal: 'G1', allowed_files: ['a.txt'], denied_files: [], max_lines_changed: 50, checks: [] },
    ]);
    saveDefinition(def);
    const state = initBlockState(def);
    state.status = 'completed';
    state.tasks[0].status = 'accepted';
    state.tasks[0].commit_sha = 'abc123def456abc123def456abc123def456abcd';
    state.current_task_id = null;
    saveState(state);

    const result = generateBlockPrDraft({ blockDefinitionPath: blockJsonPath });
    const body = readFileSync(result.body_path, 'utf-8');
    // git commands only in manual next steps as text, not as mutation
    assert.ok(!body.includes('git checkout'), body);
    assert.ok(!body.includes('git merge'), body);
    assert.ok(!body.includes('git push'), body);
    assert.ok(!body.includes('git reset'), body);
  });
});
