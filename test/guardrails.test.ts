import { describe, test } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  validateFileList,
  validateDiffSize,
  validateTestsPresent,
  validateProposedFileLineDeltas,
} from '../src/guardrails.js';
import type { Guardrails, DiffStat } from '../src/types.js';

function makeGuardrails(overrides?: Partial<Guardrails>): Guardrails {
  return {
    deny_modify: ['.env', '.env.*', 'node_modules/**', '.git/**'],
    auto_commit: false,
    auto_push: false,
    auto_merge: false,
    ...overrides,
  };
}

describe('guardrails', () => {
  test('validateFileList allows files within allow_modify', () => {
    const guardrails = makeGuardrails({
      allow_modify: ['src/**', 'README.md'],
    });
    const result = validateFileList(['src/index.ts', 'README.md'], guardrails);
    assert.strictEqual(result.ok, true);
  });

  test('validateFileList rejects files outside allow_modify', () => {
    const guardrails = makeGuardrails({
      allow_modify: ['src/**'],
    });
    const result = validateFileList(['README.md'], guardrails);
    assert.strictEqual(result.ok, false);
    assert(result.reason?.includes('outside allow_modify'));
  });

  test('validateFileList rejects all files when allow_modify is empty', () => {
    const guardrails = makeGuardrails({
      allow_modify: [],
    });
    const result = validateFileList(['README.md'], guardrails);
    assert.strictEqual(result.ok, false);
    assert(result.reason?.includes('outside allow_modify'));
  });

  test('empty allow_modify means no file is allowed', () => {
    const guardrails = makeGuardrails({
      allow_modify: [],
    });
    assert.strictEqual(validateFileList(['src/index.ts'], guardrails).ok, false);
    assert.strictEqual(validateFileList(['README.md'], guardrails).ok, false);
    assert.strictEqual(validateFileList(['.env'], guardrails).ok, false);
  });

  test('validateFileList rejects denied files', () => {
    const guardrails = makeGuardrails();
    const result = validateFileList(['.env'], guardrails);
    assert.strictEqual(result.ok, false);
    assert(result.reason?.includes('Forbidden file touched'));
  });

  test('deny_modify has priority over allow_modify', () => {
    const guardrails = makeGuardrails({
      allow_modify: ['**/*'],
    });
    const result = validateFileList(['.env'], guardrails);
    assert.strictEqual(result.ok, false);
    assert(result.reason?.includes('Forbidden file touched'));
  });

  test('validateFileList passes with missing allow_modify', () => {
    const guardrails = makeGuardrails();
    const result = validateFileList(['src/index.ts'], guardrails);
    assert.strictEqual(result.ok, true);
  });

  test('validateFileList rejects absolute paths', () => {
    const guardrails = makeGuardrails();
    const result = validateFileList(['/etc/passwd'], guardrails);
    assert.strictEqual(result.ok, false);
    assert(result.reason?.includes('Absolute path not allowed'));
  });

  test('validateFileList rejects path traversal', () => {
    const guardrails = makeGuardrails();
    const result = validateFileList(['../secret.ts'], guardrails);
    assert.strictEqual(result.ok, false);
    assert(result.reason?.includes('Path traversal not allowed'));
  });

  test('validateFileList rejects backslash paths', () => {
    const guardrails = makeGuardrails();
    const result = validateFileList(['src\\index.ts'], guardrails);
    assert.strictEqual(result.ok, false);
    assert(result.reason?.includes('Backslash not allowed'));
  });

  test('validateDiffSize passes when within limit', () => {
    const diffStat: DiffStat = {
      files: ['src/index.ts'],
      insertions: 10,
      deletions: 5,
      binaryFiles: [],
    };
    const result = validateDiffSize(diffStat, 20);
    assert.strictEqual(result.ok, true);
  });

  test('validateDiffSize rejects when over limit', () => {
    const diffStat: DiffStat = {
      files: ['src/index.ts'],
      insertions: 20,
      deletions: 10,
      binaryFiles: [],
    };
    const result = validateDiffSize(diffStat, 20);
    assert.strictEqual(result.ok, false);
    assert(result.reason?.includes('Diff too large'));
  });

  test('validateDiffSize rejects binary files', () => {
    const diffStat: DiffStat = {
      files: ['image.png'],
      insertions: 0,
      deletions: 0,
      binaryFiles: ['image.png'],
    };
    const result = validateDiffSize(diffStat, 100);
    assert.strictEqual(result.ok, false);
    assert(result.reason?.includes('Binary files detected'));
  });

  test('validateDiffSize passes with undefined maxLines', () => {
    const diffStat: DiffStat = {
      files: ['src/index.ts'],
      insertions: 1000,
      deletions: 1000,
      binaryFiles: [],
    };
    const result = validateDiffSize(diffStat, undefined);
    assert.strictEqual(result.ok, true);
  });

  test('validateTestsPresent passes when not required', () => {
    const result = validateTestsPresent(['src/index.ts'], false);
    assert.strictEqual(result.ok, true);
  });

  test('validateTestsPresent rejects when required but no test files', () => {
    const result = validateTestsPresent(['src/index.ts'], true);
    assert.strictEqual(result.ok, false);
    assert(result.reason?.includes('Tests required'));
  });

  test('validateTestsPresent passes when .test. file present', () => {
    const result = validateTestsPresent(['src/index.test.ts'], true);
    assert.strictEqual(result.ok, true);
  });

  test('validateTestsPresent passes when .spec. file present', () => {
    const result = validateTestsPresent(['src/index.spec.ts'], true);
    assert.strictEqual(result.ok, true);
  });

  test('validateProposedFileLineDeltas passes when within limit', () => {
    const dir = mkdtempSync(join(tmpdir(), 'guardrails-test-'));
    try {
      writeFileSync(join(dir, 'file.txt'), 'line1\nline2\n', 'utf-8');
      validateProposedFileLineDeltas(
        dir,
        [{ path: 'file.txt', content: 'line1\nline2\nline3\n' }],
        5
      );
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  test('validateProposedFileLineDeltas rejects when delta too large', () => {
    const dir = mkdtempSync(join(tmpdir(), 'guardrails-test-'));
    try {
      writeFileSync(join(dir, 'file.txt'), 'line1\n', 'utf-8');
      assert.throws(
        () =>
          validateProposedFileLineDeltas(
            dir,
            [{ path: 'file.txt', content: 'a\nb\nc\nd\ne\nf\n' }],
            2
          ),
        /Guardrails failed: Proposed file line delta too large/
      );
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  test('validateProposedFileLineDeltas no-op when maxLinesChanged undefined', () => {
    const dir = mkdtempSync(join(tmpdir(), 'guardrails-test-'));
    try {
      writeFileSync(join(dir, 'file.txt'), 'line1\n', 'utf-8');
      validateProposedFileLineDeltas(
        dir,
        [{ path: 'file.txt', content: 'a\nb\nc\nd\ne\nf\n' }],
        undefined
      );
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  test('validateProposedFileLineDeltas rejects absolute path', () => {
    assert.throws(
      () =>
        validateProposedFileLineDeltas('/tmp', [{ path: '/etc/passwd', content: '' }], 5),
      /Absolute path not allowed/
    );
  });

  test('validateProposedFileLineDeltas rejects path traversal', () => {
    assert.throws(
      () =>
        validateProposedFileLineDeltas('/tmp', [{ path: '../secret', content: '' }], 5),
      /Path traversal not allowed/
    );
  });
});
