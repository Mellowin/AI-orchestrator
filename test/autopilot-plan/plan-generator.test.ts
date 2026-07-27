import { describe, test } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { generateProviderPlan, ProviderBadOutputError } from '../../src/autopilot-plan/plan-generator.js';
import type { AutopilotPlanMission } from '../../src/autopilot-plan/types.js';

function buildMission(repoPath: string): AutopilotPlanMission {
  return {
    run_id: 'plan-checks-test',
    repo_slug: 'owner/repo',
    repo_path: repoPath,
    base_branch: 'main',
    goal: 'Add a feature to the demo project inside a subdirectory',
    mode: 'github',
    capabilities: {
      allow_real_provider: true,
      allow_repo_apply: true,
      allow_repo_commit: true,
      allow_repo_push: true,
      allow_pr_create: true,
      allow_pr_update: true,
      allow_actions_read: true,
      allow_repair: true,
    },
    provider: { name: 'kimi', token_env: 'KIMI_API_KEY' },
    output_dir: join(repoPath, 'out'),
  };
}

function validTask() {
  return {
    id: 'task-1',
    title: 'Update demo project',
    goal: 'Update the demo project',
    allowed_files: ['demo-repo/src/add.ts'],
    denied_files: ['.env'],
    checks: [
      { command: 'npm', args: ['install'], cwd: 'demo-repo' },
      { command: 'npm', args: ['test'], cwd: 'demo-repo' },
    ],
    risk: 'low',
    acceptance_criteria: ['Dependencies install and tests pass'],
    expected_result: 'demo-repo tests pass',
    max_lines_changed: 100,
  };
}

describe('autopilot-plan checks validation', () => {
  test('generateProviderPlan accepts structured checks with cwd', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'plan-checks-ok-'));
    try {
      const { plan } = await generateProviderPlan(buildMission(tmpDir), async () =>
        JSON.stringify({
          tasks: [validTask()],
          ci_enabled: true,
          repair_enabled: true,
          risk_level: 'low',
          caveats: [],
        })
      );
      assert.strictEqual(plan.tasks.length, 1);
      const checks = plan.tasks[0].checks;
      assert.ok(checks);
      assert.strictEqual(checks.length, 2);
      assert.deepStrictEqual(checks[0], { command: 'npm', args: ['install'], cwd: 'demo-repo' });
      assert.deepStrictEqual(checks[1], { command: 'npm', args: ['test'], cwd: 'demo-repo' });
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('generateProviderPlan rejects string checks with cd and shell operators', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'plan-checks-shell-'));
    try {
      await assert.rejects(
        () =>
          generateProviderPlan(buildMission(tmpDir), async () =>
            JSON.stringify({
              tasks: [
                {
                  ...validTask(),
                  checks: ['cd demo-repo && npm install && npm test'],
                },
              ],
              ci_enabled: true,
              repair_enabled: true,
              risk_level: 'low',
              caveats: [],
            })
          ),
        /shell/
      );
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('generateProviderPlan rejects structured checks with cwd outside repo', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'plan-checks-cwd-'));
    try {
      await assert.rejects(
        () =>
          generateProviderPlan(buildMission(tmpDir), async () =>
            JSON.stringify({
              tasks: [
                {
                  ...validTask(),
                  checks: [{ command: 'npm', args: ['test'], cwd: '../outside' }],
                },
              ],
              ci_enabled: true,
              repair_enabled: true,
              risk_level: 'low',
              caveats: [],
            })
          ),
        /repository root|\.\.|"\.\." segments/
      );
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('autopilot-plan planner correction retry', () => {
  test('recovers from contradictory guardrails on second attempt', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'plan-correction-'));
    let call = 0;
    try {
      const { plan, attempts } = await generateProviderPlan(buildMission(tmpDir), async () => {
        call += 1;
        if (call === 1) {
          return JSON.stringify({
            tasks: [
              {
                ...validTask(),
                allowed_files: ['docs/proofs/STAGE_18_26_PROOF6_*.md'],
                denied_files: ['**/*'],
              },
            ],
            ci_enabled: true,
            repair_enabled: true,
            risk_level: 'low',
            caveats: [],
          });
        }
        return JSON.stringify({
          tasks: [validTask()],
          ci_enabled: true,
          repair_enabled: true,
          risk_level: 'low',
          caveats: [],
        });
      });
      assert.strictEqual(call, 2);
      assert.strictEqual(plan.tasks.length, 1);
      assert.strictEqual(attempts.length, 2);
      assert.strictEqual(attempts[0].decision, 'retry');
      assert.ok(attempts[0].validation_error?.includes('overlaps denied'));
      assert.strictEqual(attempts[1].decision, 'accept');
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('exhausts retry budget and returns attempts on persistent contradiction', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'plan-exhaust-'));
    try {
      await assert.rejects(
        () =>
          generateProviderPlan(buildMission(tmpDir), async () =>
            JSON.stringify({
              tasks: [
                {
                  ...validTask(),
                  allowed_files: ['docs/proofs/STAGE_18_26_PROOF6_*.md'],
                  denied_files: ['**/*'],
                },
              ],
              ci_enabled: true,
              repair_enabled: true,
              risk_level: 'low',
              caveats: [],
            })
          ),
        (err: Error) => {
          assert.ok(err instanceof ProviderBadOutputError, `expected ProviderBadOutputError, got ${err.name}`);
          assert.ok(err.attempts && err.attempts.length === 3, `expected 3 attempts, got ${err.attempts?.length}`);
          assert.ok(err.attempts.every((a) => a.decision === 'retry'));
          assert.ok(err.attempts[0].validation_error?.includes('overlaps denied'));
          return true;
        }
      );
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('recovers from malformed JSON on second attempt', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'plan-json-correction-'));
    let call = 0;
    try {
      const { plan, attempts } = await generateProviderPlan(buildMission(tmpDir), async () => {
        call += 1;
        if (call === 1) {
          return 'not valid json';
        }
        return JSON.stringify({
          tasks: [validTask()],
          ci_enabled: true,
          repair_enabled: true,
          risk_level: 'low',
          caveats: [],
        });
      });
      assert.strictEqual(call, 2);
      assert.strictEqual(plan.tasks.length, 1);
      assert.strictEqual(attempts.length, 2);
      assert.strictEqual(attempts[0].decision, 'retry');
      assert.ok(attempts[0].validation_error?.includes('valid JSON'));
      assert.strictEqual(attempts[1].decision, 'accept');
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
