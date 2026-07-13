import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AutopilotRunTimelineEvent } from './types.js';

export function createTimeline(): AutopilotRunTimelineEvent[] {
  return [];
}

export function addTimelineEvent(
  timeline: AutopilotRunTimelineEvent[],
  event: string,
  payload?: Record<string, unknown>
): void {
  timeline.push({
    timestamp: new Date().toISOString(),
    event,
    payload,
  });
}

export function getReportDir(reportDir: string): string {
  return reportDir;
}

export function writeTimeline(reportDir: string, timeline: AutopilotRunTimelineEvent[]): string {
  if (!existsSync(reportDir)) {
    mkdirSync(reportDir, { recursive: true });
  }
  const path = join(reportDir, 'timeline.json');
  writeFileSync(path, JSON.stringify(timeline, null, 2), 'utf-8');
  return path;
}
