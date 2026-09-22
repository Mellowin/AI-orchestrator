import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { MultitaskMissionResult } from './types.js';

export interface MultitaskMissionReportPaths {
  mdPath: string;
  jsonPath: string;
}

function ensureDir(dir: string): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

export function writeMultitaskMissionReport(
  runDir: string,
  result: MultitaskMissionResult,
  startedAt: string,
  finishedAt: string,
  durationMs: number
): MultitaskMissionReportPaths {
  ensureDir(runDir);
  const mdPath = join(runDir, 'multitask-mission-report.md');
  const jsonPath = join(runDir, 'multitask-mission-report.json');

  const taskRows = result.task_results
    .map(
      (t) =>
        `| ${t.task_id} | ${t.title} | ${t.status} | ${t.commit_sha ? t.commit_sha.slice(0, 7) : '-'} | ${t.reason ?? '-'} |`
    )
    .join('\n');

  const pausedTask =
    result.verdict === 'MULTITASK_MISSION_PAUSED_PROVIDER'
      ? result.autopilot_result?.mvp_result?.task_results.find((t) => t.status === 'paused_provider')
      : undefined;
  const pausedSection =
    result.verdict === 'MULTITASK_MISSION_PAUSED_PROVIDER'
      ? [
          '',
          '## Provider pause',
          '',
          `- **Verdict:** ${result.verdict}`,
          `- **Provider:** ${result.provider_failure?.provider ?? 'kimi'}`,
          `- **Phase:** ${pausedTask?.task_phase ?? 'unknown'}`,
          `- **Reason:** ${result.provider_failure?.sanitized_message ?? result.reason}`,
          '- **Mission state preserved:** YES',
          `- **Resume supported:** ${result.resume_supported === true ? 'YES' : 'NO'}`,
          `- **Resume command:** \`${result.resume_command ?? 'rerun with --resume'}\``,
        ]
      : [];

  const gitPausedTask =
    result.verdict === 'MULTITASK_MISSION_PAUSED_GIT_AUTH'
      ? result.autopilot_result?.mvp_result?.task_results.find((t) => t.status === 'paused_git_auth')
      : undefined;
  const gitPausedSection =
    result.verdict === 'MULTITASK_MISSION_PAUSED_GIT_AUTH'
      ? [
          '',
          '## Git remote auth pause',
          '',
          `- **Verdict:** ${result.verdict}`,
          `- **Remote:** ${result.git_failure?.remote ?? 'origin'}`,
          `- **Operation:** ${result.git_failure?.operation ?? 'push'}`,
          `- **Failure kind:** ${result.git_failure?.failure_kind ?? 'unknown'}`,
          `- **Phase:** ${gitPausedTask?.task_phase ?? 'committed'}`,
          `- **Reason:** ${result.git_failure?.sanitized_message ?? result.reason}`,
          gitPausedTask?.commit_sha ? `- **Accepted commit preserved:** ${gitPausedTask.commit_sha}` : '',
          '- **Mission state preserved:** YES',
          `- **Resume supported:** ${result.resume_supported === true ? 'YES' : 'NO'}`,
          `- **Resume command:** \`${result.resume_command ?? 'rerun with --resume'}\``,
        ].filter((line) => line !== '')
      : [];

  const md = [
    '# Multi-Task Mission Report',
    '',
    `- **Run id:** ${result.mission.run_id}`,
    `- **Goal:** ${result.mission.goal}`,
    `- **Started:** ${startedAt}`,
    `- **Finished:** ${finishedAt}`,
    `- **Duration:** ${durationMs}ms`,
    `- **Verdict:** ${result.verdict}`,
    `- **Reason:** ${result.reason}`,
    result.work_branch ? `- **Work branch:** ${result.work_branch}` : '',
    result.pr ? `- **PR:** #${result.pr.number} (${result.pr.url})` : '',
    ...pausedSection,
    ...gitPausedSection,
    result.validation_failure_classification
      ? `- **Validation failure classification:** ${result.validation_failure_classification}`
      : '',
    result.finalization_repair_attempts !== undefined
      ? `- **Finalization repair attempts:** ${result.finalization_repair_attempts}`
      : '',
    result.finalization_repair_commit_sha
      ? `- **Finalization repair commit:** ${result.finalization_repair_commit_sha.slice(0, 7)}`
      : '',
    '',
    '## Tasks',
    '',
    '| Task | Title | Status | Commit | Reason |',
    '|------|-------|--------|--------|--------|',
    taskRows || '| - | - | - | - | - |',
    '',
    '## Final review',
    '',
    result.final_review
      ? `- **Verdict:** ${result.final_review.verdict}\n- **Summary:** ${result.final_review.summary}\n- **Caveats:** ${result.final_review.caveats.length > 0 ? result.final_review.caveats.join(', ') : 'none'}${result.final_review.unauthorized_files && result.final_review.unauthorized_files.length > 0 ? `\n- **Unauthorized files:** ${result.final_review.unauthorized_files.join(', ')}` : ''}${result.final_review.acceptance_gaps && result.final_review.acceptance_gaps.length > 0 ? `\n- **Acceptance gaps:** ${result.final_review.acceptance_gaps.join(', ')}` : ''}`
      : '- No final review performed.',
    '',
    '## Next human action',
    '',
    result.next_human_action ?? '-',
  ].join('\n');

  writeFileSync(mdPath, md, 'utf-8');
  writeFileSync(
    jsonPath,
    JSON.stringify(
      {
        ...result,
        started_at: startedAt,
        finished_at: finishedAt,
        duration_ms: durationMs,
      },
      null,
      2
    ),
    'utf-8'
  );

  return { mdPath, jsonPath };
}
