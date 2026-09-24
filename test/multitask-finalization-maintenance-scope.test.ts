import { describe, test } from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildMissionFromGoal } from '../src/autopilot-one-click/mission-builder.js';
import { runAutopilotPlan } from '../src/autopilot-plan/runner.js';
import { runMultitaskMission } from '../src/autopilot-one-click/multitask/runner.js';
import {
  computePlanHash,
  getMissionRunDir,
  loadMissionState,
} from '../src/autopilot-one-click/multitask/state-manager.js';
import type { FinalReviewInput } from '../src/autopilot-one-click/multitask/types.js';
import type { AutopilotRunResult } from '../src/autopilot-run/types.js';
import type { AutopilotRemoteFinalizationResult } from '../src/autopilot-run/runner.js';
import type { MvpRunConfig } from '../src/mvp-run/types.js';

function git(repoPath: string, args: string[]): string {
  const result = spawnSync('git', args, { cwd: repoPath, encoding: 'utf-8', shell: false });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  }
  return result.stdout.trim();
}

function createValidationRepo(): string {
  const repoPath = mkdtempSync(join(tmpdir(), 'maint-scope-repo-'));
  git(repoPath, ['init', '--initial-branch=main']);
  git(repoPath, ['config', 'user.email', 'test@example.com']);
  git(repoPath, ['config', 'user.name', 'Test User']);

  writeFileSync(
    join(repoPath, 'package.json'),
    JSON.stringify({
      name: 'maint-scope-repo',
      version: '0.0.1',
      scripts: {
        'verify:summary': 'node scripts/verify-testing-summary.mjs',
        'verify:product': 'echo ok',
        'verify:product:ci': 'echo ok',
        'test:chunks:product': 'echo ok',
        'test:chunks:product:ci': 'echo ok',
      },
    }),
    'utf-8'
  );

  const realVerifier = readFileSync(join(process.cwd(), 'scripts', 'verify-testing-summary.mjs'), 'utf-8');
  mkdirSync(join(repoPath, 'scripts'));
  writeFileSync(join(repoPath, 'scripts', 'verify-testing-summary.mjs'), realVerifier, 'utf-8');

  mkdirSync(join(repoPath, '.github', 'workflows'), { recursive: true });
  writeFileSync(
    join(repoPath, '.github', 'workflows', 'product-verify.yml'),
    'on:\n  workflow_dispatch:\n',
    'utf-8'
  );

  writeFileSync(
    join(repoPath, 'TESTING_SUMMARY.md'),
    '# Summary\n\n**Last verified:** `INITIAL_SHA`\n\n## Test metrics\n\n- **Last verified commit:** `INITIAL_SHA`\n',
    'utf-8'
  );

  git(repoPath, ['add', '.']);
  git(repoPath, ['commit', '-m', 'init']);
  const initialSha = git(repoPath, ['rev-parse', 'HEAD']);
  const summary = readFileSync(join(repoPath, 'TESTING_SUMMARY.md'), 'utf-8').replace(/INITIAL_SHA/g, initialSha);
  writeFileSync(join(repoPath, 'TESTING_SUMMARY.md'), summary, 'utf-8');
  git(repoPath, ['add', 'TESTING_SUMMARY.md']);
  git(repoPath, ['commit', '-m', 'lock summary']);
  return repoPath;
}

function concretePath(pattern: string): string {
  return pattern.replace(/\*\*/g, 'x').replace(/\*/g, 'x');
}

function fakeDiff(paths: string[]): string {
  return paths
    .map((p) =>
      [
        `diff --git a/${p} b/${p}`,
        'index e69de29..d8649da 100644',
        `--- a/${p}`,
        `+++ b/${p}`,
        '@@ -1 +1 @@',
        '-old',
        '+new',
      ].join('\n')
    )
    .join('\n');
}

