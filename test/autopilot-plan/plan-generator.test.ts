import { describe, test } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { generateProviderPlan } from '../../src/autopilot-plan/plan-generator.js';
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

describe('autopilot-plan checks validation', () => {
  test('generateProviderPlan accepts structured checks with cwd', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'plan-checks-ok-'));
    try {
      const plan = await generateProviderPlan(buildMission(tmpDir), async () =>
        JSON.stringify({
          tasks: [
            {
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
            },
          ],
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
                  id: 'task-1',
                  title: 'Update demo project',
                  goal: 'Update the demo project',
                  allowed_files: ['demo-repo/src/add.ts'],
                  denied_files: ['.env'],
                  checks: ['cd demo-repo && npm install && npm test'],
                  risk: 'low',
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
                  id: 'task-1',
                  title: 'Update demo project',
                  goal: 'Update the demo project',
                  allowed_files: ['demo-repo/src/add.ts'],
                  denied_files: ['.env'],
                  checks: [{ command: 'npm', args: ['test'], cwd: '../outside' }],
                  risk: 'low',
                },
              ],
              ci_enabled: true,
              repair_enabled: true,
              risk_level: 'low',
              caveats: [],
            })
          ),
        /repository root|\.\./
      );
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
