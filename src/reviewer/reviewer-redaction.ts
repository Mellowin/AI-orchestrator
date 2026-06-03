/**
 * Redact potential secrets from text before including it in reviewer output.
 * Never throws. Returns safe string.
 */
export function redactReviewerText(input: string): string {
  if (typeof input !== 'string') {
    return String(input);
  }

  let result = input;

  // sk- tokens
  result = result.replace(/sk-[A-Za-z0-9_-]+/g, '[REDACTED]');

  // Bearer tokens
  result = result.replace(/Bearer\s+[A-Za-z0-9_./+-]+/gi, 'Bearer [REDACTED]');

  // API key assignments: KEY=value where value looks like a secret
  // KIMI_API_KEY=...
  result = result.replace(/(KIMI_API_KEY)=\S+/gi, '$1=[REDACTED]');
  // OPENAI_API_KEY=...
  result = result.replace(/(OPENAI_API_KEY)=\S+/gi, '$1=[REDACTED]');
  // ANTHROPIC_API_KEY=...
  result = result.replace(/(ANTHROPIC_API_KEY)=\S+/gi, '$1=[REDACTED]');
  // GITHUB_TOKEN=...
  result = result.replace(/(GITHUB_TOKEN)=\S+/gi, '$1=[REDACTED]');

  // Generic GitHub personal access tokens (ghp_..., github_pat_...)
  result = result.replace(/ghp_[A-Za-z0-9]{36,}/g, '[REDACTED]');
  result = result.replace(/github_pat_[A-Za-z0-9_]{30,}/g, '[REDACTED]');

  // Generic .env secret patterns: anything that looks like SECRET_NAME=secret_value
  // Be conservative: only redact values that look like secrets (long alphanumeric, base64-like, or containing common secret words)
  result = result.replace(
    /(\b[A-Za-z_]*(?:SECRET|TOKEN|KEY|PASSWORD|PASS|AUTH|PRIVATE)[A-Za-z_]*)=(\S{8,})/gi,
    '$1=[REDACTED]'
  );

  return result;
}

export function redactReviewerList(input: string[]): string[] {
  if (!Array.isArray(input)) {
    return [];
  }
  return input.map((item) => redactReviewerText(item));
}
