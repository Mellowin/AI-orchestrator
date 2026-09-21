import { redactSecrets } from './sandbox-preflight-repair.js';

export type ProviderFailureKind =
  | 'AUTH_INVALID'
  | 'AUTH_EXPIRED'
  | 'QUOTA_EXHAUSTED'
  | 'RATE_LIMITED'
  | 'PERMISSION_DENIED'
  | 'TRANSIENT_NETWORK'
  | 'PROVIDER_5XX'
  | 'BAD_REQUEST'
  | 'CONTEXT_LIMIT'
  | 'UNKNOWN_PROVIDER_FAILURE';

export type ProviderRole =
  | 'coder'
  | 'reviewer'
  | 'planner'
  | 'final_reviewer'
  | 'unknown';

export interface StructuredProviderFailure {
  provider: string;
  role: ProviderRole;
  http_status: number | null;
  failure_kind: ProviderFailureKind;
  retryable: boolean;
  pause_recommended: boolean;
  sanitized_message: string;
  provider_error_code?: string;
  provider_error_type?: string;
}

export interface ProviderErrorBody {
  code?: string;
  type?: string;
  message?: string;
}

export interface ProviderHttpClassification {
  failure_kind: ProviderFailureKind;
  retryable: boolean;
  pause_recommended: boolean;
}

const SANITIZED_MESSAGE_MAX_LENGTH = 500;

export function sanitizeProviderMessage(raw: string): string {
  // Provider error bodies can echo request headers; never let secrets through.
  const redacted = redactSecrets(raw)
    .replace(/sk-[^\s]*/g, '[REDACTED]')
    .replace(/Bearer\s+[^\s]*/gi, 'Bearer [REDACTED]')
    .trim();
  return redacted.length > SANITIZED_MESSAGE_MAX_LENGTH
    ? redacted.slice(0, SANITIZED_MESSAGE_MAX_LENGTH)
    : redacted;
}

function readStringField(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export function extractProviderErrorBody(bodyText: string): ProviderErrorBody | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return null;
  }
  const root = parsed as Record<string, unknown>;
  const nested =
    typeof root.error === 'object' && root.error !== null
      ? (root.error as Record<string, unknown>)
      : undefined;

  const code = (nested && readStringField(nested, 'code')) ?? readStringField(root, 'code');
  const type = (nested && readStringField(nested, 'type')) ?? readStringField(root, 'type');
  const rawMessage =
    (nested && readStringField(nested, 'message')) ?? readStringField(root, 'message');
  const message = rawMessage !== undefined ? sanitizeProviderMessage(rawMessage) : undefined;

  if (code === undefined && type === undefined && message === undefined) {
    return null;
  }
  return {
    ...(code !== undefined ? { code } : {}),
    ...(type !== undefined ? { type } : {}),
    ...(message !== undefined ? { message } : {}),
  };
}

function buildEvidence(errorBody: ProviderErrorBody | null | undefined): string {
  if (!errorBody) {
    return '';
  }
  return [errorBody.code, errorBody.type, errorBody.message]
    .filter((part): part is string => typeof part === 'string')
    .join(' ')
    .toLowerCase();
}

function hasContextLengthEvidence(evidence: string): boolean {
  return (
    evidence.includes('context_length') ||
    evidence.includes('context length') ||
    evidence.includes('context window') ||
    evidence.includes('max tokens') ||
    evidence.includes('maximum context') ||
    evidence.includes('too many tokens') ||
    evidence.includes('request too large')
  );
}

export function classifyProviderHttpFailure(args: {
  status: number;
  errorBody?: ProviderErrorBody | null;
}): ProviderHttpClassification {
  const { status, errorBody } = args;
  const evidence = buildEvidence(errorBody);

  if (status === 401) {
    return {
      failure_kind: evidence.includes('expired') ? 'AUTH_EXPIRED' : 'AUTH_INVALID',
      retryable: false,
      pause_recommended: true,
    };
  }

  if (status === 403) {
    let failure_kind: ProviderFailureKind = 'UNKNOWN_PROVIDER_FAILURE';
    if (
      evidence.includes('insufficient_quota') ||
      evidence.includes('quota') ||
      evidence.includes('billing') ||
      evidence.includes('account')
    ) {
      failure_kind = 'QUOTA_EXHAUSTED';
    } else if (
      evidence.includes('access denied') ||
      evidence.includes('forbidden') ||
      evidence.includes('permission') ||
      evidence.includes('scope')
    ) {
      failure_kind = 'PERMISSION_DENIED';
    }
    return { failure_kind, retryable: false, pause_recommended: true };
  }

  if (status === 429) {
    return { failure_kind: 'RATE_LIMITED', retryable: true, pause_recommended: false };
  }

  if (status === 400 || status === 413 || status === 422) {
    if (hasContextLengthEvidence(evidence)) {
      return { failure_kind: 'CONTEXT_LIMIT', retryable: false, pause_recommended: false };
    }
    return { failure_kind: 'BAD_REQUEST', retryable: false, pause_recommended: false };
  }

  if (status >= 500 && status < 600) {
    return { failure_kind: 'PROVIDER_5XX', retryable: true, pause_recommended: false };
  }

  return { failure_kind: 'UNKNOWN_PROVIDER_FAILURE', retryable: false, pause_recommended: false };
}

export function classifyProviderTransportFailure(
  kind: 'timeout' | 'network'
): ProviderHttpClassification {
  if (kind !== 'timeout' && kind !== 'network') {
    throw new Error(`Invalid transport failure kind: ${String(kind)}`);
  }
  return { failure_kind: 'TRANSIENT_NETWORK', retryable: true, pause_recommended: false };
}

const PAUSE_AFTER_EXHAUSTION_KINDS = new Set<ProviderFailureKind>([
  'RATE_LIMITED',
  'TRANSIENT_NETWORK',
  'PROVIDER_5XX',
]);

export function exhausted(failure: StructuredProviderFailure): StructuredProviderFailure {
  return {
    ...failure,
    retryable: false,
    pause_recommended:
      failure.pause_recommended || PAUSE_AFTER_EXHAUSTION_KINDS.has(failure.failure_kind),
  };
}