async function setupMission() {
  const repoPath = createValidationRepo();
  const outputDir = mkdtempSync(join(tmpdir(), 'maint-scope-out-'));
  const runId = `maint-scope-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const mission = buildMissionFromGoal('Add docs note', {
    preset: 'multitask-safe',
    repo_path: repoPath,
    output_dir: outputDir,
    run_id: runId,
  });
  mission.mode = 'github';
  mission.capabilities = {
    allow_real_provider: false,
    allow_repo_apply: true,
    allow_repo_commit: true,
    allow_repo_push: true,
    allow_pr_create: true,
    allow_pr_update: true,
    allow_actions_read: true,
    allow_repair: true,
  };
  const planResult = await runAutopilotPlan(mission, { command: 'test' });

  // Commit an accepted task file on the base branch, leaving
  // TESTING_SUMMARY.md stale so integrated validation fails repairably.
  // The runner creates the mission work branch itself from this HEAD.
  const taskFiles = planResult.plan.tasks.flatMap((t) => t.allowed_files).map(concretePath);
  for (const file of taskFiles) {
    const full = join(repoPath, file);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, '# accepted task output\n', 'utf-8');
  }
  git(repoPath, ['add', '.']);
  git(repoPath, ['commit', '-m', 'accepted task output']);

  return { repoPath, outputDir, runId, mission, planResult, workBranch: `mission-${runId}`, taskFiles };
}

function makeDeferredAutopilotResult(
  planResult: Awaited<ReturnType<typeof runAutopilotPlan>>
): AutopilotRunResult {
  const configPath = planResult.generated_files.find((p) => p.endsWith('autopilot.config.json'))!;
  const mvpConfigPath = planResult.generated_files.find((p) => p.endsWith('mvp-run.config.json'))!;
  return {
    config: {} as AutopilotRunResult['config'],
    command: 'test',
    config_path: configPath,
    started_at: new Date().toISOString(),
    finished_at: new Date().toISOString(),
    duration_ms: 100,
    verdict: 'AUTOPILOT_MVP_DEFERRED',
    reason: 'MVP completed; remote finalization deferred to caller',
    repair_attempts: 0,
    report_dir: planResult.run_dir,
    exit_code: 0,
    mvp_result: {
      config: {} as AutopilotRunResult['mvp_result']['config'],
      command: 'mvp',
      config_path: mvpConfigPath,
      started_at: new Date().toISOString(),
      finished_at: new Date().toISOString(),
      duration_ms: 50,
      verdict: 'MVP_RUN_PASSED',
      reason: 'Fake MVP',
      preflight: {} as AutopilotRunResult['mvp_result']['preflight'],
      task_results: planResult.plan.tasks.map((t) => ({
        id: t.id,
        title: t.title,
        status: 'passed',
        provider_attempts: 1,
        recovery_attempts: 0,
        commit_sha: 'a'.repeat(40),
      })),
      tasks_total: planResult.plan.tasks.length,
      tasks_passed: planResult.plan.tasks.length,
      tasks_failed: 0,
      tasks_blocked: 0,
      tasks_skipped: 0,
      tasks_caveats: 0,
      commits: ['a'.repeat(40)],
      branch: 'mission-branch',
      pushed: true,
      caveats: [],
      report_dir: join(planResult.run_dir, 'mvp-run-reports'),
    },
  };
}

function makeApprovedFinalReview(): string {
  return JSON.stringify({
    verdict: 'approved',
    summary: 'approved',
    caveats: [],
    unauthorized_files: [],
    acceptance_gaps: [],
  });
}

function makeCiSuccess(): AutopilotRemoteFinalizationResult {
  return {
    verdict: 'AUTOPILOT_GREEN',
    reason: 'CI green',
    ci_run_id: 987654,
    ci_conclusion: 'success',
    repair_attempts: 0,
  };
}

describe('mission finalization maintenance scope in final review', () => {
  const originalToken = process.env.GITHUB_TOKEN;
  const savedEnv: Record<string, string | undefined> = {};

  // The finalization repair consults the real Kimi API when KIMI_* env vars
  // are present; tests must use the deterministic fallback only.
  function disableRealAiEnv() {
    for (const key of ['KIMI_API_KEY', 'KIMI_BASE_URL', 'KIMI_MODEL', 'OPENAI_API_KEY']) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  }

  function restoreAiEnv() {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }

  test('authorized TESTING_SUMMARY repair passes the final-review gate and reaches PR + CI', async () => {
    process.env.GITHUB_TOKEN = 'fake-token';
    disableRealAiEnv();
    const { repoPath, outputDir, runId, mission, planResult, taskFiles } = await setupMission();
    try {
      const calls: Array<{ type: 'pr' | 'ci'; config?: MvpRunConfig }> = [];
      let reviewInput: FinalReviewInput | undefined;

      const result = await runMultitaskMission(mission, planResult, {
        command: 'test',
        runAutopilotRunFn: async () => {
          // The real MVP runner would create and check out the mission work
          // branch; simulate that so finalization repair can commit on it.
          git(repoPath, ['checkout', '-b', `mission-${runId}`]);
          return makeDeferredAutopilotResult(planResult);
        },
        collectDiffFn: () => fakeDiff([...taskFiles, 'TESTING_SUMMARY.md']),
        runFinalReviewFn: async (input) => {
          reviewInput = input;
          return {
            verdict: 'approved',
            summary: 'approved',
            caveats: [],
            unauthorized_files: [],
            acceptance_gaps: [],
          };
        },
        createMvpRunPrFn: async (config) => {
          calls.push({ type: 'pr', config });
          return { created: true, number: 7, url: 'https://github.com/owner/repo/pull/7', draft: true, reason: 'ok' };
        },
        runAutopilotRemoteFinalizationFn: async (_config, mvpConfig) => {
          calls.push({ type: 'ci', config: mvpConfig });
          return makeCiSuccess();
        },
      });

      assert.strictEqual(result.verdict, 'MULTITASK_MISSION_DONE', result.reason);
      assert.strictEqual(result.pr?.number, 7, 'PR creation must be reached after the maintenance repair');
      assert.deepStrictEqual(
        calls.map((c) => c.type),
        ['pr', 'ci'],
        'mission must proceed to PR creation and then CI observation'
      );

      // Final review must have received the persisted deterministic evidence.
      assert.ok(reviewInput, 'final review must run');
      assert.ok(reviewInput!.authorized_maintenance, 'authorized maintenance evidence must reach final review');
      assert.deepStrictEqual(reviewInput!.authorized_maintenance!.maintenance_files, ['TESTING_SUMMARY.md']);
      assert.deepStrictEqual(reviewInput!.authorized_maintenance!.repair_files, ['TESTING_SUMMARY.md']);
      assert.strictEqual(reviewInput!.authorized_maintenance!.revalidation_ok, true);
      assert.match(reviewInput!.authorized_maintenance!.repair_commit_sha, /^[a-f0-9]{40}$/);

      const state = loadMissionState(getMissionRunDir(outputDir, runId));
      assert.ok(state?.authorized_maintenance, 'evidence must persist in mission state');
      assert.strictEqual(state?.finalization_repair_attempts, 1);
      assert.strictEqual(state?.validation_outcome?.ok, true);
    } finally {
      process.env.GITHUB_TOKEN = originalToken;
      restoreAiEnv();
      rmSync(repoPath, { recursive: true, force: true });
      rmSync(outputDir, { recursive: true, force: true });
    }
  });

  test('resume after committed repair reuses persisted authorization and still reaches PR', async () => {
    process.env.GITHUB_TOKEN = 'fake-token';
    disableRealAiEnv();
    const { repoPath, outputDir, runId, mission, planResult, workBranch, taskFiles } = await setupMission();
    try {
      const runDir = getMissionRunDir(outputDir, runId);
      mkdirSync(runDir, { recursive: true });
      const baseSha = git(repoPath, ['rev-parse', 'main']);
      const repairSha = git(repoPath, ['rev-parse', 'HEAD']);
      const autopilotResult = makeDeferredAutopilotResult(planResult);
      writeFileSync(
        join(runDir, 'multitask-mission-state.json'),
        JSON.stringify(
          {
            version: 1,
            run_id: runId,
            stage: 'mission_review',
            plan_hash: computePlanHash(planResult.plan),
            base_sha: baseSha,
            work_branch: workBranch,
            tasks: planResult.plan.tasks.map((t) => ({ task_id: t.id, status: 'accepted', commit_sha: repairSha })),
            autopilot_result: autopilotResult,
            validation_outcome: {
              ok: true,
              exitCode: 0,
              command: 'node scripts/verify-testing-summary.mjs',
              output: 'ok',
              classification: 'success',
            },
            finalization_repair_attempts: 1,
            finalization_repair_commit_sha: repairSha,
            authorized_maintenance: {
              classification: 'REPAIRABLE_REPOSITORY_FAILURE',
              maintenance_files: ['TESTING_SUMMARY.md'],
              repair_files: ['TESTING_SUMMARY.md'],
              repair_commit_sha: repairSha,
              revalidation_ok: true,
            },
          },
          null,
          2
        ),
        'utf-8'
      );

      let reviewInput: FinalReviewInput | undefined;
      const calls: Array<{ type: 'pr' | 'ci' }> = [];

      const result = await runMultitaskMission(mission, planResult, {
        command: 'test',
        resume: true,
        runAutopilotRunFn: async () => {
          throw new Error('autopilot must not rerun when resuming from mission_review');
        },
        collectDiffFn: () => fakeDiff([...taskFiles, 'TESTING_SUMMARY.md']),
        runFinalReviewFn: async (input) => {
          reviewInput = input;
          return {
            verdict: 'approved',
            summary: 'approved',
            caveats: [],
            unauthorized_files: [],
            acceptance_gaps: [],
          };
        },
        createMvpRunPrFn: async () => {
          calls.push({ type: 'pr' });
          return { created: true, number: 9, url: 'https://github.com/owner/repo/pull/9', draft: true, reason: 'ok' };
        },
        runAutopilotRemoteFinalizationFn: async () => {
          calls.push({ type: 'ci' });
          return makeCiSuccess();
        },
      });

      assert.strictEqual(result.verdict, 'MULTITASK_MISSION_DONE', result.reason);
      assert.strictEqual(result.pr?.number, 9);
      assert.deepStrictEqual(calls, [{ type: 'pr' }, { type: 'ci' }]);
      assert.ok(reviewInput?.authorized_maintenance, 'resume must reuse persisted authorization evidence');
      assert.strictEqual(reviewInput!.authorized_maintenance!.repair_commit_sha, repairSha);
      assert.deepStrictEqual(reviewInput!.unauthorized_files ?? [], []);
    } finally {
      process.env.GITHUB_TOKEN = originalToken;
      restoreAiEnv();
      rmSync(repoPath, { recursive: true, force: true });
      rmSync(outputDir, { recursive: true, force: true });
    }
  });

  test('inconsistent maintenance evidence on resume fails closed and blocks PR creation', async () => {
    process.env.GITHUB_TOKEN = 'fake-token';
    disableRealAiEnv();
    const { repoPath, outputDir, runId, mission, planResult, workBranch, taskFiles } = await setupMission();
    try {
      const runDir = getMissionRunDir(outputDir, runId);
      mkdirSync(runDir, { recursive: true });
      const baseSha = git(repoPath, ['rev-parse', 'main']);
      const repairSha = git(repoPath, ['rev-parse', 'HEAD']);
      const autopilotResult = makeDeferredAutopilotResult(planResult);
      writeFileSync(
        join(runDir, 'multitask-mission-state.json'),
        JSON.stringify(
          {
            version: 1,
            run_id: runId,
            stage: 'mission_review',
            plan_hash: computePlanHash(planResult.plan),
            base_sha: baseSha,
            work_branch: workBranch,
            tasks: planResult.plan.tasks.map((t) => ({ task_id: t.id, status: 'accepted', commit_sha: repairSha })),
            autopilot_result: autopilotResult,
            validation_outcome: {
              ok: true,
              exitCode: 0,
              command: 'node scripts/verify-testing-summary.mjs',
              output: 'ok',
              classification: 'success',
            },
            // Tampered evidence: repair claims a file the validator never authorized.
            authorized_maintenance: {
              classification: 'REPAIRABLE_REPOSITORY_FAILURE',
              maintenance_files: ['TESTING_SUMMARY.md'],
              repair_files: ['TESTING_SUMMARY.md', 'package.json'],
              repair_commit_sha: repairSha,
              revalidation_ok: true,
            },
          },
          null,
          2
        ),
        'utf-8'
      );

      let prCalled = false;
      const result = await runMultitaskMission(mission, planResult, {
        command: 'test',
        resume: true,
        runAutopilotRunFn: async () => autopilotResult,
        collectDiffFn: () => fakeDiff([...taskFiles, 'TESTING_SUMMARY.md']),
        reviewCallFn: async () => makeApprovedFinalReview(),
        createMvpRunPrFn: async () => {
          prCalled = true;
          return { created: false, reason: 'should not be called' };
        },
        runAutopilotRemoteFinalizationFn: async () => makeCiSuccess(),
      });

      // Deterministic gate overrides model approval: TESTING_SUMMARY.md is
      // unauthorized because the evidence is inconsistent.
      assert.strictEqual(result.verdict, 'MULTITASK_MISSION_FAILED');
      assert.deepStrictEqual(result.final_review?.unauthorized_files, ['TESTING_SUMMARY.md']);
      assert.strictEqual(prCalled, false, 'PR must not be created when the mandatory gate fails');
    } finally {
      process.env.GITHUB_TOKEN = originalToken;
      restoreAiEnv();
      rmSync(repoPath, { recursive: true, force: true });
      rmSync(outputDir, { recursive: true, force: true });
    }
  });
});
