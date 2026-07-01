import { validateRealBlockFile, type RealBlockValidateReport } from './real-block-validate.js';
import {
  checkRealBlockRunAIChecklist,
  type RealBlockRunAIChecklistReport,
} from './real-block-run-ai-checklist.js';
import { runRealProviderSmoke, normalizeRealProviderSmokeProvider, type RealProviderSmokeResult } from './real-provider-smoke.js';
import { runRealCoderContractSmoke, type RealCoderContractSmokeReport } from './real-coder-contract-smoke.js';
import { runRealReviewerContractSmoke, type RealReviewerContractSmokeReport } from './real-reviewer-contract-smoke.js';
import { loadBlockDefinition } from './block/block-loader.js';
import { redactSecrets } from './sandbox-preflight-repair.js';
import type { BlockDefinition } from './block/block-types.js';

export interface RealBlockPreflightStepReport {
  ok: boolean;
  strict?: boolean;
  contractValid?: boolean;
  warningsAsErrors?: boolean;
  error?: string;
  warnings?: string[];
  reasons?: string[];
}

export interface RealBlockPreflightStepsReport {
  blockValidation: RealBlockPreflightStepReport;
  checklist: RealBlockPreflightStepReport;
  providerSmoke: RealBlockPreflightStepReport;
  coderContractSmoke: RealBlockPreflightStepReport;
  reviewerContractSmoke: RealBlockPreflightStepReport;
}

export interface RealBlockPreflightReport {
  ok: boolean;
  mode: 'real-block-preflight';
  blockPath: string;
  provider: string;
  resume: boolean;
  timeoutMs: number;
  steps: RealBlockPreflightStepsReport;
  reasons: string[];
  nextCommands: string[];
}

const DEFAULT_TIMEOUT_MS = 15000;
const MIN_TIMEOUT_MS = 1000;
const MAX_TIMEOUT_MS = 120000;

function getEnv(env: NodeJS.ProcessEnv, name: string): string | undefined {
  return env[name]?.trim();
}

export function parseRealBlockPreflightTimeoutMs(
  env: NodeJS.ProcessEnv,
  overrideMs?: number
): number {
  let raw: string | undefined;
  if (overrideMs !== undefined) {
    raw = String(overrideMs);
  } else {
    raw = getEnv(env, 'REAL_BLOCK_PREFLIGHT_TIMEOUT_MS');
  }

  if (raw === undefined || raw === '') {
    return DEFAULT_TIMEOUT_MS;
  }

  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error('Invalid timeout: must be a non-negative integer');
  }
  if (parsed === 0) {
    throw new Error('Invalid timeout: timeout must be greater than 0');
  }
  if (parsed < MIN_TIMEOUT_MS) {
    return MIN_TIMEOUT_MS;
  }
  if (parsed > MAX_TIMEOUT_MS) {
    return MAX_TIMEOUT_MS;
  }
  return parsed;
}

function buildFakeProviderFetchFn(env: NodeJS.ProcessEnv): typeof fetch | undefined {
  const fake = getEnv(env, 'REAL_PROVIDER_SMOKE_FAKE_RESPONSE');
  if (fake === undefined) {
    return undefined;
  }
  return (() =>
    Promise.resolve({
      ok: true,
      status: 200,
      statusText: 'OK',
      text: async () => JSON.stringify({ choices: [{ message: { content: fake } }] }),
      json: async () => ({ choices: [{ message: { content: fake } }] }),
    } as unknown as Response)) as unknown as typeof fetch;
}

function makeProviderEnv(baseEnv: NodeJS.ProcessEnv, timeoutMs: number): NodeJS.ProcessEnv {
  return {
    ...baseEnv,
    REAL_PROVIDER_SMOKE_TIMEOUT_MS: String(timeoutMs),
  };
}

function safeRedact(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  return redactSecrets(value);
}

function buildNextCommands(
  blockPath: string,
  block: BlockDefinition | undefined,
  provider: string,
  timeoutMs: number,
  includeTimeout: boolean
): string[] {
  if (!block) return [];
  const taskProbeParts = [
    `npx tsx src/cli.ts real-block-task-probe ${blockPath}`,
    `--provider ${provider}`,
  ];
  if (includeTimeout) {
    taskProbeParts.push(`--timeout-ms ${timeoutMs}`);
  }
  return [
    taskProbeParts.join(' '),
    `npx tsx src/cli.ts real-block-run-ai ${blockPath}`,
    `npx tsx src/cli.ts real-block-run-ai-report runs/block/${block.block_id}/state.json`,
  ];
}

