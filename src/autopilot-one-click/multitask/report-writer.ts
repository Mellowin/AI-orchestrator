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
        `| ${t.task_id} | ${t.title} | ${t.status} | ${t.commit_sha ? t.commit_sha.slice(0, 7) : '-'} |`
    )
    .join('\n');

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
    '',
    '## Tasks',
    '',
    '| Task | Title | Status | Commit |',
    '|------|-------|--------|--------|',
    taskRows || '| - | - | - | - |',
    '',
    '## Final review',
    '',
    result.final_review
      ? `- **Verdict:** ${result.final_review.verdict}\n- **Summary:** ${result.final_review.summary}\n- **Caveats:** ${result.final_review.caveats.length > 0 ? result.final_review.caveats.join(', ') : 'none'}`
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
