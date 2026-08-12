import { describe, test } from 'node:test';
import assert from 'node:assert';
import { deriveTaskResult } from '../src/real-block-run-ai.js';
import type { BlockTaskDefinition } from '../src/block/block-types.js';

function makeTask(overrides?: Partial<BlockTaskDefinition>): BlockTaskDefinition {
  return {
    task_id: 'task-1',
    title: 'Task 1',
    goal: 'Add docs',
    allowed_files: ['docs/a.md'],
    denied_files: [],
    checks: [],
    ...overrides,
  };
}

function makeCommitSha(): string {
  return 'a'.repeat(40);
}

describe('deriveTaskResult terminal execution precedence', () => {
  test('reviewer accepted + pushed + valid commit => accepted', () => {
    const result = deriveTaskResult(makeTask(), {
      exitCode: 0,
      state: {
        status: 'pushed',
        commit_sha: makeCommitSha(),
        pushed: true,
        committed: true,
        reviewer_gate: { status: 'accepted' },
      },
    });

    assert.strictEqual(result.status, 'accepted');
    assert.strictEqual(result.finalStatus, 'accepted');
    assert.strictEqual(result.nextAction, 'continue');
    assert.strictEqual(result.pushed, true);
    assert.strictEqual(result.codeApplied, true);
  });

  test('reviewer accepted + push failure (exit 1, state failed) => failed, not accepted', () => {
    const result = deriveTaskResult(makeTask(), {
      exitCode: 1,
      state: {
        status: 'failed',
        commit_sha: makeCommitSha(),
        committed: true,
        reviewer_gate: { status: 'accepted' },
        safety_note: 'Push failed: unable to authenticate',
      },
    });

    assert.strictEqual(result.status, 'failed');
    assert.strictEqual(result.finalStatus, 'failed');
    assert.strictEqual(result.nextAction, 'block');
    assert.strictEqual(result.pushed, false);
    assert.ok(result.reason?.includes('Push failed'), `reason was: ${result.reason}`);
  });

  test('reviewer accepted + failed state loaded in resume (exit 0) => still failed', () => {
    const result = deriveTaskResult(makeTask(), {
      exitCode: 0,
      state: {
        status: 'failed',
        commit_sha: makeCommitSha(),
        committed: true,
        reviewer_gate: { status: 'accepted' },
        safety_note: 'Push failed: remote rejected',
      },
    });

    assert.strictEqual(result.status, 'failed');
    assert.strictEqual(result.finalStatus, 'failed');
    assert.strictEqual(result.nextAction, 'block');
    assert.strictEqual(result.pushed, false);
  });

  test('reviewer accepted + state not pushed => failed', () => {
    const result = deriveTaskResult(makeTask(), {
      exitCode: 0,
      state: {
        status: 'approved',
        commit_sha: makeCommitSha(),
        committed: true,
        reviewer_gate: { status: 'accepted' },
      },
    });

    assert.strictEqual(result.status, 'failed');
    assert.strictEqual(result.finalStatus, 'failed');
    assert.strictEqual(result.nextAction, 'block');
    assert.strictEqual(result.pushed, false);
  });

  test('reviewer accepted + missing commit sha => accepted (SHA validation is callers responsibility)', () => {
    const result = deriveTaskResult(makeTask(), {
      exitCode: 0,
      state: {
        status: 'pushed',
        reviewer_gate: { status: 'accepted' },
      },
    });

    assert.strictEqual(result.status, 'accepted');
    assert.strictEqual(result.finalStatus, 'accepted');
    assert.strictEqual(result.nextAction, 'continue');
    assert.strictEqual(result.codeApplied, false);
    assert.strictEqual(result.pushed, true);
  });

  test('second reviewer accepted + pushed => fixed_and_accepted', () => {
    const result = deriveTaskResult(makeTask(), {
      exitCode: 0,
      state: {
        status: 'pushed',
        commit_sha: makeCommitSha(),
        pushed: true,
        committed: true,
        fixed_and_accepted: true,
        reviewer_fix_task_second_review: {
          finalStatus: 'accepted',
          fixCommitSha: makeCommitSha(),
        },
      },
    });

    assert.strictEqual(result.status, 'fixed_and_accepted');
    assert.strictEqual(result.finalStatus, 'accepted');
    assert.strictEqual(result.nextAction, 'continue');
    assert.strictEqual(result.pushed, true);
  });

  test('second reviewer accepted + push failure => failed', () => {
    const result = deriveTaskResult(makeTask(), {
      exitCode: 1,
      state: {
        status: 'failed',
        commit_sha: makeCommitSha(),
        committed: true,
        fixed_and_accepted: true,
        reviewer_fix_task_second_review: {
          finalStatus: 'accepted',
          fixCommitSha: makeCommitSha(),
        },
        safety_note: 'Push failed: remote rejected',
      },
    });

    assert.strictEqual(result.status, 'failed');
    assert.strictEqual(result.finalStatus, 'failed');
    assert.strictEqual(result.nextAction, 'block');
    assert.strictEqual(result.pushed, false);
  });

  test('successful push without reviewer gate still accepted via pushed fallback', () => {
    const result = deriveTaskResult(makeTask(), {
      exitCode: 0,
      state: {
        status: 'pushed',
        commit_sha: makeCommitSha(),
        pushed: true,
        committed: true,
      },
    });

    assert.strictEqual(result.status, 'accepted');
    assert.strictEqual(result.finalStatus, 'accepted');
    assert.strictEqual(result.nextAction, 'continue');
  });
});
