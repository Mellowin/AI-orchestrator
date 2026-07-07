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
 * Throws a safe error if no valid decision can be extracted.
 */
export function parseReviewerDecisionText(text: string): ReviewerParseResult {
  const strict = tryStrictJsonParse(text);
  if (strict !== undefined) {
    return strict;
  }

  const extracted = tryExtractJson(text);
  if (extracted !== undefined) {
    return extracted;
  }

  throw new Error(`Reviewer output is not valid JSON: ${maskRawExcerpt(text)}`);
}

export function buildParseFailureResult(
  attempts: number,
  lastRawText: string | unknown
): ReviewerParseFailure {
  const text = typeof lastRawText === 'string' ? lastRawText : JSON.stringify(lastRawText);
  return {
    decision: 'blocked',
    reason: 'reviewer_json_parse_failed',
    parseAttempts: attempts,
    rawExcerptMasked: maskRawExcerpt(text),
  };
}

export { maskRawExcerpt };
