import { describe, test } from 'node:test';
import assert from 'node:assert';
import { validateGeneratedPlan } from '../src/autopilot-one-click/multitask/plan-validator.js';
import type { AutopilotPlanGeneratedPlan, AutopilotPlanMission, AutopilotPlanTask } from '../src/autopilot-plan/types.js';

function makeMission(): AutopilotPlanMission {
  return {
    run_id: 'overlap-test',
    repo_slug: 'owner/repo',
    repo_path: '.',
    base_branch: 'main',
    goal: 'Test overlap',
    mode: 'fake',
    capabilities: {
      allow_real_provider: false,
      allow_repo_apply: false,
      allow_repo_commit: false,
      allow_repo_push: false,
      allow_pr_create: false,
      allow_pr_update: false,
      allow_actions_read: false,
      allow_repair: false,
    },
    output_dir: '/tmp/out',
  };
}

function makeTask(id: string, allowedFiles: string[], overrides: Partial<AutopilotPlanTask> = {}): AutopilotPlanTask {
  return {
    id,
    title: `Task ${id}`,
    goal: `Implement ${id}`,
    allowed_files: allowedFiles,
    denied_files: ['.env'],
    checks: ['npm test'],
    risk: 'low',
    acceptance_criteria: ['it works'],
    expected_result: 'passes',
    max_lines_changed: 100,
    ...overrides,
  };
}

function makePlan(tasks: AutopilotPlanTask[]): AutopilotPlanGeneratedPlan {
  return {
    goal: 'Test plan',
    mode: 'fake',
    tasks,
    ci_enabled: false,
    repair_enabled: false,
    risk_level: 'low',
    caveats: [],
  };
}

describe('detectFileScopeOverlap glob-aware analysis', () => {
  test('detects glob directory overlapping a concrete file', () => {
    const plan = makePlan([
      makeTask('a', ['src/**']),
      makeTask('b', ['src/foo.ts']),
    ]);
    const result = validateGeneratedPlan(plan, makeMission());
    assert.strictEqual(result.ok, false);
    assert.ok(result.issues.some((i) => i.message.includes('overlapping scopes')));
  });

  test('detects glob extension overlapping a concrete file', () => {
    const plan = makePlan([
      makeTask('a', ['docs/*.md']),
      makeTask('b', ['docs/readme.md']),
    ]);
    const result = validateGeneratedPlan(plan, makeMission());
    assert.strictEqual(result.ok, false);
    assert.ok(result.issues.some((i) => i.message.includes('overlapping scopes')));
  });

  test('detects wildcard segment intersection across patterns', () => {
    // `src/*/index.ts` and `src/api/*.ts` intersect at `src/api/index.ts`.
    const plan = makePlan([
      makeTask('a', ['src/*/index.ts']),
      makeTask('b', ['src/api/*.ts']),
    ]);
    const result = validateGeneratedPlan(plan, makeMission());
    assert.strictEqual(result.ok, false);
    assert.ok(result.issues.some((i) => i.message.includes('overlapping scopes')));
  });

  test('detects identical globs as overlapping', () => {
    const plan = makePlan([
      makeTask('a', ['src/**']),
      makeTask('b', ['src/**']),
    ]);
    const result = validateGeneratedPlan(plan, makeMission());
    assert.strictEqual(result.ok, false);
    assert.ok(result.issues.some((i) => i.message.includes('overlapping scopes')));
  });

  test('allows exact non-overlapping paths', () => {
    const plan = makePlan([
      makeTask('a', ['docs/A.md']),
      makeTask('b', ['src/B.ts']),
    ]);
    const result = validateGeneratedPlan(plan, makeMission());
    assert.strictEqual(result.ok, true, `Expected no issues but got: ${result.issues.map((i) => i.message).join(', ')}`);
  });

  test('allows overlapping scopes for dependent tasks', () => {
    const plan = makePlan([
      makeTask('a', ['src/**'], { depends_on: [] }),
      makeTask('b', ['src/foo.ts'], { depends_on: ['a'] }),
    ]);
    const result = validateGeneratedPlan(plan, makeMission());
    assert.strictEqual(result.ok, true, `Expected no issues but got: ${result.issues.map((i) => i.message).join(', ')}`);
  });

  test('normalizes Windows separators before comparing', () => {
    const plan = makePlan([
      makeTask('a', ['src\\**']),
      makeTask('b', ['src/foo.ts']),
    ]);
    const result = validateGeneratedPlan(plan, makeMission());
    assert.strictEqual(result.ok, false);
    assert.ok(result.issues.some((i) => i.message.includes('overlapping scopes')));
  });
});


describe('sibling task scope overlap validation', () => {
  test('detects overlap between sibling tasks that share a dependency', () => {
    const plan = makePlan([
      makeTask('parent', ['src/parent.ts']),
      makeTask('sibling-a', ['src/shared.ts'], { depends_on: ['parent'] }),
      makeTask('sibling-b', ['src/shared.ts'], { depends_on: ['parent'] }),
    ]);
    const result = validateGeneratedPlan(plan, makeMission());
    assert.strictEqual(result.ok, false);
    assert.ok(
      result.issues.some((i) => i.message.includes('overlapping scopes') && i.message.includes('sibling-a') && i.message.includes('sibling-b')),
      `expected sibling overlap issue, got: ${result.issues.map((i) => i.message).join(', ')}`
    );
  });
});
