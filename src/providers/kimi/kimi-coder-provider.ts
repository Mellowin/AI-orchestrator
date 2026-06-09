import type {
  CoderProvider,
  CoderTaskInput,
  CoderResult,
  ProviderConfig,
  ProviderId,
} from '../provider-types.js';
import {
  createRealProviderCall,
  buildProviderCallInput,
  normalizeProviderCallResult,
  normalizeProviderCallError,
} from '../../provider-call.js';
import type { FetchFn } from '../../provider-call.js';
import { parseKimiOutputJson } from '../../kimi-output-validator.js';

export function createKimiCoderProvider(config: ProviderConfig): CoderProvider {
  const apiKey = config.apiKey ?? '';
  const baseUrl = config.baseUrl ?? '';
  const model = config.model;
  const userAgent = config.userAgent;

  return {
    id: 'kimi' as ProviderId,
    role: 'coder',

    async runTask(input: CoderTaskInput): Promise<CoderResult> {
      return runKimiCoder(input, apiKey, baseUrl, model, userAgent, undefined);
    },

    async runFix(input: CoderTaskInput): Promise<CoderResult> {
      return runKimiCoder(input, apiKey, baseUrl, model, userAgent, undefined);
    },
  };
}

async function runKimiCoder(
  input: CoderTaskInput,
  apiKey: string,
  baseUrl: string,
  model: string,
  userAgent: string | undefined,
  fetchFn: FetchFn | undefined
): Promise<CoderResult> {
  const prompt = buildCoderPrompt(input);

  const callFn = createRealProviderCall({
    provider: 'kimi',
    apiKey,
    baseUrl,
    fetchFn: fetchFn ?? (globalThis.fetch as unknown as FetchFn),
    model,
    userAgent,
  });

  const providerInput = buildProviderCallInput('coder', prompt, 'kimi', model);

  try {
    const result = await callFn(providerInput);
    const normalized = normalizeProviderCallResult(result);
    const kimiOutput = parseKimiOutputJson(normalized.text);

    return {
      summary: input.goal,
      files: kimiOutput.files.map((f) => ({ path: f.path, content: f.content })),
      notes: kimiOutput.notes,
    };
  } catch (err) {
    const info = normalizeProviderCallError(err);
    throw new Error(`Kimi coder failed: ${info.message}`);
  }
}

function buildCoderPrompt(input: CoderTaskInput): string {
  const allowedSection =
    input.allowed_files.length > 0
      ? `Allowed files:\n${input.allowed_files.map((f) => `- ${f}`).join('\n')}`
      : 'Allowed files: any file within repo scope';

  const deniedSection =
    input.denied_files.length > 0
      ? `Denied files (DO NOT touch):\n${input.denied_files.map((f) => `- ${f}`).join('\n')}`
      : '';

  const repoContextSection = input.repo_context
    ? `\n# Context\n${input.repo_context}\n`
    : '';

  const failureSection = input.previous_failure
    ? `\n# Previous Failure\n${input.previous_failure}\n`
    : '';

  return (
    `# Task\n` +
    `ID: ${input.task_id}\n` +
    `Title: ${input.title}\n` +
    `Goal: ${input.goal}\n` +
    `${repoContextSection}\n` +
    `${allowedSection}\n` +
    `${deniedSection}\n\n` +
    `Max lines changed: ${input.max_lines_changed}\n\n` +
    `# Instructions\n` +
    `Return ONLY valid JSON using the file_update schema. ` +
    `Return full file content, not diffs. ` +
    `Do not include markdown outside JSON. ` +
    `Do not modify files outside allowed scope.` +
    `${failureSection}`
  );
}
