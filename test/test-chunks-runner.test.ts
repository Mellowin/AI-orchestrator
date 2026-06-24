import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, rm } from 'node:fs/promises';
import { writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const PROJECT_ROOT = join(import.meta.dirname, '..');
const CHUNK_RUNNER = join(PROJECT_ROOT, 'scripts', 'run-test-chunks.mjs');
const CHUNK_LIB_URL = pathToFileURL(join(PROJECT_ROOT, 'scripts', 'test-chunks-lib.mjs')).href;

async function loadLib() {
  return import(CHUNK_LIB_URL);
}

describe('test:chunks runner script', () => {
  it('chunk runner script exists', async () => {
    const content = await readFile(CHUNK_RUNNER, 'utf8');
    assert.ok(content.length > 0);
    assert.ok(content.includes('discoverTestFiles'));
  });

  it('chunk runner lib exists and exports helpers', async () => {
    const lib = await loadLib();
    assert.equal(typeof lib.discoverTestFiles, 'function');
    assert.equal(typeof lib.chunkFiles, 'function');
    assert.equal(typeof lib.parseNodeTestSummary, 'function');
    assert.equal(typeof lib.aggregateSummaries, 'function');
    assert.equal(typeof lib.redactOutput, 'function');
  });

  it('discovers .test.ts files recursively under test/', async () => {
    const lib = await loadLib();
    const files = await lib.discoverTestFiles(join(PROJECT_ROOT, 'test'));
    assert.ok(files.length > 50, `expected many test files, got ${files.length}`);
    assert.ok(files.every((f) => f.endsWith('.test.ts')));
    assert.ok(files.some((f) => f.includes('cli-real-repo-run-ai.test.ts')));
    assert.ok(files.some((f) => f.includes('real-repo-rollback.test.ts')));
  });

  it('sorts files deterministically', async () => {
    const lib = await loadLib();
    const files = await lib.discoverTestFiles(join(PROJECT_ROOT, 'test'));
    const files2 = await lib.discoverTestFiles(join(PROJECT_ROOT, 'test'));
    assert.deepEqual(files, files2);
    for (let i = 1; i < files.length; i++) {
      assert.ok(files[i - 1].localeCompare(files[i], 'en') <= 0);
    }
  });

  it('chunks a fake list correctly', async () => {
    const lib = await loadLib();
    const list = ['a', 'b', 'c', 'd', 'e'];
    assert.deepEqual(lib.chunkFiles(list, 2), [['a', 'b'], ['c', 'd'], ['e']]);
    assert.deepEqual(lib.chunkFiles(list, 10), [['a', 'b', 'c', 'd', 'e']]);
  });

  it('rejects invalid chunk size', async () => {
    const lib = await loadLib();
    assert.throws(() => lib.chunkFiles(['a'], 0), /chunkSize/);
    assert.throws(() => lib.chunkFiles(['a'], -1), /chunkSize/);
    assert.throws(() => lib.chunkFiles(['a'], NaN), /chunkSize/);
  });

  it('parses Node test runner summary', async () => {
    const lib = await loadLib();
    const sample = `\n▶ suite\n  ✔ one (1ms)\n✔ suite (2ms)\nℹ tests 5\nℹ suites 1\nℹ pass 5\nℹ fail 0\nℹ cancelled 0\nℹ skipped 0\nℹ duration_ms 1234.5\n`;
    const parsed = lib.parseNodeTestSummary(sample);
    assert.equal(parsed.tests, 5);
    assert.equal(parsed.suites, 1);
    assert.equal(parsed.pass, 5);
    assert.equal(parsed.fail, 0);
    assert.equal(parsed.durationMs, 1234.5);
  });

  it('aggregates summaries', async () => {
    const lib = await loadLib();
    const total = lib.aggregateSummaries([
      { tests: 10, suites: 2, pass: 9, fail: 1, cancelled: 0, skipped: 0, durationMs: 100 },
      { tests: 5, suites: 1, pass: 5, fail: 0, cancelled: 0, skipped: 0, durationMs: 50 },
    ]);
    assert.equal(total.tests, 15);
    assert.equal(total.suites, 3);
    assert.equal(total.pass, 14);
    assert.equal(total.fail, 1);
    assert.equal(total.durationMs, 150);
  });

  it('redacts token-like strings', async () => {
    const lib = await loadLib();
    const raw = 'key=sk-abc12345678901234567890 token=xyz123secret api_key=foo Bearer xyz123secret gh=ghp_123456789012345678901234567890123456';
    const redacted = lib.redactOutput(raw);
    assert.ok(!redacted.includes('sk-abc12345678901234567890'));
    assert.ok(!redacted.includes('xyz123secret'));
    assert.ok(!redacted.includes('ghp_123456789012345678901234567890123456'));
    assert.ok(redacted.includes('sk-***'));
    assert.ok(redacted.includes('Bearer ***'));
  });

  it('package.json has test:chunks script', async () => {
    const pkg = JSON.parse(await readFile(join(PROJECT_ROOT, 'package.json'), 'utf8'));
    assert.ok(pkg.scripts['test:chunks']);
    assert.ok(pkg.scripts['test:chunks'].includes('run-test-chunks'));
  });

  it('verify:product runs runner self-test separately and uses product chunks', async () => {
    const pkg = JSON.parse(await readFile(join(PROJECT_ROOT, 'package.json'), 'utf8'));
    assert.ok(pkg.scripts['verify:product']);
    assert.ok(pkg.scripts['verify:product'].includes('test/test-chunks-runner.test.ts'));
    assert.ok(pkg.scripts['verify:product'].includes('test:chunks:product'));
    assert.ok(!pkg.scripts['verify:product'].includes('npm test'));
  });

  it('runner exits non-zero when chunk fails', async () => {
    const tmpFile = join(PROJECT_ROOT, 'tmp', 'chunk-runner-failing.test.ts');
    writeFileSync(
      tmpFile,
      `import { describe, it } from 'node:test';\nimport assert from 'node:assert/strict';\ndescribe('intentional failure', () => { it('fails', () => { assert.fail('intentional chunk failure'); }); });\n`,
      'utf8'
    );

    try {
      const result = spawnSync(
        process.execPath,
        ['scripts/run-test-chunks.mjs', '--chunk-size', '2', '--test-dir', join(PROJECT_ROOT, 'tmp')],
        {
          cwd: PROJECT_ROOT,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
        }
      );

      assert.notEqual(result.status, 0, 'expected non-zero exit for failing chunk');
      const output = `${result.stdout}\n${result.stderr}`;
      assert.ok(output.includes('Chunk 1: FAILED'), output);
      assert.ok(output.includes('intentional chunk failure'), output);
    } finally {
      try {
        await rm(tmpFile);
      } catch {
        // ignore cleanup errors
      }
    }
  });

  it('runs chunks concurrently and aggregates totals', async () => {
    const base = join(PROJECT_ROOT, 'tmp', `chunk-concurrent-${Date.now()}`);
    mkdirSync(base, { recursive: true });
    const files = ['a', 'b', 'c'].map((name) => join(base, `${name}.test.ts`));
    writeFileSync(files[0], `import { describe, it } from 'node:test';\ndescribe('a', () => { it('a1', () => {}); });\n`, 'utf8');
    writeFileSync(files[1], `import { describe, it } from 'node:test';\ndescribe('b', () => { it('b1', () => {}); it('b2', () => {}); });\n`, 'utf8');
    writeFileSync(files[2], `import { describe, it } from 'node:test';\ndescribe('c', () => { it('c1', () => {}); });\n`, 'utf8');

    try {
      const result = spawnSync(
        process.execPath,
        ['scripts/run-test-chunks.mjs', '--chunk-size', '1', '--concurrency', '3', '--test-dir', base],
        {
          cwd: PROJECT_ROOT,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
        }
      );

      assert.equal(result.status, 0, `expected success: ${result.stderr}`);
      const output = `${result.stdout}\n${result.stderr}`;
      assert.ok(output.includes('TOTAL: tests=4'), output);
      assert.ok(output.includes('OK: all test chunks passed'), output);
    } finally {
      try {
        await rm(base, { recursive: true, force: true });
      } catch {
        // ignore cleanup errors
      }
    }
  });

  it('enforces per-chunk timeout', async () => {
    const base = join(PROJECT_ROOT, 'tmp', `chunk-timeout-${Date.now()}`);
    mkdirSync(base, { recursive: true });
    const file = join(base, 'slow.test.ts');
    writeFileSync(
      file,
      `import { describe, it } from 'node:test';\ndescribe('slow', () => { it('waits', async () => { await new Promise(r => setTimeout(r, 5000)); }); });\n`,
      'utf8'
    );

    try {
      const result = spawnSync(
        process.execPath,
        ['scripts/run-test-chunks.mjs', '--chunk-timeout-ms', '500', '--test-dir', base],
        {
          cwd: PROJECT_ROOT,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
        }
      );

      assert.notEqual(result.status, 0, 'expected non-zero exit for timed-out chunk');
      const output = `${result.stdout}\n${result.stderr}`;
      assert.ok(output.includes('timed out after 500ms'), output);
    } finally {
      try {
        await rm(base, { recursive: true, force: true });
      } catch {
        // ignore cleanup errors
      }
    }
  });

  it('no live provider calls in test:chunks runner code', async () => {
    const content = await readFile(CHUNK_RUNNER, 'utf8');
    assert.ok(!content.includes('api.moonshot.cn'));
    assert.ok(!content.includes('openai.com'));
  });

  it('no network calls in test:chunks runner code', async () => {
    const content = await readFile(CHUNK_RUNNER, 'utf8');
    assert.ok(!content.includes('fetch('));
    assert.ok(!content.includes('http://'));
    assert.ok(!content.includes('https://'));
  });

  it('--exclude removes file from --list-chunks', async () => {
    const result = spawnSync(
      process.execPath,
      ['scripts/run-test-chunks.mjs', '--list-chunks', '--exclude', 'test-chunks-runner.test.ts'],
      {
        cwd: PROJECT_ROOT,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    );
    assert.equal(result.status, 0, `list-chunks failed: ${result.stderr}`);
    const output = `${result.stdout}\n${result.stderr}`;
    assert.ok(!output.includes('test-chunks-runner.test.ts'), output);
    assert.ok(output.includes('1 excluded'), output);
  });

  it('multiple --exclude values work', async () => {
    const base = join(PROJECT_ROOT, 'tmp', `chunk-exclude-multi-${Date.now()}`);
    mkdirSync(base, { recursive: true });
    writeFileSync(join(base, 'a.test.ts'), `import { describe, it } from 'node:test'; describe('a', () => { it('a1', () => {}); });\n`, 'utf8');
    writeFileSync(join(base, 'b.test.ts'), `import { describe, it } from 'node:test'; describe('b', () => { it('b1', () => {}); });\n`, 'utf8');
    writeFileSync(join(base, 'c.test.ts'), `import { describe, it } from 'node:test'; describe('c', () => { it('c1', () => {}); });\n`, 'utf8');

    try {
      const result = spawnSync(
        process.execPath,
        ['scripts/run-test-chunks.mjs', '--list-chunks', '--exclude', 'a.test.ts', '--exclude', 'b.test.ts', '--test-dir', base],
        {
          cwd: PROJECT_ROOT,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
        }
      );
      assert.equal(result.status, 0, `list-chunks failed: ${result.stderr}`);
      const output = `${result.stdout}\n${result.stderr}`;
      assert.ok(!output.includes('a.test.ts'), output);
      assert.ok(!output.includes('b.test.ts'), output);
      assert.ok(output.includes('c.test.ts'), output);
      assert.ok(output.includes('2 excluded'), output);
    } finally {
      try {
        await rm(base, { recursive: true, force: true });
      } catch {
        // ignore cleanup errors
      }
    }
  });

  it('excluded file is not executed', async () => {
    const base = join(PROJECT_ROOT, 'tmp', `chunk-exclude-run-${Date.now()}`);
    mkdirSync(base, { recursive: true });
    writeFileSync(join(base, 'pass.test.ts'), `import { describe, it } from 'node:test'; describe('pass', () => { it('ok', () => {}); });\n`, 'utf8');
    writeFileSync(join(base, 'fail.test.ts'), `import { describe, it } from 'node:test'; import assert from 'node:assert/strict'; describe('fail', () => { it('bad', () => { assert.fail('excluded failure'); }); });\n`, 'utf8');

    try {
      const result = spawnSync(
        process.execPath,
        ['scripts/run-test-chunks.mjs', '--exclude', 'fail.test.ts', '--test-dir', base],
        {
          cwd: PROJECT_ROOT,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
        }
      );
      assert.equal(result.status, 0, `expected success when failing file is excluded: ${result.stderr}`);
      const output = `${result.stdout}\n${result.stderr}`;
      assert.ok(output.includes('OK: all test chunks passed'), output);
      assert.ok(!output.includes('excluded failure'), output);
    } finally {
      try {
        await rm(base, { recursive: true, force: true });
      } catch {
        // ignore cleanup errors
      }
    }
  });

  it('invalid exclude does not crash', async () => {
    const result = spawnSync(
      process.execPath,
      ['scripts/run-test-chunks.mjs', '--list-chunks', '--exclude', 'does-not-exist.test.ts'],
      {
        cwd: PROJECT_ROOT,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    );
    assert.equal(result.status, 0, `expected success for invalid exclude: ${result.stderr}`);
    const output = `${result.stdout}\n${result.stderr}`;
    assert.ok(output.includes('0 excluded'), output);
  });

  it('isolates known heavy test files into single-file chunks', async () => {
    const result = spawnSync(process.execPath, ['scripts/run-test-chunks.mjs', '--list-chunks'], {
      cwd: PROJECT_ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    assert.equal(result.status, 0, `list-chunks failed: ${result.stderr}`);

    const heavyFiles = ['cli-real-block-run-ai.test.ts', 'cli-real-repo-run-ai.test.ts'];
    const lines = result.stdout.split(/\r?\n/);
    const chunkFileCounts = new Map<string, number>();
    let currentChunk: string | null = null;

    for (const line of lines) {
      const chunkHeader = line.match(/^Chunk (\d+):/);
      if (chunkHeader) {
        currentChunk = chunkHeader[1];
        continue;
      }
      if (currentChunk && line.trim().startsWith(PROJECT_ROOT.substring(0, 2))) {
        const basename = line.trim().split(/[\\/]/).pop() ?? '';
        if (heavyFiles.includes(basename)) {
          chunkFileCounts.set(basename, (chunkFileCounts.get(basename) ?? 0) + 1);
        }
      }
    }

    for (const heavy of heavyFiles) {
      assert.equal(chunkFileCounts.get(heavy), 1, `expected ${heavy} in exactly one chunk`);
    }

    // Verify each heavy file is isolated: count files in its chunk from the output.
    for (const heavy of heavyFiles) {
      let currentChunkName: string | null = null;
      let filesInChunk = 0;
      let foundChunkName: string | null = null;
      for (const line of lines) {
        const header = line.match(/^Chunk (\d+):/);
        if (header) {
          if (foundChunkName && filesInChunk === 1) {
            break;
          }
          currentChunkName = header[1];
          filesInChunk = 0;
          foundChunkName = null;
        }
        if (currentChunkName && line.trim().startsWith(PROJECT_ROOT.substring(0, 2))) {
          filesInChunk++;
          if (line.includes(heavy)) {
            foundChunkName = currentChunkName;
          }
        }
      }
      assert.equal(filesInChunk, 1, `expected ${heavy} to be isolated in a single-file chunk, got ${filesInChunk}`);
    }
  });
});
