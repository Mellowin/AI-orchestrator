import { describe, test } from 'node:test';
import assert from 'node:assert';
import {
  validateTaskTimeoutMs,
  resolveTaskTimeoutMs,
  validateReviewerParseRetries,
  resolveReviewerParseRetries,
  resolveOnBlockedTask,
} from '../src/real-block-task-timeout.js';
import type { BlockDefinition } from '../src/block/block-types.js';

function buildBlock(overrides: {
  taskTimeoutMs?: number;
  reviewerParseRetries?: number;
  onBlockedTask?: 'stop' | 'continue' | 'skip';
  coderProvider?: string;
} = {}): BlockDefinition {
  const coderProvider = overrides.coderProvider ?? 'kimi';
  return {
    block_id: 'test-block',
    title: 'Test',
    repo_path: '.',
    base_branch: 'main',
    work_branch: 'ai/test',
    providers: {
      coder: { provider: coderProvider, model: 'kimi-k2.6' },
      reviewer: { provider: coderProvider, model: 'kimi-k2.6' },
    },
    review_policy: {
      require_deterministic_checks: false,
      max_fix_attempts: 1,
      reviewer_mode: 'single',
      task_timeout_ms: overrides.taskTimeoutMs,
      reviewer_parse_retries: overrides.reviewerParseRetries,
      on_blocked_task: overrides.onBlockedTask,
    },
    tasks: [],
  };
}

