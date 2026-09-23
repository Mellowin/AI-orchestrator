import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runAutopilotOneClick } from '../src/autopilot-one-click/runner.js';
import { parseArgs } from '../src/autopilot-one-click/index.js';
import { buildResumeCommand } from '../src/autopilot-one-click/resume-command.js';
import type { AutopilotPlanResult } from '../src/autopilot-plan/types.js';
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

describe('buildResumeCommand', () => {
  test('pins the original run id and appends --resume', () => {
    assert.strictEqual(
      buildResumeCommand('npx tsx src/cli.ts autopilot-one-click --yes Add docs', 'mission-A'),
      'npx tsx src/cli.ts autopilot-one-click --yes Add docs --run-id mission-A --resume'
    );
  });

  test('never duplicates --run-id or --resume', () => {
    assert.strictEqual(
      buildResumeCommand('cmd --run-id mission-A --resume', 'mission-A'),
      'cmd --run-id mission-A --resume'
    );
    assert.strictEqual(
      buildResumeCommand('cmd --run-id mission-A', 'mission-A'),
      'cmd --run-id mission-A --resume'
    );
    assert.strictEqual(
      buildResumeCommand('cmd --resume', 'mission-A'),
      'cmd --resume --run-id mission-A'
    );
  });
});

describe('one-click resume identity', () => {
  test('raw goal + --resume without --run-id fails closed: no report dir, no provider calls, no repo mutation', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'resume-failclosed-out-'));
    const tmpRepo = mkdtempSync(join(tmpdir(), 'resume-failclosed-repo-'));
    try {
      const result = await runAutopilotOneClick(
        'Add docs note',
        {
          preset: 'real-multitask',
          repo_path: tmpRepo,
          output_dir: tmpDir,
          yes: true,
          resume: true,
          writeAuthPreflightFn: () => {
            throw new Error('write-auth preflight must not run on a malformed resume');
          },
          runMultitaskMissionFn: async () => {
            throw new Error('multitask mission must not run on a malformed resume');
          },
        },
        'npx tsx src/cli.ts autopilot-one-click --yes Add docs note --resume'
      );

      assert.strictEqual(result.verdict, 'ONE_CLICK_CONFIG_ERROR');
      assert.strictEqual(result.exit_code, 1);
      assert.match(result.reason, /Resume requires the original --run-id for a raw-goal mission/);
      assert.deepStrictEqual(readdirSync(tmpDir), [], 'no report directory may be created');
      assert.deepStrictEqual(readdirSync(tmpRepo), [], 'the repository must not be mutated');
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
      rmSync(tmpRepo, { recursive: true, force: true });
    }
  });

  test('git-auth pause generates a resume command that resumes the SAME run id (no duplicate mission)', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'resume-identity-out-'));
    const tmpRepo = mkdtempSync(join(tmpdir(), 'resume-identity-repo-'));
    const envSnap = snapshotEnv();
    // Provider token present so the git write-auth preflight runs. The planner
    // step is injected via planFn so the test never depends on the ambient
    // AI_PROVIDER/.env provider configuration.
    process.env.KIMI_API_KEY = 'sk-test-resume-identity';
    try {
      const goal = 'Add docs note';
      const initialCommand = `npx tsx src/cli.ts autopilot-one-click --yes ${goal}`;
      let planCalls = 0;
      const planFn = async (mission: { run_id: string }) => {
        planCalls += 1;
        return {
          mission,
          plan: { goal, mode: 'github', tasks: [] },
          run_dir: join(tmpDir, mission.run_id),
          generated_files: [join(tmpDir, mission.run_id, 'plan.json')],
          verdict: 'AUTOPILOT_PLAN_READY',
          reason: 'plan generated (test hook)',
          exit_code: 0,
          next_command: '',
        } as unknown as AutopilotPlanResult;
      };

      // Initial run: write-auth preflight rejects the credential -> pause with 0 provider calls.
      const first = await runAutopilotOneClick(
        goal,
        {
          preset: 'real-multitask',
          repo_path: tmpRepo,
          output_dir: tmpDir,
          writeAuthPreflightFn: () => ({
            ok: false,
            failure: {
              remote: 'origin',
              operation: 'preflight_write_check',
              failure_kind: 'GIT_AUTH_INVALID',
              http_status: null,
              pause_recommended: true,
              sanitized_message: 'Invalid username or token',
            },
          }),
          planFn,
        },
        initialCommand
      );

      assert.strictEqual(first.verdict, 'MULTITASK_MISSION_PAUSED_GIT_AUTH');
      assert.strictEqual(planCalls, 0, 'planner must not run before the preflight pause');
      const runA = first.mission.run_id;
      assert.match(runA, /^mission-\d{8}-\d{6}-/);

      const resumeCommand = first.resume_command;
      assert.ok(resumeCommand, 'a resume command must be generated');
      assert.ok(
        resumeCommand!.includes(`--run-id ${runA}`),
        'generated resume command must pin the exact original run id'
      );
      assert.ok(resumeCommand!.endsWith(' --resume'));
      assert.strictEqual(resumeCommand!.match(/--run-id/g)!.length, 1, 'no duplicate --run-id');
      assert.strictEqual(resumeCommand!.match(/--resume/g)!.length, 1, 'no duplicate --resume');

      // Rotate the credential: the preflight now passes. Execute the GENERATED
      // resume command through the real CLI argument parser.
      let preflightCalls = 0;
      let multitaskCalls = 0;
      let resumedRunId: string | undefined;
      const { input, options } = parseArgs(resumeCommand!.split(' ').slice(4));
      const second = await runAutopilotOneClick(
        input,
        {
          ...options,
          repo_path: tmpRepo,
          output_dir: tmpDir,
          writeAuthPreflightFn: () => {
            preflightCalls += 1;
            return { ok: true };
          },
          planFn,
          runMultitaskMissionFn: async (mission, planResult) => {
            multitaskCalls += 1;
            resumedRunId = mission.run_id;
            return {
              mission,
              plan: planResult.plan,
              plan_result: planResult,
              task_results: [],
              task_states: [],
              verdict: 'MULTITASK_MISSION_DONE',
              reason: 'resumed mission completed',
              run_dir: join(tmpDir, mission.run_id),
              exit_code: 0,
            } as MultitaskMissionResult;
          },
        },
        resumeCommand!
      );

      assert.strictEqual(preflightCalls, 1, 'write-auth preflight must pass exactly once after rotation');
      assert.strictEqual(planCalls, 1, 'the planner must begin exactly once on resume');
      assert.strictEqual(multitaskCalls, 1, 'the mission must run exactly once');
      assert.strictEqual(second.mission.run_id, runA, 'resumed mission must reuse the exact original run id');
      assert.strictEqual(resumedRunId, runA, 'the multitask runner must receive the original run id');
      assert.strictEqual(second.verdict, 'MULTITASK_MISSION_DONE');

      // No duplicate mission directory: every entry under output_dir belongs to runA.
      const entries = readdirSync(tmpDir);
      assert.ok(entries.length > 0);
      for (const entry of entries) {
        assert.ok(
          entry === runA || entry === 'missions',
          `unexpected entry ${entry}: a duplicate mission must not be created`
        );
      }
      const missionsDir = join(tmpDir, 'missions');
      if (existsSync(missionsDir)) {
        assert.deepStrictEqual(readdirSync(missionsDir), [runA]);
      }
    } finally {
      restoreEnv(envSnap);
      rmSync(tmpDir, { recursive: true, force: true });
      rmSync(tmpRepo, { recursive: true, force: true });
    }
  });
});
