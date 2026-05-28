import { describe, test } from 'node:test';
import assert from 'node:assert';
import { parseKimiOutputJson } from '../src/kimi-output-validator.js';

describe('kimi-output-validator', () => {
  test('parses plain valid JSON', () => {
    const raw = '{"mode":"file_update","files":[{"path":"src/a.ts","content":"x"}]}';
    const result = parseKimiOutputJson(raw);
    assert.strictEqual(result.mode, 'file_update');
    assert.strictEqual(result.files.length, 1);
    assert.strictEqual(result.files[0].path, 'src/a.ts');
    assert.strictEqual(result.files[0].content, 'x');
  });

  test('parses fenced json block', () => {
    const raw = '```json\n{"mode":"file_update","files":[{"path":"src/a.ts","content":"x"}]}\n```';
    const result = parseKimiOutputJson(raw);
    assert.strictEqual(result.mode, 'file_update');
    assert.strictEqual(result.files.length, 1);
    assert.strictEqual(result.files[0].path, 'src/a.ts');
    assert.strictEqual(result.files[0].content, 'x');
  });

  test('parses fenced block without language', () => {
    const raw = '```\n{"mode":"file_update","files":[{"path":"src/a.ts","content":"x"}]}\n```';
    const result = parseKimiOutputJson(raw);
    assert.strictEqual(result.mode, 'file_update');
    assert.strictEqual(result.files.length, 1);
    assert.strictEqual(result.files[0].path, 'src/a.ts');
    assert.strictEqual(result.files[0].content, 'x');
  });

  test('rejects prose before fenced json', () => {
    const raw = 'Here is the patch:\n```json\n{"mode":"file_update","files":[{"path":"src/a.ts","content":"x"}]}\n```';
    assert.throws(() => parseKimiOutputJson(raw), /Invalid Kimi JSON output/);
  });

  test('rejects prose after fenced json', () => {
    const raw = '```json\n{"mode":"file_update","files":[{"path":"src/a.ts","content":"x"}]}\n```\n\nDone';
    assert.throws(() => parseKimiOutputJson(raw), /Invalid Kimi JSON output/);
  });

  test('rejects fenced block with non-json language', () => {
    const raw = '```typescript\n{"mode":"file_update","files":[{"path":"src/a.ts","content":"x"}]}\n```';
    assert.throws(() => parseKimiOutputJson(raw), /Invalid Kimi JSON output/);
  });

  test('rejects fenced block with json extra text', () => {
    const raw = '```json extra\n{"mode":"file_update","files":[{"path":"src/a.ts","content":"x"}]}\n```';
    assert.throws(() => parseKimiOutputJson(raw), /Invalid Kimi JSON output/);
  });

  test('accepts empty files array', () => {
    const raw = '{"mode":"file_update","files":[],"notes":"Cannot safely modify files because ..."}';
    const result = parseKimiOutputJson(raw);
    assert.strictEqual(result.mode, 'file_update');
    assert.strictEqual(result.files.length, 0);
    assert.strictEqual(result.notes, 'Cannot safely modify files because ...');
  });
});
