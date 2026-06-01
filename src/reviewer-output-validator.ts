import type { ReviewVerdict } from './types.js';

function isObject(val: unknown): val is Record<string, unknown> {
  return typeof val === 'object' && val !== null && !Array.isArray(val);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

const VALID_VERDICTS = ['approve', 'needs_changes', 'reject'] as const;

type ValidVerdict = (typeof VALID_VERDICTS)[number];

function isValidVerdict(value: unknown): value is ValidVerdict {
  return typeof value === 'string' && VALID_VERDICTS.includes(value as ValidVerdict);
}

export function validateReviewVerdict(value: unknown): ReviewVerdict {
  if (!isObject(value)) {
    throw new Error('ReviewVerdict must be an object');
  }

  if (!isValidVerdict(value.verdict)) {
    throw new Error(
      `Invalid ReviewVerdict.verdict: expected one of ${VALID_VERDICTS.join(', ')}, got "${String(value.verdict)}"`
    );
  }

  if (!isStringArray(value.critical_issues)) {
    throw new Error('ReviewVerdict.critical_issues must be an array of strings');
  }

  if (!isStringArray(value.requested_changes)) {
    throw new Error('ReviewVerdict.requested_changes must be an array of strings');
  }

  if (typeof value.summary_for_human !== 'string') {
    throw new Error('ReviewVerdict.summary_for_human must be a string');
  }

  return {
    verdict: value.verdict,
    critical_issues: value.critical_issues,
    requested_changes: value.requested_changes,
    summary_for_human: value.summary_for_human,
  };
}

export function parseReviewerOutputJson(raw: string): ReviewVerdict {
  const trimmed = raw.trim();

  let jsonText: string;

  if (trimmed.startsWith('```')) {
    if (!trimmed.endsWith('```')) {
      throw new Error('Invalid reviewer JSON output: fenced block not closed');
    }

    const lines = trimmed.split('\n');
    if (lines.length < 2) {
      throw new Error('Invalid reviewer JSON output: empty fenced block');
    }

    const firstLine = lines[0];
    if (firstLine !== '```' && firstLine !== '```json') {
      throw new Error('Invalid reviewer JSON output: unsupported fenced block language');
    }

    const lastLine = lines[lines.length - 1];
    if (lastLine !== '```') {
      throw new Error('Invalid reviewer JSON output: malformed fenced block');
    }

    const middleLines = lines.slice(1, -1);
    if (middleLines.some((line) => line === '```' || line.startsWith('```'))) {
      throw new Error('Invalid reviewer JSON output: multiple fenced blocks');
    }

    jsonText = middleLines.join('\n');
  } else {
    jsonText = trimmed;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Invalid reviewer JSON output: ${message}`);
  }

  return validateReviewVerdict(parsed);
}
