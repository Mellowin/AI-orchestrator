import { describe, test } from 'node:test';
import assert from 'node:assert';
import { validateKimiOutput, parseKimiOutputJson } from '../src/kimi-output-validator.js';

describe('ai-response-parser', () => {
  describe('validateKimiOutput', () => {
    test('accepts valid file_update response', () => {
      const result = validateKimiOutput({
        mode: 'file_update',
        files: [{ path: 'src/index.ts', content: 'export {}' }],
        notes: 'Fixed',
      });
      assert.strictEqual(result.mode, 'file_update');
      assert.strictEqual(result.files.length, 1);
      assert.strictEqual(result.files[0].path, 'src/index.ts');
      assert.strictEqual(result.files[0].content, 'export {}');
      assert.strictEqual(result.notes, 'Fixed');
    });

    test('accepts empty files array', () => {
      const result = validateKimiOutput({ mode: 'file_update', files: [] });
      assert.strictEqual(result.files.length, 0);
    });

    test('rejects missing mode', () => {
      assert.throws(
        () => validateKimiOutput({ files: [] }),
        /Invalid KimiOutput mode/
      );
    });

    test('rejects invalid mode', () => {
      assert.throws(
        () => validateKimiOutput({ mode: 'patch', files: [] }),
        /Invalid KimiOutput mode/
      );
    });

    test('rejects missing files array', () => {
      assert.throws(
        () => validateKimiOutput({ mode: 'file_update' }),
        /KimiOutput\.files must be an array/
      );
    });

    test('rejects non-array files', () => {
      assert.throws(
        () => validateKimiOutput({ mode: 'file_update', files: 'nope' }),
        /KimiOutput\.files must be an array/
      );
    });

    test('rejects missing path in file object', () => {
      assert.throws(
        () => validateKimiOutput({ mode: 'file_update', files: [{ content: 'x' }] }),
        /KimiOutput\.files\[0\]\.path must be a non-empty string/
      );
    });

    test('rejects empty path string', () => {
      assert.throws(
        () => validateKimiOutput({ mode: 'file_update', files: [{ path: '', content: 'x' }] }),
        /KimiOutput\.files\[0\]\.path must be a non-empty string/
      );
    });

    test('rejects non-string path', () => {
      assert.throws(
        () => validateKimiOutput({ mode: 'file_update', files: [{ path: 123, content: 'x' }] }),
        /KimiOutput\.files\[0\]\.path must be a non-empty string/
      );
    });

    test('rejects absolute path', () => {
      assert.throws(
        () => validateKimiOutput({ mode: 'file_update', files: [{ path: '/etc/passwd', content: 'x' }] }),
        /Absolute paths are not allowed/
      );
    });

    test('rejects path traversal', () => {
      assert.throws(
        () => validateKimiOutput({ mode: 'file_update', files: [{ path: '../secret.ts', content: 'x' }] }),
        /Path traversal detected/
      );
    });

    test('rejects backslash in path', () => {
      assert.throws(
        () => validateKimiOutput({ mode: 'file_update', files: [{ path: 'src\\file.ts', content: 'x' }] }),
        /Backslash not allowed/
      );
    });

    test('rejects colon in path', () => {
      assert.throws(
        () => validateKimiOutput({ mode: 'file_update', files: [{ path: 'src/file:ts', content: 'x' }] }),
        /Colons are not allowed/
      );
    });

    test('rejects missing content in file object', () => {
      assert.throws(
        () => validateKimiOutput({ mode: 'file_update', files: [{ path: 'src/a.ts' }] }),
        /KimiOutput\.files\[0\]\.content must be a string/
      );
    });

    test('rejects non-string content', () => {
      assert.throws(
        () => validateKimiOutput({ mode: 'file_update', files: [{ path: 'src/a.ts', content: 123 }] }),
        /KimiOutput\.files\[0\]\.content must be a string/
      );
    });

    test('rejects duplicate paths', () => {
      assert.throws(
        () =>
          validateKimiOutput({
            mode: 'file_update',
            files: [
              { path: 'src/a.ts', content: 'x' },
              { path: 'src/a.ts', content: 'y' },
            ],
          }),
        /Duplicate file update/
      );
    });

    test('rejects duplicate paths after normalization', () => {
      assert.throws(
        () =>
          validateKimiOutput({
            mode: 'file_update',
            files: [
              { path: './src/a.ts', content: 'x' },
              { path: 'src/a.ts', content: 'y' },
            ],
          }),
        /Duplicate file update/
      );
    });

    test('treats non-string notes as undefined', () => {
      const result = validateKimiOutput({
        mode: 'file_update',
        files: [],
        notes: 123,
      });
      assert.strictEqual(result.notes, undefined);
    });

    test('rejects non-object input', () => {
      assert.throws(() => validateKimiOutput('string'), /KimiOutput must be an object/);
      assert.throws(() => validateKimiOutput(null), /KimiOutput must be an object/);
      assert.throws(() => validateKimiOutput(123), /KimiOutput must be an object/);
    });

    test('rejects non-object file items', () => {
      assert.throws(
        () => validateKimiOutput({ mode: 'file_update', files: ['not-an-object'] }),
        /KimiOutput\.files\[0\] must be an object/
      );
    });
  });

  describe('parseKimiOutputJson', () => {
    test('throws on empty string', () => {
      assert.throws(() => parseKimiOutputJson(''), /Invalid Kimi JSON output/);
    });

    test('throws on whitespace-only string', () => {
      assert.throws(() => parseKimiOutputJson('   \n\t  '), /Invalid Kimi JSON output/);
    });

    test('throws on malformed JSON', () => {
      assert.throws(() => parseKimiOutputJson('{"mode":'), /Invalid Kimi JSON output/);
    });

    test('throws on unclosed fenced block', () => {
      assert.throws(
        () => parseKimiOutputJson('```json\n{"mode":"file_update","files":[]}'),
        /fenced block not closed/
      );
    });

    test('throws on empty fenced block', () => {
      assert.throws(() => parseKimiOutputJson('```'), /empty fenced block/);
    });

    test('throws on multiple fenced blocks inside', () => {
      const raw = '```json\n{"mode":"file_update","files":[]}\n```\n```\n```';
      assert.throws(() => parseKimiOutputJson(raw), /multiple fenced blocks/);
    });

    test('error message does not expose secrets', () => {
      const secret = 'sk-test-secret-12345';
      try {
        parseKimiOutputJson(`{"mode":"file_update","api_key":"${secret}"}`);
        assert.fail('Expected error');
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        assert.ok(!message.includes(secret), 'Error must not contain secret');
      }
    });
  });
});
