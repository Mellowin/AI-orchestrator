import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { writeFileSync, mkdirSync, rmSync, existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { runOneTaskLoop } from '../src/block/block-one-task-loop.js';
import { initBlockState, loadBlockState, getBlockRunDir } from '../src/block/block-state-manager.js';
import type { BlockDefinition } from '../src/block/block-types.js';

function initGitRepo(repoPath: string): void {
  spawnSync('git', ['init'], { cwd: repoPath, shell: false, encoding: 'utf-8' });
  spawnSync('git', ['config', 'user.email', 'test@test.com'], { cwd: repoPath, shell: false, encoding: 'utf-8' });
  spawnSync('git', ['config', 'user.name', 'Test'], { cwd: repoPath, shell: false, encoding: 'utf-8' });
  writeFileSync(join(repoPath, 'initial.txt'), 'initial\n');
  spawnSync('git', ['add', 'initial.txt'], { cwd: repoPath, shell: false, encoding: 'utf-8' });
  spawnSync('git', ['commit', '-m', 'initial', '--no-gpg-sign'], { cwd: repoPath, shell: false, encoding: 'utf-8' });
}

function buildFakeKimiFetchResponse(files: Array<{ path: string; content: string }>): typeof globalThis.fetch {
  const payload = JSON.stringify({ mode: 'file_update', files, notes: 'fake' });
  const content = '```json\n' + payload + '\n```';
  return async () =>
    ({
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { content } }],
      }),
    }) as unknown as ReturnType<typeof globalThis.fetch>;
}

