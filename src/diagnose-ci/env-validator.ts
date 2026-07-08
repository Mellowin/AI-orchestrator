import type { DiagnoseCiCapabilitySummary, DiagnoseCiConfig, DiagnoseCiVerdict } from './types.js';

export interface DiagnoseCiEnvValidationResult {
  ok: boolean;
  verdict?: DiagnoseCiVerdict;
  reason: string;
  token?: string;
}

export function buildCapabilitySummary(config: DiagnoseCiConfig): DiagnoseCiCapabilitySummary {
  const requested: string[] = [
    'github.pr.read',
    'github.actions.read',
    'github.logs.read',
  ];

  const forbidden: string[] = [
    'github.contents.write',
    'github.pr.write',
    'github.actions.write',
    'github.merge',
    'github.force_push',
  ];

  if (config.allow_github_write) {
    forbidden.push('github.actions.logs.write');
  }

  return { requested, forbidden };
}

export function validateDiagnoseCiEnv(config: DiagnoseCiConfig): DiagnoseCiEnvValidationResult {
  if (config.mode === 'fake') {
    return { ok: true, reason: 'Fake mode does not require a GitHub token' };
  }

  const token = process.env[config.token_env];

  if (token === undefined || token.trim().length === 0) {
    return {
      ok: false,
      verdict: 'DIAGNOSE_CI_NEEDS_TOKEN',
      reason: `GitHub mode requires a token in the ${config.token_env} environment variable`,
    };
  }

  return { ok: true, reason: 'GitHub token present', token };
}
