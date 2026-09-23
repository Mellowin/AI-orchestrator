import { createHash } from 'node:crypto';
import type { ReviewerDecision } from '../providers/provider-types.js';
import { validateReviewerDecision } from './reviewer-schema.js';
import { redactSecrets } from '../sandbox-preflight-repair.js';

export interface ReviewerParseResult {
  decision: ReviewerDecision;
  rawText: string;
  extractionMethod: 'strict' | 'fenced' | 'top_level_object';
}

export interface ReviewerParseFailure {
  decision: 'blocked';
  reason: 'reviewer_json_parse_failed';
  parseAttempts: number;
  rawExcerptMasked: string;
}

const MAX_RAW_OUTPUT_EXCERPT = 200;
const MAX_RAW_OUTPUT_PERSIST = 4096;

/**
 * Explicit, structural marker for "reviewer returned malformed output".
 * Callers must classify parse failures by instanceof, never by matching
 * native JSON.parse wording (which varies by engine and is not part of any
 * contract).
 */
export class ReviewerOutputParseError extends Error {
  readonly name = 'ReviewerOutputParseError';
  constructor(
    message: string,
    readonly rawText?: string
  ) {
    super(message);
  }
}

export interface SanitizedRawOutput {
  excerptMasked: string;
  length: number;
  sha256: string;
  truncated: boolean;
}

/**
 * Sanitize and bound a raw provider payload before persistence: secrets are
 * redacted, the stored excerpt is capped, and the hash/length are computed
 * over the redacted text so integrity can be verified without storing giant
 * or sensitive payloads.
 */
export function sanitizeRawOutput(text: string): SanitizedRawOutput {
  const redacted = redactSecrets(text);
  const bounded =
    redacted.length > MAX_RAW_OUTPUT_PERSIST
      ? redacted.slice(0, MAX_RAW_OUTPUT_PERSIST)
      : redacted;
  return {
    excerptMasked: maskRawExcerpt(bounded, MAX_RAW_OUTPUT_EXCERPT),
    length: redacted.length,
    sha256: createHash('sha256').update(bounded).digest('hex'),
    truncated: redacted.length > MAX_RAW_OUTPUT_PERSIST,
  };
}

function maskRawExcerpt(text: string, maxLength = 200): string {
  const trimmed = text.trim();
  const excerpt = trimmed.length > maxLength ? trimmed.slice(0, maxLength) + '...' : trimmed;
  return redactSecrets(excerpt);
}

function tryStrictJsonParse(text: string): ReviewerParseResult | undefined {
  const trimmed = text.trim();
  if (trimmed === '') {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return undefined;
  }
  return {
    decision: validateReviewerDecision(parsed),
    rawText: text,
    extractionMethod: 'strict',
  };
}

function extractFencedJson(text: string): string | undefined {
  const trimmed = text.trim();
  if (!trimmed.startsWith('```')) {
    return undefined;
  }
  const lines = trimmed.split('\n');
  if (lines.length < 2) {
    return undefined;
  }
  const firstLine = lines[0];
  if (firstLine !== '```' && firstLine !== '```json') {
    return undefined;
  }
  const lastLine = lines[lines.length - 1];
  if (lastLine !== '```') {
    return undefined;
  }
  const middle = lines.slice(1, -1).join('\n');
  if (middle.trim() === '') {
    return undefined;
  }
  return middle;
}

function findTopLevelObject(text: string): string | undefined {
  // Find the first top-level JSON object starting at '{'.
  const start = text.indexOf('{');
  if (start === -1) {
    return undefined;
  }
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < text.length; i++) {
    const char = text[i];
    if (inString) {
      if (escape) {
        escape = false;
      } else if (char === '\\') {
        escape = true;
      } else if (char === '"') {
        inString = false;
      }
    } else {
      if (char === '"') {
        inString = true;
      } else if (char === '{') {
        depth++;
      } else if (char === '}') {
        depth--;
        if (depth === 0) {
          return text.slice(start, i + 1);
        }
      }
    }
  }
  return undefined;
}

function tryExtractJson(text: string): ReviewerParseResult | undefined {
  const fenced = extractFencedJson(text);
  if (fenced !== undefined) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(fenced);
    } catch {
      // Fall through to top-level object extraction.
      parsed = undefined;
    }
    if (parsed !== undefined) {
      return {
        decision: validateReviewerDecision(parsed),
        rawText: text,
        extractionMethod: 'fenced',
      };
    }
  }

  const topLevel = findTopLevelObject(text);
  if (topLevel !== undefined) {
    const parsed = JSON.parse(topLevel);
    return {
      decision: validateReviewerDecision(parsed),
      rawText: text,
      extractionMethod: 'top_level_object',
    };
  }

  return undefined;
}

/**
 * Parse reviewer output text into a validated ReviewerDecision.
 * Tries strict JSON parse, then fenced JSON block, then first top-level object.
 * Throws ReviewerOutputParseError if no valid decision can be extracted.
 */
export function parseReviewerDecisionText(text: string): ReviewerParseResult {
  try {
    const strict = tryStrictJsonParse(text);
    if (strict !== undefined) {
      return strict;
    }

    const extracted = tryExtractJson(text);
    if (extracted !== undefined) {
      return extracted;
    }
  } catch (err) {
    if (err instanceof ReviewerOutputParseError) {
      throw err;
    }
    const message = err instanceof Error ? err.message : String(err);
    throw new ReviewerOutputParseError(redactSecrets(message), text);
  }

  throw new ReviewerOutputParseError(
    `Reviewer output is not valid JSON: ${maskRawExcerpt(text)}`,
    text
  );
}

export function buildParseFailureResult(
  attempts: number,
  lastRawText: string | unknown
): ReviewerParseFailure {
  const text =
    typeof lastRawText === 'string'
      ? lastRawText
      : lastRawText === undefined
        ? ''
        : JSON.stringify(lastRawText);
  return {
    decision: 'blocked',
    reason: 'reviewer_json_parse_failed',
    parseAttempts: attempts,
    rawExcerptMasked: maskRawExcerpt(text),
  };
}

export { maskRawExcerpt };
