import type { BlockDefinition } from './block/block-types.js';

const DEFAULT_TASK_TIMEOUT_MS = 120000;
const REAL_PROVIDER_TASK_TIMEOUT_MS = 600000;
const MIN_TASK_TIMEOUT_MS = 500;
const MAX_TASK_TIMEOUT_MS = 900000;

function isRealProviderBlock(block: BlockDefinition): boolean {
  const coderProvider = block.providers?.coder?.provider;
  // Treat 'kimi' and any other non-fake remote providers as real.
  return coderProvider !== undefined && coderProvider !== 'fake';
}

export function getDefaultTaskTimeoutMs(block?: BlockDefinition): number {
  if (block && isRealProviderBlock(block)) {
    return REAL_PROVIDER_TASK_TIMEOUT_MS;
  }
  return DEFAULT_TASK_TIMEOUT_MS;
}

export function validateTaskTimeoutMs(value: unknown, block?: BlockDefinition): number {
  const defaultMs = getDefaultTaskTimeoutMs(block);
  if (value === undefined || value === null) {
    return defaultMs;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed === '') {
      return defaultMs;
    }
    const num = Number(trimmed);
    if (!Number.isInteger(num)) {
      throw new Error(`Invalid task timeout "${value}": must be an integer`);
    }
    return validateTaskTimeoutMs(num, block);
  }

  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new Error(`Invalid task timeout: must be an integer`);
  }

  if (value < MIN_TASK_TIMEOUT_MS || value > MAX_TASK_TIMEOUT_MS) {
    throw new Error(
      `Invalid task timeout ${value} ms: must be between ${MIN_TASK_TIMEOUT_MS} and ${MAX_TASK_TIMEOUT_MS}`
    );
  }

  return value;
}

export function resolveTaskTimeoutMs(block: BlockDefinition): number {
  const fromBlock = block.review_policy?.task_timeout_ms;
  if (fromBlock !== undefined) {
    return validateTaskTimeoutMs(fromBlock, block);
  }

  const fromEnv = process.env.REAL_BLOCK_TASK_TIMEOUT_MS;
  if (fromEnv !== undefined && fromEnv.trim() !== '') {
    return validateTaskTimeoutMs(fromEnv, block);
  }

  return getDefaultTaskTimeoutMs(block);
}

const DEFAULT_REVIEWER_PARSE_RETRIES = 2;
const MIN_REVIEWER_PARSE_RETRIES = 0;
const MAX_REVIEWER_PARSE_RETRIES = 5;

export function validateReviewerParseRetries(value: unknown): number {
  if (value === undefined || value === null) {
    return DEFAULT_REVIEWER_PARSE_RETRIES;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed === '') {
      return DEFAULT_REVIEWER_PARSE_RETRIES;
    }
    const num = Number(trimmed);
    if (!Number.isInteger(num)) {
      throw new Error(`Invalid reviewer parse retries "${value}": must be an integer`);
    }
    return validateReviewerParseRetries(num);
  }

  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new Error(`Invalid reviewer parse retries: must be an integer`);
  }

  if (value < MIN_REVIEWER_PARSE_RETRIES || value > MAX_REVIEWER_PARSE_RETRIES) {
    throw new Error(
      `Invalid reviewer parse retries ${value}: must be between ${MIN_REVIEWER_PARSE_RETRIES} and ${MAX_REVIEWER_PARSE_RETRIES}`
    );
  }

  return value;
}

export function resolveReviewerParseRetries(block: BlockDefinition): number {
  const fromBlock = block.review_policy?.reviewer_parse_retries;
  if (fromBlock !== undefined) {
    return validateReviewerParseRetries(fromBlock);
  }

  const fromEnv = process.env.REAL_REVIEWER_PARSE_RETRIES;
  if (fromEnv !== undefined && fromEnv.trim() !== '') {
    return validateReviewerParseRetries(fromEnv);
  }

  return DEFAULT_REVIEWER_PARSE_RETRIES;
}

export type OnBlockedTaskPolicy = 'stop' | 'continue';

export function resolveOnBlockedTask(block: BlockDefinition): OnBlockedTaskPolicy {
  const fromBlock = block.review_policy?.on_blocked_task;
  if (fromBlock === 'continue' || fromBlock === 'skip') {
    return 'continue';
  }
  if (fromBlock === 'stop') {
    return 'stop';
  }

  const fromEnv = process.env.REAL_BLOCK_ON_BLOCKED_TASK;
  if (fromEnv === 'continue' || fromEnv === 'skip') {
    return 'continue';
  }
  if (fromEnv === 'stop') {
    return 'stop';
  }

  return 'stop';
}

export function getResolvedTimeoutReport(block: BlockDefinition): {
  resolvedTaskTimeoutMs: number;
  resolvedReviewerParseRetries: number;
  resolvedOnBlockedTask: OnBlockedTaskPolicy;
} {
  return {
    resolvedTaskTimeoutMs: resolveTaskTimeoutMs(block),
    resolvedReviewerParseRetries: resolveReviewerParseRetries(block),
    resolvedOnBlockedTask: resolveOnBlockedTask(block),
  };
}
