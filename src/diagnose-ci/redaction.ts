/**
 * Redact secrets from any text that may be printed or persisted.
 *
 * This is applied to console output, reports, JSON artifacts, and error
 * messages so that diagnostic artifacts can be shared safely.
 */

export function redactSecrets(text: string): string {
  if (typeof text !== 'string') {
    return '';
  }

  return (
    text
      // GitHub personal access tokens (fine-grained and classic).
      .replace(/github_pat_[a-zA-Z0-9_]+/g, 'github_pat_***')
      .replace(/ghp_[a-zA-Z0-9]+/g, 'ghp_***')
      .replace(/gho_[a-zA-Z0-9]+/g, 'gho_***')
      .replace(/ghs_[a-zA-Z0-9]+/g, 'ghs_***')
      .replace(/ghu_[a-zA-Z0-9]+/g, 'ghu_***')
      // OpenAI-like API keys.
      .replace(/sk-[a-zA-Z0-9]+/g, 'sk-***')
      // Bearer tokens in headers or logs.
      .replace(/Bearer\s+\S+/gi, 'Bearer ***')
      // Authorization headers with token or Bearer schemes.
      .replace(/Authorization:\s*(?:token|Bearer)\s+\S+/gi, 'Authorization: ***')
      // Environment-style key=value secrets (e.g. KIMI_API_KEY=...).
      .replace(
        /([A-Za-z_][A-Za-z0-9_]*(?:API[_-]?KEY|api[_-]?key|TOKEN|token|SECRET|secret|PASSWORD|password))\s*[:=]\s*[^\s\r\n'"]+/g,
        '$1=***'
      )
      // Explicit KIMI_API_KEY fallback to cover unusual casing.
      .replace(/KIMI_API_KEY\s*[:=]\s*[^\s\r\n'"]+/g, 'KIMI_API_KEY=***')
  );
}
