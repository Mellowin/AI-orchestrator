import type {
  DiagnoseCiChunkRunnerSummary,
  DiagnoseCiFailedTestFile,
  DiagnoseCiLogParseResult,
  DiagnoseCiSummaryLock,
} from './types.js';

const FILE_LOCATION_RE = /^(.+\.(?:ts|js|tsx|jsx|mjs|cjs)):/;

function countLeadingSpaces(line: string): number {
  let count = 0;
  for (const ch of line) {
    if (ch === ' ') count += 1;
    else break;
  }
  return count;
}

export function parseLog(log: string, maxLogExcerptChars = 4000): DiagnoseCiLogParseResult {
  const failedTestFiles: DiagnoseCiFailedTestFile[] = [];
  const timeouts: string[] = [];
  const typecheckFailures: string[] = [];
  const buildFailures: string[] = [];

  const lines = log.split(/\r?\n/);
  let currentSubtest: string | undefined;

  type BlockKey = 'error' | 'stack';
  let entry: Partial<DiagnoseCiFailedTestFile> | null = null;
  let blockKey: BlockKey | null = null;
  let blockIndent = 0;
  const blockLines: string[] = [];

  function flushBlock(): void {
    if (entry && blockKey && blockLines.length > 0) {
      const value = blockLines.join('\n');
      if (blockKey === 'error') {
        entry.message = value.trim();
      } else if (blockKey === 'stack') {
        entry.stack = value.trim();
      }
    }
    blockKey = null;
    blockLines.length = 0;
    blockIndent = 0;
  }

  function flushEntry(): void {
    flushBlock();
    if (entry && entry.file) {
      failedTestFiles.push({
        file: entry.file,
        subtest: entry.subtest,
        message: entry.message,
        expected: entry.expected,
        actual: entry.actual,
        stack: entry.stack,
        location: entry.location,
      });
    }
    entry = null;
  }

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const trimmed = line.trim();

    if (trimmed.startsWith('# Subtest:')) {
      currentSubtest = trimmed.slice('# Subtest:'.length).trim();
      continue;
    }

    const notOkMatch = line.match(/^not ok\s+\d+(?:\s+-\s+(.*))?$/);
    if (notOkMatch) {
      flushEntry();
      entry = {
        subtest: currentSubtest ?? notOkMatch[1] ?? undefined,
      };
      currentSubtest = undefined;
      continue;
    }

    if (entry) {
      const indent = countLeadingSpaces(line);

      if (blockKey) {
        if (line.length > 0 && indent >= blockIndent) {
          blockLines.push(line.slice(blockIndent));
          continue;
        }
        flushBlock();
      }

      const locationMatch = line.match(/^  location:\s*(.+)$/);
      if (locationMatch) {
        const location = locationMatch[1].replace(/^['"]|['"]$/g, '');
        entry.location = location;
        const fileMatch = location.match(FILE_LOCATION_RE);
        if (fileMatch) {
          entry.file = fileMatch[1];
        }
        continue;
      }

      const errorBlockMatch = line.match(/^  error:\s*\|-?\s*$/);
      if (errorBlockMatch) {
        blockKey = 'error';
        blockIndent = indent + 2;
        continue;
      }
      const errorInlineMatch = line.match(/^  error:\s*(.+)$/);
      if (errorInlineMatch) {
        entry.message = errorInlineMatch[1].replace(/^['"]|['"]$/g, '');
        continue;
      }

      const expectedMatch = line.match(/^  expected:\s*(.+)$/);
      if (expectedMatch) {
        entry.expected = expectedMatch[1].replace(/^['"]|['"]$/g, '');
        continue;
      }

      const actualMatch = line.match(/^  actual:\s*(.+)$/);
      if (actualMatch) {
        entry.actual = actualMatch[1].replace(/^['"]|['"]$/g, '');
        continue;
      }

      const stackBlockMatch = line.match(/^  stack:\s*\|-?\s*$/);
      if (stackBlockMatch) {
        blockKey = 'stack';
        blockIndent = indent + 2;
        continue;
      }
      const stackInlineMatch = line.match(/^  stack:\s*(.+)$/);
      if (stackInlineMatch) {
        entry.stack = stackInlineMatch[1].replace(/^['"]|['"]$/g, '');
        continue;
      }

      if (trimmed === '...' || /^ok\s+\d+/.test(line)) {
        flushEntry();
      }
    }

    if (/timeout|cancelled|exceeded time/i.test(line) && !/TOTAL:|tests=|suites=|pass=|fail=/i.test(line)) {
      timeouts.push(line.trim());
    }

    if (/Type check/i.test(line) && /(?:failed|error|exit)/i.test(line)) {
      typecheckFailures.push(line.trim());
    }
    if (/\bBuild\b/i.test(line) && /(?:failed|error|exit)/i.test(line)) {
      buildFailures.push(line.trim());
    }
  }

  flushEntry();

  const summaryLock = parseSummaryLock(log);
  const chunkRunner = parseChunkRunner(log);
  const rawExcerpt = log.slice(0, Math.max(0, maxLogExcerptChars));

  return {
    failedTestFiles,
    summaryLock,
    chunkRunner,
    timeouts,
    typecheckFailures,
    buildFailures,
    rawExcerpt,
  };
}

function parseSummaryLock(log: string): DiagnoseCiSummaryLock | null {
  const lines = log.split(/\r?\n/);
  let staleCommit: string | undefined;
  let changedFile: string | undefined;
  let message: string | undefined;

  for (const line of lines) {
    if (/Verifier failed:\s*TESTING_SUMMARY verification failed:/i.test(line)) {
      message = line.trim();
    }

    const match = line.match(/Last verified commit \(([a-f0-9]+)\)(?::\s*(.+))?/i);
    if (match) {
      staleCommit = match[1];
      if (match[2]) {
        changedFile = match[2].trim();
      }
      message = message ?? line.trim();
    }
  }

  if (!message && !staleCommit) {
    return null;
  }

  return { staleCommit, changedFile, message };
}

function parseChunkRunner(log: string): DiagnoseCiChunkRunnerSummary | null {
  const match = log.match(
    /TOTAL:\s*tests=(\d+)\s+suites=(\d+)\s+pass=(\d+)\s+fail=(\d+)\s+cancelled=(\d+)\s+skipped=(\d+)/i
  );
  if (!match) {
    return null;
  }

  return {
    totalTests: Number(match[1]),
    totalSuites: Number(match[2]),
    pass: Number(match[3]),
    fail: Number(match[4]),
    cancelled: Number(match[5]),
    skipped: Number(match[6]),
    rawLine: match[0],
  };
}
