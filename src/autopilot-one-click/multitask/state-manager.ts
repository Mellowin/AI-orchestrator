import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { AutopilotPlanGeneratedPlan, AutopilotPlanTask } from '../../autopilot-plan/types.js';
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

function normalizeSeparators(value: unknown): unknown {
  if (typeof value === 'string') {
    return value.replace(/\\/g, '/');
  }
  if (Array.isArray(value)) {
    return value.map(normalizeSeparators);
  }
  return value;
}

function canonicalTask(t: AutopilotPlanTask) {
  return {
    id: t.id,
    title: t.title,
    goal: t.goal,
    allowed_files: normalizeSeparators([...t.allowed_files].sort()),
    denied_files: normalizeSeparators([...(t.denied_files ?? [])].sort()),
    checks: normalizeSeparators([...(t.checks ?? [])].sort()),
    tests: normalizeSeparators([...(t.tests ?? [])].sort()),
    depends_on: [...(t.depends_on ?? [])].sort(),
    acceptance_criteria: normalizeSeparators([...(t.acceptance_criteria ?? [])].sort()),
    expected_result: t.expected_result ?? '',
    max_lines_changed: t.max_lines_changed ?? null,
    risk: t.risk,
  };
}

export function computePlanHash(plan: AutopilotPlanGeneratedPlan): string {
  const canonical = JSON.stringify({
    goal: plan.goal,
    mode: plan.mode,
    ci_enabled: plan.ci_enabled,
    repair_enabled: plan.repair_enabled,
    risk_level: plan.risk_level,
    tasks: [...plan.tasks]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map(canonicalTask),
  });
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

