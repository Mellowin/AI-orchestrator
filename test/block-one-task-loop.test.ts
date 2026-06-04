import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runOneTaskLoop } from '../src/block/block-one-task-loop.js';
import { initBlockState, loadBlockState, getBlockRunDir } from '../src/block/block-state-manager.js';
import type { BlockDefinition } from '../src/block/block-types.js';

describe('block-one-task-loop', () => {
  let blockJsonPath: string;
  let blockId: string;

  beforeEach(() => {
    blockId = `test-block-${Date.now()}`;

    const definition: BlockDefinition = {
      block_id: blockId,
      title: 'Test Block',
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
      tasks: [
        {
          task_id: 'task-1',
          title: 'Add greeting file',
          goal: 'Create a greeting file with hello world',
          allowed_files: ['greeting.txt'],
          denied_files: ['secret.txt'],
          max_lines_changed: 50,
          checks: ['node -e "require(\'fs\').existsSync(\'greeting.txt\')||process.exit(1)"'],
        },
        {
          task_id: 'task-2',
          title: 'Second task',
          goal: 'Do nothing',
          allowed_files: ['second.txt'],
          denied_files: [],
          max_lines_changed: 50,
          checks: [],
        },
      ],
    };

    blockJsonPath = join(tmpdir(), `block-${blockId}.json`);
    writeFileSync(blockJsonPath, JSON.stringify(definition, null, 2));

    const state = initBlockState(definition);
    const runDir = getBlockRunDir(blockId);
    if (!existsSync(runDir)) {
      mkdirSync(runDir, { recursive: true });
    }
    writeFileSync(join(runDir, 'block-state.json'), JSON.stringify(state, null, 2));
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

  it('fake mode accepted marks task accepted', async () => {
    const result = await runOneTaskLoop({
      blockId,
      mode: 'fake',
      allowBlockRunOne: false,
      allowRealProvider: false,
      allowRealRepoApply: false,
      allowRealRepoCommit: false,
      allowRealRepoPush: false,
      allowKimiReviewer: false,
      reviewerProvider: 'fake',
      coderProvider: 'fake',
      blockDefinitionPath: blockJsonPath,
      fakeCoderOptions: {
        taskResponse: {
          summary: 'Created greeting file',
          files: [{ path: 'greeting.txt', content: 'hello world\n' }],
        },
      },
    });

    assert.strictEqual(result.block_id, blockId);
    assert.strictEqual(result.task_id, 'task-1');
    assert.strictEqual(result.status_after, 'accepted');
    assert.strictEqual(result.coder_called, true);
    assert.strictEqual(result.reviewer_called, true);
    assert.strictEqual(result.checks_passed, true);
    assert.strictEqual(result.pushed, false);
    assert.strictEqual(result.reviewer_decision, 'accepted');
    assert.strictEqual(result.next_action, 'advance_to_next_task');
    assert.strictEqual(result.files_applied.length, 1);
    assert.strictEqual(result.files_applied[0], 'greeting.txt');
    assert.ok(result.commit_sha, 'commit_sha should be present');
    assert.strictEqual(result.commit_sha!.length, 40);
  });

  it('fake mode accepted advances current_task_id to next task', async () => {
    await runOneTaskLoop({
      blockId,
      mode: 'fake',
      allowBlockRunOne: false,
      allowRealProvider: false,
      allowRealRepoApply: false,
      allowRealRepoCommit: false,
      allowRealRepoPush: false,
      allowKimiReviewer: false,
      reviewerProvider: 'fake',
      coderProvider: 'fake',
      blockDefinitionPath: blockJsonPath,
      fakeCoderOptions: {
        taskResponse: {
          summary: 'Created greeting file',
          files: [{ path: 'greeting.txt', content: 'hello world\n' }],
        },
      },
    });

    const state = loadBlockState(blockId);
    assert.ok(state);
    assert.strictEqual(state!.current_task_id, 'task-2');
    assert.strictEqual(state!.status, 'running');
  });

  it('fake mode accepted on last task completes block', async () => {
    // Accept task-1 first
    await runOneTaskLoop({
      blockId,
      mode: 'fake',
      allowBlockRunOne: false,
      allowRealProvider: false,
      allowRealRepoApply: false,
      allowRealRepoCommit: false,
      allowRealRepoPush: false,
      allowKimiReviewer: false,
      reviewerProvider: 'fake',
      coderProvider: 'fake',
      blockDefinitionPath: blockJsonPath,
      fakeCoderOptions: {
        taskResponse: {
          summary: 'Created greeting file',
          files: [{ path: 'greeting.txt', content: 'hello world\n' }],
        },
      },
    });

    // Now run task-2
    await runOneTaskLoop({
      blockId,
      mode: 'fake',
      allowBlockRunOne: false,
      allowRealProvider: false,
      allowRealRepoApply: false,
      allowRealRepoCommit: false,
      allowRealRepoPush: false,
      allowKimiReviewer: false,
      reviewerProvider: 'fake',
      coderProvider: 'fake',
      blockDefinitionPath: blockJsonPath,
      fakeCoderOptions: {
        taskResponse: {
          summary: 'Created second file',
          files: [{ path: 'second.txt', content: 'second\n' }],
        },
      },
    });

    const after = loadBlockState(blockId);
    assert.ok(after);
    assert.strictEqual(after!.status, 'completed');
    assert.strictEqual(after!.current_task_id, null);
  });

  it('fake mode rejected marks fix_required', async () => {
    const result = await runOneTaskLoop({
      blockId,
      mode: 'fake',
      allowBlockRunOne: false,
      allowRealProvider: false,
      allowRealRepoApply: false,
      allowRealRepoCommit: false,
      allowRealRepoPush: false,
      allowKimiReviewer: false,
      reviewerProvider: 'fake',
      coderProvider: 'fake',
      blockDefinitionPath: blockJsonPath,
      fakeCoderOptions: {
        taskResponse: {
          summary: 'Created greeting file',
          files: [{ path: 'greeting.txt', content: 'hello world\n' }],
        },
      },
      fakeReviewerOptions: {
        decision: {
          decision: 'rejected',
          confidence: 'high',
          blocking_issues: ['Missing newline at EOF'],
          non_blocking_issues: [],
          review_summary: 'Fix missing newline',
          fix_task: 'Add newline',
          next_action: 'send_fix_to_coder',
        },
      },
    });

    assert.strictEqual(result.status_after, 'fix_required');
    assert.strictEqual(result.reviewer_decision, 'rejected');
    assert.strictEqual(result.next_action, 'send_fix_to_coder');

    const state = loadBlockState(blockId);
    const task = state!.tasks.find((t) => t.task_id === 'task-1');
    assert.strictEqual(task!.status, 'fix_required');
    assert.strictEqual(task!.fix_attempts, 1);
  });

  it('fake mode deterministic severe failure blocks task', async () => {
    // Secret pattern in allowed file triggers severe safety issue in deterministic checks
    const result = await runOneTaskLoop({
      blockId,
      mode: 'fake',
      allowBlockRunOne: false,
      allowRealProvider: false,
      allowRealRepoApply: false,
      allowRealRepoCommit: false,
      allowRealRepoPush: false,
      allowKimiReviewer: false,
      reviewerProvider: 'fake',
      coderProvider: 'fake',
      blockDefinitionPath: blockJsonPath,
      fakeCoderOptions: {
        taskResponse: {
          summary: 'Created greeting file with secret',
          files: [{ path: 'greeting.txt', content: 'api_key = sk-test12345\n' }],
        },
      },
    });

    assert.strictEqual(result.status_after, 'blocked');
    assert.strictEqual(result.next_action, 'block_for_human');
    assert.ok(result.safety_findings.some((f) => f.toLowerCase().includes('secret')), `Expected secret finding, got: ${result.safety_findings.join(', ')}`);
  });

  it('fake mode guardrails failure marks checks_failed', async () => {
    const result = await runOneTaskLoop({
      blockId,
      mode: 'fake',
      allowBlockRunOne: false,
      allowRealProvider: false,
      allowRealRepoApply: false,
      allowRealRepoCommit: false,
      allowRealRepoPush: false,
      allowKimiReviewer: false,
      reviewerProvider: 'fake',
      coderProvider: 'fake',
      blockDefinitionPath: blockJsonPath,
      fakeCoderOptions: {
        taskResponse: {
          summary: 'Created wrong file',
          files: [{ path: 'wrong.txt', content: 'nope\n' }],
        },
      },
    });

    assert.strictEqual(result.status_after, 'checks_failed');
    assert.strictEqual(result.checks_passed, false);
    assert.strictEqual(result.next_action, 'send_fix_to_coder');
  });

  it('fake mode only changes one task', async () => {
    const result = await runOneTaskLoop({
      blockId,
      mode: 'fake',
      allowBlockRunOne: false,
      allowRealProvider: false,
      allowRealRepoApply: false,
      allowRealRepoCommit: false,
      allowRealRepoPush: false,
      allowKimiReviewer: false,
      reviewerProvider: 'fake',
      coderProvider: 'fake',
      blockDefinitionPath: blockJsonPath,
      fakeCoderOptions: {
        taskResponse: {
          summary: 'Created greeting file',
          files: [{ path: 'greeting.txt', content: 'hello world\n' }],
        },
      },
    });

    assert.strictEqual(result.task_id, 'task-1');
    const state = loadBlockState(blockId);
    const task2 = state!.tasks.find((t) => t.task_id === 'task-2');
    assert.strictEqual(task2!.status, 'pending');
  });

  it('fake mode does not write files outside block state', async () => {
    await runOneTaskLoop({
      blockId,
      mode: 'fake',
      allowBlockRunOne: false,
      allowRealProvider: false,
      allowRealRepoApply: false,
      allowRealRepoCommit: false,
      allowRealRepoPush: false,
      allowKimiReviewer: false,
      reviewerProvider: 'fake',
      coderProvider: 'fake',
      blockDefinitionPath: blockJsonPath,
      fakeCoderOptions: {
        taskResponse: {
          summary: 'Created greeting file',
          files: [{ path: 'greeting.txt', content: 'hello world\n' }],
        },
      },
    });

    // repo_path is /nonexistent/repo-path-fake-mode — nothing should be created there
    assert.strictEqual(existsSync('/nonexistent/repo-path-fake-mode'), false);
  });

  it('fake mode returns fake 40-char commit SHA', async () => {
    const result = await runOneTaskLoop({
      blockId,
      mode: 'fake',
      allowBlockRunOne: false,
      allowRealProvider: false,
      allowRealRepoApply: false,
      allowRealRepoCommit: false,
      allowRealRepoPush: false,
      allowKimiReviewer: false,
      reviewerProvider: 'fake',
      coderProvider: 'fake',
      blockDefinitionPath: blockJsonPath,
      fakeCoderOptions: {
        taskResponse: {
          summary: 'Created greeting file',
          files: [{ path: 'greeting.txt', content: 'hello world\n' }],
        },
      },
    });

    assert.ok(result.commit_sha);
    assert.strictEqual(result.commit_sha!.length, 40);
    assert.ok(/^f{40}$/.test(result.commit_sha!));
  });

  it('rejects when block state not found', async () => {
    await assert.rejects(
      runOneTaskLoop({
        blockId: 'nonexistent',
        mode: 'fake',
        allowBlockRunOne: false,
        allowRealProvider: false,
        allowRealRepoApply: false,
        allowRealRepoCommit: false,
        allowRealRepoPush: false,
        allowKimiReviewer: false,
        reviewerProvider: 'fake',
        coderProvider: 'fake',
        blockDefinitionPath: blockJsonPath,
      }),
      /Block state not found/
    );
  });

  it('real mode without ALLOW_BLOCK_RUN_ONE fails before mutation', async () => {
    await assert.rejects(
      runOneTaskLoop({
        blockId,
        mode: 'real_kimi_coder_fake_reviewer',
        allowBlockRunOne: false,
        allowRealProvider: true,
        allowRealRepoApply: true,
        allowRealRepoCommit: true,
        allowRealRepoPush: false,
        allowKimiReviewer: false,
        reviewerProvider: 'fake',
        coderProvider: 'kimi',
        blockDefinitionPath: blockJsonPath,
      }),
      /ALLOW_BLOCK_RUN_ONE=true/
    );
  });

  it('real mode without ALLOW_REAL_PROVIDER fails before mutation', async () => {
    await assert.rejects(
      runOneTaskLoop({
        blockId,
        mode: 'real_kimi_coder_fake_reviewer',
        allowBlockRunOne: true,
        allowRealProvider: false,
        allowRealRepoApply: true,
        allowRealRepoCommit: true,
        allowRealRepoPush: false,
        allowKimiReviewer: false,
        reviewerProvider: 'fake',
        coderProvider: 'kimi',
        blockDefinitionPath: blockJsonPath,
      }),
      /ALLOW_REAL_PROVIDER=true/
    );
  });

  it('real mode without ALLOW_REAL_REPO_APPLY fails before mutation', async () => {
    await assert.rejects(
      runOneTaskLoop({
        blockId,
        mode: 'real_kimi_coder_fake_reviewer',
        allowBlockRunOne: true,
        allowRealProvider: true,
        allowRealRepoApply: false,
        allowRealRepoCommit: true,
        allowRealRepoPush: false,
        allowKimiReviewer: false,
        reviewerProvider: 'fake',
        coderProvider: 'kimi',
        blockDefinitionPath: blockJsonPath,
      }),
      /ALLOW_REAL_REPO_APPLY=true/
    );
  });

  it('real mode with Kimi reviewer without ALLOW_KIMI_REVIEWER fails before mutation', async () => {
    await assert.rejects(
      runOneTaskLoop({
        blockId,
        mode: 'real_kimi_coder_kimi_reviewer',
        allowBlockRunOne: true,
        allowRealProvider: true,
        allowRealRepoApply: true,
        allowRealRepoCommit: true,
        allowRealRepoPush: false,
        allowKimiReviewer: false,
        reviewerProvider: 'kimi',
        coderProvider: 'kimi',
        blockDefinitionPath: blockJsonPath,
      }),
      /ALLOW_KIMI_REVIEWER=true/
    );
  });

  it('real mode fails with not implemented safely yet', async () => {
    await assert.rejects(
      runOneTaskLoop({
        blockId,
        mode: 'real_kimi_coder_fake_reviewer',
        allowBlockRunOne: true,
        allowRealProvider: true,
        allowRealRepoApply: true,
        allowRealRepoCommit: true,
        allowRealRepoPush: false,
        allowKimiReviewer: false,
        reviewerProvider: 'fake',
        coderProvider: 'kimi',
        blockDefinitionPath: blockJsonPath,
      }),
      /not implemented safely yet/
    );
  });
});
