import { redactSecrets } from './sandbox-preflight-repair.js';

/**
 * Structured classification for Git remote operation failures (push, fetch,
 * ls-remote, write-auth preflight). Authentication/permission failures are
 * operator-fixable credential interruptions and recommend a resumable pause;
 * repository conflicts (non-fast-forward, unexpected remote state) stay
 * fail-closed and never recommend a pause.
 */

export type GitRemoteOperation = 'push' | 'fetch' | 'ls-remote' | 'preflight_write_check';

export type GitRemoteFailureKind =
  | 'GIT_AUTH_INVALID'
  | 'GIT_AUTH_EXPIRED'
  | 'GIT_PERMISSION_DENIED'
  | 'GIT_REMOTE_UNAVAILABLE'
  | 'GIT_NETWORK_FAILURE'
  | 'GIT_NON_FAST_FORWARD'
  | 'GIT_REMOTE_CONFLICT'
  | 'GIT_UNKNOWN_FAILURE';

export interface StructuredGitRemoteFailure {
  remote: string;
  operation: GitRemoteOperation;
  failure_kind: GitRemoteFailureKind;
  http_status: number | null;
  pause_recommended: boolean;
  sanitized_message: string;
}

const SANITIZED_MESSAGE_MAX_LENGTH = 500;

/**
 * Redact secrets from raw git output. Covers known token patterns, embedded
 * credentials in URLs (e.g. x-access-token:<token>@github.com), and the exact
 * value of the currently configured GITHUB_TOKEN. The token value itself is
 * never persisted anywhere.
 */
export function sanitizeGitRemoteMessage(raw: string): string {
  let text = redactSecrets(raw);
  // Embedded credentials in URLs: scheme://user:password@host/...
  text = text.replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, '$1[REDACTED]@');
  // Exact configured credential values must never survive into state/reports.
  const token = process.env.GITHUB_TOKEN?.trim();
  if (token) {
    text = text.split(token).join('[REDACTED]');
  }
  text = text.trim();
  return text.length > SANITIZED_MESSAGE_MAX_LENGTH
    ? text.slice(0, SANITIZED_MESSAGE_MAX_LENGTH)
    : text;
}

function extractHttpStatus(evidence: string): number | null {
  const patterns = [
    /returned error:\s*(\d{3})/i,
    /http\/[\d.]+\s+(\d{3})/i,
    /\bhttp\s+(\d{3})\b/i,
    /status code\s+(\d{3})/i,
  ];
  for (const pattern of patterns) {
    const match = evidence.match(pattern);
    if (match) {
      const status = Number(match[1]);
      if (status >= 100 && status <= 599) {
        return status;
      }
    }
  }
  return null;
}

function isNonFastForward(evidence: string): boolean {
  return evidence.includes('non-fast-forward') || evidence.includes('fetch first');
}

function isRemoteConflict(evidence: string): boolean {
  return (
    evidence.includes('stale info') ||
    evidence.includes('remote conflict') ||
    evidence.includes('unexpected remote head')
  );
}

function isNetworkFailure(evidence: string): boolean {
  return (
    evidence.includes('could not resolve host') ||
    evidence.includes('failed to connect') ||
    evidence.includes('connection timed out') ||
    evidence.includes('connection refused') ||
    evidence.includes('unable to connect') ||
    evidence.includes('network is unreachable') ||
    evidence.includes('operation timed out') ||
    evidence.includes('connection reset')
  );
}

function isAuthFailure(evidence: string): boolean {
  return (
    evidence.includes('invalid username or token') ||
    evidence.includes('authentication failed') ||
    evidence.includes('could not read username') ||
    evidence.includes('terminal prompts disabled') ||
    evidence.includes('bad credentials') ||
    evidence.includes('invalid credential')
  );
}

function isPermissionFailure(evidence: string): boolean {
  return (
    evidence.includes('permission denied') ||
    evidence.includes('permission to') ||
    evidence.includes('write access') ||
    evidence.includes('access denied') ||
    evidence.includes('not authorized') ||
    evidence.includes('forbidden')
  );
}

function isRemoteUnavailable(evidence: string): boolean {
  return (
    evidence.includes('repository not found') ||
    evidence.includes('does not appear to be a git repository') ||
    evidence.includes('remote: not found')
  );
}

export interface ClassifyGitRemoteFailureInput {
  remote: string;
  operation: GitRemoteOperation;
  /** Raw stderr/stdout of the failed git command; sanitized before storage. */
  output: string;
}

/**
 * Classify a failed git remote operation. Ordering matters: repository
 * conflicts are checked first so an explicit non-fast-forward is never
 * misread as a credential problem; hook/remote messages carrying auth
 * evidence (e.g. "remote: Invalid username or token") are classified as
 * authentication failures even though the push was technically rejected.
 */
export function classifyGitRemoteFailure(
  input: ClassifyGitRemoteFailureInput
): StructuredGitRemoteFailure {
  const sanitizedMessage = sanitizeGitRemoteMessage(input.output);
  const evidence = sanitizedMessage.toLowerCase();
  const httpStatus = extractHttpStatus(evidence);

  let failureKind: GitRemoteFailureKind;
  let pauseRecommended: boolean;

  if (isNonFastForward(evidence)) {
    failureKind = 'GIT_NON_FAST_FORWARD';
    pauseRecommended = false;
  } else if (isRemoteConflict(evidence)) {
    failureKind = 'GIT_REMOTE_CONFLICT';
    pauseRecommended = false;
  } else if (isAuthFailure(evidence) || httpStatus === 401) {
    failureKind = evidence.includes('expired') ? 'GIT_AUTH_EXPIRED' : 'GIT_AUTH_INVALID';
    pauseRecommended = true;
  } else if (isPermissionFailure(evidence) || httpStatus === 403) {
    failureKind = 'GIT_PERMISSION_DENIED';
    pauseRecommended = true;
  } else if (isNetworkFailure(evidence)) {
    failureKind = 'GIT_NETWORK_FAILURE';
    pauseRecommended = true;
  } else if (isRemoteUnavailable(evidence) || httpStatus === 404 || (httpStatus !== null && httpStatus >= 500)) {
    failureKind = 'GIT_REMOTE_UNAVAILABLE';
    pauseRecommended = true;
  } else {
    failureKind = 'GIT_UNKNOWN_FAILURE';
    pauseRecommended = false;
  }

  return {
    remote: input.remote,
    operation: input.operation,
    failure_kind: failureKind,
    http_status: httpStatus,
    pause_recommended: pauseRecommended,
    sanitized_message: sanitizedMessage,
  };
}

/** True when the failure kind is a credential/access interruption an operator can fix. */
export function isGitCredentialFailureKind(kind: GitRemoteFailureKind): boolean {
  return (
    kind === 'GIT_AUTH_INVALID' ||
    kind === 'GIT_AUTH_EXPIRED' ||
    kind === 'GIT_PERMISSION_DENIED'
  );
}
