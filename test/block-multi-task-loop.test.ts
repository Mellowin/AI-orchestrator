import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { writeFileSync, mkdirSync, rmSync, existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { runMultiTaskLoop, runMultiTaskFakeLoop } from '../src/block/block-multi-task-loop.js';
import { initBlockState, loadBlockState, getBlockRunDir } from '../src/block/block-state-manager.js';
import type { BlockDefinition } from '../src/block/block-types.js';

describe('block-multi-task-loop', () => {
  let blockJsonPath: string;
  let blockId: string;

  beforeEach(() => {
    blockId = `test-multi-${Date.now()}`;
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
    } catch {
      // ignore cleanup errors
    }
  });

  function createDefinition(tasks: BlockDefinition['tasks']): BlockDefinition {
    return {
      block_id: blockId,
      title: 'Multi Task Block',
      repo_path: '/nonexistent/repo-path-fake-mode',
      base_branch: 'main',
      work_branch: 'feature/test',
      providers: {
        coder: { provider: 'fake', model: 'fake-model' },
        reviewer: { provider: 'fake', model: 'fake-model' },
      },
      review_policy: {
        require_deterministic_checks: true,
        max_fix_attempts: 3,
        reviewer_mode: 'single',
      },
      tasks,
    };
  }

  function saveDefinitionAndState(def: BlockDefinition) {
    blockJsonPath = join(tmpdir(), `block-${blockId}.json`);
    writeFileSync(blockJsonPath, JSON.stringify(def, null, 2));

    const state = initBlockState(def);
    const runDir = getBlockRunDir(blockId);
    if (!existsSync(runDir)) {
      mkdirSync(runDir, { recursive: true });
    }
    writeFileSync(join(runDir, 'block-state.json'), JSON.stringify(state, null, 2));
  }

  it('initializes missing block state', async () => {
    const def = createDefinition([
      {
        task_id: 'task-1',
        title: 'First task',
        goal: 'Do first thing',
        allowed_files: ['a.txt'],
        denied_files: [],
        max_lines_changed: 50,
        checks: [],
      },
    ]);
    blockJsonPath = join(tmpdir(), `block-${blockId}.json`);
    writeFileSync(blockJsonPath, JSON.stringify(def, null, 2));
    // Do NOT save state — let the loop initialize it

    const result = await runMultiTaskFakeLoop({
          maxTotalAttemptsPerRun: 20,
      blockDefinitionPath: blockJsonPath,
      mode: 'fake',
      maxTasksPerRun: 1,
      stopOnRejected: true,
      stopOnBlocked: true,
      fakeCoderOptions: {
        taskResponse: {
          summary: 'Done',
          files: [{ path: 'a.txt', content: 'a\n' }],
        },
      },
    });

    assert.strictEqual(result.block_id, blockId);
    assert.strictEqual(result.tasks_attempted, 1);
    const state = loadBlockState(blockId);
    assert.ok(state);
  });

  it('runs first pending task', async () => {
    const def = createDefinition([
      {
        task_id: 'task-1',
        title: 'First task',
        goal: 'Do first thing',
        allowed_files: ['a.txt'],
        denied_files: [],
        max_lines_changed: 50,
        checks: [],
      },
    ]);
    saveDefinitionAndState(def);

    const result = await runMultiTaskFakeLoop({
          maxTotalAttemptsPerRun: 20,
      blockDefinitionPath: blockJsonPath,
      mode: 'fake',
      maxTasksPerRun: 1,
      stopOnRejected: true,
      stopOnBlocked: true,
      fakeCoderOptions: {
        taskResponse: {
          summary: 'Done',
          files: [{ path: 'a.txt', content: 'a\n' }],
        },
      },
    });

    assert.strictEqual(result.tasks_attempted, 1);
    assert.strictEqual(result.tasks_accepted, 1);
    assert.strictEqual(result.final_block_status, 'completed');
  });

  it('runs multiple pending tasks', async () => {
    const def = createDefinition([
      {
        task_id: 'task-1',
        title: 'First task',
        goal: 'Do first thing',
        allowed_files: ['src/fake.ts'],
        denied_files: [],
        max_lines_changed: 50,
        checks: [],
      },
      {
        task_id: 'task-2',
        title: 'Second task',
        goal: 'Do second thing',
        allowed_files: ['src/fake.ts'],
        denied_files: [],
        max_lines_changed: 50,
        checks: [],
      },
      {
        task_id: 'task-3',
        title: 'Third task',
        goal: 'Do third thing',
        allowed_files: ['src/fake.ts'],
        denied_files: [],
        max_lines_changed: 50,
        checks: [],
      },
    ]);
    saveDefinitionAndState(def);

    const result = await runMultiTaskFakeLoop({
          maxTotalAttemptsPerRun: 20,
      blockDefinitionPath: blockJsonPath,
      mode: 'fake',
      maxTasksPerRun: 10,
      stopOnRejected: true,
      stopOnBlocked: true,
    });

    assert.strictEqual(result.tasks_attempted, 3);
    assert.strictEqual(result.tasks_accepted, 3);
    assert.strictEqual(result.final_block_status, 'completed');
    assert.strictEqual(result.current_task_id, null);
  });

  it('stops when block completed', async () => {
    const def = createDefinition([
      {
        task_id: 'task-1',
        title: 'First task',
        goal: 'Do first thing',
        allowed_files: ['a.txt'],
        denied_files: [],
        max_lines_changed: 50,
        checks: [],
      },
    ]);
    saveDefinitionAndState(def);

    // Run once to complete
    await runMultiTaskFakeLoop({
          maxTotalAttemptsPerRun: 20,
      blockDefinitionPath: blockJsonPath,
      mode: 'fake',
      maxTasksPerRun: 10,
      stopOnRejected: true,
      stopOnBlocked: true,
      fakeCoderOptions: {
        taskResponse: {
          summary: 'Done',
          files: [{ path: 'a.txt', content: 'a\n' }],
        },
      },
    });

    // Run again — should complete zero tasks
    const result = await runMultiTaskFakeLoop({
          maxTotalAttemptsPerRun: 20,
      blockDefinitionPath: blockJsonPath,
      mode: 'fake',
      maxTasksPerRun: 10,
      stopOnRejected: true,
      stopOnBlocked: true,
      fakeCoderOptions: {
        taskResponse: {
          summary: 'Done',
          files: [{ path: 'a.txt', content: 'a\n' }],
        },
      },
    });

    assert.strictEqual(result.tasks_attempted, 0);
    assert.strictEqual(result.final_block_status, 'completed');
  });

  it('respects maxTasksPerRun', async () => {
    const def = createDefinition([
      {
        task_id: 'task-1',
        title: 'First task',
        goal: 'Do first thing',
        allowed_files: ['src/fake.ts'],
        denied_files: [],
        max_lines_changed: 50,
        checks: [],
      },
      {
        task_id: 'task-2',
        title: 'Second task',
        goal: 'Do second thing',
        allowed_files: ['src/fake.ts'],
        denied_files: [],
        max_lines_changed: 50,
        checks: [],
      },
      {
        task_id: 'task-3',
        title: 'Third task',
        goal: 'Do third thing',
        allowed_files: ['src/fake.ts'],
        denied_files: [],
        max_lines_changed: 50,
        checks: [],
      },
    ]);
    saveDefinitionAndState(def);

    const result = await runMultiTaskFakeLoop({
          maxTotalAttemptsPerRun: 20,
      blockDefinitionPath: blockJsonPath,
      mode: 'fake',
      maxTasksPerRun: 2,
      stopOnRejected: true,
      stopOnBlocked: true,
    });

    assert.strictEqual(result.tasks_attempted, 2);
    assert.strictEqual(result.tasks_accepted, 2);
    assert.strictEqual(result.final_block_status, 'running');
  });

  it('advances current_task_id after accepted task', async () => {
    const def = createDefinition([
      {
        task_id: 'task-1',
        title: 'First task',
        goal: 'Do first thing',
        allowed_files: ['src/fake.ts'],
        denied_files: [],
        max_lines_changed: 50,
        checks: [],
      },
      {
        task_id: 'task-2',
        title: 'Second task',
        goal: 'Do second thing',
        allowed_files: ['src/fake.ts'],
        denied_files: [],
        max_lines_changed: 50,
        checks: [],
      },
    ]);
    saveDefinitionAndState(def);

    const result = await runMultiTaskFakeLoop({
          maxTotalAttemptsPerRun: 20,
      blockDefinitionPath: blockJsonPath,
      mode: 'fake',
      maxTasksPerRun: 1,
      stopOnRejected: true,
      stopOnBlocked: true,
    });

    assert.strictEqual(result.tasks_attempted, 1);
    assert.strictEqual(result.tasks_accepted, 1);
    assert.strictEqual(result.current_task_id, 'task-2');
  });

  it('does not run more than one block at once', async () => {
    // This is inherent in the design — each call loads one block
    const def = createDefinition([
      {
        task_id: 'task-1',
        title: 'First task',
        goal: 'Do first thing',
        allowed_files: ['src/fake.ts'],
        denied_files: [],
        max_lines_changed: 50,
        checks: [],
      },
    ]);
    saveDefinitionAndState(def);

    const result = await runMultiTaskFakeLoop({
          maxTotalAttemptsPerRun: 20,
      blockDefinitionPath: blockJsonPath,
      mode: 'fake',
      maxTasksPerRun: 10,
      stopOnRejected: true,
      stopOnBlocked: true,
    });

    assert.strictEqual(result.block_id, blockId);
    assert.strictEqual(result.tasks_attempted, 1);
  });

  it('stopOnRejected=true stops on fix_required', async () => {
    const def = createDefinition([
      {
        task_id: 'task-1',
        title: 'First task',
        goal: 'Do first thing',
        allowed_files: ['src/fake.ts'],
        denied_files: [],
        max_lines_changed: 50,
        checks: [],
      },
      {
        task_id: 'task-2',
        title: 'Second task',
        goal: 'Do second thing',
        allowed_files: ['src/fake.ts'],
        denied_files: [],
        max_lines_changed: 50,
        checks: [],
      },
    ]);
    saveDefinitionAndState(def);

    const result = await runMultiTaskFakeLoop({
          maxTotalAttemptsPerRun: 20,
      blockDefinitionPath: blockJsonPath,
      mode: 'fake',
      maxTasksPerRun: 10,
      stopOnRejected: true,
      stopOnBlocked: true,
      fakeReviewerOptions: {
        decision: {
          decision: 'rejected',
          confidence: 'high',
          blocking_issues: ['Issue'],
          non_blocking_issues: [],
          review_summary: 'Fix it',
          fix_task: 'Fix issue',
          next_action: 'send_fix_to_coder',
        },
      },
    });

    assert.strictEqual(result.tasks_attempted, 0);
    assert.strictEqual(result.tasks_fix_required, 1);
    assert.strictEqual(result.final_block_status, 'fixing');
  });

  it('stopOnRejected=false retries until max_fix_attempts then blocked', async () => {
    const def = createDefinition([
      {
        task_id: 'task-1',
        title: 'First task',
        goal: 'Do first thing',
        allowed_files: ['a.txt'],
        denied_files: [],
        max_lines_changed: 50,
        checks: [],
      },
    ]);
    saveDefinitionAndState(def);

    const result = await runMultiTaskFakeLoop({
          maxTotalAttemptsPerRun: 20,
      blockDefinitionPath: blockJsonPath,
      mode: 'fake',
      maxTasksPerRun: 10,
      stopOnRejected: false,
      stopOnBlocked: true,
      fakeCoderOptions: {
        taskResponse: {
          summary: 'Done',
          files: [{ path: 'a.txt', content: 'hello\n' }],
          notes: '',
        },
        fixResponse: {
          summary: 'Fix done',
          files: [{ path: 'a.txt', content: 'fixed\n' }],
          notes: '',
        },
      },
      fakeReviewerOptions: {
        decision: {
          decision: 'rejected',
          confidence: 'high',
          blocking_issues: ['Issue'],
          non_blocking_issues: [],
          review_summary: 'Fix it',
          fix_task: 'Fix issue',
          next_action: 'send_fix_to_coder',
        },
      },
    });

    // Loop retries until max_fix_attempts (3) is reached, then blocked
    assert.strictEqual(result.tasks_attempted, 1);
    assert.strictEqual(result.tasks_fix_required, 2);
    assert.strictEqual(result.tasks_blocked, 1);
    assert.strictEqual(result.final_block_status, 'blocked');
  });

  it('stopOnBlocked=true stops on blocked', async () => {
    const def = createDefinition([
      {
        task_id: 'task-1',
        title: 'First task',
        goal: 'Do first thing',
        allowed_files: ['a.txt'],
        denied_files: [],
        max_lines_changed: 50,
        checks: [],
      },
    ]);
    saveDefinitionAndState(def);

    const result = await runMultiTaskFakeLoop({
          maxTotalAttemptsPerRun: 20,
      blockDefinitionPath: blockJsonPath,
      mode: 'fake',
      maxTasksPerRun: 10,
      stopOnRejected: true,
      stopOnBlocked: true,
      fakeCoderOptions: {
        taskResponse: {
          summary: 'Secret leak',
          files: [{ path: 'a.txt', content: 'sk-test12345\n' }],
        },
      },
    });

    assert.strictEqual(result.tasks_attempted, 1);
    assert.strictEqual(result.tasks_blocked, 1);
    assert.strictEqual(result.final_block_status, 'blocked');
  });

  it('blocked block stops loop', async () => {
    const def = createDefinition([
      {
        task_id: 'task-1',
        title: 'First task',
        goal: 'Do first thing',
        allowed_files: ['a.txt'],
        denied_files: [],
        max_lines_changed: 50,
        checks: [],
      },
      {
        task_id: 'task-2',
        title: 'Second task',
        goal: 'Do second thing',
        allowed_files: ['b.txt'],
        denied_files: [],
        max_lines_changed: 50,
        checks: [],
      },
    ]);
    saveDefinitionAndState(def);

    // Pre-block the block by setting a blocked state on task-1
    const state = loadBlockState(blockId);
    state!.tasks[0].status = 'blocked';
    state!.status = 'blocked';
    state!.current_task_id = null;
    writeFileSync(join(getBlockRunDir(blockId), 'block-state.json'), JSON.stringify(state, null, 2));

    const result = await runMultiTaskFakeLoop({
          maxTotalAttemptsPerRun: 20,
      blockDefinitionPath: blockJsonPath,
      mode: 'fake',
      maxTasksPerRun: 10,
      stopOnRejected: true,
      stopOnBlocked: true,
    });

    assert.strictEqual(result.tasks_attempted, 0);
    assert.strictEqual(result.final_block_status, 'blocked');
  });

  it('checks_failed retries same task while attempts remain', async () => {
    const def = createDefinition([
      {
        task_id: 'task-1',
        title: 'First task',
        goal: 'Do first thing',
        allowed_files: ['a.txt'],
        denied_files: [],
        max_lines_changed: 50,
        checks: [],
      },
    ]);
    saveDefinitionAndState(def);

    const result = await runMultiTaskFakeLoop({
          maxTotalAttemptsPerRun: 20,
      blockDefinitionPath: blockJsonPath,
      mode: 'fake',
      maxTasksPerRun: 10,
      stopOnRejected: false,
      stopOnBlocked: true,
      fakeCoderOptions: {
        taskResponse: {
          summary: 'Bad file',
          files: [{ path: 'denied.txt', content: 'x\n' }],
        },
        fixResponse: {
          summary: 'Fixed',
          files: [{ path: 'a.txt', content: 'ok\n' }],
        },
      },
      fakeReviewerOptions: {
        decision: {
          decision: 'accepted',
          confidence: 'high',
          blocking_issues: [],
          non_blocking_issues: [],
          review_summary: 'LGTM',
          fix_task: null,
          next_action: 'advance_to_next_task',
        },
      },
    });

    assert.strictEqual(result.tasks_attempted, 1);
    assert.strictEqual(result.tasks_accepted, 1);
    assert.strictEqual(result.tasks_fix_required, 1);
    assert.strictEqual(result.final_block_status, 'completed');
  });

  it('repeated checks_failed blocks at max_fix_attempts', async () => {
    const def = createDefinition([
      {
        task_id: 'task-1',
        title: 'First task',
        goal: 'Do first thing',
        allowed_files: ['a.txt'],
        denied_files: [],
        max_lines_changed: 50,
        checks: [],
      },
    ]);
    saveDefinitionAndState(def);
    // Override review_policy to small limit
    const state = loadBlockState(blockId);
    state!.review_policy!.max_fix_attempts = 2;
    writeFileSync(join(getBlockRunDir(blockId), 'block-state.json'), JSON.stringify(state, null, 2));

    const result = await runMultiTaskFakeLoop({
          maxTotalAttemptsPerRun: 20,
      blockDefinitionPath: blockJsonPath,
      mode: 'fake',
      maxTasksPerRun: 10,
      stopOnRejected: false,
      stopOnBlocked: true,
      fakeCoderOptions: {
        taskResponse: {
          summary: 'Bad file',
          files: [{ path: 'denied.txt', content: 'x\n' }],
        },
        fixResponse: {
          summary: 'Still bad',
          files: [{ path: 'denied.txt', content: 'y\n' }],
        },
      },
    });

    assert.strictEqual(result.tasks_attempted, 1);
    assert.strictEqual(result.tasks_blocked, 1);
    assert.strictEqual(result.final_block_status, 'blocked');
  });

  it('accepted after check-fix path advances to next task', async () => {
    const def = createDefinition([
      {
        task_id: 'task-1',
        title: 'First task',
        goal: 'Do first thing',
        allowed_files: ['a.txt'],
        denied_files: [],
        max_lines_changed: 50,
        checks: [],
      },
      {
        task_id: 'task-2',
        title: 'Second task',
        goal: 'Do second thing',
        allowed_files: ['b.txt'],
        denied_files: [],
        max_lines_changed: 50,
        checks: [],
      },
    ]);
    saveDefinitionAndState(def);

    const result = await runMultiTaskFakeLoop({
          maxTotalAttemptsPerRun: 20,
      blockDefinitionPath: blockJsonPath,
      mode: 'fake',
      maxTasksPerRun: 10,
      stopOnRejected: false,
      stopOnBlocked: true,
      fakeCoderOptions: {
        taskResponses: [
          { summary: 'Bad file', files: [{ path: 'denied.txt', content: 'x\n' }] },
          { summary: 'Good', files: [{ path: 'b.txt', content: 'ok\n' }] },
        ],
        fixResponse: {
          summary: 'Fixed',
          files: [{ path: 'a.txt', content: 'ok\n' }],
        },
      },
      fakeReviewerOptions: {
        decision: {
          decision: 'accepted',
          confidence: 'high',
          blocking_issues: [],
          non_blocking_issues: [],
          review_summary: 'LGTM',
          fix_task: null,
          next_action: 'advance_to_next_task',
        },
      },
    });

    assert.strictEqual(result.tasks_attempted, 2);
    assert.strictEqual(result.tasks_accepted, 2);
    assert.strictEqual(result.tasks_fix_required, 1);
    assert.strictEqual(result.final_block_status, 'completed');
  });

  it('completed block runs zero tasks', async () => {
    const def = createDefinition([
      {
        task_id: 'task-1',
        title: 'First task',
        goal: 'Do first thing',
        allowed_files: ['a.txt'],
        denied_files: [],
        max_lines_changed: 50,
        checks: [],
      },
    ]);
    saveDefinitionAndState(def);

    // Complete the block
    const state = loadBlockState(blockId);
    state!.tasks[0].status = 'accepted';
    state!.status = 'completed';
    state!.current_task_id = null;
    writeFileSync(join(getBlockRunDir(blockId), 'block-state.json'), JSON.stringify(state, null, 2));

    const result = await runMultiTaskFakeLoop({
          maxTotalAttemptsPerRun: 20,
      blockDefinitionPath: blockJsonPath,
      mode: 'fake',
      maxTasksPerRun: 10,
      stopOnRejected: true,
      stopOnBlocked: true,
    });

    assert.strictEqual(result.tasks_attempted, 0);
    assert.strictEqual(result.final_block_status, 'completed');
  });

  it('no real provider calls', async () => {
    const def = createDefinition([
      {
        task_id: 'task-1',
        title: 'First task',
        goal: 'Do first thing',
        allowed_files: ['a.txt'],
        denied_files: [],
        max_lines_changed: 50,
        checks: [],
      },
    ]);
    saveDefinitionAndState(def);

    const result = await runMultiTaskFakeLoop({
          maxTotalAttemptsPerRun: 20,
      blockDefinitionPath: blockJsonPath,
      mode: 'fake',
      maxTasksPerRun: 10,
      stopOnRejected: true,
      stopOnBlocked: true,
    });

    for (const r of result.results) {
      assert.strictEqual(r.coder_called, true);
      // Fake provider, not real
      assert.ok(r.commit_sha === null || /^f{40}$/.test(r.commit_sha!));
    }
  });

  it('no real git calls', async () => {
    const def = createDefinition([
      {
        task_id: 'task-1',
        title: 'First task',
        goal: 'Do first thing',
        allowed_files: ['a.txt'],
        denied_files: [],
        max_lines_changed: 50,
        checks: [],
      },
    ]);
    saveDefinitionAndState(def);

    const result = await runMultiTaskFakeLoop({
          maxTotalAttemptsPerRun: 20,
      blockDefinitionPath: blockJsonPath,
      mode: 'fake',
      maxTasksPerRun: 10,
      stopOnRejected: true,
      stopOnBlocked: true,
    });

    assert.strictEqual(result.results[0].pushed, false);
    assert.ok(result.results[0].commit_sha === null || /^f{40}$/.test(result.results[0].commit_sha!));
  });

  it('no GitHub API calls', async () => {
    const def = createDefinition([
      {
        task_id: 'task-1',
        title: 'First task',
        goal: 'Do first thing',
        allowed_files: ['a.txt'],
        denied_files: [],
        max_lines_changed: 50,
        checks: [],
      },
    ]);
    saveDefinitionAndState(def);

    const result = await runMultiTaskFakeLoop({
          maxTotalAttemptsPerRun: 20,
      blockDefinitionPath: blockJsonPath,
      mode: 'fake',
      maxTasksPerRun: 10,
      stopOnRejected: true,
      stopOnBlocked: true,
    });

    assert.strictEqual(result.results.length, 1);
    // No PR creation in any result
    assert.ok(!result.safety_findings.some((f) => f.includes('PR')));
  });

  it('no applyFileUpdates', async () => {
    const def = createDefinition([
      {
        task_id: 'task-1',
        title: 'First task',
        goal: 'Do first thing',
        allowed_files: ['a.txt'],
        denied_files: [],
        max_lines_changed: 50,
        checks: [],
      },
    ]);
    saveDefinitionAndState(def);

    const result = await runMultiTaskFakeLoop({
          maxTotalAttemptsPerRun: 20,
      blockDefinitionPath: blockJsonPath,
      mode: 'fake',
      maxTasksPerRun: 10,
      stopOnRejected: true,
      stopOnBlocked: true,
      fakeCoderOptions: {
        taskResponse: {
          summary: 'Done',
          files: [{ path: 'a.txt', content: 'a\n' }],
        },
      },
    });

    // repo_path is nonexistent — if applyFileUpdates were called, it would error
    assert.strictEqual(result.results[0].files_applied[0], 'a.txt');
    assert.strictEqual(existsSync('/nonexistent/repo-path-fake-mode'), false);
  });

  it('no git add/commit/push/reset/checkout', async () => {
    const def = createDefinition([
      {
        task_id: 'task-1',
        title: 'First task',
        goal: 'Do first thing',
        allowed_files: ['a.txt'],
        denied_files: [],
        max_lines_changed: 50,
        checks: [],
      },
    ]);
    saveDefinitionAndState(def);

    const result = await runMultiTaskFakeLoop({
          maxTotalAttemptsPerRun: 20,
      blockDefinitionPath: blockJsonPath,
      mode: 'fake',
      maxTasksPerRun: 10,
      stopOnRejected: true,
      stopOnBlocked: true,
    });

    assert.strictEqual(result.results[0].pushed, false);
    assert.ok(result.results[0].commit_sha === null || /^f{40}$/.test(result.results[0].commit_sha!));
  });

  it('no secrets in result', async () => {
    const def = createDefinition([
      {
        task_id: 'task-1',
        title: 'First task',
        goal: 'Do first thing',
        allowed_files: ['a.txt'],
        denied_files: [],
        max_lines_changed: 50,
        checks: [],
      },
    ]);
    saveDefinitionAndState(def);

    const result = await runMultiTaskFakeLoop({
          maxTotalAttemptsPerRun: 20,
      blockDefinitionPath: blockJsonPath,
      mode: 'fake',
      maxTasksPerRun: 10,
      stopOnRejected: true,
      stopOnBlocked: true,
      fakeCoderOptions: {
        taskResponse: {
          summary: 'Done',
          files: [{ path: 'a.txt', content: 'sk-test12345\n' }],
        },
      },
    });

    const json = JSON.stringify(result);
    assert.ok(!json.includes('sk-test12345'), 'Secret leaked in result');
  });

  it('state saved after each task', async () => {
    const def = createDefinition([
      {
        task_id: 'task-1',
        title: 'First task',
        goal: 'Do first thing',
        allowed_files: ['src/fake.ts'],
        denied_files: [],
        max_lines_changed: 50,
        checks: [],
      },
      {
        task_id: 'task-2',
        title: 'Second task',
        goal: 'Do second thing',
        allowed_files: ['src/fake.ts'],
        denied_files: [],
        max_lines_changed: 50,
        checks: [],
      },
    ]);
    saveDefinitionAndState(def);

    await runMultiTaskFakeLoop({
          maxTotalAttemptsPerRun: 20,
      blockDefinitionPath: blockJsonPath,
      mode: 'fake',
      maxTasksPerRun: 10,
      stopOnRejected: true,
      stopOnBlocked: true,
    });

    const state = loadBlockState(blockId);
    assert.ok(state);
    assert.strictEqual(state!.status, 'completed');
  });

  it('summary counts are correct', async () => {
    const def = createDefinition([
      {
        task_id: 'task-1',
        title: 'First task',
        goal: 'Do first thing',
        allowed_files: ['src/fake.ts'],
        denied_files: [],
        max_lines_changed: 50,
        checks: [],
      },
      {
        task_id: 'task-2',
        title: 'Second task',
        goal: 'Do second thing',
        allowed_files: ['src/fake.ts'],
        denied_files: [],
        max_lines_changed: 50,
        checks: [],
      },
      {
        task_id: 'task-3',
        title: 'Third task',
        goal: 'Do third thing',
        allowed_files: ['src/fake.ts'],
        denied_files: [],
        max_lines_changed: 50,
        checks: [],
      },
    ]);
    saveDefinitionAndState(def);

    const result = await runMultiTaskFakeLoop({
          maxTotalAttemptsPerRun: 20,
      blockDefinitionPath: blockJsonPath,
      mode: 'fake',
      maxTasksPerRun: 10,
      stopOnRejected: true,
      stopOnBlocked: true,
    });

    assert.strictEqual(result.tasks_attempted, 3);
    assert.strictEqual(result.tasks_accepted, 3);
    assert.strictEqual(result.tasks_fix_required, 0);
    assert.strictEqual(result.tasks_blocked, 0);
    assert.strictEqual(result.results.length, 3);
  });

  describe('real_kimi_coder_kimi_reviewer', () => {
    let realRepoPath: string;
    let realBlockId: string;
    let realBlockJsonPath: string;
    let originalFetch: typeof globalThis.fetch;

    function initGitRepo(repoPath: string): void {
      spawnSync('git', ['init'], { cwd: repoPath, shell: false, encoding: 'utf-8' });
      spawnSync('git', ['config', 'user.email', 'test@test.com'], { cwd: repoPath, shell: false, encoding: 'utf-8' });
      spawnSync('git', ['config', 'user.name', 'Test'], { cwd: repoPath, shell: false, encoding: 'utf-8' });
      writeFileSync(join(repoPath, 'initial.txt'), 'initial\n');
      spawnSync('git', ['add', 'initial.txt'], { cwd: repoPath, shell: false, encoding: 'utf-8' });
      spawnSync('git', ['commit', '-m', 'initial', '--no-gpg-sign'], { cwd: repoPath, shell: false, encoding: 'utf-8' });
      spawnSync('git', ['checkout', '-b', 'feature/test'], { cwd: repoPath, shell: false, encoding: 'utf-8' });
    }

    function buildFakeKimiFetchForCoderAndReviewer(
      coderFiles: Array<{ path: string; content: string }> | Array<Array<{ path: string; content: string }>>,
      reviewerDecision: Record<string, unknown>
    ): typeof globalThis.fetch {
      let callCount = 0;
      let coderCallIndex = 0;
      const coderFilesList: Array<Array<{ path: string; content: string }>> = Array.isArray(coderFiles[0])
        ? (coderFiles as Array<Array<{ path: string; content: string }>>)
        : [coderFiles as Array<{ path: string; content: string }>];
      return async () => {
        callCount++;
        if (callCount % 2 === 1) {
          const files = coderFilesList[coderCallIndex % coderFilesList.length];
          coderCallIndex++;
          const payload = JSON.stringify({ mode: 'file_update', files, notes: 'fake' });
          const content = '```json\n' + payload + '\n```';
          return {
            ok: true,
            status: 200,
            json: async () => ({ choices: [{ message: { content } }] }),
          } as unknown as ReturnType<typeof globalThis.fetch>;
        }
        const content = JSON.stringify(reviewerDecision);
        return {
          ok: true,
          status: 200,
          json: async () => ({ choices: [{ message: { content } }] }),
        } as unknown as ReturnType<typeof globalThis.fetch>;
      };
    }

    function createRealDefinition(tasks: BlockDefinition['tasks']): BlockDefinition {
      return {
        block_id: realBlockId,
        title: 'Real Multi-Task Block',
        repo_path: realRepoPath,
        base_branch: 'main',
        work_branch: 'feature/test',
        providers: {
          coder: { provider: 'kimi', model: 'kimi-k2.6' },
          reviewer: { provider: 'kimi', model: 'kimi-k2.6' },
        },
        review_policy: {
          require_deterministic_checks: true,
          max_fix_attempts: 3,
          reviewer_mode: 'single',
        },
        tasks,
      };
    }

    function saveRealDefinitionAndState(def: BlockDefinition) {
      realBlockJsonPath = join(tmpdir(), `block-${realBlockId}.json`);
      writeFileSync(realBlockJsonPath, JSON.stringify(def, null, 2));

      const state = initBlockState(def);
      const runDir = getBlockRunDir(realBlockId);
      if (!existsSync(runDir)) {
        mkdirSync(runDir, { recursive: true });
      }
      writeFileSync(join(runDir, 'block-state.json'), JSON.stringify(state, null, 2));
    }

    beforeEach(() => {
      realBlockId = `kimi-multi-${Date.now()}`;
      realRepoPath = mkdtempSync(join(tmpdir(), 'kimi-multi-repo-'));
      initGitRepo(realRepoPath);
      originalFetch = globalThis.fetch;
      process.env.KIMI_BASE_URL = 'https://api.kimi.com/coding/v1';
      process.env.KIMI_API_KEY = 'sk-test12345';
    });

    afterEach(() => {
      globalThis.fetch = originalFetch;
      delete process.env.KIMI_BASE_URL;
      delete process.env.KIMI_API_KEY;
      try {
        const runDir = getBlockRunDir(realBlockId);
        if (existsSync(runDir)) {
          rmSync(runDir, { recursive: true, force: true });
        }
        if (existsSync(realBlockJsonPath)) {
          rmSync(realBlockJsonPath, { force: true });
        }
        if (existsSync(realRepoPath)) {
          rmSync(realRepoPath, { recursive: true, force: true });
        }
      } catch {
        // ignore cleanup errors
      }
    });

    it('requires ALLOW_BLOCK_RUN_ONE', async () => {
      const def = createRealDefinition([
        {
          task_id: 'task-1',
          title: 'First task',
          goal: 'Do first thing',
          allowed_files: ['a.txt'],
          denied_files: [],
          max_lines_changed: 50,
          checks: ['node -e "require(\'fs\').existsSync(\'a.txt\')||process.exit(1)"'],
        },
      ]);
      saveRealDefinitionAndState(def);

      await assert.rejects(
        runMultiTaskLoop({
              maxTotalAttemptsPerRun: 20,
          blockDefinitionPath: realBlockJsonPath,
          mode: 'real_kimi_coder_kimi_reviewer',
          maxTasksPerRun: 1,
          stopOnRejected: true,
          stopOnBlocked: true,
          allowBlockRunOne: false,
          allowRealProvider: true,
          allowRealRepoApply: true,
          allowRealRepoCommit: true,
          allowRealRepoPush: false,
          allowKimiReviewer: true,
          coderProvider: 'kimi',
          reviewerProvider: 'kimi',
        }),
        /ALLOW_BLOCK_RUN_ONE/
      );
    });

    it('requires ALLOW_REAL_PROVIDER', async () => {
      const def = createRealDefinition([
        {
          task_id: 'task-1',
          title: 'First task',
          goal: 'Do first thing',
          allowed_files: ['a.txt'],
          denied_files: [],
          max_lines_changed: 50,
          checks: ['node -e "require(\'fs\').existsSync(\'a.txt\')||process.exit(1)"'],
        },
      ]);
      saveRealDefinitionAndState(def);

      await assert.rejects(
        runMultiTaskLoop({
              maxTotalAttemptsPerRun: 20,
          blockDefinitionPath: realBlockJsonPath,
          mode: 'real_kimi_coder_kimi_reviewer',
          maxTasksPerRun: 1,
          stopOnRejected: true,
          stopOnBlocked: true,
          allowBlockRunOne: true,
          allowRealProvider: false,
          allowRealRepoApply: true,
          allowRealRepoCommit: true,
          allowRealRepoPush: false,
          allowKimiReviewer: true,
          coderProvider: 'kimi',
          reviewerProvider: 'kimi',
        }),
        /ALLOW_REAL_PROVIDER/
      );
    });

    it('requires ALLOW_REAL_REPO_APPLY', async () => {
      const def = createRealDefinition([
        {
          task_id: 'task-1',
          title: 'First task',
          goal: 'Do first thing',
          allowed_files: ['a.txt'],
          denied_files: [],
          max_lines_changed: 50,
          checks: ['node -e "require(\'fs\').existsSync(\'a.txt\')||process.exit(1)"'],
        },
      ]);
      saveRealDefinitionAndState(def);

      await assert.rejects(
        runMultiTaskLoop({
              maxTotalAttemptsPerRun: 20,
          blockDefinitionPath: realBlockJsonPath,
          mode: 'real_kimi_coder_kimi_reviewer',
          maxTasksPerRun: 1,
          stopOnRejected: true,
          stopOnBlocked: true,
          allowBlockRunOne: true,
          allowRealProvider: true,
          allowRealRepoApply: false,
          allowRealRepoCommit: true,
          allowRealRepoPush: false,
          allowKimiReviewer: true,
          coderProvider: 'kimi',
          reviewerProvider: 'kimi',
        }),
        /ALLOW_REAL_REPO_APPLY/
      );
    });

    it('requires ALLOW_REAL_REPO_COMMIT', async () => {
      const def = createRealDefinition([
        {
          task_id: 'task-1',
          title: 'First task',
          goal: 'Do first thing',
          allowed_files: ['a.txt'],
          denied_files: [],
          max_lines_changed: 50,
          checks: ['node -e "require(\'fs\').existsSync(\'a.txt\')||process.exit(1)"'],
        },
      ]);
      saveRealDefinitionAndState(def);

      await assert.rejects(
        runMultiTaskLoop({
              maxTotalAttemptsPerRun: 20,
          blockDefinitionPath: realBlockJsonPath,
          mode: 'real_kimi_coder_kimi_reviewer',
          maxTasksPerRun: 1,
          stopOnRejected: true,
          stopOnBlocked: true,
          allowBlockRunOne: true,
          allowRealProvider: true,
          allowRealRepoApply: true,
          allowRealRepoCommit: false,
          allowRealRepoPush: false,
          allowKimiReviewer: true,
          coderProvider: 'kimi',
          reviewerProvider: 'kimi',
        }),
        /ALLOW_REAL_REPO_COMMIT/
      );
    });

    it('requires ALLOW_KIMI_REVIEWER', async () => {
      const def = createRealDefinition([
        {
          task_id: 'task-1',
          title: 'First task',
          goal: 'Do first thing',
          allowed_files: ['a.txt'],
          denied_files: [],
          max_lines_changed: 50,
          checks: ['node -e "require(\'fs\').existsSync(\'a.txt\')||process.exit(1)"'],
        },
      ]);
      saveRealDefinitionAndState(def);

      await assert.rejects(
        runMultiTaskLoop({
              maxTotalAttemptsPerRun: 20,
          blockDefinitionPath: realBlockJsonPath,
          mode: 'real_kimi_coder_kimi_reviewer',
          maxTasksPerRun: 1,
          stopOnRejected: true,
          stopOnBlocked: true,
          allowBlockRunOne: true,
          allowRealProvider: true,
          allowRealRepoApply: true,
          allowRealRepoCommit: true,
          allowRealRepoPush: false,
          allowKimiReviewer: false,
          coderProvider: 'kimi',
          reviewerProvider: 'kimi',
        }),
        /ALLOW_KIMI_REVIEWER/
      );
    });

    it('rejects ALLOW_REAL_REPO_PUSH=true', async () => {
      const def = createRealDefinition([
        {
          task_id: 'task-1',
          title: 'First task',
          goal: 'Do first thing',
          allowed_files: ['a.txt'],
          denied_files: [],
          max_lines_changed: 50,
          checks: ['node -e "require(\'fs\').existsSync(\'a.txt\')||process.exit(1)"'],
        },
      ]);
      saveRealDefinitionAndState(def);

      await assert.rejects(
        runMultiTaskLoop({
              maxTotalAttemptsPerRun: 20,
          blockDefinitionPath: realBlockJsonPath,
          mode: 'real_kimi_coder_kimi_reviewer',
          maxTasksPerRun: 1,
          stopOnRejected: true,
          stopOnBlocked: true,
          allowBlockRunOne: true,
          allowRealProvider: true,
          allowRealRepoApply: true,
          allowRealRepoCommit: true,
          allowRealRepoPush: true,
          allowKimiReviewer: true,
          coderProvider: 'kimi',
          reviewerProvider: 'kimi',
        }),
        /ALLOW_REAL_REPO_PUSH=false/
      );
    });

    it('rejects maxTasksPerRun > 3', async () => {
      const def = createRealDefinition([
        {
          task_id: 'task-1',
          title: 'First task',
          goal: 'Do first thing',
          allowed_files: ['a.txt'],
          denied_files: [],
          max_lines_changed: 50,
          checks: ['node -e "require(\'fs\').existsSync(\'a.txt\')||process.exit(1)"'],
        },
      ]);
      saveRealDefinitionAndState(def);

      await assert.rejects(
        runMultiTaskLoop({
              maxTotalAttemptsPerRun: 20,
          blockDefinitionPath: realBlockJsonPath,
          mode: 'real_kimi_coder_kimi_reviewer',
          maxTasksPerRun: 4,
          stopOnRejected: true,
          stopOnBlocked: true,
          allowBlockRunOne: true,
          allowRealProvider: true,
          allowRealRepoApply: true,
          allowRealRepoCommit: true,
          allowRealRepoPush: false,
          allowKimiReviewer: true,
          coderProvider: 'kimi',
          reviewerProvider: 'kimi',
        }),
        /maxTasksPerRun must be <= 3/
      );
    });

    it('runs exactly one task when maxTasksPerRun=1', async () => {
      globalThis.fetch = buildFakeKimiFetchForCoderAndReviewer(
        [{ path: 'a.txt', content: 'hello\n' }],
        {
          decision: 'accepted',
          confidence: 'high',
          blocking_issues: [],
          non_blocking_issues: [],
          review_summary: 'Looks good',
          fix_task: null,
          next_action: 'advance_to_next_task',
        }
      );

      const def = createRealDefinition([
        {
          task_id: 'task-1',
          title: 'First task',
          goal: 'Do first thing',
          allowed_files: ['a.txt'],
          denied_files: [],
          max_lines_changed: 50,
          checks: ['node -e "require(\'fs\').existsSync(\'a.txt\')||process.exit(1)"'],
        },
        {
          task_id: 'task-2',
          title: 'Second task',
          goal: 'Do second thing',
          allowed_files: ['b.txt'],
          denied_files: [],
          max_lines_changed: 50,
          checks: ['node -e "require(\'fs\').existsSync(\'b.txt\')||process.exit(1)"'],
        },
      ]);
      saveRealDefinitionAndState(def);

      const result = await runMultiTaskLoop({
            maxTotalAttemptsPerRun: 20,
        blockDefinitionPath: realBlockJsonPath,
        mode: 'real_kimi_coder_kimi_reviewer',
        maxTasksPerRun: 1,
        stopOnRejected: true,
        stopOnBlocked: true,
        allowBlockRunOne: true,
        allowRealProvider: true,
        allowRealRepoApply: true,
        allowRealRepoCommit: true,
        allowRealRepoPush: false,
        allowKimiReviewer: true,
        coderProvider: 'kimi',
        reviewerProvider: 'kimi',
      });

      assert.strictEqual(result.mode, 'real_kimi_coder_kimi_reviewer');
      assert.strictEqual(result.tasks_attempted, 1);
      assert.strictEqual(result.tasks_accepted, 1);
      assert.strictEqual(result.results.length, 1);
      assert.strictEqual(result.results[0].status_after, 'accepted');
      assert.ok(result.results[0].commit_sha);
      assert.strictEqual(result.results[0].commit_sha!.length, 40);
      assert.strictEqual(result.results[0].pushed, false);
    });

    it('runs two tasks when maxTasksPerRun=2', async () => {
      let callCount = 0;
      globalThis.fetch = async () => {
        callCount++;
        console.log('TEST_FETCH callCount=', callCount);
        if (callCount % 2 === 1) {
          const payload = JSON.stringify({ mode: 'file_update', files: [{ path: `file-${Math.ceil(callCount / 2)}.txt`, content: 'hello\n' }], notes: 'fake' });
          const content = '```json\n' + payload + '\n```';
          return {
            ok: true,
            status: 200,
            json: async () => ({ choices: [{ message: { content } }] }),
          } as unknown as ReturnType<typeof globalThis.fetch>;
        }
        const content = JSON.stringify({
          decision: 'accepted',
          confidence: 'high',
          blocking_issues: [],
          non_blocking_issues: [],
          review_summary: 'Looks good',
          fix_task: null,
          next_action: 'advance_to_next_task',
        });
        return {
          ok: true,
          status: 200,
          json: async () => ({ choices: [{ message: { content } }] }),
        } as unknown as ReturnType<typeof globalThis.fetch>;
      };

      const def = createRealDefinition([
        {
          task_id: 'task-1',
          title: 'First task',
          goal: 'Do first thing',
          allowed_files: ['file-1.txt'],
          denied_files: [],
          max_lines_changed: 50,
          checks: ['node -e "require(\'fs\').existsSync(\'file-1.txt\')||process.exit(1)"'],
        },
        {
          task_id: 'task-2',
          title: 'Second task',
          goal: 'Do second thing',
          allowed_files: ['file-2.txt'],
          denied_files: [],
          max_lines_changed: 50,
          checks: ['node -e "require(\'fs\').existsSync(\'file-2.txt\')||process.exit(1)"'],
        },
        {
          task_id: 'task-3',
          title: 'Third task',
          goal: 'Do third thing',
          allowed_files: ['file-3.txt'],
          denied_files: [],
          max_lines_changed: 50,
          checks: ['node -e "require(\'fs\').existsSync(\'file-3.txt\')||process.exit(1)"'],
        },
      ]);
      saveRealDefinitionAndState(def);

      const result = await runMultiTaskLoop({
            maxTotalAttemptsPerRun: 20,
        blockDefinitionPath: realBlockJsonPath,
        mode: 'real_kimi_coder_kimi_reviewer',
        maxTasksPerRun: 2,
        stopOnRejected: true,
        stopOnBlocked: true,
        allowBlockRunOne: true,
        allowRealProvider: true,
        allowRealRepoApply: true,
        allowRealRepoCommit: true,
        allowRealRepoPush: false,
        allowKimiReviewer: true,
        coderProvider: 'kimi',
        reviewerProvider: 'kimi',
      });

      assert.strictEqual(result.tasks_attempted, 2);
      assert.strictEqual(result.tasks_accepted, 2);
      assert.strictEqual(result.results.length, 2);
      assert.strictEqual(result.final_block_status, 'running');
    });

    it('stops when block completed', async () => {
      let callCount = 0;
      globalThis.fetch = async () => {
        callCount++;
        console.log('TEST_FETCH callCount=', callCount);
        if (callCount % 2 === 1) {
          const payload = JSON.stringify({ mode: 'file_update', files: [{ path: 'a.txt', content: 'hello\n' }], notes: 'fake' });
          const content = '```json\n' + payload + '\n```';
          return {
            ok: true,
            status: 200,
            json: async () => ({ choices: [{ message: { content } }] }),
          } as unknown as ReturnType<typeof globalThis.fetch>;
        }
        const content = JSON.stringify({
          decision: 'accepted',
          confidence: 'high',
          blocking_issues: [],
          non_blocking_issues: [],
          review_summary: 'Looks good',
          fix_task: null,
          next_action: 'advance_to_next_task',
        });
        return {
          ok: true,
          status: 200,
          json: async () => ({ choices: [{ message: { content } }] }),
        } as unknown as ReturnType<typeof globalThis.fetch>;
      };

      const def = createRealDefinition([
        {
          task_id: 'task-1',
          title: 'First task',
          goal: 'Do first thing',
          allowed_files: ['a.txt'],
          denied_files: [],
          max_lines_changed: 50,
          checks: ['node -e "require(\'fs\').existsSync(\'a.txt\')||process.exit(1)"'],
        },
      ]);
      saveRealDefinitionAndState(def);

      const result = await runMultiTaskLoop({
            maxTotalAttemptsPerRun: 20,
        blockDefinitionPath: realBlockJsonPath,
        mode: 'real_kimi_coder_kimi_reviewer',
        maxTasksPerRun: 3,
        stopOnRejected: true,
        stopOnBlocked: true,
        allowBlockRunOne: true,
        allowRealProvider: true,
        allowRealRepoApply: true,
        allowRealRepoCommit: true,
        allowRealRepoPush: false,
        allowKimiReviewer: true,
        coderProvider: 'kimi',
        reviewerProvider: 'kimi',
      });

      assert.strictEqual(result.tasks_attempted, 1);
      assert.strictEqual(result.tasks_accepted, 1);
      assert.strictEqual(result.final_block_status, 'completed');
      assert.strictEqual(result.current_task_id, null);
    });

    it('stops on fix_required', async () => {
      globalThis.fetch = buildFakeKimiFetchForCoderAndReviewer(
        [
          [{ path: 'a.txt', content: 'hello\n' }],
          [{ path: 'a.txt', content: 'fixed\n' }],
          [{ path: 'a.txt', content: 'fixed2\n' }],
        ],
        {
          decision: 'rejected',
          confidence: 'high',
          blocking_issues: ['Fix this'],
          non_blocking_issues: [],
          review_summary: 'Needs fix',
          fix_task: 'Fix it',
          next_action: 'send_fix_to_coder',
        }
      );

      const def = createRealDefinition([
        {
          task_id: 'task-1',
          title: 'First task',
          goal: 'Do first thing',
          allowed_files: ['a.txt'],
          denied_files: [],
          max_lines_changed: 50,
          checks: ['node -e "require(\'fs\').existsSync(\'a.txt\')||process.exit(1)"'],
        },
        {
          task_id: 'task-2',
          title: 'Second task',
          goal: 'Do second thing',
          allowed_files: ['b.txt'],
          denied_files: [],
          max_lines_changed: 50,
          checks: ['node -e "require(\'fs\').existsSync(\'b.txt\')||process.exit(1)"'],
        },
      ]);
      saveRealDefinitionAndState(def);

      const result = await runMultiTaskLoop({
            maxTotalAttemptsPerRun: 20,
        blockDefinitionPath: realBlockJsonPath,
        mode: 'real_kimi_coder_kimi_reviewer',
        maxTasksPerRun: 3,
        stopOnRejected: true,
        stopOnBlocked: true,
        allowBlockRunOne: true,
        allowRealProvider: true,
        allowRealRepoApply: true,
        allowRealRepoCommit: true,
        allowRealRepoPush: false,
        allowKimiReviewer: true,
        coderProvider: 'kimi',
        reviewerProvider: 'kimi',
      });

      assert.strictEqual(result.tasks_attempted, 0);
      assert.strictEqual(result.tasks_fix_required, 1);
      assert.strictEqual(result.tasks_accepted, 0);
      assert.strictEqual(result.final_block_status, 'fixing');
    });

    it('stops on blocked', async () => {
      globalThis.fetch = async () => {
        const payload = JSON.stringify({ mode: 'file_update', files: [{ path: 'a.txt', content: 'sk-leaked\n' }], notes: 'fake' });
        const content = '```json\n' + payload + '\n```';
        return {
          ok: true,
          status: 200,
          json: async () => ({ choices: [{ message: { content } }] }),
        } as unknown as ReturnType<typeof globalThis.fetch>;
      };

      const def = createRealDefinition([
        {
          task_id: 'task-1',
          title: 'First task',
          goal: 'Do first thing',
          allowed_files: ['a.txt'],
          denied_files: [],
          max_lines_changed: 50,
          checks: ['node -e "require(\'fs\').existsSync(\'a.txt\')||process.exit(1)"'],
        },
      ]);
      saveRealDefinitionAndState(def);

      const result = await runMultiTaskLoop({
            maxTotalAttemptsPerRun: 20,
        blockDefinitionPath: realBlockJsonPath,
        mode: 'real_kimi_coder_kimi_reviewer',
        maxTasksPerRun: 3,
        stopOnRejected: true,
        stopOnBlocked: true,
        allowBlockRunOne: true,
        allowRealProvider: true,
        allowRealRepoApply: true,
        allowRealRepoCommit: true,
        allowRealRepoPush: false,
        allowKimiReviewer: true,
        coderProvider: 'kimi',
        reviewerProvider: 'kimi',
      });

      assert.strictEqual(result.tasks_attempted, 1);
      assert.strictEqual(result.tasks_blocked, 1);
      assert.strictEqual(result.final_block_status, 'blocked');
    });

    it('avoids infinite loop if stopOnRejected=false and current_task_id did not advance', async () => {
      globalThis.fetch = buildFakeKimiFetchForCoderAndReviewer(
        [
          [{ path: 'a.txt', content: 'hello\n' }],
          [{ path: 'a.txt', content: 'fixed\n' }],
          [{ path: 'a.txt', content: 'fixed2\n' }],
        ],
        {
          decision: 'rejected',
          confidence: 'high',
          blocking_issues: ['Fix this'],
          non_blocking_issues: [],
          review_summary: 'Needs fix',
          fix_task: 'Fix it',
          next_action: 'send_fix_to_coder',
        }
      );

      const def = createRealDefinition([
        {
          task_id: 'task-1',
          title: 'First task',
          goal: 'Do first thing',
          allowed_files: ['a.txt'],
          denied_files: [],
          max_lines_changed: 50,
          checks: ['node -e "require(\'fs\').existsSync(\'a.txt\')||process.exit(1)"'],
        },
      ]);
      saveRealDefinitionAndState(def);

      const result = await runMultiTaskLoop({
            maxTotalAttemptsPerRun: 20,
        blockDefinitionPath: realBlockJsonPath,
        mode: 'real_kimi_coder_kimi_reviewer',
        maxTasksPerRun: 3,
        stopOnRejected: false,
        stopOnBlocked: true,
        allowBlockRunOne: true,
        allowRealProvider: true,
        allowRealRepoApply: true,
        allowRealRepoCommit: true,
        allowRealRepoPush: false,
        allowKimiReviewer: true,
        coderProvider: 'kimi',
        reviewerProvider: 'kimi',
      });

      // Loop retries until max_fix_attempts (3) is reached, then blocked
      assert.strictEqual(result.tasks_attempted, 1);
      assert.strictEqual(result.tasks_fix_required, 2);
      assert.strictEqual(result.tasks_blocked, 1);
      assert.strictEqual(result.final_block_status, 'blocked');
    });

    it('collects per-task results', async () => {
      globalThis.fetch = buildFakeKimiFetchForCoderAndReviewer(
        [{ path: 'a.txt', content: 'hello\n' }],
        {
          decision: 'accepted',
          confidence: 'high',
          blocking_issues: [],
          non_blocking_issues: [],
          review_summary: 'Looks good',
          fix_task: null,
          next_action: 'advance_to_next_task',
        }
      );

      const def = createRealDefinition([
        {
          task_id: 'task-1',
          title: 'First task',
          goal: 'Do first thing',
          allowed_files: ['a.txt'],
          denied_files: [],
          max_lines_changed: 50,
          checks: ['node -e "require(\'fs\').existsSync(\'a.txt\')||process.exit(1)"'],
        },
      ]);
      saveRealDefinitionAndState(def);

      const result = await runMultiTaskLoop({
            maxTotalAttemptsPerRun: 20,
        blockDefinitionPath: realBlockJsonPath,
        mode: 'real_kimi_coder_kimi_reviewer',
        maxTasksPerRun: 1,
        stopOnRejected: true,
        stopOnBlocked: true,
        allowBlockRunOne: true,
        allowRealProvider: true,
        allowRealRepoApply: true,
        allowRealRepoCommit: true,
        allowRealRepoPush: false,
        allowKimiReviewer: true,
        coderProvider: 'kimi',
        reviewerProvider: 'kimi',
      });

      assert.strictEqual(result.results.length, 1);
      assert.strictEqual(result.results[0].coder_called, true);
      assert.strictEqual(result.results[0].reviewer_called, true);
      assert.strictEqual(result.results[0].reviewer_decision, 'accepted');
      assert.strictEqual(result.results[0].pushed, false);
      assert.ok(result.results[0].commit_sha);
    });

    it('summary counts accepted tasks correctly', async () => {
      let callCount = 0;
      globalThis.fetch = async () => {
        callCount++;
        console.log('TEST_FETCH callCount=', callCount);
        if (callCount % 2 === 1) {
          const payload = JSON.stringify({ mode: 'file_update', files: [{ path: `file-${Math.ceil(callCount / 2)}.txt`, content: 'hello\n' }], notes: 'fake' });
          const content = '```json\n' + payload + '\n```';
          return {
            ok: true,
            status: 200,
            json: async () => ({ choices: [{ message: { content } }] }),
          } as unknown as ReturnType<typeof globalThis.fetch>;
        }
        const content = JSON.stringify({
          decision: 'accepted',
          confidence: 'high',
          blocking_issues: [],
          non_blocking_issues: [],
          review_summary: 'Looks good',
          fix_task: null,
          next_action: 'advance_to_next_task',
        });
        return {
          ok: true,
          status: 200,
          json: async () => ({ choices: [{ message: { content } }] }),
        } as unknown as ReturnType<typeof globalThis.fetch>;
      };

      const def = createRealDefinition([
        {
          task_id: 'task-1',
          title: 'First task',
          goal: 'Do first thing',
          allowed_files: ['file-1.txt'],
          denied_files: [],
          max_lines_changed: 50,
          checks: ['node -e "require(\'fs\').existsSync(\'file-1.txt\')||process.exit(1)"'],
        },
        {
          task_id: 'task-2',
          title: 'Second task',
          goal: 'Do second thing',
          allowed_files: ['file-2.txt'],
          denied_files: [],
          max_lines_changed: 50,
          checks: ['node -e "require(\'fs\').existsSync(\'file-2.txt\')||process.exit(1)"'],
        },
      ]);
      saveRealDefinitionAndState(def);

      const result = await runMultiTaskLoop({
            maxTotalAttemptsPerRun: 20,
        blockDefinitionPath: realBlockJsonPath,
        mode: 'real_kimi_coder_kimi_reviewer',
        maxTasksPerRun: 2,
        stopOnRejected: true,
        stopOnBlocked: true,
        allowBlockRunOne: true,
        allowRealProvider: true,
        allowRealRepoApply: true,
        allowRealRepoCommit: true,
        allowRealRepoPush: false,
        allowKimiReviewer: true,
        coderProvider: 'kimi',
        reviewerProvider: 'kimi',
      });

      assert.strictEqual(result.tasks_attempted, 2);
      assert.strictEqual(result.tasks_accepted, 2);
      assert.strictEqual(result.tasks_fix_required, 0);
      assert.strictEqual(result.tasks_blocked, 0);
    });

    it('final_block_status is completed after all tasks accepted', async () => {
      let callCount = 0;
      globalThis.fetch = async () => {
        callCount++;
        console.log('TEST_FETCH callCount=', callCount);
        if (callCount % 2 === 1) {
          const payload = JSON.stringify({ mode: 'file_update', files: [{ path: `file-${Math.ceil(callCount / 2)}.txt`, content: 'hello\n' }], notes: 'fake' });
          const content = '```json\n' + payload + '\n```';
          return {
            ok: true,
            status: 200,
            json: async () => ({ choices: [{ message: { content } }] }),
          } as unknown as ReturnType<typeof globalThis.fetch>;
        }
        const content = JSON.stringify({
          decision: 'accepted',
          confidence: 'high',
          blocking_issues: [],
          non_blocking_issues: [],
          review_summary: 'Looks good',
          fix_task: null,
          next_action: 'advance_to_next_task',
        });
        return {
          ok: true,
          status: 200,
          json: async () => ({ choices: [{ message: { content } }] }),
        } as unknown as ReturnType<typeof globalThis.fetch>;
      };

      const def = createRealDefinition([
        {
          task_id: 'task-1',
          title: 'First task',
          goal: 'Do first thing',
          allowed_files: ['file-1.txt'],
          denied_files: [],
          max_lines_changed: 50,
          checks: ['node -e "require(\'fs\').existsSync(\'file-1.txt\')||process.exit(1)"'],
        },
        {
          task_id: 'task-2',
          title: 'Second task',
          goal: 'Do second thing',
          allowed_files: ['file-2.txt'],
          denied_files: [],
          max_lines_changed: 50,
          checks: ['node -e "require(\'fs\').existsSync(\'file-2.txt\')||process.exit(1)"'],
        },
      ]);
      saveRealDefinitionAndState(def);

      const result = await runMultiTaskLoop({
            maxTotalAttemptsPerRun: 20,
        blockDefinitionPath: realBlockJsonPath,
        mode: 'real_kimi_coder_kimi_reviewer',
        maxTasksPerRun: 3,
        stopOnRejected: true,
        stopOnBlocked: true,
        allowBlockRunOne: true,
        allowRealProvider: true,
        allowRealRepoApply: true,
        allowRealRepoCommit: true,
        allowRealRepoPush: false,
        allowKimiReviewer: true,
        coderProvider: 'kimi',
        reviewerProvider: 'kimi',
      });

      assert.strictEqual(result.final_block_status, 'completed');
      assert.strictEqual(result.current_task_id, null);
    });

    it('no real Kimi calls in tests — fake fetch only', async () => {
      let fetchCalled = false;
      const inner = buildFakeKimiFetchForCoderAndReviewer(
        [{ path: 'a.txt', content: 'hello\n' }],
        {
          decision: 'accepted',
          confidence: 'high',
          blocking_issues: [],
          non_blocking_issues: [],
          review_summary: 'Looks good',
          fix_task: null,
          next_action: 'advance_to_next_task',
        }
      );
      globalThis.fetch = async (...args: Parameters<typeof globalThis.fetch>) => {
        fetchCalled = true;
        return inner(...args);
      };

      const def = createRealDefinition([
        {
          task_id: 'task-1',
          title: 'First task',
          goal: 'Do first thing',
          allowed_files: ['a.txt'],
          denied_files: [],
          max_lines_changed: 50,
          checks: ['node -e "require(\'fs\').existsSync(\'a.txt\')||process.exit(1)"'],
        },
      ]);
      saveRealDefinitionAndState(def);

      await runMultiTaskLoop({
            maxTotalAttemptsPerRun: 20,
        blockDefinitionPath: realBlockJsonPath,
        mode: 'real_kimi_coder_kimi_reviewer',
        maxTasksPerRun: 1,
        stopOnRejected: true,
        stopOnBlocked: true,
        allowBlockRunOne: true,
        allowRealProvider: true,
        allowRealRepoApply: true,
        allowRealRepoCommit: true,
        allowRealRepoPush: false,
        allowKimiReviewer: true,
        coderProvider: 'kimi',
        reviewerProvider: 'kimi',
      });

      assert.ok(fetchCalled, 'Expected fake fetch to be called');
    });

    it('no secrets in result', async () => {
      globalThis.fetch = buildFakeKimiFetchForCoderAndReviewer(
        [{ path: 'a.txt', content: 'hello\n' }],
        {
          decision: 'accepted',
          confidence: 'high',
          blocking_issues: [],
          non_blocking_issues: [],
          review_summary: 'Looks good',
          fix_task: null,
          next_action: 'advance_to_next_task',
        }
      );

      const def = createRealDefinition([
        {
          task_id: 'task-1',
          title: 'First task',
          goal: 'Do first thing',
          allowed_files: ['a.txt'],
          denied_files: [],
          max_lines_changed: 50,
          checks: ['node -e "require(\'fs\').existsSync(\'a.txt\')||process.exit(1)"'],
        },
      ]);
      saveRealDefinitionAndState(def);

      const result = await runMultiTaskLoop({
            maxTotalAttemptsPerRun: 20,
        blockDefinitionPath: realBlockJsonPath,
        mode: 'real_kimi_coder_kimi_reviewer',
        maxTasksPerRun: 1,
        stopOnRejected: true,
        stopOnBlocked: true,
        allowBlockRunOne: true,
        allowRealProvider: true,
        allowRealRepoApply: true,
        allowRealRepoCommit: true,
        allowRealRepoPush: false,
        allowKimiReviewer: true,
        coderProvider: 'kimi',
        reviewerProvider: 'kimi',
      });

      const json = JSON.stringify(result);
      assert.ok(!json.includes('sk-test12345'), 'API key leaked in result');
    });
  });
});
