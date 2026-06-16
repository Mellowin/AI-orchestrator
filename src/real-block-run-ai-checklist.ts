import { checkRealBlockRunReadiness, type ReadinessReport } from './real-block-run-ai-readiness.js';
import { normalizeRealProviderSmokeProvider } from './real-provider-smoke.js';
import { redactSecrets } from './sandbox-preflight-repair.js';
import { validateRealBlockFile, type RealBlockValidateReport } from './real-block-validate.js';

export interface ProviderSmokeCheckResult {
  provider: string;
  supported: boolean;
  envReady: boolean;
  missingEnv?: string[];
  shouldRunCommand?: string;
}

export interface BlockValidationSummary {
  ok: boolean;
  strict: boolean;
  warningsAsErrors?: true;
  warnings: string[];
  reasons?: string[];
}

export interface RealBlockRunAIChecklistReport {
  ok: boolean;
  mode: 'real-block-run-ai-checklist';
  strict: boolean;
  blockPath: string;
  resume: boolean;
  provider: string;
  blockValidation: BlockValidationSummary;
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
  const allowRealProvider = getEnv(env, 'ALLOW_REAL_PROVIDER') === 'true' || getEnv(env, 'ALLOW_REAL_PROVIDER') === '1';
  if (!allowRealProvider) {
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

function summarizeBlockValidation(
  report: RealBlockValidateReport
): BlockValidationSummary {
  return {
    ok: report.ok,
    strict: report.strict,
    warningsAsErrors: report.warningsAsErrors,
    warnings: report.warnings,
    reasons: report.reasons,
  };
}

export function checkRealBlockRunAIChecklist(
  blockPath: string,
  options: { resume?: boolean; provider?: string; env?: NodeJS.ProcessEnv; strict?: boolean } = {}
): RealBlockRunAIChecklistReport {
  const env = options.env ?? process.env;
  const resume = options.resume ?? false;
  const strict = options.strict ?? false;
  const providerInput = options.provider?.trim() ?? 'kimi';

  const blockValidationReport = validateRealBlockFile(blockPath, { strict });
  const blockValidation = summarizeBlockValidation(blockValidationReport);

  const providerSmoke = checkProviderSmokeReadiness(env, providerInput);
  const blockReadiness = checkRealBlockRunReadiness(blockPath, { resume });

  const nextCommands: string[] = [];
  const warnings: string[] = [...blockValidationReport.warnings];
  const reasons: string[] = [];

  if (strict && !blockValidationReport.ok) {
    reasons.push('Strict block validation failed');
    if (blockValidationReport.reasons && blockValidationReport.reasons.length > 0) {
      reasons.push(...blockValidationReport.reasons);
    }
    return {
      ok: false,
      mode: 'real-block-run-ai-checklist',
      strict: true,
      blockPath,
      resume,
      provider: providerSmoke.provider,
      blockValidation,
      blockReadiness,
      providerSmoke,
      nextCommands,
      warnings,
      reasons,
    };
  }

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
    strict,
    blockPath,
    resume,
    provider: providerSmoke.provider,
    blockValidation,
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
