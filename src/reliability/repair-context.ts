import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ReliabilityClassification, ReliabilityScenarioResult } from './types.js';
import { redactSecrets } from '../diagnose-ci/redaction.js';

export interface RepairContextInput {
  mission_goal?: string;
  branch: string;
  pr_number?: number;
  pr_url?: string;
  failed_run_id?: number;
  failed_job_name?: string;
  failed_step_name?: string;
  classification: ReliabilityClassification;
  confidence: 'high' | 'medium' | 'low';
  log_excerpt?: string;
  failed_test?: { file?: string; subtest?: string; expected?: string; actual?: string; stack?: string };
  compiler_errors?: string[];
  changed_files?: string[];
  diff_summary?: string;
  allowed_files: string[];
  forbidden_files?: string[];
  reproduction_command?: string[];
  verification_command?: string[];
  previous_attempts?: ReliabilityScenarioResult[];
  max_context_chars?: number;
}

export interface RepairContext {
  markdown: string;
  json: Record<string, unknown>;
  truncated: boolean;
}

export function buildRepairContext(input: RepairContextInput): RepairContext {
  const max = input.max_context_chars ?? 8000;
  const sections: string[] = [];

  sections.push(`# Repair Context`);
  sections.push(`## Mission`);
  sections.push(input.mission_goal ?? 'Autonomous repair of CI failure.');

  sections.push(`## Branch and PR`);
  sections.push(`- Branch: ${input.branch}`);
  if (input.pr_number !== undefined) sections.push(`- PR: #${input.pr_number}${input.pr_url ? ` (${input.pr_url})` : ''}`);
  if (input.failed_run_id !== undefined) sections.push(`- Failed CI run: ${input.failed_run_id}`);
  if (input.failed_job_name) sections.push(`- Failed job: ${input.failed_job_name}`);
  if (input.failed_step_name) sections.push(`- Failed step: ${input.failed_step_name}`);

  sections.push(`## Classification`);
  sections.push(`- Classification: ${input.classification}`);
  sections.push(`- Confidence: ${input.confidence}`);

  if (input.log_excerpt) {
    sections.push(`## Log excerpt`);
    sections.push('```');
    sections.push(truncate(input.log_excerpt, 2000));
    sections.push('```');
  }

  if (input.failed_test) {
    sections.push(`## Failed test`);
    if (input.failed_test.file) sections.push(`- File: ${input.failed_test.file}`);
    if (input.failed_test.subtest) sections.push(`- Subtest: ${input.failed_test.subtest}`);
    if (input.failed_test.expected) sections.push(`- Expected: ${input.failed_test.expected}`);
    if (input.failed_test.actual) sections.push(`- Actual: ${input.failed_test.actual}`);
    if (input.failed_test.stack) sections.push(`- Stack:\n\`\`\`\n${truncate(input.failed_test.stack, 1000)}\n\`\`\``);
  }

  if (input.compiler_errors && input.compiler_errors.length > 0) {
    sections.push(`## Compiler errors`);
    for (const err of input.compiler_errors.slice(0, 20)) {
      sections.push(`- ${err}`);
    }
  }

  sections.push(`## Scope`);
  sections.push(`- Allowed files: ${input.allowed_files.join(', ')}`);
  if (input.forbidden_files && input.forbidden_files.length > 0) {
    sections.push(`- Forbidden files: ${input.forbidden_files.join(', ')}`);
  }

  if (input.changed_files && input.changed_files.length > 0) {
    sections.push(`## Changed files`);
    for (const file of input.changed_files) {
      sections.push(`- ${file}`);
    }
  }

  if (input.diff_summary) {
    sections.push(`## Diff summary`);
    sections.push(truncate(input.diff_summary, 1500));
  }

  if (input.reproduction_command) {
    sections.push(`## Reproduction command`);
    sections.push(`\`\`\`bash\n${shellCommand(input.reproduction_command)}\n\`\`\``);
  }

  if (input.verification_command) {
    sections.push(`## Verification command`);
    sections.push(`\`\`\`bash\n${shellCommand(input.verification_command)}\n\`\`\``);
  }

  if (input.previous_attempts && input.previous_attempts.length > 0) {
    sections.push(`## Previous attempts`);
    for (const attempt of input.previous_attempts) {
      sections.push(`- Attempt ${attempt.repair_attempts}: ${attempt.verdict}${attempt.failure_reason ? ` — ${attempt.failure_reason}` : ''}`);
    }
  }

  let markdown = redactSecrets(sections.join('\n\n'));
  let truncated = false;
  if (markdown.length > max) {
    markdown = markdown.slice(0, max) + '\n\n[context truncated]';
    truncated = true;
  }

  const json: Record<string, unknown> = {
    branch: input.branch,
    classification: input.classification,
    confidence: input.confidence,
    allowed_files: input.allowed_files,
    forbidden_files: input.forbidden_files,
    reproduction_command: input.reproduction_command,
    verification_command: input.verification_command,
    previous_attempts: input.previous_attempts?.map((a) => ({
      attempt: a.repair_attempts,
      verdict: a.verdict,
      reason: a.failure_reason,
    })),
    truncated,
  };

  return { markdown, json, truncated };
}

export function getDiffSummary(repoPath: string, baseBranch: string): string {
  const result = spawnSync('git', ['diff', '--stat', `${baseBranch}...HEAD`], {
    cwd: repoPath,
    encoding: 'utf-8',
    shell: false,
  });
  return result.status === 0 ? result.stdout.trim() : '';
}

export function getChangedFiles(repoPath: string, baseBranch: string): string[] {
  const result = spawnSync('git', ['diff', '--name-only', `${baseBranch}...HEAD`], {
    cwd: repoPath,
    encoding: 'utf-8',
    shell: false,
  });
  if (result.status !== 0) return [];
  return result.stdout.trim().split('\n').filter(Boolean);
}

function shellCommand(args: string[]): string {
  return args.map((arg) => (arg.includes(' ') ? `"${arg}"` : arg)).join(' ');
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return value.slice(0, maxLength) + '\n[truncated]';
}
