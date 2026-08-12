import { describe, test } from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { generateProviderPlan } from '../src/autopilot-plan/plan-generator.js';
import type { AutopilotPlanMission } from '../src/autopilot-plan/types.js';

function makeGitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'plan-ctx-repo-'));
  mkdirSync(join(dir, 'src', 'autopilot-one-click'), { recursive: true });
  mkdirSync(join(dir, 'docs', 'autonomous-workflow'), { recursive: true });
  writeFileSync(join(dir, 'src', 'cli.ts'), 'export const cli = 1;\n', 'utf-8');
  writeFileSync(join(dir, 'src', 'autopilot-one-click', 'index.ts'), 'export const index = 1;\n', 'utf-8');
  writeFileSync(join(dir, 'src', 'autopilot-one-click', 'runner.ts'), 'export const runner = 1;\n', 'utf-8');
  writeFileSync(join(dir, 'src', 'workspace-paths.ts'), 'export const workspacePaths = 1;\n', 'utf-8');

  spawnSync('git', ['init'], { cwd: dir, encoding: 'utf-8', shell: false });
  spawnSync('git', ['config', 'user.email', 'ci@example.com'], { cwd: dir, encoding: 'utf-8', shell: false });
  spawnSync('git', ['config', 'user.name', 'CI User'], { cwd: dir, encoding: 'utf-8', shell: false });
  spawnSync('git', ['add', '.'], { cwd: dir, encoding: 'utf-8', shell: false });
  spawnSync('git', ['commit', '-m', 'init', '--no-gpg-sign'], { cwd: dir, encoding: 'utf-8', shell: false });
  return dir;
}

