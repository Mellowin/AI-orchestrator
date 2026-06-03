import { describe, test } from 'node:test';
import assert from 'node:assert';
import { createFakeCoderProvider } from '../src/providers/fake/fake-coder-provider.js';
import { createFakeReviewerProvider } from '../src/providers/fake/fake-reviewer-provider.js';

describe('fake-provider', () => {
  describe('fake coder', () => {
    test('returns CoderResult', async () => {
      const coder = createFakeCoderProvider();
      const result = await coder.runTask({
        task_id: 't1',
        title: 'Test',
        goal: 'test goal',
        allowed_files: ['src/test.ts'],
        denied_files: ['.env'],
        max_lines_changed: 10,
        repo_context: 'test repo',
      });
      assert.strictEqual(typeof result.summary, 'string');
      assert.ok(Array.isArray(result.files));
      assert.strictEqual(result.files.length, 1);
      assert.strictEqual(result.files[0].path, 'src/fake.ts');
    });

    test('runFix returns CoderResult', async () => {
      const coder = createFakeCoderProvider();
      const result = await coder.runFix({
        task_id: 't1',
        title: 'Test',
        goal: 'test goal',
        allowed_files: ['src/test.ts'],
        denied_files: ['.env'],
        max_lines_changed: 10,
        repo_context: 'test repo',
        previous_failure: 'check failed',
      });
      assert.strictEqual(typeof result.summary, 'string');
      assert.ok(Array.isArray(result.files));
    });

    test('custom task response', async () => {
      const custom = {
        summary: 'custom',
        files: [{ path: 'custom.ts', content: '// custom' }],
      };
      const coder = createFakeCoderProvider({ taskResponse: custom });
      const result = await coder.runTask({
        task_id: 't1',
        title: 'Test',
        goal: 'test goal',
        allowed_files: [],
        denied_files: [],
        max_lines_changed: 10,
        repo_context: '',
      });
      assert.strictEqual(result.summary, 'custom');
      assert.strictEqual(result.files[0].path, 'custom.ts');
    });
  });

  describe('fake reviewer', () => {
    test('returns accepted decision by default', async () => {
      const reviewer = createFakeReviewerProvider();
      const result = await reviewer.reviewCommit({
        block_id: 'b1',
        task_id: 't1',
        task_title: 'Test',
        task_goal: 'goal',
        allowed_files: ['src/test.ts'],
        denied_files: ['.env'],
        max_lines_changed: 10,
        commit_sha: 'abc123',
        changed_files: ['src/test.ts'],
        diff: '+line',
        typecheck_result: 'pass',
        build_result: 'pass',
        test_result: 'pass',
        git_status: 'clean',
        safety_findings: [],
      });
      assert.strictEqual(result.decision, 'accepted');
      assert.strictEqual(result.next_action, 'advance_to_next_task');
      assert.strictEqual(result.confidence, 'high');
    });

    test('returns rejected decision when configured', async () => {
      const reviewer = createFakeReviewerProvider({
        decision: {
          decision: 'rejected',
          confidence: 'medium',
          blocking_issues: ['issue'],
          non_blocking_issues: [],
          review_summary: 'bad',
          fix_task: 'fix it',
          next_action: 'send_fix_to_coder',
        },
      });
      const result = await reviewer.reviewCommit({
        task_id: 't1',
        task_title: 'Test',
        task_goal: 'goal',
        allowed_files: [],
        denied_files: [],
        max_lines_changed: 10,
        commit_sha: 'abc',
        changed_files: [],
        diff: '',
        typecheck_result: 'pass',
        build_result: 'pass',
        test_result: 'pass',
        git_status: 'clean',
        safety_findings: [],
      });
      assert.strictEqual(result.decision, 'rejected');
      assert.strictEqual(result.next_action, 'send_fix_to_coder');
    });

    test('uses no network', async () => {
      const reviewer = createFakeReviewerProvider();
      // Should resolve immediately without any network call
      const result = await reviewer.reviewCommit({
        task_id: 't1',
        task_title: 'Test',
        task_goal: 'goal',
        allowed_files: [],
        denied_files: [],
        max_lines_changed: 10,
        commit_sha: 'abc',
        changed_files: [],
        diff: '',
        typecheck_result: 'pass',
        build_result: 'pass',
        test_result: 'pass',
        git_status: 'clean',
        safety_findings: [],
      });
      assert.strictEqual(result.decision, 'accepted');
    });

    test('requires no API key', async () => {
      const originalKey = process.env.KIMI_API_KEY;
      delete process.env.KIMI_API_KEY;
      try {
        const reviewer = createFakeReviewerProvider();
        const result = await reviewer.reviewCommit({
          task_id: 't1',
          task_title: 'Test',
          task_goal: 'goal',
          allowed_files: [],
          denied_files: [],
          max_lines_changed: 10,
          commit_sha: 'abc',
          changed_files: [],
          diff: '',
          typecheck_result: 'pass',
          build_result: 'pass',
          test_result: 'pass',
          git_status: 'clean',
          safety_findings: [],
        });
        assert.strictEqual(result.decision, 'accepted');
      } finally {
        if (originalKey !== undefined) {
          process.env.KIMI_API_KEY = originalKey;
        }
      }
    });
  });
});
