import { buildReviewerInput } from './reviewer-input.js';
import { evaluateReviewerGate } from './reviewer-gate.js';
import { redactSecrets } from './sandbox-preflight-repair.js';
import type { ReviewerEvidence } from './reviewer-evidence.js';
import type { ReviewerInput } from './reviewer-input.js';
import type { ReviewerGateResult } from './reviewer-gate.js';
import {
  parseReviewerDecision,
  type ReviewerDecision as GateReviewerDecision,
} from './reviewer-decision.js';
import {
  parseReviewerDecisionText,
  buildParseFailureResult,
  type ReviewerParseFailure,
} from './reviewer/reviewer-output-parser.js';

export type ReviewerProviderCall = (
  input: ReviewerInput
) => Promise<string | unknown>;

export interface ReviewerProviderRunnerInput {
  evidence: ReviewerEvidence;
  reviewer: ReviewerProviderCall;
  maxParseRetries?: number;
}

export interface ReviewerProviderRunnerResult {
  reviewerInput: ReviewerInput;
  rawReviewerOutput?: string | unknown;
  gateResult: ReviewerGateResult;
  parseFailure?: ReviewerParseFailure;
}

const DEFAULT_REVIEWER_PARSE_RETRIES = 2;
const MAX_REVIEWER_PARSE_RETRIES = 5;

function resolveMaxParseRetries(input: ReviewerProviderRunnerInput): number {
  const raw = input.maxParseRetries;
  if (raw === undefined) {
    return DEFAULT_REVIEWER_PARSE_RETRIES;
  }
  if (!Number.isInteger(raw) || raw < 0 || raw > MAX_REVIEWER_PARSE_RETRIES) {
    throw new Error(
      `Invalid maxParseRetries: ${raw}. Must be an integer between 0 and ${MAX_REVIEWER_PARSE_RETRIES}.`
    );
  }
  return raw;
}

function buildRepairInput(
  baseInput: ReviewerInput,
  attempt: number,
  lastError: string
): ReviewerInput {
  return {
    ...baseInput,
    previousFailure: `Previous reviewer output could not be parsed as valid JSON (attempt ${attempt}). Error: ${lastError}. Respond with a single valid JSON object matching the required output format exactly. Do not include prose, markdown fences, or explanations outside the JSON.`,
  };
}