export async function runRealBlockPreflight(
  options: {
    blockPath: string;
    provider?: string;
    resume?: boolean;
    timeoutMs?: number;
    env?: NodeJS.ProcessEnv;
    providerFetchFn?: typeof fetch;
    coderFetchFn?: typeof fetch;
    reviewerFetchFn?: typeof fetch;
  }
): Promise<RealBlockPreflightReport> {
  const env = options.env ?? process.env;
  const rawProvider = options.provider?.trim() ?? 'kimi';
  const resume = options.resume ?? false;
  const providerCheck = normalizeRealProviderSmokeProvider(rawProvider);
  const provider = providerCheck.provider;
  const supported = providerCheck.supported;

  let timeoutMs: number;
  try {
    timeoutMs = parseRealBlockPreflightTimeoutMs(env, options.timeoutMs);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      mode: 'real-block-preflight',
      blockPath: options.blockPath,
      provider,
      resume,
      timeoutMs: DEFAULT_TIMEOUT_MS,
      steps: {
        blockValidation: { ok: false, error: safeRedact(message) },
        checklist: { ok: false, error: safeRedact(message) },
        providerSmoke: { ok: false, error: safeRedact(message) },
        coderContractSmoke: { ok: false, error: safeRedact(message) },
        reviewerContractSmoke: { ok: false, error: safeRedact(message) },
      },
      reasons: [safeRedact(message) ?? 'Invalid timeout'],
      nextCommands: [],
    };
  }

  // Step 1: strict block validation
  let validationReport: RealBlockValidateReport;
  try {
    validationReport = validateRealBlockFile(options.blockPath, { strict: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    validationReport = {
      ok: false,
      mode: 'real-block-validate',
      strict: true,
      blockPath: options.blockPath,
      blockId: '',
      title: '',
      repoPath: '',
      baseBranch: '',
      workBranch: '',
      taskCount: 0,
      tasks: [],
      warnings: [],
      nextCommands: [],
      warningsAsErrors: true,
      reasons: [message],
    } as RealBlockValidateReport;
  }

  // Step 2: strict checklist
  let checklistReport: RealBlockRunAIChecklistReport;
  try {
    checklistReport = checkRealBlockRunAIChecklist(options.blockPath, {
      resume,
      provider,
      env,
      strict: true,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    checklistReport = {
      ok: false,
      mode: 'real-block-run-ai-checklist',
      blockPath: options.blockPath,
      resume,
      strict: true,
      provider,
      blockValidation: { ok: false, strict: true, warnings: [], warningsAsErrors: true },
      blockReadiness: {
        ready: false,
        mode: 'fresh',
        existingState: 'none',
        reasons: [message],
        blockId: '',
        blockTitle: '',
        taskCount: 0,
        statePath: '',
        repoPath: '',
      },
      providerSmoke: { provider, supported, envReady: false, missingEnv: [], shouldRunCommand: '' },
      resolvedTaskTimeoutMs: 120000,
      resolvedReviewerParseRetries: 2,
      resolvedOnBlockedTask: 'stop',
      nextCommands: [],
      warnings: [],
      reasons: [message],
    } as RealBlockRunAIChecklistReport;
  }

  // Provider/coder/reviewer smoke require a supported provider.
  // For unsupported provider, fail those steps safely without calling env/network.
  let providerSmokeReport: RealProviderSmokeResult = {
    ok: false,
    provider,
    mode: 'real-provider-smoke',
    responseParsed: false,
    error: providerCheck.error,
  };
  let coderContractReport: RealCoderContractSmokeReport = {
    ok: false,
    mode: 'real-coder-contract-smoke',
    provider,
    supported,
    contractValid: false,
    error: providerCheck.error,
  };
  let reviewerContractReport: RealReviewerContractSmokeReport = {
    ok: false,
    mode: 'real-reviewer-contract-smoke',
    provider,
    supported,
    contractValid: false,
    error: providerCheck.error,
  };

  if (supported) {
    const providerEnv = makeProviderEnv(env, timeoutMs);
    const providerFetchFn = options.providerFetchFn ?? buildFakeProviderFetchFn(env);

    try {
      providerSmokeReport = await runRealProviderSmoke(provider, providerFetchFn, providerEnv);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      providerSmokeReport = {
        ok: false,
        provider,
        mode: 'real-provider-smoke',
        responseParsed: false,
        error: redactSecrets(message),
      };
    }

    try {
      coderContractReport = await runRealCoderContractSmoke({
        provider,
        timeoutMs,
        env,
        fetchFn: options.coderFetchFn,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      coderContractReport = {
        ok: false,
        mode: 'real-coder-contract-smoke',
        provider,
        supported,
        contractValid: false,
        timeoutMs,
        error: redactSecrets(message),
      };
    }

    try {
      reviewerContractReport = await runRealReviewerContractSmoke({
        provider,
        timeoutMs,
        env,
        fetchFn: options.reviewerFetchFn,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      reviewerContractReport = {
        ok: false,
        mode: 'real-reviewer-contract-smoke',
        provider,
        supported,
        contractValid: false,
        timeoutMs,
        error: redactSecrets(message),
      };
    }
  }

  const steps: RealBlockPreflightStepsReport = {
    blockValidation: {
      ok: validationReport.ok,
      strict: validationReport.strict,
      warnings: validationReport.warnings,
      warningsAsErrors: validationReport.warningsAsErrors,
    },
    checklist: {
      ok: checklistReport.ok,
      strict: checklistReport.strict,
      reasons: checklistReport.reasons,
    },
    providerSmoke: {
      ok: providerSmokeReport.ok,
      error: providerSmokeReport.error,
    },
    coderContractSmoke: {
      ok: coderContractReport.ok,
      contractValid: coderContractReport.contractValid,
      error: coderContractReport.error,
    },
    reviewerContractSmoke: {
      ok: reviewerContractReport.ok,
      contractValid: reviewerContractReport.contractValid,
      error: reviewerContractReport.error,
    },
  };

  const rawReasons: string[] = [];
  if (!validationReport.ok) {
    rawReasons.push('Strict block validation failed');
    if (validationReport.reasons && validationReport.reasons.length > 0) {
      rawReasons.push(...validationReport.reasons);
    } else if (validationReport.warnings && validationReport.warnings.length > 0) {
      rawReasons.push(...validationReport.warnings);
    }
  }
  if (!checklistReport.ok) {
    rawReasons.push('Strict checklist failed');
    if (checklistReport.reasons && checklistReport.reasons.length > 0) {
      rawReasons.push(...checklistReport.reasons);
    }
  }
  if (!providerSmokeReport.ok) {
    rawReasons.push('Provider smoke failed');
    if (providerSmokeReport.error) {
      rawReasons.push(providerSmokeReport.error);
    }
  }
  if (!coderContractReport.ok) {
    rawReasons.push('Coder contract smoke failed');
    if (coderContractReport.error) {
      rawReasons.push(coderContractReport.error);
    }
  }
  if (!reviewerContractReport.ok) {
    rawReasons.push('Reviewer contract smoke failed');
    if (reviewerContractReport.error) {
      rawReasons.push(reviewerContractReport.error);
    }
  }
  const reasons = Array.from(new Set(rawReasons));

  let block: BlockDefinition | undefined;
  if (validationReport.ok) {
    try {
      block = loadBlockDefinition(options.blockPath);
    } catch {
      block = undefined;
    }
  }

  const ok =
    validationReport.ok &&
    checklistReport.ok &&
    providerSmokeReport.ok &&
    coderContractReport.ok &&
    reviewerContractReport.ok;

  const nextCommands = ok
    ? buildNextCommands(
        options.blockPath,
        block,
        provider,
        timeoutMs,
        options.timeoutMs !== undefined
      )
    : [];

  return {
    ok,
    mode: 'real-block-preflight',
    blockPath: options.blockPath,
    provider,
    resume,
    timeoutMs,
    steps,
    reasons: reasons.map((r) => redactSecrets(r)),
    nextCommands,
  };
}

export function formatRealBlockPreflightReport(report: RealBlockPreflightReport): string {
  return JSON.stringify(
    report,
    (_key, value) => (typeof value === 'string' ? redactSecrets(value) : value),
    2
  );
}
