import type {
  AutopilotPlanCapabilities,
  AutopilotPlanCapabilitySummary,
  AutopilotPlanMission,
  AutopilotPlanMode,
} from './types.js';

export function buildCapabilitySummary(
  capabilities: AutopilotPlanCapabilities
): AutopilotPlanCapabilitySummary {
  const requested: string[] = [];
  const allowedWrite: string[] = [];
  const forbidden: string[] = [];

  const all: Array<{ key: keyof AutopilotPlanCapabilities; label: string }> = [
    { key: 'allow_real_provider', label: 'provider.real' },
    { key: 'allow_repo_apply', label: 'repo.apply.write' },
    { key: 'allow_repo_commit', label: 'repo.commit.write' },
    { key: 'allow_repo_push', label: 'repo.push.write' },
    { key: 'allow_pr_create', label: 'github.pr.create' },
    { key: 'allow_pr_update', label: 'github.pr.update' },
    { key: 'allow_actions_read', label: 'github.actions.read' },
    { key: 'allow_repair', label: 'autopilot.repair' },
  ];

  for (const item of all) {
    requested.push(item.label);
    if (capabilities[item.key]) {
      allowedWrite.push(item.label);
    } else {
      forbidden.push(item.label);
    }
  }

  return {
    requested,
    allowed_write: allowedWrite,
    forbidden,
  };
}

export function checkTokenPresence(
  mission: AutopilotPlanMission
): {
  provider_token_present: boolean;
  github_token_present: boolean;
  needed_provider: boolean;
  needed_github: boolean;
} {
  const neededProvider = mission.mode === 'github' && mission.capabilities.allow_real_provider;
  const neededGithub = mission.mode === 'github' && mission.capabilities.allow_actions_read;

  const providerEnv = mission.provider?.token_env ?? 'KIMI_API_KEY';
  const githubEnv = mission.github?.token_env ?? 'GITHUB_TOKEN';

  return {
    provider_token_present: !!process.env[providerEnv],
    github_token_present: !!process.env[githubEnv],
    needed_provider: neededProvider,
    needed_github: neededGithub,
  };
}

export function deriveCaveats(
  mission: AutopilotPlanMission,
  tokens: ReturnType<typeof checkTokenPresence>
): string[] {
  const caveats: string[] = [];

  if (mission.mode === 'fake') {
    caveats.push('Fake mode: no real provider, no repo mutation, no CI observation, no repair.');
  }

  if (mission.mode === 'github' && !mission.capabilities.allow_real_provider) {
    caveats.push('Real provider is disabled; plan will be generated deterministically.');
  }

  if (tokens.needed_provider && !tokens.provider_token_present) {
    caveats.push(`Provider token (${mission.provider?.token_env ?? 'KIMI_API_KEY'}) is required but not present.`);
  }

  if (tokens.needed_github && !tokens.github_token_present) {
    caveats.push(`GitHub token (${mission.github?.token_env ?? 'GITHUB_TOKEN'}) is required but not present.`);
  }

  if (mission.constraints && mission.constraints.length > 0) {
    for (const constraint of mission.constraints) {
      caveats.push(`Constraint: ${constraint}`);
    }
  }

  return caveats;
}

export function isSafeMode(mode: AutopilotPlanMode): boolean {
  return mode === 'fake';
}
