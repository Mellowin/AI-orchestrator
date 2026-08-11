import { describe, test } from 'node:test';
import assert from 'node:assert';
import { extractLiteralFilePaths, validateGeneratedPlan } from '../src/autopilot-one-click/multitask/plan-validator.js';
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

  test('detects partial wildcard segment intersection', () => {
    // `src/a*b.ts` and `src/ab*.ts` both authorize `src/ab.ts`.
    const plan = makePlan([
      makeTask('a', ['src/a*b.ts']),
      makeTask('b', ['src/ab*.ts']),
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

describe('extractLiteralFilePaths', () => {
  test('extracts explicit docs targets from failed real-run mission goal', () => {
    const goal = `Создай полный набор документации по автономному multitask workflow AI Orchestrator после Stage 18.26.

Задача 1:
Создай документ docs/autonomous-workflow/01-one-click.md.

Задача 2:
После задачи 1 создай docs/autonomous-workflow/02-task-lifecycle.md.

Задача 3:
После задачи 2 создай docs/autonomous-workflow/03-review-and-recovery.md.

Задача 4:
После задач 1–3 создай docs/autonomous-workflow/04-safety-model.md.

Задача 5:
После задач 1–4 создай docs/autonomous-workflow/README.md.`;

    const paths = extractLiteralFilePaths(goal);
    assert.deepStrictEqual(paths, [
      'docs/autonomous-workflow/01-one-click.md',
      'docs/autonomous-workflow/02-task-lifecycle.md',
      'docs/autonomous-workflow/03-review-and-recovery.md',
      'docs/autonomous-workflow/04-safety-model.md',
      'docs/autonomous-workflow/README.md',
    ]);
  });

  test('extracts root-level README.md and source paths', () => {
    const goal = 'Update README.md and create src/foo.ts plus test/foo.test.ts.';
    const paths = extractLiteralFilePaths(goal);
    assert.deepStrictEqual(paths, ['README.md', 'src/foo.ts', 'test/foo.test.ts']);
  });

  test('extracts dot-prefixed workflow paths', () => {
    const goal = 'Add .github/workflows/ci.yml.';
    const paths = extractLiteralFilePaths(goal);
    assert.deepStrictEqual(paths, ['.github/workflows/ci.yml']);
  });

  test('ignores URLs and domain-like tokens', () => {
    const goal = 'See https://github.com/Mellowin/AI-orchestrator/blob/main/README.md for context.';
    const paths = extractLiteralFilePaths(goal);
    assert.deepStrictEqual(paths, []);
  });

  test('ignores CLI flags', () => {
    const goal = 'Run with --repo-path src/foo.ts --output-dir reports.';
    const paths = extractLiteralFilePaths(goal);
    assert.deepStrictEqual(paths, ['src/foo.ts']);
  });

  test('ignores version strings', () => {
    const goal = 'Requires node v20.12.3 and npm 10.5.0.';
    const paths = extractLiteralFilePaths(goal);
    assert.deepStrictEqual(paths, []);
  });

  test('normalizes Windows backslash separators', () => {
    const goal = 'Create docs\\autonomous-workflow\\01-one-click.md.';
    const paths = extractLiteralFilePaths(goal);
    assert.deepStrictEqual(paths, ['docs/autonomous-workflow/01-one-click.md']);
  });
});

describe('explicit target path fidelity validation', () => {
  test('accepts plan that covers all explicit target paths', () => {
    const mission = makeMission();
    mission.goal = 'Create docs/autonomous-workflow/01-one-click.md and docs/autonomous-workflow/02-task-lifecycle.md.';
    const plan = makePlan([
      makeTask('task-1', ['docs/autonomous-workflow/01-one-click.md']),
      makeTask('task-2', ['docs/autonomous-workflow/02-task-lifecycle.md'], { depends_on: ['task-1'] }),
    ]);
    const result = validateGeneratedPlan(plan, mission);
    assert.strictEqual(result.ok, true, `Expected plan to be accepted: ${result.issues.map((i) => i.message).join('; ')}`);
  });

  test('rejects plan that substitutes README.md for docs/.../README.md', () => {
    const mission = makeMission();
    mission.goal = 'Create docs/autonomous-workflow/README.md.';
    const plan = makePlan([makeTask('task-1', ['README.md'])]);
    const result = validateGeneratedPlan(plan, mission);
    assert.strictEqual(result.ok, false, 'Expected plan to be rejected for missing explicit target');
    assert.ok(
      result.issues.some((i) => i.message.includes('Missing explicit operator target: docs/autonomous-workflow/README.md')),
      `Expected missing target issue, got: ${result.issues.map((i) => i.message).join(', ')}`
    );
  });

  test('rejects failed-real-run plan with wrong file set', () => {
    const mission = makeMission();
    mission.goal = `Create docs/autonomous-workflow/01-one-click.md, docs/autonomous-workflow/02-task-lifecycle.md,
docs/autonomous-workflow/03-review-and-recovery.md, docs/autonomous-workflow/04-safety-model.md,
and docs/autonomous-workflow/README.md.`;
    const plan = makePlan([
      makeTask('doc-readme', ['README.md']),
      makeTask('doc-architecture', ['docs/architecture.md'], { depends_on: ['doc-readme'] }),
      makeTask('doc-workflow', ['docs/workflow.md'], { depends_on: ['doc-readme'] }),
      makeTask('doc-config', ['docs/configuration.md'], { depends_on: ['doc-readme'] }),
      makeTask('doc-roadmap', ['docs/roadmap-stage-18-26.md'], { depends_on: ['doc-readme'] }),
    ]);
    const result = validateGeneratedPlan(plan, mission);
    assert.strictEqual(result.ok, false, 'Expected plan to be rejected for missing explicit targets');
    assert.ok(
      result.issues.some((i) => i.message.includes('Missing explicit operator target: docs/autonomous-workflow/01-one-click.md')),
      `Expected missing 01-one-click issue, got: ${result.issues.map((i) => i.message).join(', ')}`
    );
    assert.ok(
      result.issues.some((i) => i.message.includes('Missing explicit operator target: docs/autonomous-workflow/README.md')),
      `Expected missing README issue, got: ${result.issues.map((i) => i.message).join(', ')}`
    );
  });

  test('accepts corrected plan with exact target files', () => {
    const mission = makeMission();
    mission.goal = `Create docs/autonomous-workflow/01-one-click.md, docs/autonomous-workflow/02-task-lifecycle.md,
docs/autonomous-workflow/03-review-and-recovery.md, docs/autonomous-workflow/04-safety-model.md,
and docs/autonomous-workflow/README.md.`;
    const plan = makePlan([
      makeTask('task-1', ['docs/autonomous-workflow/01-one-click.md']),
      makeTask('task-2', ['docs/autonomous-workflow/02-task-lifecycle.md'], { depends_on: ['task-1'] }),
      makeTask('task-3', ['docs/autonomous-workflow/03-review-and-recovery.md'], { depends_on: ['task-2'] }),
      makeTask('task-4', ['docs/autonomous-workflow/04-safety-model.md'], { depends_on: ['task-3'] }),
      makeTask('task-5', ['docs/autonomous-workflow/README.md'], { depends_on: ['task-4'] }),
    ]);
    const result = validateGeneratedPlan(plan, mission);
    assert.strictEqual(result.ok, true, `Expected corrected plan to be accepted: ${result.issues.map((i) => i.message).join('; ')}`);
  });

  test('does not require target coverage when no explicit paths in goal', () => {
    const mission = makeMission();
    mission.goal = 'Refactor the codebase to improve maintainability.';
    const plan = makePlan([makeTask('refactor', ['src/**/*.ts'])]);
    const result = validateGeneratedPlan(plan, mission);
    assert.strictEqual(result.ok, true, `Expected plan with no explicit targets to be accepted: ${result.issues.map((i) => i.message).join('; ')}`);
  });
});