describe('real-block-task-timeout', () => {
  describe('validateTaskTimeoutMs', () => {
    test('default is 120000 without block', () => {
      assert.strictEqual(validateTaskTimeoutMs(undefined), 120000);
    });

    test('default is 120000 for fake provider block', () => {
      const fakeBlock = buildBlock({ coderProvider: 'fake' });
      assert.strictEqual(validateTaskTimeoutMs(undefined, fakeBlock), 120000);
    });

    test('default is 600000 for real provider block', () => {
      const realBlock = buildBlock({ coderProvider: 'kimi' });
      assert.strictEqual(validateTaskTimeoutMs(undefined, realBlock), 600000);
    });

    test('block value overrides default', () => {
      const realBlock = buildBlock({ coderProvider: 'kimi' });
      assert.strictEqual(validateTaskTimeoutMs(300000, realBlock), 300000);
    });

    test('env string overrides default when block value absent', () => {
      const realBlock = buildBlock({ coderProvider: 'kimi' });
      assert.strictEqual(validateTaskTimeoutMs('300000', realBlock), 300000);
    });

    test('invalid low value fails', () => {
      assert.throws(() => validateTaskTimeoutMs(499), /between 500 and 900000/);
    });

    test('invalid high value fails', () => {
      assert.throws(() => validateTaskTimeoutMs(900001), /between 500 and 900000/);
    });

    test('non-number value fails', () => {
      assert.throws(() => validateTaskTimeoutMs('not-a-number'), /must be an integer/);
    });
  });

  describe('resolveTaskTimeoutMs', () => {
    const originalEnv = process.env.REAL_BLOCK_TASK_TIMEOUT_MS;

    test('block value beats env', () => {
      process.env.REAL_BLOCK_TASK_TIMEOUT_MS = '600000';
      const block = buildBlock({ taskTimeoutMs: 300000 });
      assert.strictEqual(resolveTaskTimeoutMs(block), 300000);
    });

    test('env used when block value absent', () => {
      process.env.REAL_BLOCK_TASK_TIMEOUT_MS = '450000';
      const block = buildBlock({});
      assert.strictEqual(resolveTaskTimeoutMs(block), 450000);
    });

    test('fake provider default is 120000 when env absent', () => {
      delete process.env.REAL_BLOCK_TASK_TIMEOUT_MS;
      const block = buildBlock({ coderProvider: 'fake' });
      assert.strictEqual(resolveTaskTimeoutMs(block), 120000);
    });

    test('real provider default is 600000 when env absent', () => {
      delete process.env.REAL_BLOCK_TASK_TIMEOUT_MS;
      const block = buildBlock({ coderProvider: 'kimi' });
      assert.strictEqual(resolveTaskTimeoutMs(block), 600000);
    });

    test.after(() => {
      if (originalEnv === undefined) {
        delete process.env.REAL_BLOCK_TASK_TIMEOUT_MS;
      } else {
        process.env.REAL_BLOCK_TASK_TIMEOUT_MS = originalEnv;
      }
    });
  });

  describe('validateReviewerParseRetries', () => {
    test('default is 2', () => {
      assert.strictEqual(validateReviewerParseRetries(undefined), 2);
    });

    test('accepts 0', () => {
      assert.strictEqual(validateReviewerParseRetries(0), 0);
    });

    test('accepts 5', () => {
      assert.strictEqual(validateReviewerParseRetries(5), 5);
    });

    test('invalid low value fails', () => {
      assert.throws(() => validateReviewerParseRetries(-1), /between 0 and 5/);
    });

    test('invalid high value fails', () => {
      assert.throws(() => validateReviewerParseRetries(6), /between 0 and 5/);
    });

    test('non-number value fails', () => {
      assert.throws(() => validateReviewerParseRetries('two'), /must be an integer/);
    });
  });

  describe('resolveReviewerParseRetries', () => {
    const originalEnv = process.env.REAL_REVIEWER_PARSE_RETRIES;

    test('block value beats env', () => {
      process.env.REAL_REVIEWER_PARSE_RETRIES = '0';
      const block = buildBlock({ reviewerParseRetries: 3 });
      assert.strictEqual(resolveReviewerParseRetries(block), 3);
    });

    test('env used when block value absent', () => {
      process.env.REAL_REVIEWER_PARSE_RETRIES = '1';
      const block = buildBlock({});
      assert.strictEqual(resolveReviewerParseRetries(block), 1);
    });

    test.after(() => {
      if (originalEnv === undefined) {
        delete process.env.REAL_REVIEWER_PARSE_RETRIES;
      } else {
        process.env.REAL_REVIEWER_PARSE_RETRIES = originalEnv;
      }
    });
  });

  describe('resolveOnBlockedTask', () => {
    const originalEnv = process.env.REAL_BLOCK_ON_BLOCKED_TASK;

    test('default is stop', () => {
      const block = buildBlock({});
      assert.strictEqual(resolveOnBlockedTask(block), 'stop');
    });

    test('block continue', () => {
      const block = buildBlock({ onBlockedTask: 'continue' });
      assert.strictEqual(resolveOnBlockedTask(block), 'continue');
    });

    test('block skip maps to continue', () => {
      const block = buildBlock({ onBlockedTask: 'skip' });
      assert.strictEqual(resolveOnBlockedTask(block), 'continue');
    });

    test('env stop', () => {
      process.env.REAL_BLOCK_ON_BLOCKED_TASK = 'stop';
      const block = buildBlock({});
      assert.strictEqual(resolveOnBlockedTask(block), 'stop');
    });

    test('env continue', () => {
      process.env.REAL_BLOCK_ON_BLOCKED_TASK = 'continue';
      const block = buildBlock({});
      assert.strictEqual(resolveOnBlockedTask(block), 'continue');
    });

    test('block beats env', () => {
      process.env.REAL_BLOCK_ON_BLOCKED_TASK = 'continue';
      const block = buildBlock({ onBlockedTask: 'stop' });
      assert.strictEqual(resolveOnBlockedTask(block), 'stop');
    });

    test.after(() => {
      if (originalEnv === undefined) {
        delete process.env.REAL_BLOCK_ON_BLOCKED_TASK;
      } else {
        process.env.REAL_BLOCK_ON_BLOCKED_TASK = originalEnv;
      }
    });
  });
});
