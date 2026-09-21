/**
 * Fake provider error directives for deterministic integration tests.
 *
 * A fake response string can encode a simulated provider failure instead of a
 * normal completion payload:
 * - `__FETCH_ERROR__`                  → HTTP 500 with empty body (legacy form)
 * - `__FETCH_ERROR__:<status>:<body>`  → HTTP <status> with <body> as the error body
 * - `__FETCH_TIMEOUT__`                → simulated request timeout
 */

export type FakeProviderErrorDirective =
  | { kind: 'http'; status: number; body: string }
  | { kind: 'timeout' };

const FETCH_ERROR_PREFIX = '__FETCH_ERROR__';
const FETCH_TIMEOUT_TOKEN = '__FETCH_TIMEOUT__';

export function parseFakeProviderErrorDirective(raw: string): FakeProviderErrorDirective | null {
  const trimmed = raw.trim();
  if (trimmed === FETCH_TIMEOUT_TOKEN) {
    return { kind: 'timeout' };
  }
  if (trimmed === FETCH_ERROR_PREFIX) {
    return { kind: 'http', status: 500, body: '' };
  }
  if (trimmed.startsWith(`${FETCH_ERROR_PREFIX}:`)) {
    const rest = trimmed.slice(FETCH_ERROR_PREFIX.length + 1);
    const separator = rest.indexOf(':');
    const statusText = separator === -1 ? rest : rest.slice(0, separator);
    const status = Number(statusText);
    if (!Number.isInteger(status) || status < 100 || status > 599) {
      return null;
    }
    const body = separator === -1 ? '' : rest.slice(separator + 1);
    return { kind: 'http', status, body };
  }
  return null;
}
