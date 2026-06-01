import { describe, test } from 'node:test';
import assert from 'node:assert';
import { validateReviewVerdict, parseReviewerOutputJson } from '../src/reviewer-output-validator.js';

describe('reviewer-output-validator', () => {
  describe('validateReviewVerdict', () => {
    test('accepts valid approved verdict', () => {
      const result = validateReviewVerdict({
        verdict: 'approve',
        critical_issues: [],
        requested_changes: [],
        summary_for_human: 'Looks good',
      });
      assert.strictEqual(result.verdict, 'approve');
      assert.deepStrictEqual(result.critical_issues, []);
      assert.deepStrictEqual(result.requested_changes, []);
      assert.strictEqual(result.summary_for_human, 'Looks good');
    });

    test('accepts valid needs_changes verdict', () => {
      const result = validateReviewVerdict({
        verdict: 'needs_changes',
        critical_issues: ['Missing error handling'],
        requested_changes: ['Add try/catch block'],
        summary_for_human: 'Needs fixes',
      });
      assert.strictEqual(result.verdict, 'needs_changes');
      assert.deepStrictEqual(result.critical_issues, ['Missing error handling']);
      assert.deepStrictEqual(result.requested_changes, ['Add try/catch block']);
    });

    test('accepts valid reject verdict', () => {
      const result = validateReviewVerdict({
        verdict: 'reject',
        critical_issues: ['Security issue', 'Logic bug'],
        requested_changes: [],
        summary_for_human: 'Cannot approve',
      });
      assert.strictEqual(result.verdict, 'reject');
      assert.deepStrictEqual(result.critical_issues, ['Security issue', 'Logic bug']);
    });

    test('rejects missing verdict', () => {
      assert.throws(
        () =>
          validateReviewVerdict({
            critical_issues: [],
            requested_changes: [],
            summary_for_human: 'x',
          }),
        /Invalid ReviewVerdict.verdict/
      );
    });

    test('rejects unknown verdict', () => {
      assert.throws(
        () =>
          validateReviewVerdict({
            verdict: 'maybe',
            critical_issues: [],
            requested_changes: [],
            summary_for_human: 'x',
          }),
        /Invalid ReviewVerdict.verdict/
      );
    });

    test('rejects non-array critical_issues', () => {
      assert.throws(
        () =>
          validateReviewVerdict({
            verdict: 'approve',
            critical_issues: 'none',
            requested_changes: [],
            summary_for_human: 'x',
          }),
        /ReviewVerdict.critical_issues must be an array of strings/
      );
    });

    test('rejects critical_issues with non-string items', () => {
      assert.throws(
        () =>
          validateReviewVerdict({
            verdict: 'approve',
            critical_issues: [123],
            requested_changes: [],
            summary_for_human: 'x',
          }),
        /ReviewVerdict.critical_issues must be an array of strings/
      );
    });

    test('rejects non-array requested_changes', () => {
      assert.throws(
        () =>
          validateReviewVerdict({
            verdict: 'approve',
            critical_issues: [],
            requested_changes: 'none',
            summary_for_human: 'x',
          }),
        /ReviewVerdict.requested_changes must be an array of strings/
      );
    });

    test('rejects requested_changes with non-string items', () => {
      assert.throws(
        () =>
          validateReviewVerdict({
            verdict: 'approve',
            critical_issues: [],
            requested_changes: [true],
            summary_for_human: 'x',
          }),
        /ReviewVerdict.requested_changes must be an array of strings/
      );
    });

    test('rejects missing summary_for_human', () => {
      assert.throws(
        () =>
          validateReviewVerdict({
            verdict: 'approve',
            critical_issues: [],
            requested_changes: [],
          }),
        /ReviewVerdict.summary_for_human must be a string/
      );
    });

    test('rejects non-string summary_for_human', () => {
      assert.throws(
        () =>
          validateReviewVerdict({
            verdict: 'approve',
            critical_issues: [],
            requested_changes: [],
            summary_for_human: 123,
          }),
        /ReviewVerdict.summary_for_human must be a string/
      );
    });

    test('rejects non-object input', () => {
      assert.throws(() => validateReviewVerdict('string'), /ReviewVerdict must be an object/);
      assert.throws(() => validateReviewVerdict(null), /ReviewVerdict must be an object/);
      assert.throws(() => validateReviewVerdict(123), /ReviewVerdict must be an object/);
    });

    test('rejects array input', () => {
      assert.throws(() => validateReviewVerdict([]), /ReviewVerdict must be an object/);
    });
  });

  describe('parseReviewerOutputJson', () => {
    test('parses plain valid JSON', () => {
      const raw = JSON.stringify({
        verdict: 'approve',
        critical_issues: [],
        requested_changes: [],
        summary_for_human: 'OK',
      });
      const result = parseReviewerOutputJson(raw);
      assert.strictEqual(result.verdict, 'approve');
    });

    test('parses fenced json block', () => {
      const raw =
        '```json\n' +
        '{"verdict":"approve","critical_issues":[],"requested_changes":[],"summary_for_human":"OK"}\n' +
        '```';
      const result = parseReviewerOutputJson(raw);
      assert.strictEqual(result.verdict, 'approve');
    });

    test('parses fenced block without language', () => {
      const raw =
        '```\n' +
        '{"verdict":"approve","critical_issues":[],"requested_changes":[],"summary_for_human":"OK"}\n' +
        '```';
      const result = parseReviewerOutputJson(raw);
      assert.strictEqual(result.verdict, 'approve');
    });

    test('throws on empty string', () => {
      assert.throws(() => parseReviewerOutputJson(''), /Invalid reviewer JSON output/);
    });

    test('throws on whitespace-only string', () => {
      assert.throws(() => parseReviewerOutputJson('   \n\t  '), /Invalid reviewer JSON output/);
    });

    test('throws on malformed JSON', () => {
      assert.throws(() => parseReviewerOutputJson('{"verdict":'), /Invalid reviewer JSON output/);
    });

    test('throws on unclosed fenced block', () => {
      const raw = '```json\n{"verdict":"approve","critical_issues":[],"requested_changes":[],"summary_for_human":"OK"}';
      assert.throws(() => parseReviewerOutputJson(raw), /fenced block not closed/);
    });

    test('throws on empty fenced block', () => {
      assert.throws(() => parseReviewerOutputJson('```'), /empty fenced block/);
    });

    test('throws on multiple fenced blocks inside', () => {
      const raw = '```json\n{"verdict":"approve"}\n```\n```\n```';
      assert.throws(() => parseReviewerOutputJson(raw), /multiple fenced blocks/);
    });

    test('throws on non-json fenced language', () => {
      const raw = '```typescript\n{"verdict":"approve"}\n```';
      assert.throws(() => parseReviewerOutputJson(raw), /unsupported fenced block language/);
    });

    test('error message does not expose secrets', () => {
      const secret = 'sk-test-secret-abc123';
      try {
        parseReviewerOutputJson(`{"verdict":"approve","api_key":"${secret}"}`);
        assert.fail('Expected error');
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        assert.ok(!message.includes(secret), 'Error must not contain secret');
      }
    });
  });
});
