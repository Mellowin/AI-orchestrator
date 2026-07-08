import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { MvpRunResult } from './types.js';

function redactSecrets(text: string): string {
  return text
    .replace(/sk-[a-zA-Z0-9]*/g, '[REDACTED]')
    .replace(/Bearer\s+[\S]+/gi, 'Bearer [REDACTED]')
    .replace(/ghp_[a-zA-Z0-9]*/g, '[REDACTED]')
    .replace(/github_pat_[a-zA-Z0-9_-]*/g, '[REDACTED]');
}

function ensureDir(dir: string): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

export function getMvpRunReportDir(configReportDir: string, runId: string): string {
  return join(configReportDir, runId);
}

export function writeMvpRunReports(result: MvpRunResult): void {
  const reportDir = result.report_dir;
  ensureDir(reportDir);

  const sanitizedConfig = {
    ...result.config,
    repo_path: '[REDACTED]',
  };

  writeFileSync(
    join(reportDir, 'report.json'),
    JSON.stringify(
      {
        ...result,
        config: sanitizedConfig,
      },
      null,
      2
    ),
    'utf-8'
  );

  const lines: string[] = [];
  lines.push('# MVP Run Report');
  lines.push('');
  lines.push(`- Command: \`${result.command}\``);
  lines.push(`- Config: \`${result.config_path}\``);
  lines.push(`- Run ID: ${result.config.run_id}`);
  lines.push(`- Started: ${result.started_at}`);
  lines.push(`- Finished: ${result.finished_at}`);
  lines.push(`- Duration: ${result.duration_ms}ms`);
  lines.push(`- Verdict: **${result.verdict}**`);
  lines.push('');

  lines.push('## Preflight');
  lines.push('');
  lines.push(`- Repo path: ${result.preflight.repo_path}`);
  if (result.preflight.repo_slug) {
    lines.push(`- Repo slug: ${result.preflight.repo_slug}`);
  }
  lines.push(`- Base branch: ${result.preflight.base_branch}`);
  lines.push(`- Work branch: ${result.preflight.work_branch}`);
  lines.push(`- Provider: ${result.preflight.provider}`);
  lines.push(`- Real provider enabled: ${result.preflight.real_provider_enabled ? 'yes' : 'no'}`);
  lines.push(`- Apply enabled: ${result.preflight.apply_enabled ? 'yes' : 'no'}`);
  lines.push(`- Commit enabled: ${result.preflight.commit_enabled ? 'yes' : 'no'}`);
  lines.push(`- Push enabled: ${result.preflight.push_enabled ? 'yes' : 'no'}`);
  lines.push(`- PR creation enabled: ${result.preflight.pr_creation_enabled ? 'yes' : 'no'}`);
  if (result.preflight.missing_env_vars.length > 0) {
    lines.push(`- Missing env vars: ${result.preflight.missing_env_vars.join(', ')}`);
  }
  if (result.preflight.detected_risks.length > 0) {
    lines.push(`- Detected risks:`);
    for (const risk of result.preflight.detected_risks) {
      lines.push(`  - ${risk}`);
    }
  }
  lines.push('');

  lines.push('## Summary');
  lines.push('');
  lines.push(`- Total tasks: ${result.tasks_total}`);
  lines.push(`- Passed: ${result.tasks_passed}`);
  lines.push(`- Passed with caveats: ${result.tasks_caveats}`);
  lines.push(`- Failed: ${result.tasks_failed}`);
  lines.push(`- Blocked: ${result.tasks_blocked}`);
  lines.push(`- Skipped: ${result.tasks_skipped}`);
  lines.push('');

  lines.push('## Tasks');
  lines.push('');
  for (const task of result.task_results) {
    lines.push(`### ${task.title} (${task.id})`);
    lines.push('');
    lines.push(`- Status: **${task.status}**`);
    if (task.final_status) {
      lines.push(`- Final status: ${task.final_status}`);
    }
    if (task.reason) {
      lines.push(`- Reason: ${redactSecrets(task.reason)}`);
    }
    lines.push(`- Provider attempts: ${task.provider_attempts}`);
    lines.push(`- Recovery attempts: ${task.recovery_attempts}`);
    if (task.commit_sha) {
      lines.push(`- Commit: \`${task.commit_sha}\``);
    }
    if (task.fix_commit_sha) {
      lines.push(`- Fix commit: \`${task.fix_commit_sha}\``);
    }
    if (task.files_changed && task.files_changed.length > 0) {
      lines.push(`- Files changed: ${task.files_changed.join(', ')}`);
    }
    lines.push('');
  }

  lines.push('## Run metadata');
  lines.push('');
  lines.push(`- Branch: ${result.branch}`);
  lines.push(`- Pushed: ${result.pushed ? 'yes' : 'no'}`);
  if (result.commits.length > 0) {
    lines.push(`- Commits:`);
    for (const sha of result.commits) {
      lines.push(`  - \`${sha}\``);
    }
  }
  if (result.pr) {
    lines.push(`- PR created: ${result.pr.created ? 'yes' : 'no'}`);
    if (typeof result.pr.draft === 'boolean') lines.push(`  - Draft: ${result.pr.draft ? 'yes' : 'no'}`);
    if (result.pr.number) lines.push(`  - Number: #${result.pr.number}`);
    if (result.pr.url) lines.push(`  - URL: ${result.pr.url}`);
    if (result.pr.reason) lines.push(`  - Reason: ${redactSecrets(result.pr.reason)}`);
  }
  if (result.caveats.length > 0) {
    lines.push('- Caveats:');
    for (const caveat of result.caveats) {
      lines.push(`  - ${caveat}`);
    }
  }
  if (result.failure_classification) {
    lines.push(`- Failure classification: \`${result.failure_classification}\``);
  }
  if (result.next_human_action) {
    lines.push(`- Next human action: ${result.next_human_action}`);
  }
  lines.push('');

  lines.push('---');
  lines.push('');
  lines.push('This report was generated by `npx tsx src/cli.ts mvp-run <config.json>`.');
  lines.push('No token values are included in this report.');

  writeFileSync(join(reportDir, 'report.md'), lines.join('\n'), 'utf-8');
}
