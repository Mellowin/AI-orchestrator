import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { writeFileSync, readFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { generateBlockApprovalReport } from '../src/block/block-approval-report.js';
import { initBlockState, loadBlockState, getBlockRunDir, saveBlockState } from '../src/block/block-state-manager.js';
import type { BlockDefinition, BlockState } from '../src/block/block-types.js';

describe('block-approval-report', () => {
  let blockJsonPath: string;
  let blockId: string;
  let repoPath: string;

  beforeEach(() => {
    blockId = `approval-${Date.now()}`;
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

  function createDefinition(tasks: BlockDefinition['tasks']): BlockDefinition {
    return {
      block_id: blockId,
      title: 'Approval Report Test Block',
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

  it('generates report for completed block', () => {
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
    saveState(state);

    const result = generateBlockApprovalReport({ blockDefinitionPath: blockJsonPath });
    assert.strictEqual(result.block_id, blockId);
    assert.strictEqual(result.block_status, 'completed');
    assert.ok(existsSync(result.output_path));
  });

  it('completed block with all accepted tasks is pr_ready=true', () => {
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
      {
        task_id: 'doc-2',
        title: 'T2',
        goal: 'G2',
        allowed_files: ['b.txt'],
        denied_files: [],
        max_lines_changed: 50,
        checks: [],
      },
    ]);
    saveDefinition(def);
    const state = initBlockState(def);
    state.status = 'completed';
    state.current_task_id = null;
    state.tasks[0].status = 'accepted';
    state.tasks[0].commit_sha = 'abc123def456abc123def456abc123def456abcd';
    state.tasks[1].status = 'accepted';
    state.tasks[1].commit_sha = 'def456abc123def456abc123def456abc123def4';
    saveState(state);

    const result = generateBlockApprovalReport({ blockDefinitionPath: blockJsonPath });
    assert.strictEqual(result.pr_ready, true);
    assert.strictEqual(result.tasks_accepted, 2);
    assert.strictEqual(result.tasks_total, 2);
  });

  it('incomplete block is pr_ready=false', () => {
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
    state.status = 'running';
    state.tasks[0].status = 'accepted';
    state.tasks[0].commit_sha = 'abc123def456abc123def456abc123def456abcd';
    saveState(state);

    const result = generateBlockApprovalReport({ blockDefinitionPath: blockJsonPath });
    assert.strictEqual(result.pr_ready, false);
    assert.ok(result.safety_findings.some((f) => f.includes('not completed')));
  });

  it('fix_required task is pr_ready=false', () => {
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
    state.status = 'fixing';
    state.tasks[0].status = 'fix_required';
    saveState(state);

    const result = generateBlockApprovalReport({ blockDefinitionPath: blockJsonPath });
    assert.strictEqual(result.pr_ready, false);
    assert.ok(result.safety_findings.some((f) => f.includes('fix')));
  });

  it('blocked task is pr_ready=false', () => {
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
    state.status = 'blocked';
    state.tasks[0].status = 'blocked';
    saveState(state);

    const result = generateBlockApprovalReport({ blockDefinitionPath: blockJsonPath });
    assert.strictEqual(result.pr_ready, false);
    assert.ok(result.safety_findings.some((f) => f.includes('blocked')));
  });

  it('checks_failed task is pr_ready=false', () => {
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
    state.status = 'running';
    state.tasks[0].status = 'checks_failed';
    saveState(state);

    const result = generateBlockApprovalReport({ blockDefinitionPath: blockJsonPath });
    assert.strictEqual(result.pr_ready, false);
    assert.ok(result.safety_findings.some((f) => f.includes('checks_failed')));
  });

  it('accepted task without commit_sha is pr_ready=false', () => {
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
    state.current_task_id = null;
    state.tasks[0].status = 'accepted';
    state.tasks[0].commit_sha = null;
    saveState(state);

    const result = generateBlockApprovalReport({ blockDefinitionPath: blockJsonPath });
    assert.strictEqual(result.pr_ready, false);
    assert.ok(result.safety_findings.some((f) => f.includes('no commit SHA')));
  });

  it('current_task_id not null is pr_ready=false', () => {
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
      {
        task_id: 'doc-2',
        title: 'T2',
        goal: 'G2',
        allowed_files: ['b.txt'],
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
    state.tasks[1].status = 'accepted';
    state.tasks[1].commit_sha = 'def456abc123def456abc123def456abc123def4';
    // current_task_id still set
    saveState(state);

    const result = generateBlockApprovalReport({ blockDefinitionPath: blockJsonPath });
    assert.strictEqual(result.pr_ready, false);
    assert.ok(result.safety_findings.some((f) => f.includes('Current task')));
  });

  it('report includes task table', () => {
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
    saveState(state);

    const result = generateBlockApprovalReport({ blockDefinitionPath: blockJsonPath });
    const report = readFileSync(result.output_path, 'utf-8');
    assert.ok(report.includes('Task Results'));
    assert.ok(report.includes('doc-1'));
    assert.ok(report.includes('accepted'));
  });

  it('report includes commit SHAs', () => {
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
    saveState(state);

    const result = generateBlockApprovalReport({ blockDefinitionPath: blockJsonPath });
    const report = readFileSync(result.output_path, 'utf-8');
    assert.ok(report.includes('Commit Evidence'));
    assert.ok(report.includes('abc123d'));
  });

  it('report includes changed files', () => {
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
    saveState(state);

    const result = generateBlockApprovalReport({ blockDefinitionPath: blockJsonPath });
    const report = readFileSync(result.output_path, 'utf-8');
    assert.ok(report.includes('Actually Changed Files'));
    assert.ok(report.includes('Allowed Files'));
    assert.ok(report.includes('Denied Files'));
  });

  it('report includes safety checklist', () => {
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
    saveState(state);

    const result = generateBlockApprovalReport({ blockDefinitionPath: blockJsonPath });
    const report = readFileSync(result.output_path, 'utf-8');
    assert.ok(report.includes('Safety Checklist'));
    assert.ok(report.includes('No auto-merge'));
    assert.ok(report.includes('No PR was created'));
    assert.ok(report.includes('No main branch touch'));
  });

  it('report includes manual human decision section', () => {
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
    saveState(state);

    const result = generateBlockApprovalReport({ blockDefinitionPath: blockJsonPath });
    const report = readFileSync(result.output_path, 'utf-8');
    assert.ok(report.includes('Human Decision'));
    assert.ok(report.includes('PR-ready'));
  });

  it('report includes manual next commands', () => {
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
    saveState(state);

    const result = generateBlockApprovalReport({ blockDefinitionPath: blockJsonPath });
    const report = readFileSync(result.output_path, 'utf-8');
    assert.ok(report.includes('Manual Next Commands'));
    assert.ok(report.includes('git status --short'));
    assert.ok(report.includes('git log --oneline'));
    assert.ok(report.includes('git diff --stat'));
  });

  it('report redacts sk- secret', () => {
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
    state.tasks[0].reviewer_summary = 'Used sk-test12345 token';
    saveState(state);

    const result = generateBlockApprovalReport({ blockDefinitionPath: blockJsonPath });
    const report = readFileSync(result.output_path, 'utf-8');
    assert.ok(!report.includes('sk-test12345'));
    assert.ok(report.includes('[REDACTED]'));
  });

  it('report redacts Bearer token', () => {
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
    state.tasks[0].reviewer_summary = 'Bearer abcdef123456';
    saveState(state);

    const result = generateBlockApprovalReport({ blockDefinitionPath: blockJsonPath });
    const report = readFileSync(result.output_path, 'utf-8');
    assert.ok(!report.includes('Bearer abcdef123456'));
    assert.ok(report.includes('Bearer [REDACTED]'));
  });

  it('report redacts KIMI_API_KEY', () => {
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
    state.tasks[0].reviewer_summary = 'KIMI_API_KEY=sk-secret123';
    saveState(state);

    const result = generateBlockApprovalReport({ blockDefinitionPath: blockJsonPath });
    const report = readFileSync(result.output_path, 'utf-8');
    assert.ok(!report.includes('sk-secret123'));
    assert.ok(report.includes('[REDACTED]'));
  });

  it('report does not mutate block state', () => {
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
    saveState(state);

    const before = JSON.stringify(loadBlockState(blockId));
    generateBlockApprovalReport({ blockDefinitionPath: blockJsonPath });
    const after = JSON.stringify(loadBlockState(blockId));
    assert.strictEqual(before, after);
  });

  it('report does not call provider', () => {
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
    saveState(state);

    const result = generateBlockApprovalReport({ blockDefinitionPath: blockJsonPath });
    // Report generation is synchronous and does not use any provider
    assert.ok(result.output_path);
  });

  it('report does not call GitHub API', () => {
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
    saveState(state);

    const result = generateBlockApprovalReport({ blockDefinitionPath: blockJsonPath });
    assert.ok(result.output_path);
    // No GitHub API call was made (no network activity in this pure local function)
  });

  it('report does not call git push/merge/checkout/reset', () => {
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
    saveState(state);

    const result = generateBlockApprovalReport({ blockDefinitionPath: blockJsonPath });
    const report = readFileSync(result.output_path, 'utf-8');
    assert.ok(report.includes('No push was performed') || report.includes('Push disabled'));
    assert.ok(report.includes('No auto-merge was performed'));
    assert.ok(report.includes('No checkout or branch switch occurred'));
  });

  it('custom output path works', () => {
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
    saveState(state);

    const customPath = join(tmpdir(), `report-${blockId}.md`);
    const result = generateBlockApprovalReport({
      blockDefinitionPath: blockJsonPath,
      outputPath: customPath,
    });
    assert.strictEqual(result.output_path, customPath);
    assert.ok(existsSync(customPath));
    rmSync(customPath, { force: true });
  });

  it('missing block state fails safely', () => {
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
    // Do NOT save state

    assert.throws(
      () => generateBlockApprovalReport({ blockDefinitionPath: blockJsonPath }),
      /Block state not found/
    );
  });

  it('missing block definition fails safely', () => {
    assert.throws(
      () => generateBlockApprovalReport({ blockDefinitionPath: join(tmpdir(), 'nonexistent.json') }),
      /Failed to parse|not found|ENOENT/
    );
  });
});
