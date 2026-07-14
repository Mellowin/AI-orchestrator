import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { MultitaskMissionResult } from './types.js';

export interface MultitaskMissionState {
  run_id: string;
  stage: 'planning' | 'running' | 'reviewing' | 'completed';
  result?: MultitaskMissionResult;
  last_error?: string;
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

export function saveMissionState(
  runDir: string,
  state: MultitaskMissionState,
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
): MultitaskMissionState | null {
  const path = getMissionStatePath(runDir);
  if (!existsSync(path)) {
    return null;
  }
  try {
    const raw = readFn ? readFn(path) : readFileSync(path, 'utf-8');
    const parsed = JSON.parse(raw) as MultitaskMissionState;
    if (typeof parsed.run_id !== 'string' || typeof parsed.stage !== 'string') {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}
