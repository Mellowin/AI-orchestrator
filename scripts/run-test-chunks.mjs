import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { cpus } from 'node:os';
import {
  aggregateSummaries,
  chunkFiles,
  discoverTestFiles,
  formatChunkSummary,
  formatFinalSummary,
  parseNodeTestSummary,
  redactOutput,
} from './test-chunks-lib.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const DEFAULT_CHUNK_SIZE = 3;
const DEFAULT_CONCURRENCY = Math.min(12, Math.max(1, cpus().length));
const DEFAULT_CHUNK_TIMEOUT_MS = 300_000;

// Files known to spawn long-running integration tests are isolated into single-file chunks
// so they do not push mixed chunks over the interactive tool timeout.
const HEAVY_FILE_NAMES = new Set([
  'cli-real-block-run-ai.test.ts',
  'cli-real-repo-run-ai.test.ts',
]);
const TEST_DIR = join(__dirname, '..', 'test');
const RUNNER_BIN = process.execPath;
const RUNNER_ARGS = [join(__dirname, '..', 'node_modules', 'tsx', 'dist', 'cli.mjs'), '--test'];

/**
 * Parse CLI arguments.
 * --chunk-size N
 * --chunk-index N (0-based, runs only that chunk)
 * --test-dir path
 * --concurrency N (max parallel chunks, default based on CPU count, capped at 12)
 * --chunk-timeout-ms N (per-chunk timeout, default 300000)
 * --list-chunks (print chunks and exit)
 * --exclude <path-or-basename> (exclude one or more test files; can be repeated)
 */
function parseArgs(argv) {
  const args = {
    chunkSize: DEFAULT_CHUNK_SIZE,
    chunkIndex: null,
    testDir: TEST_DIR,
    concurrency: DEFAULT_CONCURRENCY,
    chunkTimeoutMs: DEFAULT_CHUNK_TIMEOUT_MS,
    listChunks: false,
    excludes: [],
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--chunk-size' || arg === '--chunkSize') {
      const next = argv[i + 1];
      const parsed = Number(next);
      if (next == null || !Number.isFinite(parsed) || parsed < 1) {
        throw new Error(`Invalid --chunk-size value: ${next}`);
      }
      args.chunkSize = Math.floor(parsed);
      i++;
    } else if (arg === '--chunk-index' || arg === '--chunkIndex') {
      const next = argv[i + 1];
      const parsed = Number(next);
      if (next == null || !Number.isFinite(parsed) || parsed < 0) {
        throw new Error(`Invalid --chunk-index value: ${next}`);
      }
      args.chunkIndex = Math.floor(parsed);
      i++;
    } else if (arg === '--test-dir' || arg === '--testDir') {
      const next = argv[i + 1];
      if (next == null) {
        throw new Error('Missing value for --test-dir');
      }
      args.testDir = next;
      i++;
    } else if (arg === '--concurrency') {
      const next = argv[i + 1];
      const parsed = Number(next);
      if (next == null || !Number.isFinite(parsed) || parsed < 1) {
        throw new Error(`Invalid --concurrency value: ${next}`);
      }
      args.concurrency = Math.floor(parsed);
      i++;
    } else if (arg === '--chunk-timeout-ms') {
      const next = argv[i + 1];
      const parsed = Number(next);
      if (next == null || !Number.isFinite(parsed) || parsed < 1) {
        throw new Error(`Invalid --chunk-timeout-ms value: ${next}`);
      }
      args.chunkTimeoutMs = Math.floor(parsed);
      i++;
    } else if (arg === '--list-chunks') {
      args.listChunks = true;
    } else if (arg === '--exclude') {
      const next = argv[i + 1];
      if (next == null) {
        throw new Error('Missing value for --exclude');
      }
      args.excludes.push(next);
      i++;
    }
  }
  return args;
}

/**
 * Build env for a chunk child process.
 * Remove NODE_TEST_CONTEXT to avoid the test runner treating the child as a recursive test run.
 */
function buildChunkEnv() {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  return env;
}

/**
 * Run a single chunk of test files through tsx --test.
 * Returns { ok: boolean, output: string, summary: object, timedOut: boolean }.
 */
function runChunk(files, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn(RUNNER_BIN, [...RUNNER_ARGS, ...files], {
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
      env: buildChunkEnv(),
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, timeoutMs);

    child.stdout.on('data', (data) => {
      stdout += data.toString('utf8');
    });

    child.stderr.on('data', (data) => {
      stderr += data.toString('utf8');
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      const combined = `${stdout}\n${stderr}`.trim();
      const summary = parseNodeTestSummary(combined);
      if (timedOut) {
        resolve({
          ok: false,
          output: `${combined}\nChunk timed out after ${timeoutMs}ms`.trim(),
          summary,
          timedOut: true,
        });
      } else {
        resolve({
          ok: code === 0,
          output: combined,
          summary,
          timedOut: false,
        });
      }
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({
        ok: false,
        output: `Failed to spawn test runner: ${err.message}`,
        summary: parseNodeTestSummary(''),
        timedOut: false,
      });
    });
  });
}

