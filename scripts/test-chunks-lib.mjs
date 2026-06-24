import { readdir, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';

/**
 * Recursively discover all *.test.ts files under root.
 * Returns absolute paths sorted deterministically.
 * @param {string} root
 * @returns {Promise<string[]>}
 */
export async function discoverTestFiles(root) {
  const files = [];
  await walk(root, files);
  files.sort((a, b) => a.localeCompare(b, 'en'));
  return files;
}

async function walk(dir, files, isRoot = true) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (isRoot) {
      throw new Error(`Failed to read test directory ${dir}: ${err instanceof Error ? err.message : String(err)}`);
    }
    // Transient directories (e.g. temp dirs being deleted during a parallel run) are skipped.
    return;
  }
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(fullPath, files, false);
    } else if (entry.isFile() && entry.name.endsWith('.test.ts')) {
      files.push(fullPath);
    }
  }
}

/**
 * Split files into chunks of at most chunkSize.
 * @param {string[]} files
 * @param {number} chunkSize
 * @returns {string[][]}
 */
export function chunkFiles(files, chunkSize) {
  if (!Number.isFinite(chunkSize) || chunkSize < 1) {
    throw new Error(`chunkSize must be a positive integer, got ${chunkSize}`);
  }
  const chunks = [];
  for (let i = 0; i < files.length; i += chunkSize) {
    chunks.push(files.slice(i, i + chunkSize));
  }
  return chunks;
}

/**
 * Parse Node test runner summary from stdout/stderr string.
 * @param {string} output
 * @returns {{ tests: number; suites: number; pass: number; fail: number; cancelled: number; skipped: number; durationMs: number | null }}
 */
export function parseNodeTestSummary(output) {
  const result = {
    tests: 0,
    suites: 0,
    pass: 0,
    fail: 0,
    cancelled: 0,
    skipped: 0,
    durationMs: null,
  };
  if (!output) return result;

  const lines = output.split(/\r?\n/);
  for (const line of lines) {
    const testsMatch = line.match(/^(?:ℹ|#)\s+tests\s+(\d+)$/);
    if (testsMatch) {
      result.tests = Number(testsMatch[1]);
      continue;
    }
    const suitesMatch = line.match(/^(?:ℹ|#)\s+suites\s+(\d+)$/);
    if (suitesMatch) {
      result.suites = Number(suitesMatch[1]);
      continue;
    }
    const passMatch = line.match(/^(?:ℹ|#)\s+pass\s+(\d+)$/);
    if (passMatch) {
      result.pass = Number(passMatch[1]);
      continue;
    }
    const failMatch = line.match(/^(?:ℹ|#)\s+fail\s+(\d+)$/);
    if (failMatch) {
      result.fail = Number(failMatch[1]);
      continue;
    }
    const cancelledMatch = line.match(/^(?:ℹ|#)\s+cancelled\s+(\d+)$/);
    if (cancelledMatch) {
      result.cancelled = Number(cancelledMatch[1]);
      continue;
    }
    const skippedMatch = line.match(/^(?:ℹ|#)\s+skipped\s+(\d+)$/);
    if (skippedMatch) {
      result.skipped = Number(skippedMatch[1]);
      continue;
    }
    const durationMatch = line.match(/^(?:ℹ|#)\s+duration_ms\s+(\d+(?:\.\d+)?)$/);
    if (durationMatch) {
      result.durationMs = Number(durationMatch[1]);
    }
  }
  return result;
}

/**
 * Aggregate multiple parsed summaries into one.
 * @param {Array<ReturnType<typeof parseNodeTestSummary>>} summaries
 * @returns {{ tests: number; suites: number; pass: number; fail: number; cancelled: number; skipped: number; durationMs: number }}
 */
export function aggregateSummaries(summaries) {
  const total = {
    tests: 0,
    suites: 0,
    pass: 0,
    fail: 0,
    cancelled: 0,
    skipped: 0,
    durationMs: 0,
  };
  for (const s of summaries) {
    total.tests += s.tests;
    total.suites += s.suites;
    total.pass += s.pass;
    total.fail += s.fail;
    total.cancelled += s.cancelled;
    total.skipped += s.skipped;
    total.durationMs += s.durationMs ?? 0;
  }
  return total;
}

/**
 * Redact token-like strings from output before printing it.
 * @param {string} output
 * @returns {string}
 */
export function redactOutput(output) {
  if (typeof output !== 'string') return '';
  return output
    .replace(/sk-[a-zA-Z0-9]{20,}/g, 'sk-***')
    .replace(/ghp_[a-zA-Z0-9]{36}/g, 'ghp_***')
    .replace(/github_pat_[a-zA-Z0-9_]{22,}/g, 'github_pat_***')
    .replace(/Bearer\s+[a-zA-Z0-9_\-]{8,}/g, 'Bearer ***')
    .replace(/([a-zA-Z_]*(?:api[_-]?key|token|password|secret))\s*[:=]\s*[^\s\r\n'"]+/gi, '$1=***');
}

/**
 * Format a chunk summary line.
 * @param {number} chunkIndex
 * @param {string[]} files
 * @param {ReturnType<typeof parseNodeTestSummary>} summary
 * @param {boolean} failed
 * @returns {string}
 */
export function formatChunkSummary(chunkIndex, files, summary, failed) {
  const fileCount = files.length;
  const duration = summary.durationMs != null ? ` (${Math.round(summary.durationMs)}ms)` : '';
  const status = failed ? 'FAILED' : 'OK';
  return `Chunk ${chunkIndex + 1}: ${status} | files=${fileCount} tests=${summary.tests} suites=${summary.suites} pass=${summary.pass} fail=${summary.fail}${duration}`;
}

/**
 * Format the final aggregated summary.
 * @param {ReturnType<typeof aggregateSummaries>} total
 * @returns {string}
 */
export function formatFinalSummary(total) {
  return `TOTAL: tests=${total.tests} suites=${total.suites} pass=${total.pass} fail=${total.fail} cancelled=${total.cancelled} skipped=${total.skipped} (${Math.round(total.durationMs)}ms)`;
}
