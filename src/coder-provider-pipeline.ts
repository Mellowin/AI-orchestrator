import {
  callProviderWithRetry,
  resolveProviderRetryConfig,
  ProviderCallFailedError,
  normalizeProviderCallError,
  buildRecoveryPrompt,
  selectRecoveryPrompt,
  type ProviderCallFn,
  type ProviderRetryConfig,
} from './provider-call.js';
import { parseKimiOutputJson } from './kimi-output-validator.js';
import {
  classifyKimiOutput,
  type ClassifiedKimiOutput,
} from './kimi-output-classifier.js';
import {
  writeProviderAttemptEvidence,
} from './provider-attempt-evidence.js';
import { getRunDir, initAttemptDir } from './state-manager.js';
import type { KimiOutput, ProviderAttempt, ProviderAttemptType } from './types.js';

export interface CoderProviderPipelineOptions {
  taskId: string;
  repoPath: string;
  basePrompt: string;
  providerCall: ProviderCallFn;
  provider: string;
  model: string;
  providerAttemptType: ProviderAttemptType;
  startingGlobalAttemptNumber: number;
  retryConfig?: ProviderRetryConfig;
  logPrefix?: string;
  buildAttemptDir?: (globalAttemptNumber: number, localAttemptNumber: number) => string;
}

export interface CoderProviderPipelineSuccess {
  success: true;
  kimiOutput: KimiOutput;
  rawProviderText: string;
  classified: ClassifiedKimiOutput;
  providerAttempts: ProviderAttempt[];
  nextGlobalAttemptNumber: number;
  effectiveAttemptDir: string;
}

export interface CoderProviderPipelineFailure {
  success: false;
  reason: string;
  providerAttempts: ProviderAttempt[];
  nextGlobalAttemptNumber: number;
  isAuthError: boolean;
  rawProviderText?: string;
}

export type CoderProviderPipelineResult =
  | CoderProviderPipelineSuccess
  | CoderProviderPipelineFailure;

function resolveAttemptDir(
  options: CoderProviderPipelineOptions,
  globalAttemptNumber: number,
  localAttemptNumber: number
): string {
  if (options.buildAttemptDir) {
    return options.buildAttemptDir(globalAttemptNumber, localAttemptNumber);
  }
  return initAttemptDir(options.taskId, globalAttemptNumber);
}

function remapProviderAttempts(
  localAttempts: ProviderAttempt[],
  type: ProviderAttemptType,
  startingGlobalAttemptNumber: number
): ProviderAttempt[] {
  return localAttempts.map((attempt, index) => ({
    ...attempt,
    attempt: startingGlobalAttemptNumber + index,
    type,
  }));
}

export async function runCoderProviderPipeline(
  options: CoderProviderPipelineOptions
): Promise<CoderProviderPipelineResult> {
  const {
    taskId,
    repoPath,
    basePrompt,
    providerCall,
    provider,
    model,
    providerAttemptType,
    startingGlobalAttemptNumber,
    retryConfig,
    logPrefix = '[real-repo-run-ai]',
  } = options;

  const resolvedRetryConfig = retryConfig ?? resolveProviderRetryConfig();
  let effectiveAttemptDir: string | undefined;

  try {
    let capturedRawText = '';
    let capturedKimiOutput: KimiOutput | undefined;
    let capturedClassified: ClassifiedKimiOutput | undefined;

    const retryResult = await callProviderWithRetry<KimiOutput>({
      providerCall,
      provider,
      model,
      basePrompt,
      buildRecoveryPrompt: selectRecoveryPrompt,
      parseOutput: parseKimiOutputJson,
      taskId,
      config: resolvedRetryConfig,
      logPrefix,
      async onAttempt(info) {
        const globalAttemptNumber = startingGlobalAttemptNumber + info.attempt - 1;
        const attemptDir = resolveAttemptDir(
          options,
          globalAttemptNumber,
          info.attempt
        );

        if (info.parsed !== undefined && info.rawText !== undefined) {
          capturedRawText = info.rawText;
          capturedKimiOutput = info.parsed;
          capturedClassified = classifyKimiOutput(repoPath, info.parsed);
          effectiveAttemptDir = attemptDir;
          writeProviderAttemptEvidence({
            taskId,
            attempt: globalAttemptNumber,
            repoPath,
            rawText: info.rawText,
            kimiOutput: info.parsed,
            classified: capturedClassified,
            phase: 'pre-apply',
            attemptDir,
          });
        } else if (info.rawText !== undefined) {
          writeProviderAttemptEvidence({
            taskId,
            attempt: globalAttemptNumber,
            repoPath,
            rawText: info.rawText,
            error:
              info.error instanceof Error
                ? info.error.message
                : typeof info.error === 'string'
                  ? info.error
                  : 'Unknown provider attempt error',
            phase: 'pre-apply',
            attemptDir,
          });
        }
      },
    });

    if (capturedKimiOutput === undefined || capturedClassified === undefined) {
      return {
        success: false,
        reason: 'Provider retry finished without a parseable KimiOutput.',
        providerAttempts: remapProviderAttempts(
          retryResult.providerAttempts,
          providerAttemptType,
          startingGlobalAttemptNumber
        ),
        nextGlobalAttemptNumber: startingGlobalAttemptNumber,
        isAuthError: false,
        rawProviderText: capturedRawText,
      };
    }

    return {
      success: true,
      kimiOutput: capturedKimiOutput,
      rawProviderText: capturedRawText,
      classified: capturedClassified,
      providerAttempts: remapProviderAttempts(
        retryResult.providerAttempts,
        providerAttemptType,
        startingGlobalAttemptNumber
      ),
      nextGlobalAttemptNumber:
        startingGlobalAttemptNumber + retryResult.providerAttempts.length,
      effectiveAttemptDir: effectiveAttemptDir!,
    };
  } catch (providerErr) {
    let localAttempts: ProviderAttempt[] = [];
    if (providerErr instanceof ProviderCallFailedError) {
      localAttempts = providerErr.providerAttempts;
    }
    const info = normalizeProviderCallError(providerErr);
    const lowerMessage = info.message.toLowerCase();
    const statusMatch = lowerMessage.match(/status\s+(\d{3})/);
    const httpStatus = statusMatch ? parseInt(statusMatch[1], 10) : undefined;
    const isAuthError =
      lowerMessage.includes('api key') ||
      lowerMessage.includes('unauthorized') ||
      lowerMessage.includes('authentication') ||
      lowerMessage.includes('forbidden') ||
      lowerMessage.includes('access denied') ||
      httpStatus === 401 ||
      httpStatus === 403;

    return {
      success: false,
      reason: info.message,
      providerAttempts: remapProviderAttempts(
        localAttempts,
        providerAttemptType,
        startingGlobalAttemptNumber
      ),
      nextGlobalAttemptNumber:
        startingGlobalAttemptNumber + localAttempts.length,
      isAuthError,
    };
  }
}

export function buildDefaultAttemptDir(
  taskId: string,
  globalAttemptNumber: number
): string {
  return initAttemptDir(taskId, globalAttemptNumber);
}

export function buildReviewerFixAttemptDir(
  parentTaskId: string,
  fixAttemptNumber: number,
  globalAttemptNumber: number,
  localAttemptNumber: number
): string {
  const base = getRunDir(parentTaskId);
  return `${base}/reviewer-fix-attempt-${fixAttemptNumber}/provider-attempt-${localAttemptNumber}`;
}

export { buildNoEffectRecoveryPrompt } from './provider-attempt-evidence.js';
export { selectRecoveryPrompt } from './provider-call.js';
