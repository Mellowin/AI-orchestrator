import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  getCurrentBlockTaskDefinition,
  buildCoderInputFromBlockTask,
  buildTaskGuardrailsFromBlockTask,
  resolveCoderAndReviewerProviders,
} from '../src/block/block-task-runner.js';
import type { BlockDefinition, BlockState, BlockTaskDefinition } from '../src/block/block-types.js';

describe('block-task-runner', () => {
  const taskDef: BlockTaskDefinition = {
    task_id: 't1',
    title: 'Test task',
    goal: 'Do something',
    allowed_files: ['src/**/*.ts'],
    denied_files: ['src/secret.ts'],
    max_lines_changed: 100,
    checks: ['npm run typecheck', 'npm test'],
  };

  const blockDef: BlockDefinition = {
    block_id: 'b1',
    title: 'Block one',
    repo_path: '/tmp/repo',
    base_branch: 'main',
    work_branch: 'feature/b1',
    providers: {
      coder: { provider: 'fake', model: 'fake-model' },
      reviewer: { provider: 'fake', model: 'fake-model' },
    },
    review_policy: {
      require_deterministic_checks: true,
      max_fix_attempts: 3,
      reviewer_mode: 'single',
    },
    tasks: [taskDef],
  };

  describe('getCurrentBlockTaskDefinition', () => {
    it('returns current task definition when current_task_id matches', () => {
      const state: BlockState = {
        block_id: 'b1',
        title: 'Block one',
        status: 'running',
        repo_path: '/tmp/repo',
        base_branch: 'main',
        work_branch: 'feature/b1',
        current_task_id: 't1',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        tasks: [],
        safety_note: '',
        review_policy: blockDef.review_policy,
      };
      const result = getCurrentBlockTaskDefinition(blockDef, state);
      assert.strictEqual(result.task_id, 't1');
    });

    it('throws when no current_task_id', () => {
      const state: BlockState = {
        block_id: 'b1',
        title: 'Block one',
        status: 'running',
        repo_path: '/tmp/repo',
        base_branch: 'main',
        work_branch: 'feature/b1',
        current_task_id: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        tasks: [],
        safety_note: '',
        review_policy: blockDef.review_policy,
      };
      assert.throws(() => getCurrentBlockTaskDefinition(blockDef, state), /No current task id/);
    });

    it('throws when task not found', () => {
      const state: BlockState = {
        block_id: 'b1',
        title: 'Block one',
        status: 'running',
        repo_path: '/tmp/repo',
        base_branch: 'main',
        work_branch: 'feature/b1',
        current_task_id: 'missing',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        tasks: [],
        safety_note: '',
        review_policy: blockDef.review_policy,
      };
      assert.throws(() => getCurrentBlockTaskDefinition(blockDef, state), /not found/);
    });
  });

  describe('buildCoderInputFromBlockTask', () => {
    it('builds CoderTaskInput from task definition', () => {
      const state: BlockState = {
        block_id: 'b1',
        title: 'Block one',
        status: 'running',
        repo_path: '/tmp/repo',
        base_branch: 'main',
        work_branch: 'feature/b1',
        current_task_id: 't1',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        tasks: [],
        safety_note: '',
        review_policy: blockDef.review_policy,
      };
      const input = buildCoderInputFromBlockTask(blockDef, taskDef, state);
      assert.strictEqual(input.task_id, 't1');
      assert.strictEqual(input.title, 'Test task');
      assert.strictEqual(input.goal, 'Do something');
      assert.deepStrictEqual(input.allowed_files, ['src/**/*.ts']);
      assert.deepStrictEqual(input.denied_files, ['src/secret.ts']);
      assert.strictEqual(input.max_lines_changed, 100);
      assert.strictEqual(typeof input.repo_context, 'string');
    });

    it('coder input includes product vision context', () => {
      const state: BlockState = {
        block_id: 'b1',
        title: 'Block one',
        status: 'running',
        repo_path: '/tmp/repo',
        base_branch: 'main',
        work_branch: 'feature/b1',
        current_task_id: 't1',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        tasks: [],
        safety_note: '',
        review_policy: blockDef.review_policy,
      };
      const input = buildCoderInputFromBlockTask(blockDef, taskDef, state);
      assert.ok(input.repo_context.includes('Do something'));
    });

    it('no provider call during input building', () => {
      const state: BlockState = {
        block_id: 'b1',
        title: 'Block one',
        status: 'running',
        repo_path: '/tmp/repo',
        base_branch: 'main',
        work_branch: 'feature/b1',
        current_task_id: 't1',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        tasks: [],
        safety_note: '',
        review_policy: blockDef.review_policy,
      };
      // buildCoderInputFromBlockTask is pure — it should not throw or make network calls
      const input = buildCoderInputFromBlockTask(blockDef, taskDef, state);
      assert.strictEqual(input.task_id, 't1');
    });
  });

  describe('buildTaskGuardrailsFromBlockTask', () => {
    it('builds Guardrails from task definition', () => {
      const guardrails = buildTaskGuardrailsFromBlockTask(taskDef);
      assert.deepStrictEqual(guardrails.allow_modify, ['src/**/*.ts']);
      assert.deepStrictEqual(guardrails.deny_modify, ['src/secret.ts']);
      assert.strictEqual(guardrails.max_lines_changed, 100);
      assert.strictEqual(guardrails.auto_commit, false);
      assert.strictEqual(guardrails.auto_push, false);
      assert.strictEqual(guardrails.auto_merge, false);
    });
  });

  describe('resolveCoderAndReviewerProviders', () => {
    it('returns fake providers in fake mode', () => {
      const providers = resolveCoderAndReviewerProviders({
        mode: 'fake',
        coderConfig: { provider: 'fake', model: 'fake' },
        reviewerConfig: { provider: 'fake', model: 'fake' },
        allowRealProvider: false,
        allowKimiReviewer: false,
      });
      assert.strictEqual(providers.coder.id, 'fake');
      assert.strictEqual(providers.reviewer.id, 'fake');
    });

    it('provider resolution fake does not create real providers', () => {
      const providers = resolveCoderAndReviewerProviders({
        mode: 'fake',
        coderConfig: { provider: 'fake', model: 'fake' },
        reviewerConfig: { provider: 'fake', model: 'fake' },
        allowRealProvider: false,
        allowKimiReviewer: false,
      });
      // Fake providers have no network, no API keys
      assert.strictEqual(providers.coder.id, 'fake');
      assert.strictEqual(providers.reviewer.id, 'fake');
    });

    it('throws in real_kimi_coder_fake_reviewer mode without allowRealProvider', () => {
      assert.throws(
        () =>
          resolveCoderAndReviewerProviders({
            mode: 'real_kimi_coder_fake_reviewer',
            coderConfig: { provider: 'kimi', model: 'kimi-k2.6' },
            reviewerConfig: { provider: 'fake', model: 'fake' },
            allowRealProvider: false,
            allowKimiReviewer: false,
          }),
        /ALLOW_REAL_PROVIDER=true/
      );
    });

    it('real modes require explicit allow flags', () => {
      assert.throws(
        () =>
          resolveCoderAndReviewerProviders({
            mode: 'real_kimi_coder_fake_reviewer',
            coderConfig: { provider: 'kimi', model: 'kimi-k2.6' },
            reviewerConfig: { provider: 'fake', model: 'fake' },
            allowRealProvider: false,
            allowKimiReviewer: false,
          }),
        /ALLOW_REAL_PROVIDER=true/
      );
    });

    it('throws in real_kimi_coder_kimi_reviewer mode without allowKimiReviewer', () => {
      assert.throws(
        () =>
          resolveCoderAndReviewerProviders({
            mode: 'real_kimi_coder_kimi_reviewer',
            coderConfig: { provider: 'kimi', model: 'kimi-k2.6' },
            reviewerConfig: { provider: 'kimi', model: 'kimi-k2.6' },
            allowRealProvider: true,
            allowKimiReviewer: false,
          }),
        /ALLOW_KIMI_REVIEWER=true/
      );
    });

    it('Kimi reviewer requires explicit allow flag', () => {
      assert.throws(
        () =>
          resolveCoderAndReviewerProviders({
            mode: 'real_kimi_coder_kimi_reviewer',
            coderConfig: { provider: 'kimi', model: 'kimi-k2.6' },
            reviewerConfig: { provider: 'kimi', model: 'kimi-k2.6' },
            allowRealProvider: true,
            allowKimiReviewer: false,
          }),
        /ALLOW_KIMI_REVIEWER=true/
      );
    });
  });
});
