export interface SandboxPreflightRepairInput {
  failedStep: string;
  logs: string;
  attempt: number;
  maxAttempts: number;
  taskGoal: string;
  rawProviderText: string;
}

export interface SandboxPreflightRepairDecision {
  repairable: boolean;
  reason: string;
  repairPrompt?: string;
}

function redactSecrets(text: string): string {
  // Redact obvious API key patterns
  return text
    .replace(/\b(sk-[a-zA-Z0-9_-]+)\b/g, '[REDACTED]')
    .replace(/\b(pk-[a-zA-Z0-9_-]+)\b/g, '[REDACTED]')
    .replace(/\b(Bearer\s+[a-zA-Z0-9_-]+)\b/g, '[REDACTED]')
    .replace(/\b([a-zA-Z0-9_-]*(?:secret|token|api[_-]?key|password)[a-zA-Z0-9_-]*\s*[:=]\s*)([^\s\n]+)/gi, '$1[REDACTED]');
}

function buildRepairPrompt(
  taskGoal: string,
  failedStep: string,
  logs: string,
  rawProviderText: string
): string {
  const redactedLogs = redactSecrets(logs);

  return (
    `# Task (Repair Attempt)\n\n` +
    `Goal: ${taskGoal}\n\n` +
    `# Previous Attempt Failed\n\n` +
    `Sandbox preflight failed at step: ${failedStep}\n\n` +
    `Check output summary:\n${redactedLogs}\n\n` +
    `# Instructions\n\n` +
    `Fix the issue that caused the check to fail. ` +
    `Return ONLY valid JSON using the file_update schema. ` +
    `Return full file content, not diffs. ` +
    `Do not include markdown outside JSON. ` +
    `Do not modify files outside allowed scope. ` +
    `Do not include secrets, tokens, or API keys.`
  );
}

export function buildSandboxPreflightRepairDecision(
  input: SandboxPreflightRepairInput
): SandboxPreflightRepairDecision {
  if (input.attempt >= input.maxAttempts) {
    return {
      repairable: false,
      reason: `Attempt ${input.attempt} of ${input.maxAttempts} reached. No more repairs allowed.`,
    };
  }

  if (input.failedStep !== 'checks') {
    return {
      repairable: false,
      reason: `Failed step '${input.failedStep}' is not repairable by provider correction.`,
    };
  }

  const repairPrompt = buildRepairPrompt(
    input.taskGoal,
    input.failedStep,
    input.logs,
    input.rawProviderText
  );

  return {
    repairable: true,
    reason: `Sandbox preflight failed at step '${input.failedStep}'. Repair prompt prepared for attempt ${input.attempt + 1}.`,
    repairPrompt,
  };
}
