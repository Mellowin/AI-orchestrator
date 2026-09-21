import { ProviderCallFailedError, normalizeProviderCallError } from '../../provider-call.js';
import {
  exhausted,
  type ProviderRole,
  type StructuredProviderFailure,
} from '../../provider-failure.js';

export class KimiProviderError extends Error {
  constructor(
    message: string,
    public readonly failure?: StructuredProviderFailure
  ) {
    super(message);
    this.name = 'KimiProviderError';
  }
}

export function extractKimiProviderFailure(
  error: unknown,
  role: ProviderRole
): StructuredProviderFailure | undefined {
  const base =
    error instanceof ProviderCallFailedError && error.failure !== undefined
      ? error.failure
      : normalizeProviderCallError(error).failure;
  if (base === undefined) {
    return undefined;
  }
  const filled: StructuredProviderFailure = { ...base, provider: 'kimi', role };
  // ProviderCallFailedError already applied retry-budget exhaustion; a raw
  // transport/HTTP error escaped after a single call, so treat it as spent.
  return error instanceof ProviderCallFailedError ? filled : exhausted(filled);
}
