import { describe, test, before } from 'node:test';
import assert from 'node:assert';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { classifyKimiOutput, classifyProposedFile } from '../src/kimi-output-classifier.js';

describe('kimi-output-classifier', () => {
  let tmpDir: string;
  let repoPath: string;

  before(() => {
    tmpDir = mkdtempSync(join(process.cwd(), 'tmp', 'kimi-classifier-'));
    repoPath = join(tmpDir, 'repo');
    mkdirSync(repoPath, { recursive: true });
  });

  test.after(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('EMPTY_FILE_LIST when files array is empty', () => {
    const result = classifyKimiOutput(repoPath, { mode: 'file_update', files: [] });
    assert.strictEqual(result.classification, 'EMPTY_FILE_LIST');
    assert.strictEqual(result.files.length, 0);
  });

  test('create effect for new file with content', () => {
    const result = classifyKimiOutput(repoPath, {
      mode: 'file_update',
      files: [{ path: 'new.md', content: '# hello\n' }],
    });
    assert.strictEqual(result.classification, 'EFFECTIVE_CHANGES');
    const file = result.files[0];
    assert.strictEqual(file.exists_before, false);
    assert.strictEqual(file.effect, 'create');
    assert.strictEqual(file.before_sha256, null);
    assert.ok(file.proposed_sha256);
  });

  test('create effect for new empty file', () => {
    const result = classifyKimiOutput(repoPath, {
      mode: 'file_update',
      files: [{ path: 'empty.md', content: '' }],
    });
    assert.strictEqual(result.classification, 'EFFECTIVE_CHANGES');
    assert.strictEqual(result.files[0].effect, 'create');
    assert.strictEqual(result.files[0].proposed_lines, 0);
  });

  test('identical effect for existing file with same content', () => {
    const filePath = join(repoPath, 'same.md');
    writeFileSync(filePath, 'same content', 'utf-8');
    const result = classifyKimiOutput(repoPath, {
      mode: 'file_update',
      files: [{ path: 'same.md', content: 'same content' }],
    });
    assert.strictEqual(result.classification, 'ALL_IDENTICAL');
    assert.strictEqual(result.files[0].effect, 'identical');
    assert.strictEqual(result.files[0].exists_before, true);
  });

  test('modify effect when content differs', () => {
    const filePath = join(repoPath, 'modify.md');
    writeFileSync(filePath, 'before', 'utf-8');
    const result = classifyKimiOutput(repoPath, {
      mode: 'file_update',
      files: [{ path: 'modify.md', content: 'after' }],
    });
    assert.strictEqual(result.classification, 'EFFECTIVE_CHANGES');
    assert.strictEqual(result.files[0].effect, 'modify');
    assert.notStrictEqual(result.files[0].before_sha256, result.files[0].proposed_sha256);
  });

  test('ALL_IDENTICAL when all proposed files are identical', () => {
    writeFileSync(join(repoPath, 'a.md'), 'a', 'utf-8');
    writeFileSync(join(repoPath, 'b.md'), 'b', 'utf-8');
    const result = classifyKimiOutput(repoPath, {
      mode: 'file_update',
      files: [
        { path: 'a.md', content: 'a' },
        { path: 'b.md', content: 'b' },
      ],
    });
    assert.strictEqual(result.classification, 'ALL_IDENTICAL');
    assert.strictEqual(result.files.every((f) => f.effect === 'identical'), true);
  });

  test('EFFECTIVE_CHANGES when some identical and some modified', () => {
    writeFileSync(join(repoPath, 'keep.md'), 'keep', 'utf-8');
    writeFileSync(join(repoPath, 'change.md'), 'old', 'utf-8');
    const result = classifyKimiOutput(repoPath, {
      mode: 'file_update',
      files: [
        { path: 'keep.md', content: 'keep' },
        { path: 'change.md', content: 'new' },
      ],
    });
    assert.strictEqual(result.classification, 'EFFECTIVE_CHANGES');
    const byPath = new Map(result.files.map((f) => [f.path, f]));
    assert.strictEqual(byPath.get('keep.md')?.effect, 'identical');
    assert.strictEqual(byPath.get('change.md')?.effect, 'modify');
  });

  test('classifyProposedFile normalizes backslash paths', () => {
    writeFileSync(join(repoPath, 'norm.md'), 'x', 'utf-8');
    const result = classifyProposedFile(repoPath, {
      path: 'norm.md',
      content: 'y',
    });
    assert.strictEqual(result.path, 'norm.md');
    assert.strictEqual(result.effect, 'modify');
  });

  test('line and byte counts are reported', () => {
    const result = classifyKimiOutput(repoPath, {
      mode: 'file_update',
      files: [{ path: 'lines.md', content: 'line1\nline2\nline3' }],
    });
    const file = result.files[0];
    assert.strictEqual(file.proposed_lines, 3);
    assert.strictEqual(file.proposed_bytes, Buffer.byteLength('line1\nline2\nline3', 'utf-8'));
  });
});