function findTopLevelObject(text: string): string | undefined {
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

function extractJsonCandidate(text: string): string | undefined {
  const fenced = extractFencedJson(text);
  if (fenced !== undefined) {
    return fenced;
  }
  return findTopLevelObject(text);
}

function tryParseCamelCaseReviewerDecision(
  text: string
): GateReviewerDecision | undefined {
  const trimmed = text.trim();
  let candidate = trimmed;
  try {
    JSON.parse(trimmed);
  } catch {
    const extracted = extractJsonCandidate(trimmed);
    if (extracted === undefined) {
      return undefined;
    }
    candidate = extracted;
  }
  const result = parseReviewerDecision(candidate);
  if (!result.ok || result.decision === undefined) {
    return undefined;
  }
  return result.decision;
}

function normalizeReviewerOutput(
  raw: string | unknown
): { text: string; source: 'string' | 'object' } {
  if (typeof raw === 'string') {
    return { text: raw, source: 'string' };
  }
  return { text: JSON.stringify(raw), source: 'object' };
}

function tryParseReviewerOutput(text: string): {
  decision: GateReviewerDecision;
  method: 'strict' | 'fenced' | 'top_level_object';
} | undefined {
  // First try the snake_case provider format.
  try {
    const result = parseReviewerDecisionText(text);
    const mapped: GateReviewerDecision = {
      decision:
        result.decision.decision === 'accepted'
          ? 'accept'
          : 'reject',
      confidence: result.decision.confidence,
      blockingIssues: result.decision.blocking_issues,
      nonBlockingIssues: result.decision.non_blocking_issues,
      reviewSummary: result.decision.review_summary,
      fixTask: result.decision.fix_task ?? undefined,
      nextAction:
        result.decision.next_action === 'advance_to_next_task'
          ? 'continue'
          : result.decision.next_action === 'send_fix_to_coder'
          ? 'fix'
          : 'block',
    };
    return { decision: mapped, method: result.extractionMethod };
  } catch {
    // Fall through to camelCase gate format.
  }

  const camel = tryParseCamelCaseReviewerDecision(text);
  if (camel !== undefined) {
    return { decision: camel, method: 'top_level_object' };
  }

  return undefined;
}

export async function runReviewerGateWithProvider(
  input: ReviewerProviderRunnerInput
): Promise<ReviewerProviderRunnerResult> {
  const maxRetries = resolveMaxParseRetries(input);
  const baseReviewerInput = buildReviewerInput(input.evidence);

  let lastRaw: string | unknown = undefined;
  let lastError = '';

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const reviewerInput =
      attempt === 0
        ? baseReviewerInput
        : buildRepairInput(baseReviewerInput, attempt, lastError);

    try {
      const rawReviewerOutput = await input.reviewer(reviewerInput);
      lastRaw = rawReviewerOutput;

      const { text } = normalizeReviewerOutput(rawReviewerOutput);
      const parseResult = tryParseReviewerOutput(text);

      if (parseResult === undefined) {
        throw new Error(`Reviewer output is not valid JSON`);
      }

      const gateResult = evaluateReviewerGate({
        evidence: input.evidence,
        reviewerOutput: JSON.stringify(parseResult.decision),
      });

      return {
        reviewerInput,
        rawReviewerOutput,
        gateResult: {
          ...gateResult,
          parseAttempts: attempt + 1,
        } as ReviewerGateResult,
      };
    } catch (providerError) {
      const errorMessage =
        providerError instanceof Error
          ? providerError.message
          : String(providerError);
      lastError = errorMessage;

      const isParseError =
        errorMessage.includes('not valid JSON') ||
        errorMessage.includes('ReviewerDecision') ||
        errorMessage.includes('Invalid or missing');

      if (!isParseError || attempt >= maxRetries) {
        const gateResult: ReviewerGateResult = {
          status: 'blocked',
          source: isParseError ? 'parser' : 'provider',
          reviewerInput,
          blockingIssues: [`Reviewer provider failed: ${redactSecrets(errorMessage)}`],
          nonBlockingIssues: [],
          reviewSummary: isParseError
            ? 'Blocked due to invalid reviewer output format.'
            : 'Blocked due to reviewer provider failure.',
          nextAction: 'block',
        };

        if (isParseError) {
          return {
            reviewerInput,
            rawReviewerOutput: lastRaw,
            gateResult: {
              ...gateResult,
              parseAttempts: attempt + 1,
            } as ReviewerGateResult,
            parseFailure: buildParseFailureResult(attempt + 1, lastRaw),
          };
        }

        return {
          reviewerInput,
          gateResult,
        };
      }

      // Parse error and retries remain: continue loop with repair prompt.
    }
  }

  // Should never reach here because the final iteration returns above,
  // but TypeScript requires a return statement.
  const gateResult: ReviewerGateResult = {
    status: 'blocked',
    source: 'parser',
    reviewerInput: baseReviewerInput,
    blockingIssues: [`Reviewer provider failed: ${redactSecrets(lastError)}`],
    nonBlockingIssues: [],
    reviewSummary: 'Blocked due to invalid reviewer output format.',
    nextAction: 'block',
  };
  return {
    reviewerInput: baseReviewerInput,
    rawReviewerOutput: lastRaw,
    gateResult: {
      ...gateResult,
      parseAttempts: maxRetries + 1,
    } as ReviewerGateResult,
    parseFailure: buildParseFailureResult(maxRetries + 1, lastRaw),
  };
}
