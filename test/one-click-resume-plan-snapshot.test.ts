import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runAutopilotOneClick } from '../src/autopilot-one-click/runner.js';
import { computePlanHash, getMissionRunDir } from '../src/autopilot-one-click/multitask/state-manager.js';
import { getResumePlanSnapshotPath } from '../src/autopilot-one-click/resume-plan-snapshot.js';
import type { AutopilotPlanGeneratedPlan, AutopilotPlanResult } from '../src/autopilot-plan/types.js';
import type { MultitaskMissionResult } from '../src/autopilot-one-click/multitask/types.js';

const ENV_KEYS = ['KIMI_API_KEY'] as const;

function snapshotEnv(): Map<string, string | undefined> {
  const snap = new Map<string, string | undefined>();
  for (const key of ENV_KEYS) {
    snap.set(key, process.env[key]);
  }
  return snap;
}

function restoreEnv(snap: Map<string, string | undefined>): void {
  for (const [key, value] of snap) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

function makePlan(goal: string, marker: string): AutopilotPlanGeneratedPlan {
  return {
    goal,
    mode: 'github',
    tasks: [
      {
        id: 'task-1',
        title: `Task one ${marker}`,
        goal: 'Do the first thing',
        allowed_files: ['src/a.ts'],
      },
    ],
  } as unknown as AutopilotPlanGeneratedPlan;
}

interface Harness {
  tmpDir: string;
  tmpRepo: string;
  goal: string;
  runId: string;
  planCalls: number;
  multitaskCalls: number;
  plansSeen: AutopilotPlanGeneratedPlan[];
  /** Set by the injected multitask runner to emulate task execution progress. */
  multitaskBehavior: (mission: { run_id: string }, planResult: AutopilotPlanResult) => Promise<MultitaskMissionResult>;
}

function setup(): Harness {
  const tmpDir = mkdtempSync(join(tmpdir(), 'resume-snapshot-out-'));
  const tmpRepo = mkdtempSync(join(tmpdir(), 'resume-snapshot-repo-'));
  return {
    tmpDir,
    tmpRepo,
    goal: 'Add multitask feature',
    runId: '',
    planCalls: 0,
    multitaskCalls: 0,
    plansSeen: [],
    multitaskBehavior: async (mission, planResult) =>
      ({
        mission,
        plan: planResult.plan,
        plan_result: planResult,
        task_results: [],
        task_states: [],
        verdict: 'MULTITASK_MISSION_DONE',
        reason: 'done',
        run_dir: join(tmpDir, mission.run_id),
        exit_code: 0,
      }) as MultitaskMissionResult,
  };
}

async function runOnce(
  h: Harness,
  opts: { resume?: boolean; runId?: string; planMarker: string; planBMarker?: string } 
): Promise<{ verdict: string; reason: string; resume_command?: string }> {
  const planFn = async (mission: { run_id: string; goal: string }) => {
    h.planCalls += 1;
    // First call returns PLAN-A; any later call would return PLAN-B (the
    // non-deterministic re-plan the fix must prevent).
    const marker = h.planCalls === 1 ? opts.planMarker : (opts.planBMarker ?? 'PLAN-B-REGENERATED');
    const plan = makePlan(mission.goal, marker);
    h.plansSeen.push(plan);
    return {
      mission,
      plan,
      run_dir: join(h.tmpDir, mission.run_id),
      generated_files: [join(h.tmpDir, mission.run_id, 'plan.json')],
      verdict: 'AUTOPILOT_PLAN_READY',
      reason: 'plan generated (test hook)',
      exit_code: 0,
      next_command: '',
    } as unknown as AutopilotPlanResult;
  };
  const runMultitaskMissionFn = async (mission: { run_id: string }, planResult: AutopilotPlanResult) => {
    h.multitaskCalls += 1;
    return h.multitaskBehavior(mission as never, planResult);
  };
  return runAutopilotOneClick(
    h.goal,
    {
      preset: 'real-multitask',
      repo_path: h.tmpRepo,
      output_dir: h.tmpDir,
      yes: true,
      resume: opts.resume ?? false,
      run_id: opts.runId,
      planFn,
      runMultitaskMissionFn,
      writeAuthPreflightFn: () => ({ ok: true }),
    },
    `npx tsx src/cli.ts autopilot-one-click --yes ${h.goal}`
  );
}

describe('Stage 18.26f: deterministic resume reuses the exact persisted plan', () => {
  test('initial run persists an immutable snapshot; resume makes ZERO planner calls and reuses PLAN-A', async () => {
    const envSnap = snapshotEnv();
    process.env.KIMI_API_KEY = 'sk-test-snapshot';
    const h = setup();
    try {
      // Initial run pauses on provider quota during task execution.
      h.multitaskBehavior = async (mission, planResult) =>
        ({
          mission,
          plan: planResult.plan,
          plan_result: planResult,
          task_results: [
            { task_id: 'task-1', title: 'Task one PLAN-A', status: 'paused_provider', reason: 'quota exhausted' },
          ],
          task_states: [],
          verdict: 'MULTITASK_MISSION_PAUSED_PROVIDER',
          reason: 'provider quota exhausted during task-5 generating phase',
          run_dir: join(h.tmpDir, mission.run_id),
          exit_code: 1,
          resume_supported: true,
          resume_command: `npx tsx src/cli.ts autopilot-one-click --yes ${h.goal} --run-id ${mission.run_id} --resume`,
        }) as MultitaskMissionResult;

      const first = await runOnce(h, { planMarker: 'PLAN-A' });
      assert.strictEqual(first.verdict, 'MULTITASK_MISSION_PAUSED_PROVIDER');
      assert.strictEqual(h.planCalls, 1, 'planner runs exactly once on the initial run');
      const runId = (first as unknown as { mission?: { run_id?: string } }).mission?.run_id;
      assert.ok(runId, 'run id must be present');
      assert.ok(existsSync(getResumePlanSnapshotPath(h.tmpDir, runId!)), 'immutable snapshot must be persisted');

      // Quota recovered: resume with the exact same run id. A planner called now
      // would return PLAN-B; the fix must never invoke it.
      h.multitaskBehavior = async (mission, planResult) =>
        ({
          mission,
          plan: planResult.plan,
          plan_result: planResult,
          task_results: [
            { task_id: 'task-1', title: 'Task one PLAN-A', status: 'accepted', commit_sha: 'abc123' },
          ],
          task_states: [],
          verdict: 'MULTITASK_MISSION_DONE',
          reason: 'mission continued from paused task and completed',
          run_dir: join(h.tmpDir, mission.run_id),
          exit_code: 0,
        }) as MultitaskMissionResult;

      const second = await runOnce(h, { resume: true, runId, planMarker: 'PLAN-A', planBMarker: 'PLAN-B-MUST-NOT-APPEAR' });
      assert.strictEqual(second.verdict, 'MULTITASK_MISSION_DONE');
      assert.strictEqual(h.planCalls, 1, 'planner call count on resume must be ZERO (total stays 1)');
      assert.strictEqual(h.multitaskCalls, 2);
      assert.strictEqual(h.plansSeen.length, 1, 'exactly one plan object was ever produced');
      assert.match(h.plansSeen[0].tasks[0].title, /PLAN-A/, 'the resumed mission must continue with the exact original PLAN-A');
    } finally {
      restoreEnv(envSnap);
      rmSync(h.tmpDir, { recursive: true, force: true });
      rmSync(h.tmpRepo, { recursive: true, force: true });
    }
  });

  test('tampered snapshot (plan hash mismatch) fails closed with zero provider calls', async () => {
    const envSnap = snapshotEnv();
    process.env.KIMI_API_KEY = 'sk-test-snapshot';
    const h = setup();
    try {
      const first = await runOnce(h, { planMarker: 'PLAN-A' });
      const runId = (first as unknown as { mission: { run_id: string } }).mission.run_id;
      assert.strictEqual(h.planCalls, 1);

      // Tamper: swap the persisted plan for a different one without fixing the hash.
      const snapPath = getResumePlanSnapshotPath(h.tmpDir, runId);
      const snap = JSON.parse(readFileSync(snapPath, 'utf-8'));
      snap.plan_result.plan.tasks[0].title = 'Tampered task';
      writeFileSync(snapPath, JSON.stringify(snap), 'utf-8');

      const second = await runOnce(h, { resume: true, runId, planMarker: 'PLAN-A' });
      assert.strictEqual(second.verdict, 'ONE_CLICK_CONFIG_ERROR');
      assert.match(second.reason, /snapshot integrity check failed/);
      assert.strictEqual(h.planCalls, 1, 'zero provider calls on the failed integrity check');
      assert.strictEqual(h.multitaskCalls, 1, 'mission must not execute');
    } finally {
      restoreEnv(envSnap);
      rmSync(h.tmpDir, { recursive: true, force: true });
      rmSync(h.tmpRepo, { recursive: true, force: true });
    }
  });

  test('resume fails closed when snapshot run id differs from requested run id', async () => {
    const envSnap = snapshotEnv();
    process.env.KIMI_API_KEY = 'sk-test-snapshot';
    const h = setup();
    try {
      const first = await runOnce(h, { planMarker: 'PLAN-A' });
      const runId = (first as unknown as { mission: { run_id: string } }).mission.run_id;

      const snapPath = getResumePlanSnapshotPath(h.tmpDir, runId);
      const snap = JSON.parse(readFileSync(snapPath, 'utf-8'));
      snap.run_id = 'mission-someone-else';
      writeFileSync(snapPath, JSON.stringify(snap), 'utf-8');

      const second = await runOnce(h, { resume: true, runId, planMarker: 'PLAN-A' });
      assert.strictEqual(second.verdict, 'ONE_CLICK_CONFIG_ERROR');
      assert.match(second.reason, /snapshot run id .* does not match requested run id/);
      assert.strictEqual(h.planCalls, 1);
    } finally {
      restoreEnv(envSnap);
      rmSync(h.tmpDir, { recursive: true, force: true });
      rmSync(h.tmpRepo, { recursive: true, force: true });
    }
  });

  test('resume fails closed when snapshot goal differs from resume command goal', async () => {
    const envSnap = snapshotEnv();
    process.env.KIMI_API_KEY = 'sk-test-snapshot';
    const h = setup();
    try {
      const first = await runOnce(h, { planMarker: 'PLAN-A' });
      const runId = (first as unknown as { mission: { run_id: string } }).mission.run_id;

      const snapPath = getResumePlanSnapshotPath(h.tmpDir, runId);
      const snap = JSON.parse(readFileSync(snapPath, 'utf-8'));
      snap.mission.goal = 'Completely different goal';
      writeFileSync(snapPath, JSON.stringify(snap), 'utf-8');

      const second = await runOnce(h, { resume: true, runId, planMarker: 'PLAN-A' });
      assert.strictEqual(second.verdict, 'ONE_CLICK_CONFIG_ERROR');
      assert.match(second.reason, /snapshot mission goal does not match/);
      assert.strictEqual(h.planCalls, 1);
    } finally {
      restoreEnv(envSnap);
      rmSync(h.tmpDir, { recursive: true, force: true });
      rmSync(h.tmpRepo, { recursive: true, force: true });
    }
  });

  test('resume fails closed when snapshot repo differs from the requested mission repo', async () => {
    const envSnap = snapshotEnv();
    process.env.KIMI_API_KEY = 'sk-test-snapshot';
    const h = setup();
    try {
      const first = await runOnce(h, { planMarker: 'PLAN-A' });
      const runId = (first as unknown as { mission: { run_id: string } }).mission.run_id;

      const snapPath = getResumePlanSnapshotPath(h.tmpDir, runId);
      const snap = JSON.parse(readFileSync(snapPath, 'utf-8'));
      snap.mission.repo_path = join(h.tmpDir, 'some-other-repo');
      writeFileSync(snapPath, JSON.stringify(snap), 'utf-8');

      const second = await runOnce(h, { resume: true, runId, planMarker: 'PLAN-A' });
      assert.strictEqual(second.verdict, 'ONE_CLICK_CONFIG_ERROR');
      assert.match(second.reason, /snapshot repository does not match/);
      assert.strictEqual(h.planCalls, 1);
    } finally {
      restoreEnv(envSnap);
      rmSync(h.tmpDir, { recursive: true, force: true });
      rmSync(h.tmpRepo, { recursive: true, force: true });
    }
  });

  test('resume fails closed when multitask state plan_hash differs from snapshot plan_hash', async () => {
    const envSnap = snapshotEnv();
    process.env.KIMI_API_KEY = 'sk-test-snapshot';
    const h = setup();
    try {
      const first = await runOnce(h, { planMarker: 'PLAN-A' });
      const runId = (first as unknown as { mission: { run_id: string } }).mission.run_id;
      const planHash = computePlanHash(h.plansSeen[0]);

      // Write a mission state whose plan_hash does not match the snapshot.
      const stateDir = getMissionRunDir(h.tmpDir, runId);
      mkdirSync(stateDir, { recursive: true });
      writeFileSync(
        join(stateDir, 'multitask-mission-state.json'),
        JSON.stringify({
          version: 1,
          run_id: runId,
          stage: 'executing_tasks',
          plan_hash: planHash === '0000000000000000' ? '1111111111111111' : '0000000000000000',
          base_sha: 'deadbeef',
          work_branch: `mission-${runId}`,
          tasks: [],
        }),
        'utf-8'
      );

      const second = await runOnce(h, { resume: true, runId, planMarker: 'PLAN-A' });
      assert.strictEqual(second.verdict, 'ONE_CLICK_CONFIG_ERROR');
      assert.match(second.reason, /plan_hash does not match the persisted plan snapshot/);
      assert.strictEqual(h.planCalls, 1, 'zero provider calls on the failed check');
    } finally {
      restoreEnv(envSnap);
      rmSync(h.tmpDir, { recursive: true, force: true });
      rmSync(h.tmpRepo, { recursive: true, force: true });
    }
  });

  test('legacy run with execution state but no snapshot fails closed as LEGACY_RESUME_PLAN_UNAVAILABLE with zero provider calls', async () => {
    const envSnap = snapshotEnv();
    process.env.KIMI_API_KEY = 'sk-test-snapshot';
    const h = setup();
    try {
      // Emulate a pre-18.26f run: mission state exists, but no snapshot was
      // ever persisted (and mutable plan.json was overwritten by a failed
      // resume attempt).
      const runId = 'mission-20260924-051715-multitask-workflow-a';
      const stateDir = getMissionRunDir(h.tmpDir, runId);
      mkdirSync(stateDir, { recursive: true });
      writeFileSync(
        join(stateDir, 'multitask-mission-state.json'),
        JSON.stringify({
          version: 1,
          run_id: runId,
          stage: 'executing_tasks',
          plan_hash: 'a171b2cc00000000',
          base_sha: 'deadbeef',
          work_branch: `mission-${runId}`,
          tasks: [{ task_id: 'task-5', status: 'paused_provider' }],
        }),
        'utf-8'
      );
      assert.ok(!existsSync(getResumePlanSnapshotPath(h.tmpDir, runId)));

      const second = await runOnce(h, { resume: true, runId, planMarker: 'PLAN-A' });
      assert.strictEqual(second.verdict, 'ONE_CLICK_CONFIG_ERROR');
      assert.match(second.reason, /LEGACY_RESUME_PLAN_UNAVAILABLE/);
      assert.strictEqual(h.planCalls, 0, 'no planner call may be used as a recovery fallback');
      assert.strictEqual(h.multitaskCalls, 0, 'mission must not execute');
    } finally {
      restoreEnv(envSnap);
      rmSync(h.tmpDir, { recursive: true, force: true });
      rmSync(h.tmpRepo, { recursive: true, force: true });
    }
  });

  test('snapshot is never overwritten: a second planning phase cannot replace the original plan', async () => {
    const envSnap = snapshotEnv();
    process.env.KIMI_API_KEY = 'sk-test-snapshot';
    const h = setup();
    try {
      const first = await runOnce(h, { planMarker: 'PLAN-A' });
      const runId = (first as unknown as { mission: { run_id: string } }).mission.run_id;
      const snapPath = getResumePlanSnapshotPath(h.tmpDir, runId);
      const original = readFileSync(snapPath, 'utf-8');

      // Force the deferred-planning path? Not possible with state present; instead
      // verify immutability directly: saving again must be a no-op.
      const { saveResumePlanSnapshot } = await import('../src/autopilot-one-click/resume-plan-snapshot.js');
      const mission = (first as unknown as { mission: never }).mission;
      const otherPlan = makePlan(h.goal, 'PLAN-B') as never;
      saveResumePlanSnapshot(h.tmpDir, runId, mission, {
        mission,
        plan: otherPlan,
        generated_files: [],
        verdict: 'AUTOPILOT_PLAN_READY',
        reason: 'replan attempt',
        exit_code: 0,
      } as never);
      assert.strictEqual(readFileSync(snapPath, 'utf-8'), original, 'snapshot must be immutable');
    } finally {
      restoreEnv(envSnap);
      rmSync(h.tmpDir, { recursive: true, force: true });
      rmSync(h.tmpRepo, { recursive: true, force: true });
    }
  });
});
