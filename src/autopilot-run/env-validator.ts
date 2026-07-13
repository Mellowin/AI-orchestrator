import type {
  AutopilotCapabilitySummary,
  AutopilotRunConfig,
  AutopilotRunVerdict,
} from './types.js';

export interface AutopilotEnvValidationResult {
  ok: boolean;
  verdict?: AutopilotRunVerdict;
  reason: string;
  token_present: boolean;
  provider_present: boolean;
}

function isNonEmptyString(value: string | undefined): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

export function buildCapabilitySummary(config: AutopilotRunConfig): AutopilotCapabilitySummary {
  const requested: string[] = [
    'repo.status.read',
    'repo.diff.read',
    'github.pr.read',
    'github.actions.read',
    'github.logs.read',
  ];

  const allowedWrite: string[] = [];
  if (config.repair.allow_apply) {
    allowedWrite.push('repo.apply.write');
  }
  if (config.repair.allow_commit) {
    allowedWrite.push('repo.commit.write');
  }
  if (config.repair.allow_push) {
    allowedWrite.push('repo.push.write');
  }
  if (config.github.allow_pr_create) {
    allowedWrite.push('github.pr.create');
  }
  if (config.github.allow_pr_update) {
    allowedWrite.push('github.pr.update');
  }

  const forbidden: string[] = [
    'github.merge',
    'git.force_push',
    'github.actions.rerun',
    'repo.delete_branch',
  ];

  return { requested, allowed_write: allowedWrite, forbidden };
}

export function validateAutopilotEnv(
  config: AutopilotRunConfig
): AutopilotEnvValidationResult {
  const token = process.env[config.diagnose_config.token_env];
  const tokenPresent = isNonEmptyString(token);
  const providerPresent =
    isNonEmptyString(process.env.KIMI_API_KEY) &&
    isNonEmptyString(process.env.KIMI_BASE_URL) &&
    isNonEmptyString(process.env.KIMI_MODEL);

  if (config.mode === 'fake') {
    return {
      ok: true,
      reason: 'Fake mode does not require a GitHub token',
      token_present: tokenPresent,
      provider_present: providerPresent,
    };
  }

  const needsToken =
    (config.ci.enabled && config.ci.wait_for_ci) ||
    config.github.allow_actions_read ||
    config.github.allow_pr_create ||
    config.github.allow_pr_update ||
    config.github.allow_write;

  if (needsToken && !tokenPresent) {
    return {
      ok: false,
      verdict: 'AUTOPILOT_NEEDS_TOKEN',
      reason: `GitHub mode requires a token in the ${config.diagnose_config.token_env} environment variable`,
      token_present: false,
      provider_present: providerPresent,
    };
  }

  return {
    ok: true,
    reason: 'GitHub token present',
    token_present: tokenPresent,
    provider_present: providerPresent,
  };
}
