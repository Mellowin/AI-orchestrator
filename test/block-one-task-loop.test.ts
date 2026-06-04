import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { runOneTaskLoop } from '../src/block/block-one-task-loop.js';
import { initBlockState, loadBlockState, getBlockRunDir } from '../src/block/block-state-manager.js';
import { loadBlockDefinition } from '../src/block/block-loader.js';
import type { BlockDefinition } from '../src/block/block-types.js';

function createTempGitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'block-loop-test-'));
  spawnSync('git', ['init'], { cwd: dir, shell: false, encoding: 'utf-8' });
  spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir, shell: false, encoding: 'utf-8' });
  spawnSync('git', ['config', 'user.name', 'Test'], { cwd: dir, shell: false, encoding: 'utf-8' });
  writeFileSync(join(dir, 'README.md'), '# Test repo\n');
  spawnSync('git', ['add', '-A'], { cwd: dir, shell: false, encoding: 'utf-8' });
  spawnSync('git', ['commit', '-m', 'init', '--no-gpg-sign'], { cwd: dir, shell: false, encoding: 'utf-8' });
  spawnSync('git', ['checkout', '-b', 'feature/test'], { cwd: dir, shell: false, encoding: 'utf-8' });
  return dir;
}

describe('block-one-task-loop', () => {
  let repoPath: string;
  let blockJsonPath: string;
  let blockId: string;

  beforeEach(() => {
    repoPath = createTempGitRepo();
    blockId = `test-block-${Date.now()}`;

    const definition: BlockDefinition = {
      block_id: blockId,
      title: 'Test Block',
      repo_path: repoPath,
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
          checks: ['node -e require("fs").existsSync("greeting.txt")||process.exit(1)'],
        },
      ],
    };

    blockJsonPath = join(tmpdir(), `block-${blockId}.json`);
    writeFileSync(blockJsonPath, JSON.stringify(definition, null, 2));

    // Initialize block state
    const state = initBlockState(definition);
    // Ensure runs dir exists
    const runDir = getBlockRunDir(blockId);
    if (!existsSync(runDir)) {
      mkdirSync(runDir, { recursive: true });
    }
    // Save state manually to correct path
    writeFileSync(join(runDir, 'block-state.json'), JSON.stringify(state, null, 2));
  });

  afterEach(() => {
    try {
      rmSync(repoPath, { recursive: true, force: true });
      const runDir = getBlockRunDir(blockId);
      if (existsSync(runDir)) {
        rmSync(runDir, { recursive: true, force: true });
      }
    } catch {
      // ignore cleanup errors
    }
  });

  it('runs fake mode successfully and marks task accepted', async () => {
    const result = await runOneTaskLoop({
      blockId,
      mode: 'fake',
      allowRealProvider: false,
      allowRealRepoApply: false,
      allowRealRepoCommit: false,
      allowRealRepoPush: false,
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

    const state = loadBlockState(blockId);
    assert.ok(state);
    const task = state!.tasks.find((t) => t.task_id === 'task-1');
    assert.ok(task);
    assert.strictEqual(task!.status, 'accepted');
  });

  it('rejects when block state not found', async () => {
    await assert.rejects(
      runOneTaskLoop({
        blockId: 'nonexistent',
        mode: 'fake',
        allowRealProvider: false,
        allowRealRepoApply: false,
        allowRealRepoCommit: false,
        allowRealRepoPush: false,
        reviewerProvider: 'fake',
        coderProvider: 'fake',
        blockDefinitionPath: blockJsonPath,
      }),
      /Block state not found/
    );
  });
});
