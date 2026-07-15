import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { MultitaskMissionResult, MultitaskMissionTaskState } from './types.js';

export interface PersistedMissionState {
  version: 1;
  run_id: string;
  stage: 'planning' | 'running' | 'reviewing' | 'completed';
  plan_hash: string;
  base_sha: string;
  work_branch: string;
  pr?: { number: number; url: string };
  tasks: MultitaskMissionTaskState[];
  result?: MultitaskMissionResult;
  last_error?: string;
}

export function getMissionRunDir(outputDir: string, runId: string): string {
  return resolve(outputDir, 'missions', runId);
}

export function getMissionStatePath(runDir: string): string {
  return join(runDir, 'multitask-mission-state.json');
}

function ensureDir(path: string): void {
  const dir = dirname(path);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

export function computePlanHash(plan: { tasks: Array<{ id: string; allowed_files: string[]; depends_on?: string[] }> }): string {
  const canonical = JSON.stringify(plan.tasks.map((t: { id: string; allowed_files: string[]; depends_on?: string[] }) => ({
    id: t.id,
    allowed_files: [...t.allowed_files].sort(),
    depends_on: t.depends_on ? [...t.depends_on].sort() : [],
  })));
  return createHash('sha256').update(canonical).digest('hex').slice(0, 16);
}

export function saveMissionState(
  runDir: string,
  state: PersistedMissionState,
  writeFn?: (path: string, data: string) => void
): void {
  const path = getMissionStatePath(runDir);
  ensureDir(path);
  const data = JSON.stringify(state, null, 2);
  if (writeFn) {
    writeFn(path, data);
  } else {
    writeFileSync(path, data, 'utf-8');
  }
}

export function loadMissionState(
  runDir: string,
  readFn?: (path: string) => string
): PersistedMissionState | null {
  const path = getMissionStatePath(runDir);
  if (!existsSync(path)) {
    return null;
  }
  try {
    const raw = readFn ? readFn(path) : readFileSync(path, 'utf-8');
    const parsed = JSON.parse(raw) as PersistedMissionState;
    if (
      typeof parsed.run_id !== 'string' ||
      typeof parsed.stage !== 'string' ||
      typeof parsed.plan_hash !== 'string' ||
      typeof parsed.base_sha !== 'string' ||
      typeof parsed.work_branch !== 'string' ||
      !Array.isArray(parsed.tasks)
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

