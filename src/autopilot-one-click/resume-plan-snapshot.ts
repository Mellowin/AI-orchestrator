import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { AutopilotPlanMission, AutopilotPlanResult } from '../autopilot-plan/types.js';
import { computePlanHash, getMissionRunDir } from './multitask/state-manager.js';

/**
 * Immutable resume planning snapshot.
 *
 * A multitask mission must resume with the EXACT plan that was generated during
 * the original run. The AI planner is non-deterministic, so re-running it on
 * resume can produce a semantically equivalent but textually different plan
 * with a different plan hash, which would abort a legitimate resume. To
 * prevent that, the original plan result is persisted once — after the first
 * successful planning phase — and every later resume of the same run id loads
 * it instead of calling the planner. The snapshot is never overwritten.
 */
export interface ResumePlanSnapshot {
  version: 1;
  run_id: string;
  saved_at: string;
  mission: AutopilotPlanMission;
  plan_result: AutopilotPlanResult;
  plan_hash: string;
}

export function getResumePlanSnapshotPath(outputDir: string, runId: string): string {
  return join(getMissionRunDir(outputDir, runId), 'resume-plan-snapshot.json');
}

function getResumeAttemptsPath(outputDir: string, runId: string): string {
  return join(getMissionRunDir(outputDir, runId), 'resume-attempts.jsonl');
}

function ensureDir(path: string): void {
  const dir = dirname(path);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

export function saveResumePlanSnapshot(
  outputDir: string,
  runId: string,
  mission: AutopilotPlanMission,
  planResult: AutopilotPlanResult
): void {
  const path = getResumePlanSnapshotPath(outputDir, runId);
  // Immutable: never overwrite an existing snapshot for this run id. A snapshot
  // can only be created once, right after the original planning phase.
  if (existsSync(path)) {
    return;
  }
  const snapshot: ResumePlanSnapshot = {
    version: 1,
    run_id: runId,
    saved_at: new Date().toISOString(),
    mission,
    plan_result: planResult,
    plan_hash: computePlanHash(planResult.plan),
  };
  ensureDir(path);
  const tempPath = `${path}.tmp`;
  writeFileSync(tempPath, JSON.stringify(snapshot, null, 2), 'utf-8');
  renameSync(tempPath, path);
}

export function loadResumePlanSnapshot(outputDir: string, runId: string): ResumePlanSnapshot | null {
  const path = getResumePlanSnapshotPath(outputDir, runId);
  if (!existsSync(path)) {
    return null;
  }
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as ResumePlanSnapshot;
    if (
      parsed?.version !== 1 ||
      typeof parsed.run_id !== 'string' ||
      parsed.mission == null ||
      parsed.plan_result == null ||
      typeof parsed.plan_hash !== 'string'
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function normalizePathValue(value: string): string {
  return resolve(value.replace(/\\/g, '/'));
}

/**
 * Fail-closed identity validation for a resume attempt. Compares the mission
 * derived from the operator's resume command against the persisted snapshot.
 * No AI call is involved in these checks.
 */
export function validateResumeSnapshotIdentity(
  snapshot: ResumePlanSnapshot,
  mission: AutopilotPlanMission
): { ok: true } | { ok: false; reason: string } {
  if (snapshot.run_id !== mission.run_id) {
    return { ok: false, reason: `Resume aborted: snapshot run id ${snapshot.run_id} does not match requested run id ${mission.run_id}` };
  }
  if (normalizePathValue(snapshot.mission.repo_path) !== normalizePathValue(mission.repo_path)) {
    return { ok: false, reason: 'Resume aborted: snapshot repository does not match the requested mission repository' };
  }
  if (snapshot.mission.base_branch !== mission.base_branch) {
    return { ok: false, reason: `Resume aborted: snapshot base branch ${snapshot.mission.base_branch} does not match ${mission.base_branch}` };
  }
  if (snapshot.mission.goal !== mission.goal) {
    return { ok: false, reason: 'Resume aborted: snapshot mission goal does not match the resume command goal' };
  }
  if (snapshot.mission.mode !== mission.mode) {
    return { ok: false, reason: `Resume aborted: snapshot mode ${snapshot.mission.mode} does not match ${mission.mode}` };
  }
  return { ok: true };
}

/**
 * Append-only, versioned evidence of a resume attempt. Never mutates the
 * execution state; a failed integrity check still leaves an audit trail
 * without destroying the original pause/planning evidence.
 */
export function appendResumeAttempt(
  outputDir: string,
  runId: string,
  record: { attempted_at: string; outcome: string; reason: string; planner_calls: number }
): void {
  const path = getResumeAttemptsPath(outputDir, runId);
  ensureDir(path);
  appendFileSync(path, `${JSON.stringify(record)}\n`, 'utf-8');
}
