import { describe, test } from 'node:test';
import assert from 'node:assert';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  rmdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { writeJsonAtomic } from '../src/state-atomic-write.js';

function tmpDir(): string {
  const base = join(process.cwd(), 'tmp');
  if (!existsSync(base)) {
    mkdirSync(base);
  }
  return mkdtempSync(join(base, 'atomic-write-test-'));
}

function listTmpFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((name) => name.includes('.tmp.'));
}

describe('state-atomic-write', () => {
  test('writes valid JSON', () => {
    const dir = tmpDir();
    const filePath = join(dir, 'state.json');
    try {
      writeJsonAtomic(filePath, { status: 'ok', count: 42 });
      const raw = readFileSync(filePath, 'utf-8');
      const parsed = JSON.parse(raw);
      assert.strictEqual(parsed.status, 'ok');
      assert.strictEqual(parsed.count, 42);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('overwrites existing JSON atomically', () => {
    const dir = tmpDir();
    const filePath = join(dir, 'state.json');
    try {
      writeJsonAtomic(filePath, { version: 1 });
      writeJsonAtomic(filePath, { version: 2 });
      const raw = readFileSync(filePath, 'utf-8');
      const parsed = JSON.parse(raw);
      assert.strictEqual(parsed.version, 2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('failed temp write preserves existing final file', () => {
    const dir = tmpDir();
    const filePath = join(dir, 'state.json');
    try {
      writeJsonAtomic(filePath, { version: 1 });

      const circular: Record<string, unknown> = { version: 2 };
      circular.self = circular;

      assert.throws(() => writeJsonAtomic(filePath, circular), /cyclic|circular/i);

      const raw = readFileSync(filePath, 'utf-8');
      const parsed = JSON.parse(raw);
      assert.strictEqual(parsed.version, 1, 'Existing final file should be preserved');
      assert.strictEqual(listTmpFiles(dir).length, 0, 'No temp files should remain');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('failed rename preserves existing final file and cleans up temp', () => {
    const dir = tmpDir();
    const filePath = join(dir, 'state.json');
    try {
      writeJsonAtomic(filePath, { version: 1 });
      // Make final path a directory so rename fails.
      rmSync(filePath);
      mkdirSync(filePath);

      assert.throws(() => writeJsonAtomic(filePath, { version: 2 }));

      assert(existsSync(filePath) && statSync(filePath).isDirectory(), 'Directory final path should remain');
      assert.strictEqual(listTmpFiles(dir).length, 0, 'Temp file should be cleaned up after failed rename');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('successful write leaves no temp files', () => {
    const dir = tmpDir();
    const filePath = join(dir, 'nested', 'state.json');
    try {
      writeJsonAtomic(filePath, { status: 'ok' });
      assert(existsSync(filePath));
      assert.strictEqual(listTmpFiles(join(dir, 'nested')).length, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('creates parent directory if missing', () => {
    const dir = tmpDir();
    const filePath = join(dir, 'a', 'b', 'state.json');
    try {
      writeJsonAtomic(filePath, { status: 'ok' });
      assert(existsSync(filePath));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('does not leak token-like text in error messages', () => {
    const dir = tmpDir();
    const filePath = join(dir, 'state.json');
    const secret = 'sk-fake-atomic-secret';
    try {
      writeFileSync(filePath, '{"existing":true}', 'utf-8');
      const circular: Record<string, unknown> = { token: secret };
      circular.self = circular;
      let caught: Error | undefined;
      try {
        writeJsonAtomic(filePath, circular);
      } catch (err) {
        caught = err instanceof Error ? err : new Error(String(err));
      }
      assert(caught !== undefined, 'Expected error');
      assert(!caught.message.includes(secret), `Secret leaked in error: ${caught.message}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