function buildFakeKimiFetchForCoderAndReviewer(
  coderFiles: Array<{ path: string; content: string }>,
  reviewerDecision: Record<string, unknown>
): typeof globalThis.fetch {
  let callCount = 0;
  return async () => {
    callCount++;
    if (callCount === 1) {
      const payload = JSON.stringify({ mode: 'file_update', files: coderFiles, notes: 'fake' });
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

let originalFetch: typeof globalThis.fetch;

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

  it('real_kimi_coder_kimi_reviewer missing ALLOW_KIMI_REVIEWER fails before state mutation', async () => {
    const beforeState = loadBlockState(blockId);
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
      /ALLOW_KIMI_REVIEWER/
    );
    const afterState = loadBlockState(blockId);
    assert.strictEqual(afterState!.tasks[0].status, beforeState!.tasks[0].status);
  });

  describe('real mode with temp repo', () => {
    let realRepoPath: string;
    let realBlockJsonPath: string;
    let realBlockId: string;

    beforeEach(() => {
      realRepoPath = mkdtempSync(join(tmpdir(), 'block-real-test-'));
      initGitRepo(realRepoPath);
      spawnSync('git', ['checkout', '-b', 'feature/test'], { cwd: realRepoPath, shell: false, encoding: 'utf-8' });

      realBlockId = `real-block-${Date.now()}`;
      const definition: BlockDefinition = {
        block_id: realBlockId,
        title: 'Real Test Block',
        repo_path: realRepoPath,
        base_branch: 'main',
        work_branch: 'feature/test',
        providers: {
          coder: { provider: 'kimi', model: 'kimi-k2.6' },
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
        ],
      };

      realBlockJsonPath = join(tmpdir(), `block-${realBlockId}.json`);
      writeFileSync(realBlockJsonPath, JSON.stringify(definition, null, 2));

      const state = initBlockState(definition);
      const runDir = getBlockRunDir(realBlockId);
      if (!existsSync(runDir)) {
        mkdirSync(runDir, { recursive: true });
      }
      writeFileSync(join(runDir, 'block-state.json'), JSON.stringify(state, null, 2));

      originalFetch = globalThis.fetch;
      process.env.KIMI_API_KEY = 'fake-key';
      process.env.KIMI_BASE_URL = 'https://api.moonshot.cn/v1';
    });

    afterEach(() => {
      globalThis.fetch = originalFetch;
      delete process.env.KIMI_API_KEY;
      delete process.env.KIMI_BASE_URL;
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

    it('real mode dirty repo fails before provider call', async () => {
      writeFileSync(join(realRepoPath, 'dirty.txt'), 'dirty\n');
      await assert.rejects(
        runOneTaskLoop({
          blockId: realBlockId,
          mode: 'real_kimi_coder_fake_reviewer',
          allowBlockRunOne: true,
          allowRealProvider: true,
          allowRealRepoApply: true,
          allowRealRepoCommit: true,
          allowRealRepoPush: false,
          allowKimiReviewer: false,
          reviewerProvider: 'fake',
          coderProvider: 'kimi',
          blockDefinitionPath: realBlockJsonPath,
        }),
        /not clean/
      );
    });

    it('real mode branch main fails before provider call', async () => {
      spawnSync('git', ['checkout', 'main'], { cwd: realRepoPath, shell: false, encoding: 'utf-8' });
      await assert.rejects(
        runOneTaskLoop({
          blockId: realBlockId,
          mode: 'real_kimi_coder_fake_reviewer',
          allowBlockRunOne: true,
          allowRealProvider: true,
          allowRealRepoApply: true,
          allowRealRepoCommit: true,
          allowRealRepoPush: false,
          allowKimiReviewer: false,
          reviewerProvider: 'fake',
          coderProvider: 'kimi',
          blockDefinitionPath: realBlockJsonPath,
        }),
        /main/
      );
    });

    it('real mode branch mismatch fails before provider call', async () => {
      spawnSync('git', ['checkout', '-b', 'feature/other'], { cwd: realRepoPath, shell: false, encoding: 'utf-8' });
      await assert.rejects(
        runOneTaskLoop({
          blockId: realBlockId,
          mode: 'real_kimi_coder_fake_reviewer',
          allowBlockRunOne: true,
          allowRealProvider: true,
          allowRealRepoApply: true,
          allowRealRepoCommit: true,
          allowRealRepoPush: false,
          allowKimiReviewer: false,
          reviewerProvider: 'fake',
          coderProvider: 'kimi',
          blockDefinitionPath: realBlockJsonPath,
        }),
        /does not match work branch/
      );
    });

    it('real mode with fake Kimi response calls coder', async () => {
      globalThis.fetch = buildFakeKimiFetchResponse([
        { path: 'greeting.txt', content: 'hello world\n' },
      ]);

      const result = await runOneTaskLoop({
        blockId: realBlockId,
        mode: 'real_kimi_coder_fake_reviewer',
        allowBlockRunOne: true,
        allowRealProvider: true,
        allowRealRepoApply: true,
        allowRealRepoCommit: true,
        allowRealRepoPush: false,
        allowKimiReviewer: false,
        reviewerProvider: 'fake',
        coderProvider: 'kimi',
        blockDefinitionPath: realBlockJsonPath,
      });

      assert.strictEqual(result.block_id, realBlockId);
      assert.strictEqual(result.task_id, 'task-1');
      assert.strictEqual(result.coder_called, true);
      assert.strictEqual(result.checks_passed, true);
      assert.ok(result.commit_sha, 'commit_sha should be present');
      assert.strictEqual(result.commit_sha!.length, 40);
      assert.strictEqual(result.pushed, false);
    });

    it('real mode applies approved file only', async () => {
      globalThis.fetch = buildFakeKimiFetchResponse([
        { path: 'greeting.txt', content: 'hello world\n' },
      ]);

      await runOneTaskLoop({
        blockId: realBlockId,
        mode: 'real_kimi_coder_fake_reviewer',
        allowBlockRunOne: true,
        allowRealProvider: true,
        allowRealRepoApply: true,
        allowRealRepoCommit: true,
        allowRealRepoPush: false,
        allowKimiReviewer: false,
        reviewerProvider: 'fake',
        coderProvider: 'kimi',
        blockDefinitionPath: realBlockJsonPath,
      });

      assert.strictEqual(existsSync(join(realRepoPath, 'greeting.txt')), true);
    });

    it('real mode rejects denied file before apply', async () => {
      globalThis.fetch = buildFakeKimiFetchResponse([
        { path: 'secret.txt', content: 'secret\n' },
      ]);

      const result = await runOneTaskLoop({
        blockId: realBlockId,
        mode: 'real_kimi_coder_fake_reviewer',
        allowBlockRunOne: true,
        allowRealProvider: true,
        allowRealRepoApply: true,
        allowRealRepoCommit: true,
        allowRealRepoPush: false,
        allowKimiReviewer: false,
        reviewerProvider: 'fake',
        coderProvider: 'kimi',
        blockDefinitionPath: realBlockJsonPath,
      });

      assert.strictEqual(result.status_after, 'checks_failed');
      assert.strictEqual(result.files_applied.length, 0);
      assert.strictEqual(existsSync(join(realRepoPath, 'secret.txt')), false);
    });

    it('real mode check failure rolls back and no commit', async () => {
      globalThis.fetch = buildFakeKimiFetchResponse([
        { path: 'greeting.txt', content: 'hello world\n' },
      ]);

      // Replace the block definition with a task that has a failing check
      const definition: BlockDefinition = {
        block_id: realBlockId,
        title: 'Real Test Block',
        repo_path: realRepoPath,
        base_branch: 'main',
        work_branch: 'feature/test',
        providers: {
          coder: { provider: 'kimi', model: 'kimi-k2.6' },
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
            checks: ['node -e process.exit(1)'],
          },
        ],
      };
      writeFileSync(realBlockJsonPath, JSON.stringify(definition, null, 2));

      const result = await runOneTaskLoop({
        blockId: realBlockId,
        mode: 'real_kimi_coder_fake_reviewer',
        allowBlockRunOne: true,
        allowRealProvider: true,
        allowRealRepoApply: true,
        allowRealRepoCommit: true,
        allowRealRepoPush: false,
        allowKimiReviewer: false,
        reviewerProvider: 'fake',
        coderProvider: 'kimi',
        blockDefinitionPath: realBlockJsonPath,
      });

      assert.strictEqual(result.status_after, 'checks_failed');
      assert.strictEqual(result.checks_passed, false);
      assert.strictEqual(result.commit_sha, null);
      assert.strictEqual(existsSync(join(realRepoPath, 'greeting.txt')), false);
    });

    it('real mode check success commits', async () => {
      globalThis.fetch = buildFakeKimiFetchResponse([
        { path: 'greeting.txt', content: 'hello world\n' },
      ]);

      const result = await runOneTaskLoop({
        blockId: realBlockId,
        mode: 'real_kimi_coder_fake_reviewer',
        allowBlockRunOne: true,
        allowRealProvider: true,
        allowRealRepoApply: true,
        allowRealRepoCommit: true,
        allowRealRepoPush: false,
        allowKimiReviewer: false,
        reviewerProvider: 'fake',
        coderProvider: 'kimi',
        blockDefinitionPath: realBlockJsonPath,
      });

      assert.strictEqual(result.status_after, 'accepted');
      assert.strictEqual(result.checks_passed, true);
      assert.ok(result.commit_sha);
      assert.strictEqual(result.commit_sha!.length, 40);
    });

    it('real mode push disabled returns pushed=false', async () => {
      globalThis.fetch = buildFakeKimiFetchResponse([
        { path: 'greeting.txt', content: 'hello world\n' },
      ]);

      const result = await runOneTaskLoop({
        blockId: realBlockId,
        mode: 'real_kimi_coder_fake_reviewer',
        allowBlockRunOne: true,
        allowRealProvider: true,
        allowRealRepoApply: true,
        allowRealRepoCommit: true,
        allowRealRepoPush: false,
        allowKimiReviewer: false,
        reviewerProvider: 'fake',
        coderProvider: 'kimi',
        blockDefinitionPath: realBlockJsonPath,
      });

      assert.strictEqual(result.pushed, false);
      assert.ok(result.safety_findings.some((f) => f.includes('Push not performed')));
    });

    it('missing KIMI_API_KEY fails safely before provider call', async () => {
      delete process.env.KIMI_API_KEY;
      await assert.rejects(
        runOneTaskLoop({
          blockId: realBlockId,
          mode: 'real_kimi_coder_fake_reviewer',
          allowBlockRunOne: true,
          allowRealProvider: true,
          allowRealRepoApply: true,
          allowRealRepoCommit: true,
          allowRealRepoPush: false,
          allowKimiReviewer: false,
          reviewerProvider: 'fake',
          coderProvider: 'kimi',
          blockDefinitionPath: realBlockJsonPath,
        }),
        /KIMI_API_KEY is required/
      );
    });

    it('real mode reviewer is fake', async () => {
      globalThis.fetch = buildFakeKimiFetchResponse([
        { path: 'greeting.txt', content: 'hello world\n' },
      ]);

      const result = await runOneTaskLoop({
        blockId: realBlockId,
        mode: 'real_kimi_coder_fake_reviewer',
        allowBlockRunOne: true,
        allowRealProvider: true,
        allowRealRepoApply: true,
        allowRealRepoCommit: true,
        allowRealRepoPush: false,
        allowKimiReviewer: false,
        reviewerProvider: 'fake',
        coderProvider: 'kimi',
        blockDefinitionPath: realBlockJsonPath,
      });

      // Fake reviewer is called (not Kimi reviewer)
      assert.strictEqual(result.reviewer_called, true);
      assert.strictEqual(result.reviewer_decision, 'accepted');
    });

    it('real mode accepted updates block state', async () => {
      globalThis.fetch = buildFakeKimiFetchResponse([
        { path: 'greeting.txt', content: 'hello world\n' },
      ]);

      await runOneTaskLoop({
        blockId: realBlockId,
        mode: 'real_kimi_coder_fake_reviewer',
        allowBlockRunOne: true,
        allowRealProvider: true,
        allowRealRepoApply: true,
        allowRealRepoCommit: true,
        allowRealRepoPush: false,
        allowKimiReviewer: false,
        reviewerProvider: 'fake',
        coderProvider: 'kimi',
        blockDefinitionPath: realBlockJsonPath,
      });

      const state = loadBlockState(realBlockId);
      assert.ok(state);
      const task = state!.tasks.find((t) => t.task_id === 'task-1');
      assert.strictEqual(task!.status, 'accepted');
      assert.ok(task!.commit_sha);
      assert.strictEqual(task!.commit_sha!.length, 40);
      assert.strictEqual(task!.pushed_ref, null);
    });

    it('accepted + pushed=true stores pushed_ref in block state', async () => {
      globalThis.fetch = buildFakeKimiFetchResponse([
        { path: 'greeting.txt', content: 'hello world\n' },
      ]);

      // Set up a bare remote so push can succeed
      const remotePath = mkdtempSync(join(tmpdir(), 'block-git-remote-'));
      spawnSync('git', ['init', '--bare'], { cwd: remotePath, shell: false, encoding: 'utf-8' });
      spawnSync('git', ['remote', 'add', 'origin', remotePath], { cwd: realRepoPath, shell: false, encoding: 'utf-8' });

      await runOneTaskLoop({
        blockId: realBlockId,
        mode: 'real_kimi_coder_fake_reviewer',
        allowBlockRunOne: true,
        allowRealProvider: true,
        allowRealRepoApply: true,
        allowRealRepoCommit: true,
        allowRealRepoPush: true,
        allowKimiReviewer: false,
        reviewerProvider: 'fake',
        coderProvider: 'kimi',
        blockDefinitionPath: realBlockJsonPath,
      });

      const state = loadBlockState(realBlockId);
      assert.ok(state);
      const task = state!.tasks.find((t) => t.task_id === 'task-1');
      assert.strictEqual(task!.status, 'accepted');
      assert.ok(task!.commit_sha);
      assert.strictEqual(task!.pushed_ref, 'feature/test');

      rmSync(remotePath, { recursive: true, force: true });
    });

    it('real mode rejected updates fix_required', async () => {
      globalThis.fetch = buildFakeKimiFetchResponse([
        { path: 'greeting.txt', content: 'hello world\n' },
      ]);

      const result = await runOneTaskLoop({
        blockId: realBlockId,
        mode: 'real_kimi_coder_fake_reviewer',
        allowBlockRunOne: true,
        allowRealProvider: true,
        allowRealRepoApply: true,
        allowRealRepoCommit: true,
        allowRealRepoPush: false,
        allowKimiReviewer: false,
        reviewerProvider: 'fake',
        coderProvider: 'kimi',
        blockDefinitionPath: realBlockJsonPath,
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
      assert.strictEqual(result.next_action, 'send_fix_to_coder');

      const state = loadBlockState(realBlockId);
      const task = state!.tasks.find((t) => t.task_id === 'task-1');
      assert.strictEqual(task!.status, 'fix_required');
      assert.strictEqual(task!.fix_attempts, 1);
    });

    it('no merge', async () => {
      globalThis.fetch = buildFakeKimiFetchResponse([
        { path: 'greeting.txt', content: 'hello world\n' },
      ]);

      await runOneTaskLoop({
        blockId: realBlockId,
        mode: 'real_kimi_coder_fake_reviewer',
        allowBlockRunOne: true,
        allowRealProvider: true,
        allowRealRepoApply: true,
        allowRealRepoCommit: true,
        allowRealRepoPush: false,
        allowKimiReviewer: false,
        reviewerProvider: 'fake',
        coderProvider: 'kimi',
        blockDefinitionPath: realBlockJsonPath,
      });

      const branch = spawnSync('git', ['log', '--oneline', '--merges'], { cwd: realRepoPath, shell: false, encoding: 'utf-8' }).stdout;
      assert.strictEqual(branch.trim(), '', 'No merge commits should exist');
    });

    it('no checkout/switch', async () => {
      globalThis.fetch = buildFakeKimiFetchResponse([
        { path: 'greeting.txt', content: 'hello world\n' },
      ]);

      await runOneTaskLoop({
        blockId: realBlockId,
        mode: 'real_kimi_coder_fake_reviewer',
        allowBlockRunOne: true,
        allowRealProvider: true,
        allowRealRepoApply: true,
        allowRealRepoCommit: true,
        allowRealRepoPush: false,
        allowKimiReviewer: false,
        reviewerProvider: 'fake',
        coderProvider: 'kimi',
        blockDefinitionPath: realBlockJsonPath,
      });

      const currentBranch = spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: realRepoPath, shell: false, encoding: 'utf-8' }).stdout.trim();
      assert.strictEqual(currentBranch, 'feature/test');
    });

    it('no PR', async () => {
      globalThis.fetch = buildFakeKimiFetchResponse([
        { path: 'greeting.txt', content: 'hello world\n' },
      ]);

      await runOneTaskLoop({
        blockId: realBlockId,
        mode: 'real_kimi_coder_fake_reviewer',
        allowBlockRunOne: true,
        allowRealProvider: true,
        allowRealRepoApply: true,
        allowRealRepoCommit: true,
        allowRealRepoPush: false,
        allowKimiReviewer: false,
        reviewerProvider: 'fake',
        coderProvider: 'kimi',
        blockDefinitionPath: realBlockJsonPath,
      });

      // PR creation would require network calls or gh CLI; we assert no PR state files
      assert.strictEqual(existsSync(join(realRepoPath, 'pr-created.json')), false);
    });

    it('no real reviewer call', async () => {
      globalThis.fetch = buildFakeKimiFetchResponse([
        { path: 'greeting.txt', content: 'hello world\n' },
      ]);

      const result = await runOneTaskLoop({
        blockId: realBlockId,
        mode: 'real_kimi_coder_fake_reviewer',
        allowBlockRunOne: true,
        allowRealProvider: true,
        allowRealRepoApply: true,
        allowRealRepoCommit: true,
        allowRealRepoPush: false,
        allowKimiReviewer: false,
        reviewerProvider: 'fake',
        coderProvider: 'kimi',
        blockDefinitionPath: realBlockJsonPath,
      });

      assert.strictEqual(result.reviewer_called, true);
      assert.strictEqual(result.reviewer_decision, 'accepted');
    });

    describe('real_kimi_coder_kimi_reviewer', () => {
      let kimiBlockId: string;
      let kimiBlockJsonPath: string;

      beforeEach(() => {
        kimiBlockId = `kimi-rev-${Date.now()}`;
        const definition: BlockDefinition = {
          block_id: kimiBlockId,
          title: 'Real Kimi Reviewer Block',
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
          ],
        };

        kimiBlockJsonPath = join(tmpdir(), `block-${kimiBlockId}.json`);
        writeFileSync(kimiBlockJsonPath, JSON.stringify(definition, null, 2));

        const state = initBlockState(definition);
        const runDir = getBlockRunDir(kimiBlockId);
        if (!existsSync(runDir)) {
          mkdirSync(runDir, { recursive: true });
        }
        writeFileSync(join(runDir, 'block-state.json'), JSON.stringify(state, null, 2));
      });

      afterEach(() => {
        try {
          const runDir = getBlockRunDir(kimiBlockId);
          if (existsSync(runDir)) {
            rmSync(runDir, { recursive: true, force: true });
          }
          if (existsSync(kimiBlockJsonPath)) {
            rmSync(kimiBlockJsonPath, { force: true });
          }
        } catch {
          // ignore cleanup errors
        }
      });

      it('missing KIMI_API_KEY does not change block state', async () => {
        delete process.env.KIMI_API_KEY;
        const beforeState = loadBlockState(kimiBlockId);
        await assert.rejects(
          runOneTaskLoop({
            blockId: kimiBlockId,
            mode: 'real_kimi_coder_kimi_reviewer',
            allowBlockRunOne: true,
            allowRealProvider: true,
            allowRealRepoApply: true,
            allowRealRepoCommit: true,
            allowRealRepoPush: false,
            allowKimiReviewer: true,
            reviewerProvider: 'kimi',
            coderProvider: 'kimi',
            blockDefinitionPath: kimiBlockJsonPath,
          }),
          /KIMI_API_KEY is required/
        );
        const afterState = loadBlockState(kimiBlockId);
        assert.strictEqual(afterState!.tasks[0].status, beforeState!.tasks[0].status);
      });

      it('deterministic failure does not call real reviewer', async () => {
        globalThis.fetch = buildFakeKimiFetchResponse([
          { path: 'greeting.txt', content: 'hello world\n' },
        ]);

        // Replace definition with failing check
        const definition: BlockDefinition = {
          block_id: kimiBlockId,
          title: 'Real Kimi Reviewer Block',
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
          tasks: [
            {
              task_id: 'task-1',
              title: 'Add greeting file',
              goal: 'Create a greeting file with hello world',
              allowed_files: ['greeting.txt'],
              denied_files: ['secret.txt'],
              max_lines_changed: 50,
              checks: ['node -e process.exit(1)'],
            },
          ],
        };
        writeFileSync(kimiBlockJsonPath, JSON.stringify(definition, null, 2));

        const result = await runOneTaskLoop({
          blockId: kimiBlockId,
          mode: 'real_kimi_coder_kimi_reviewer',
          allowBlockRunOne: true,
          allowRealProvider: true,
          allowRealRepoApply: true,
          allowRealRepoCommit: true,
          allowRealRepoPush: false,
          allowKimiReviewer: true,
          reviewerProvider: 'kimi',
          coderProvider: 'kimi',
          blockDefinitionPath: kimiBlockJsonPath,
        });

        assert.strictEqual(result.status_after, 'checks_failed');
        assert.strictEqual(result.reviewer_called, false);
        assert.strictEqual(result.checks_passed, false);
      });

      it('real Kimi coder + real Kimi reviewer accepted updates state to accepted', async () => {
        globalThis.fetch = buildFakeKimiFetchForCoderAndReviewer(
          [{ path: 'greeting.txt', content: 'hello world\n' }],
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

        const result = await runOneTaskLoop({
          blockId: kimiBlockId,
          mode: 'real_kimi_coder_kimi_reviewer',
          allowBlockRunOne: true,
          allowRealProvider: true,
          allowRealRepoApply: true,
          allowRealRepoCommit: true,
          allowRealRepoPush: false,
          allowKimiReviewer: true,
          reviewerProvider: 'kimi',
          coderProvider: 'kimi',
          blockDefinitionPath: kimiBlockJsonPath,
        });

        assert.strictEqual(result.status_after, 'accepted');
        assert.strictEqual(result.coder_called, true);
        assert.strictEqual(result.reviewer_called, true);
        assert.strictEqual(result.reviewer_decision, 'accepted');
        assert.strictEqual(result.next_action, 'advance_to_next_task');
        assert.ok(result.commit_sha);
        assert.strictEqual(result.commit_sha!.length, 40);

        const state = loadBlockState(kimiBlockId);
        const task = state!.tasks.find((t) => t.task_id === 'task-1');
        assert.strictEqual(task!.status, 'accepted');
      });

      it('real reviewer rejected with send_fix_to_coder updates fix_required', async () => {
        globalThis.fetch = buildFakeKimiFetchForCoderAndReviewer(
          [{ path: 'greeting.txt', content: 'hello world\n' }],
          {
            decision: 'rejected',
            confidence: 'high',
            blocking_issues: ['Missing newline at EOF'],
            non_blocking_issues: [],
            review_summary: 'Fix missing newline',
            fix_task: 'Add newline',
            next_action: 'send_fix_to_coder',
          }
        );

        const result = await runOneTaskLoop({
          blockId: kimiBlockId,
          mode: 'real_kimi_coder_kimi_reviewer',
          allowBlockRunOne: true,
          allowRealProvider: true,
          allowRealRepoApply: true,
          allowRealRepoCommit: true,
          allowRealRepoPush: false,
          allowKimiReviewer: true,
          reviewerProvider: 'kimi',
          coderProvider: 'kimi',
          blockDefinitionPath: kimiBlockJsonPath,
        });

        assert.strictEqual(result.status_after, 'fix_required');
        assert.strictEqual(result.reviewer_decision, 'rejected');
        assert.strictEqual(result.next_action, 'send_fix_to_coder');

        const state = loadBlockState(kimiBlockId);
        const task = state!.tasks.find((t) => t.task_id === 'task-1');
        assert.strictEqual(task!.status, 'fix_required');
        assert.strictEqual(task!.fix_attempts, 1);
      });

      it('real reviewer rejected with block_for_human updates blocked', async () => {
        globalThis.fetch = buildFakeKimiFetchForCoderAndReviewer(
          [{ path: 'greeting.txt', content: 'api_key = sk-test12345\n' }],
          {
            decision: 'rejected',
            confidence: 'high',
            blocking_issues: ['Secret pattern detected'],
            non_blocking_issues: [],
            review_summary: 'Blocked for human review',
            fix_task: 'Remove secret',
            next_action: 'block_for_human',
          }
        );

        const result = await runOneTaskLoop({
          blockId: kimiBlockId,
          mode: 'real_kimi_coder_kimi_reviewer',
          allowBlockRunOne: true,
          allowRealProvider: true,
          allowRealRepoApply: true,
          allowRealRepoCommit: true,
          allowRealRepoPush: false,
          allowKimiReviewer: true,
          reviewerProvider: 'kimi',
          coderProvider: 'kimi',
          blockDefinitionPath: kimiBlockJsonPath,
        });

        assert.strictEqual(result.status_after, 'blocked');
        assert.strictEqual(result.next_action, 'block_for_human');

        const state = loadBlockState(kimiBlockId);
        const task = state!.tasks.find((t) => t.task_id === 'task-1');
        assert.strictEqual(task!.status, 'blocked');
      });

      it('accepted + pushed=false keeps pushed_ref null', async () => {
        globalThis.fetch = buildFakeKimiFetchForCoderAndReviewer(
          [{ path: 'greeting.txt', content: 'hello world\n' }],
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

        const result = await runOneTaskLoop({
          blockId: kimiBlockId,
          mode: 'real_kimi_coder_kimi_reviewer',
          allowBlockRunOne: true,
          allowRealProvider: true,
          allowRealRepoApply: true,
          allowRealRepoCommit: true,
          allowRealRepoPush: false,
          allowKimiReviewer: true,
          reviewerProvider: 'kimi',
          coderProvider: 'kimi',
          blockDefinitionPath: kimiBlockJsonPath,
        });

        assert.strictEqual(result.pushed, false);
        assert.ok(result.safety_findings.some((f) => f.includes('Push not performed')));

        const state = loadBlockState(kimiBlockId);
        const task = state!.tasks.find((t) => t.task_id === 'task-1');
        assert.strictEqual(task!.pushed_ref, null);
      });

      it('accepted + pushed=true stores pushed_ref', async () => {
        globalThis.fetch = buildFakeKimiFetchForCoderAndReviewer(
          [{ path: 'greeting.txt', content: 'hello world\n' }],
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

        const remotePath = mkdtempSync(join(tmpdir(), 'block-git-remote-kimi-'));
        spawnSync('git', ['init', '--bare'], { cwd: remotePath, shell: false, encoding: 'utf-8' });
        spawnSync('git', ['remote', 'add', 'origin', remotePath], { cwd: realRepoPath, shell: false, encoding: 'utf-8' });

        const result = await runOneTaskLoop({
          blockId: kimiBlockId,
          mode: 'real_kimi_coder_kimi_reviewer',
          allowBlockRunOne: true,
          allowRealProvider: true,
          allowRealRepoApply: true,
          allowRealRepoCommit: true,
          allowRealRepoPush: true,
          allowKimiReviewer: true,
          reviewerProvider: 'kimi',
          coderProvider: 'kimi',
          blockDefinitionPath: kimiBlockJsonPath,
        });

        assert.strictEqual(result.pushed, true);

        const state = loadBlockState(kimiBlockId);
        const task = state!.tasks.find((t) => t.task_id === 'task-1');
        assert.strictEqual(task!.pushed_ref, 'feature/test');

        rmSync(remotePath, { recursive: true, force: true });
      });

      it('reviewer result invalid schema fails safely', async () => {
        globalThis.fetch = buildFakeKimiFetchForCoderAndReviewer(
          [{ path: 'greeting.txt', content: 'hello world\n' }],
          {
            decision: 'accepted',
            confidence: 'high',
            blocking_issues: ['should be empty'],
            non_blocking_issues: [],
            review_summary: 'Invalid',
            fix_task: null,
            next_action: 'advance_to_next_task',
          }
        );

        await assert.rejects(
          runOneTaskLoop({
            blockId: kimiBlockId,
            mode: 'real_kimi_coder_kimi_reviewer',
            allowBlockRunOne: true,
            allowRealProvider: true,
            allowRealRepoApply: true,
            allowRealRepoCommit: true,
            allowRealRepoPush: false,
            allowKimiReviewer: true,
            reviewerProvider: 'kimi',
            coderProvider: 'kimi',
            blockDefinitionPath: kimiBlockJsonPath,
          }),
          /Accepted decision must have empty blocking_issues/
        );
      });

      it('reviewer API failure fails safely and does not corrupt commit state', async () => {
        let callCount = 0;
        globalThis.fetch = async () => {
          callCount++;
          if (callCount === 1) {
            const payload = JSON.stringify({ mode: 'file_update', files: [{ path: 'greeting.txt', content: 'hello world\n' }], notes: 'fake' });
            const content = '```json\n' + payload + '\n```';
            return {
              ok: true,
              status: 200,
              json: async () => ({ choices: [{ message: { content } }] }),
            } as unknown as ReturnType<typeof globalThis.fetch>;
          }
          return {
            ok: false,
            status: 500,
            json: async () => ({ error: 'server error' }),
          } as unknown as ReturnType<typeof globalThis.fetch>;
        };

        await assert.rejects(
          runOneTaskLoop({
            blockId: kimiBlockId,
            mode: 'real_kimi_coder_kimi_reviewer',
            allowBlockRunOne: true,
            allowRealProvider: true,
            allowRealRepoApply: true,
            allowRealRepoCommit: true,
            allowRealRepoPush: false,
            allowKimiReviewer: true,
            reviewerProvider: 'kimi',
            coderProvider: 'kimi',
            blockDefinitionPath: kimiBlockJsonPath,
          }),
          /Kimi reviewer failed/
        );

        // Commit should still exist in repo (not corrupted/rolled back)
        const afterCommitCount = spawnSync('git', ['rev-list', '--count', 'HEAD'], { cwd: realRepoPath, shell: false, encoding: 'utf-8' }).stdout.trim();
        assert.strictEqual(afterCommitCount, '2');
      });
    });
  });
});
