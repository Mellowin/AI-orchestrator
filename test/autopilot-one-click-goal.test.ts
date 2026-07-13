import { describe, test } from 'node:test';
import assert from 'node:assert';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { makeGoalSlug, makeRunId, isPathTraversal } from '../src/autopilot-one-click/goal-parser.js';
import { buildMissionFromGoal, MissionBuilderError } from '../src/autopilot-one-click/mission-builder.js';
import { runAutopilotOneClick } from '../src/autopilot-one-click/runner.js';

describe('autopilot-one-click goal parsing', () => {
  test('makeGoalSlug lowercases and sanitizes', () => {
    assert.strictEqual(makeGoalSlug('Add a Health Endpoint!'), 'add-a-health-endpoint');
    assert.strictEqual(makeGoalSlug('   '), 'goal');
    assert.ok(makeGoalSlug('a'.repeat(100)).length <= 40);
  });

  test('makeRunId includes date and slug', () => {
    const id = makeRunId('Add docs');
    assert.ok(id.startsWith('mission-'));
    assert.ok(id.includes('add-docs'));
  });

  test('isPathTraversal rejects traversal patterns', () => {
    assert.strictEqual(isPathTraversal('../etc'), true);
    assert.strictEqual(isPathTraversal('foo/../bar'), true);
    assert.strictEqual(isPathTraversal('reports/autopilot-plans'), false);
    assert.strictEqual(isPathTraversal('reports\\autopilot-plans'), false);
  });

  test('safe preset disables all writes', () => {
    const mission = buildMissionFromGoal('Add docs', {});
    assert.strictEqual(mission.mode, 'fake');
    assert.strictEqual(mission.capabilities.allow_real_provider, false);
    assert.strictEqual(mission.capabilities.allow_repo_apply, false);
    assert.strictEqual(mission.capabilities.allow_repo_commit, false);
    assert.strictEqual(mission.capabilities.allow_repo_push, false);
    assert.strictEqual(mission.capabilities.allow_pr_create, false);
    assert.strictEqual(mission.capabilities.allow_actions_read, false);
    assert.strictEqual(mission.capabilities.allow_repair, false);
  });

  test('read-ci preset allows actions read only', () => {
    const mission = buildMissionFromGoal('Watch CI', { preset: 'read-ci' });
    assert.strictEqual(mission.mode, 'github');
    assert.strictEqual(mission.capabilities.allow_actions_read, true);
    assert.strictEqual(mission.capabilities.allow_repo_apply, false);
    assert.strictEqual(mission.capabilities.allow_pr_create, false);
    assert.strictEqual(mission.capabilities.allow_repair, false);
  });

  test('real-pr preset enables provider and pr writes', () => {
    const mission = buildMissionFromGoal('Implement feature', { preset: 'real-pr' });
    assert.strictEqual(mission.mode, 'github');
    assert.strictEqual(mission.capabilities.allow_real_provider, true);
    assert.strictEqual(mission.capabilities.allow_repo_apply, true);
    assert.strictEqual(mission.capabilities.allow_repo_commit, true);
    assert.strictEqual(mission.capabilities.allow_repo_push, true);
    assert.strictEqual(mission.capabilities.allow_pr_create, true);
    assert.strictEqual(mission.capabilities.allow_repair, false);
  });

  test('real-repair preset enables repair', () => {
    const mission = buildMissionFromGoal('Fix CI', { preset: 'real-repair' });
    assert.strictEqual(mission.capabilities.allow_repair, true);
    assert.strictEqual(mission.repair?.max_attempts, 2);
  });

  test('fake mode forces capabilities off even with real-pr preset', () => {
    const mission = buildMissionFromGoal('Demo', { preset: 'real-pr', mode: 'fake' });
    assert.strictEqual(mission.mode, 'fake');
    assert.strictEqual(mission.capabilities.allow_repo_apply, false);
    assert.strictEqual(mission.capabilities.allow_pr_create, false);
  });

  test('path traversal in run_id is rejected', () => {
    assert.throws(
      () => buildMissionFromGoal('x', { run_id: '../evil' }),
      MissionBuilderError
    );
  });

  test('path traversal in output_dir is rejected', () => {
    assert.throws(
      () => buildMissionFromGoal('x', { output_dir: '../evil' }),
      MissionBuilderError
    );
  });

  test('path traversal in repo_path is rejected', () => {
    assert.throws(
      () => buildMissionFromGoal('x', { repo_path: '../evil' }),
      MissionBuilderError
    );
  });

  test('raw goal one-click writes report files', async () => {
    const outDir = join(process.cwd(), 'tmp', `one-click-goal-${Date.now()}`);
    const result = await runAutopilotOneClick('Add a docs note', {
      output_dir: outDir,
      run_id: `test-goal-${Date.now()}`,
    }, 'test');

    assert.ok(result.verdict === 'ONE_CLICK_DONE' || result.verdict === 'ONE_CLICK_DONE_WITH_CAVEATS', `Unexpected verdict: ${result.verdict}`);
    assert.strictEqual(result.exit_code, 0);
    assert.ok(result.generated_paths.some((p) => p.endsWith('one-click-report.md')));
    assert.ok(result.generated_paths.some((p) => p.endsWith('one-click-report.json')));

    const report = JSON.parse(readFileSync(join(result.run_dir, 'one-click-report.json'), 'utf-8'));
    assert.strictEqual(report.raw_goal, 'Add a docs note');
    assert.ok(report.final_verdict.startsWith('ONE_CLICK_DONE'));

    rmSync(outDir, { recursive: true, force: true });
  });
});
