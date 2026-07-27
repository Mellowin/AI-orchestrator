import { describe, test } from 'node:test';
import assert from 'node:assert';
import { patternsOverlap, validateTaskScope } from '../src/task-scope-validator.js';

describe('patternsOverlap', () => {
  test('exact path matches itself', () => {
    assert.strictEqual(patternsOverlap('src/foo.ts', 'src/foo.ts'), true);
  });

  test('exact paths do not overlap when different', () => {
    assert.strictEqual(patternsOverlap('src/a.ts', 'src/b.ts'), false);
  });

  test('glob allowed matches exact denied', () => {
    assert.strictEqual(patternsOverlap('src/**', 'src/foo.ts'), true);
  });

  test('allowed glob matches exact denied in subdirectory', () => {
    assert.strictEqual(patternsOverlap('docs/**/*.md', 'docs/private/note.md'), true);
  });

  test('allowed glob does not match denied in different branch', () => {
    assert.strictEqual(patternsOverlap('docs/**/*.md', 'src/private/note.md'), false);
  });

  test('single-segment wildcard overlap', () => {
    assert.strictEqual(patternsOverlap('docs/*.md', 'docs/readme.md'), true);
  });

  test('deny **/* overlaps any allowed', () => {
    assert.strictEqual(patternsOverlap('docs/proofs/*.md', '**/*'), true);
  });

  test('non-overlapping globs', () => {
    assert.strictEqual(patternsOverlap('src/**', 'docs/**'), false);
  });

  test('normalizes Windows separators', () => {
    assert.strictEqual(patternsOverlap('src\\**', 'src/foo.ts'), true);
  });

  test('handles spaces and Unicode in paths', () => {
    assert.strictEqual(patternsOverlap('docs/привет *.md', 'docs/привет readme.md'), true);
  });

  test('** matches zero segments', () => {
    assert.strictEqual(patternsOverlap('**/README.md', 'README.md'), true);
  });
});

describe('validateTaskScope', () => {
  test('accepts valid non-overlapping scope', () => {
    const result = validateTaskScope({
      id: 'part1',
      allowed_files: ['docs/proofs/part1.md'],
      denied_files: ['.env', 'node_modules/**'],
    });
    assert.strictEqual(result.length, 0);
  });

  test('rejects exact allowed and denied overlap', () => {
    const result = validateTaskScope({
      id: 'part1',
      allowed_files: ['docs/proofs/part1.md'],
      denied_files: ['docs/proofs/part1.md'],
    });
    assert.ok(result.some((i) => i.message.includes('overlaps denied')));
  });

  test('rejects allowed glob and deny **/*', () => {
    const result = validateTaskScope({
      id: 'part1',
      allowed_files: ['docs/proofs/STAGE_18_26_PROOF6_*.md'],
      denied_files: ['**/*'],
    });
    assert.ok(result.some((i) => i.message.includes('overlaps denied')));
    assert.ok(result.some((i) => i.message.includes('no writable scope')));
  });

  test('rejects allowed docs/**/*.md and denied docs/private/**', () => {
    const result = validateTaskScope({
      id: 'part1',
      allowed_files: ['docs/**/*.md'],
      denied_files: ['docs/private/**'],
    });
    assert.ok(result.some((i) => i.message.includes('overlaps denied')));
  });

  test('allows non-overlapping allowed and denied globs', () => {
    const result = validateTaskScope({
      id: 'part1',
      allowed_files: ['docs/**/*.md'],
      denied_files: ['src/**'],
    });
    assert.strictEqual(result.length, 0);
  });

  test('rejects absolute allowed path', () => {
    const result = validateTaskScope({
      id: 'part1',
      allowed_files: ['/etc/passwd'],
    });
    assert.ok(result.some((i) => i.message.includes('relative path')));
  });

  test('rejects traversal in allowed path', () => {
    const result = validateTaskScope({
      id: 'part1',
      allowed_files: ['../outside.ts'],
    });
    assert.ok(result.some((i) => i.message.includes('traversal')));
  });

  test('normalizes Windows separators and still detects overlap', () => {
    const result = validateTaskScope({
      id: 'part1',
      allowed_files: ['src\\foo.ts'],
      denied_files: ['src/*.ts'],
    });
    assert.ok(result.some((i) => i.message.includes('overlaps denied')));
  });

  test('rejects empty allowed_files', () => {
    const result = validateTaskScope({
      id: 'part1',
      allowed_files: [],
    });
    assert.ok(result.some((i) => i.message.includes('non-empty array')));
  });

  test('normalizes undefined denied_files to empty array', () => {
    const result = validateTaskScope({
      id: 'part1',
      allowed_files: ['docs/proofs/part1.md'],
    });
    assert.strictEqual(result.length, 0);
  });

  test('rejects denied .env does not conflict with allowed docs/**', () => {
    const result = validateTaskScope({
      id: 'part1',
      allowed_files: ['docs/**'],
      denied_files: ['.env'],
    });
    assert.strictEqual(result.length, 0);
  });

  test('rejects allowed .env as sensitive path', () => {
    const result = validateTaskScope({
      id: 'part1',
      allowed_files: ['.env'],
    });
    assert.ok(result.some((i) => i.message.includes('sensitive system paths')));
  });
});
