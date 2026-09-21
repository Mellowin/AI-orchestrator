import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { redactSecrets } from '../diagnose-ci/redaction.js';
import type { AutopilotOneClickReport, AutopilotOneClickResult } from './types.js';

export function writeOneClickReport(
  runDir: string,
  result: AutopilotOneClickResult,
  startedAt: string,
  finishedAt: string,
  durationMs: number
): { mdPath: string; jsonPath: string } {
  mkdirSync(runDir, { recursive: true });

  const report: AutopilotOneClickReport = {
    raw_goal: result.raw_goal,
    mission_path: result.mission_path,
    mission: result.mission,
    plan_verdict: result.plan_result.verdict,
    autopilot_verdict: result.autopilot_result?.verdict,
    final_verdict: result.verdict,
    run_dir: runDir,
    generated_paths: result.generated_paths,
    reason: result.reason,
    next_human_action: result.next_human_action,
    resume_command: result.resume_command,
    started_at: startedAt,
    finished_at: finishedAt,
    duration_ms: durationMs,
  };

  const mdPath = join(runDir, 'one-click-report.md');
  const jsonPath = join(runDir, 'one-click-report.json');

  writeFileSync(jsonPath, JSON.stringify(report, null, 2), 'utf-8');

  const pausedTask =
    result.verdict === 'MULTITASK_MISSION_PAUSED_PROVIDER'
      ? result.multitask_result?.autopilot_result?.mvp_result?.task_results.find(
          (t) => t.status === 'paused_provider'
        )
      : undefined;
  const pausedSection =
    result.verdict === 'MULTITASK_MISSION_PAUSED_PROVIDER'
      ? [
          '',
          '## Provider pause',
          '',
          `- **Verdict:** ${result.verdict}`,
          `- **Provider:** ${result.multitask_result?.provider_failure?.provider ?? 'kimi'}`,
          `- **Phase:** ${pausedTask?.task_phase ?? 'unknown'}`,
          `- **Reason:** ${result.multitask_result?.provider_failure?.sanitized_message ?? result.reason}`,
          '- **Mission state preserved:** YES',
          `- **Resume supported:** ${result.multitask_result?.resume_supported === true ? 'YES' : 'NO'}`,
          `- **Resume command:** \`${result.resume_command ?? 'rerun with --resume'}\``,
        ]
      : [];

  const md = [
    '# One-Click Autopilot Report',
    '',
    `- **Raw goal:** ${result.raw_goal ?? 'n/a'}`,
    `- **Mission path:** ${result.mission_path ?? '<inline-goal>'}`,
    `- **Run id:** ${result.mission.run_id}`,
    `- **Mode:** ${result.mission.mode}`,
    `- **Plan verdict:** ${result.plan_result.verdict}`,
    `- **Autopilot verdict:** ${result.autopilot_result?.verdict ?? 'n/a'}`,
    `- **Final verdict:** ${result.verdict}`,
    `- **Reason:** ${result.reason}`,
    result.next_human_action ? `- **Next human action:** ${result.next_human_action}` : '',
    ...pausedSection,
    '',
    '## Generated paths',
    '',
    ...result.generated_paths.map((p) => `- ${p}`),
    '',
    '## Timestamps',
    '',
    `- Started: ${startedAt}`,
    `- Finished: ${finishedAt}`,
    `- Duration: ${durationMs}ms`,
  ]
    .filter(Boolean)
    .join('\n');

  writeFileSync(mdPath, redactSecrets(md), 'utf-8');

  return { mdPath, jsonPath };
}
