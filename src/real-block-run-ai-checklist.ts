import { checkRealBlockRunReadiness, type ReadinessReport } from './real-block-run-ai-readiness.js';
import { normalizeRealProviderSmokeProvider } from './real-provider-smoke.js';
import { redactSecrets } from './sandbox-preflight-repair.js';

export interface ProviderSmokeCheckResult {
  provider: string;
  supported: boolean;
  envReady: boolean;
  missingEnv?: string[];
  shouldRunCommand?: string;
}

export interface RealBlockRunAIChecklistReport {
  ok: boolean;
  mode: 'real-block-run-ai-checklist';
  blockPath: string;
  resume: boolean;
  provider: string;
  blockReadiness: ReadinessReport;
  providerSmoke: ProviderSmokeCheckResult;
  nextCommands: string[];
  warnings: string[];
  reasons: string[];
}

function getEnv(env: NodeJS.ProcessEnv, name: string): string | undefined {
  return env[name]?.trim();
}

export function checkProviderSmokeReadiness(
  env: NodeJS.ProcessEnv,
  provider: string
): ProviderSmokeCheckResult {
  const normalized = normalizeRealProviderSmokeProvider(provider);

  if (!normalized.supported) {
    return {
      provider: normalized.provider,
      supported: false,
      envReady: false,
      shouldRunCommand: undefined,
    };
  }

  const missingEnv: string[] = [];
  if (getEnv(env, 'ALLOW_REAL_PROVIDER') !== 'true') {
    missingEnv.push('ALLOW_REAL_PROVIDER');
  }
  if (!getEnv(env, 'KIMI_API_KEY')) {
    missingEnv.push('KIMI_API_KEY');
  }
  if (!getEnv(env, 'KIMI_BASE_URL')) {
    missingEnv.push('KIMI_BASE_URL');
  }

  const envReady = missingEnv.length === 0;
  return {
    provider: normalized.provider,
    supported: true,
    envReady,
    missingEnv: missingEnv.length > 0 ? missingEnv : undefined,
    shouldRunCommand: `npx tsx src/cli.ts real-provider-smoke --provider ${normalized.provider}`,
  };
}

export function checkRealBlockRunAIChecklist(
  blockPath: string,
  options: { resume?: boolean; provider?: string; env?: NodeJS.ProcessEnv } = {}
): RealBlockRunAIChecklistReport {
  const env = options.env ?? process.env;
  const resume = options.resume ?? false;
  const providerInput = options.provider?.trim() ?? 'kimi';

  const providerSmoke = checkProviderSmokeReadiness(env, providerInput);
  const blockReadiness = checkRealBlockRunReadiness(blockPath, { resume });

  const nextCommands: string[] = [];
  const warnings: string[] = [];
  const reasons: string[] = [];

  if (!providerSmoke.supported) {
    reasons.push(`Provider ${providerSmoke.provider} is not supported for real-provider-smoke`);
  } else if (!providerSmoke.envReady) {
    reasons.push('Provider smoke env is incomplete');
    warnings.push('Set all provider smoke env vars before running real-provider-smoke.');
  } else {
    nextCommands.push(providerSmoke.shouldRunCommand!);
  }

  if (!blockReadiness.ready) {
    reasons.push('Block readiness failed');
    warnings.push('Resolve block readiness issues before running real-block-run-ai.');
  } else {
    nextCommands.push(`npx tsx src/cli.ts real-block-run-ai ${blockPath}`);
  }

  if (nextCommands.length === 0) {
    warnings.push('Run readiness and provider smoke before real block execution.');
  }

  const ok = blockReadiness.ready && providerSmoke.supported && providerSmoke.envReady;

  return {
    ok,
    mode: 'real-block-run-ai-checklist',
    blockPath,
    resume,
    provider: providerSmoke.provider,
    blockReadiness,
    providerSmoke,
    nextCommands,
    warnings,
    reasons,
  };
}

export function formatCheckRealBlockRunAIChecklistReport(report: RealBlockRunAIChecklistReport): string {
  return redactSecrets(JSON.stringify(report, null, 2));
}