function buildMission(repoPath: string): AutopilotPlanMission {
  return {
    run_id: 'plan-ctx-test',
    repo_slug: 'owner/repo',
    repo_path: repoPath,
    base_branch: 'main',
    goal: 'Document canonical one-click behavior in docs/autonomous-workflow/01-one-click.md',
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

function baseTask() {
  return {
    id: 'doc-one-click',
    title: 'Document canonical one-click launch',
    goal: 'Create docs/autonomous-workflow/01-one-click.md based on actual code',
    allowed_files: ['docs/autonomous-workflow/01-one-click.md'],
    denied_files: ['.env'],
    context_files: [
      'src/cli.ts',
      'src/autopilot-one-click/index.ts',
      'src/autopilot-one-click/runner.ts',
      'src/workspace-paths.ts',
    ],
    checks: [],
    risk: 'low',
    acceptance_criteria: ['doc is created and references actual code'],
    expected_result: 'docs/autonomous-workflow/01-one-click.md created',
    max_lines_changed: 500,
  };
}

describe('autopilot-plan read-only context_files', () => {
  test('planner prompt includes bounded repository inventory', async () => {
    const repoPath = makeGitRepo();
    try {
      let capturedPrompt = '';
      await generateProviderPlan(buildMission(repoPath), async (prompt) => {
        capturedPrompt = prompt;
        return JSON.stringify({
          tasks: [baseTask()],
          ci_enabled: false,
          repair_enabled: false,
          risk_level: 'low',
          caveats: [],
        });
      });
      assert.ok(capturedPrompt.includes('Repository file inventory'));
      assert.ok(capturedPrompt.includes('src/cli.ts'));
      assert.ok(capturedPrompt.includes('src/autopilot-one-click/index.ts'));
      assert.ok(capturedPrompt.includes('context_files'));
      assert.ok(capturedPrompt.includes('do NOT grant write permission'));
    } finally {
      rmSync(repoPath, { recursive: true, force: true });
    }
  });

  test('accepts plan with existing source context_files and new output allowed_files', async () => {
    const repoPath = makeGitRepo();
    try {
      const { plan } = await generateProviderPlan(buildMission(repoPath), async () =>
        JSON.stringify({
          tasks: [baseTask()],
          ci_enabled: false,
          repair_enabled: false,
          risk_level: 'low',
          caveats: [],
        })
      );
      assert.strictEqual(plan.tasks.length, 1);
      assert.deepStrictEqual(plan.tasks[0].allowed_files, ['docs/autonomous-workflow/01-one-click.md']);
      assert.deepStrictEqual(plan.tasks[0].context_files, [
        'src/cli.ts',
        'src/autopilot-one-click/index.ts',
        'src/autopilot-one-click/runner.ts',
        'src/workspace-paths.ts',
      ]);
    } finally {
      rmSync(repoPath, { recursive: true, force: true });
    }
  });

  test('rejects plan with nonexistent context_file and recovers on correction', async () => {
    const repoPath = makeGitRepo();
    try {
      let call = 0;
      const { plan, attempts } = await generateProviderPlan(buildMission(repoPath), async () => {
        call += 1;
        if (call === 1) {
          return JSON.stringify({
            tasks: [
              {
                ...baseTask(),
                context_files: ['src/nonexistent.ts'],
              },
            ],
            ci_enabled: false,
            repair_enabled: false,
            risk_level: 'low',
            caveats: [],
          });
        }
        return JSON.stringify({
          tasks: [baseTask()],
          ci_enabled: false,
          repair_enabled: false,
          risk_level: 'low',
          caveats: [],
        });
      });
      assert.strictEqual(call, 2);
      assert.strictEqual(attempts[0].decision, 'retry');
      assert.ok(
        attempts[0].validation_error?.includes('context_file must be an existing tracked file'),
        `Expected missing context_file error, got: ${attempts[0].validation_error}`
      );
      assert.strictEqual(attempts[1].decision, 'accept');
      assert.strictEqual(plan.tasks[0].context_files?.length, 4);
    } finally {
      rmSync(repoPath, { recursive: true, force: true });
    }
  });

  test('rejects .env, node_modules, and traversal in context_files', async () => {
    const repoPath = makeGitRepo();
    try {
      await assert.rejects(
        () =>
          generateProviderPlan(buildMission(repoPath), async () =>
            JSON.stringify({
              tasks: [
                {
                  ...baseTask(),
                  context_files: ['.env', 'node_modules/foo', '../outside.ts'],
                },
              ],
              ci_enabled: false,
              repair_enabled: false,
              risk_level: 'low',
              caveats: [],
            })
          ),
        /context_files/
      );
    } finally {
      rmSync(repoPath, { recursive: true, force: true });
    }
  });

  test('failed-real-run regression: docs output plus source context_files is accepted', async () => {
    const repoPath = makeGitRepo();
    try {
      const { plan } = await generateProviderPlan(
        {
          ...buildMission(repoPath),
          goal:
            'Create docs/autonomous-workflow/01-one-click.md and docs/autonomous-workflow/02-task-lifecycle.md based on the actual code.',
        },
        async () =>
          JSON.stringify({
            tasks: [
              {
                id: 'doc-one-click',
                title: 'Document one-click',
                goal: 'Create docs/autonomous-workflow/01-one-click.md based on actual code',
                allowed_files: ['docs/autonomous-workflow/01-one-click.md'],
                denied_files: ['.env'],
                context_files: ['src/cli.ts', 'src/autopilot-one-click/index.ts'],
                checks: [],
                risk: 'low',
                acceptance_criteria: ['doc created from actual code'],
                expected_result: 'docs/autonomous-workflow/01-one-click.md created',
                max_lines_changed: 500,
              },
              {
                id: 'doc-task-lifecycle',
                title: 'Document task lifecycle',
                goal: 'Create docs/autonomous-workflow/02-task-lifecycle.md based on actual code',
                allowed_files: ['docs/autonomous-workflow/02-task-lifecycle.md'],
                denied_files: ['.env'],
                context_files: ['src/autopilot-one-click/runner.ts'],
                checks: [],
                risk: 'low',
                depends_on: ['doc-one-click'],
                acceptance_criteria: ['doc created'],
                expected_result: '02 created',
                max_lines_changed: 500,
              },
            ],
            ci_enabled: false,
            repair_enabled: false,
            risk_level: 'low',
            caveats: [],
          })
      );
      assert.strictEqual(plan.tasks[0].allowed_files[0], 'docs/autonomous-workflow/01-one-click.md');
      assert.deepStrictEqual(plan.tasks[0].context_files, [
        'src/cli.ts',
        'src/autopilot-one-click/index.ts',
      ]);
      assert.strictEqual(plan.tasks[1].allowed_files[0], 'docs/autonomous-workflow/02-task-lifecycle.md');
      assert.deepStrictEqual(plan.tasks[1].context_files, ['src/autopilot-one-click/runner.ts']);
    } finally {
      rmSync(repoPath, { recursive: true, force: true });
    }
  });
});