/**
 * Run chunks with bounded concurrency. Prints a summary line as each chunk finishes.
 */
async function runChunks(chunks, concurrency, timeoutMs) {
  const results = new Array(chunks.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < chunks.length) {
      const index = nextIndex++;
      const result = await runChunk(chunks[index], timeoutMs);
      results[index] = { index, files: chunks[index], ...result };
      if (!result.ok) {
        console.error(formatChunkSummary(index, chunks[index], result.summary, true));
        if (result.timedOut) {
          console.error(`Chunk ${index + 1} exceeded ${timeoutMs}ms timeout.`);
        }
      } else {
        console.log(formatChunkSummary(index, chunks[index], result.summary, false));
      }
    }
  }

  const workers = [];
  for (let i = 0; i < concurrency; i++) {
    workers.push(worker());
  }
  await Promise.all(workers);
  return results;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  console.log(`Discovering test files in ${args.testDir}...`);
  const discoveredFiles = await discoverTestFiles(args.testDir);
  if (discoveredFiles.length === 0) {
    console.error('No .test.ts files found.');
    process.exitCode = 1;
    return;
  }

  const normalizedExcludes = args.excludes.map((e) => e.replace(/\\/g, '/'));
  const isExcluded = (file) => {
    const base = basename(file);
    const rel = relative(args.testDir, file).replace(/\\/g, '/');
    const absFile = resolve(file).replace(/\\/g, '/');
    return normalizedExcludes.some((ex) => {
      if (base === ex || rel === ex || rel.endsWith(`/${ex}`)) return true;
      const absEx = resolve(ex).replace(/\\/g, '/');
      return absFile === absEx;
    });
  };
  const files = discoveredFiles.filter((f) => !isExcluded(f));
  const excludedCount = discoveredFiles.length - files.length;

  const heavy = files.filter((f) => HEAVY_FILE_NAMES.has(basename(f)));
  const rest = files.filter((f) => !HEAVY_FILE_NAMES.has(basename(f)));
  const chunks = [...heavy.map((f) => [f]), ...chunkFiles(rest, args.chunkSize)];

  if (args.listChunks) {
    console.log(`Found ${files.length} test file(s), ${excludedCount} excluded, chunk size ${args.chunkSize} => ${chunks.length} chunk(s).`);
    for (let i = 0; i < chunks.length; i++) {
      console.log(`Chunk ${i + 1}:`);
      for (const file of chunks[i]) {
        console.log(`  ${file}`);
      }
    }
    return;
  }

  if (args.chunkIndex != null) {
    if (args.chunkIndex >= chunks.length) {
      console.error(`Chunk index ${args.chunkIndex} out of range (0-${chunks.length - 1}).`);
      process.exitCode = 1;
      return;
    }
    console.log(`Running chunk ${args.chunkIndex + 1}/${chunks.length} (${chunks[args.chunkIndex].length} files).`);
    const result = await runChunk(chunks[args.chunkIndex], args.chunkTimeoutMs);
    if (!result.ok) {
      console.error(formatChunkSummary(args.chunkIndex, chunks[args.chunkIndex], result.summary, true));
      if (result.timedOut) {
        console.error(`Chunk exceeded ${args.chunkTimeoutMs}ms timeout.`);
      }
      console.error(redactOutput(result.output));
      process.exitCode = 1;
    } else {
      console.log(formatChunkSummary(args.chunkIndex, chunks[args.chunkIndex], result.summary, false));
    }
    return;
  }

  console.log(
    `Found ${files.length} test file(s), ${excludedCount} excluded, chunk size ${args.chunkSize}, concurrency ${args.concurrency}, timeout ${args.chunkTimeoutMs}ms.`
  );

  const startMs = Date.now();
  const results = await runChunks(chunks, args.concurrency, args.chunkTimeoutMs);
  const wallMs = Date.now() - startMs;

  let anyFailed = false;
  for (const result of results) {
    if (!result.ok) {
      anyFailed = true;
      console.error(redactOutput(result.output));
    }
  }

  const summaries = results.map((r) => r.summary);
  const total = aggregateSummaries(summaries);
  console.log(formatFinalSummary(total));
  console.log(`Wall time: ${wallMs}ms`);

  if (anyFailed) {
    console.error('FAILED: one or more test chunks failed.');
    process.exitCode = 1;
  } else {
    console.log('OK: all test chunks passed.');
  }
}

main().catch((err) => {
  console.error(redactOutput(err instanceof Error ? err.message : String(err)));
  process.exitCode = 1;
});
