import { describe, test } from 'node:test';
import assert from 'node:assert';
import { validateTaskDAG, topologicalSortTasks } from '../src/autopilot-plan/dag.js';
import type { AutopilotPlanTask } from '../src/autopilot-plan/types.js';

function makeTask(id: string, deps?: string[]): AutopilotPlanTask {
  return {
    id,
    title: `Task ${id}`,
    goal: `Do ${id}`,
    allowed_files: [`src/${id}.ts`],
    risk: 'low',
    depends_on: deps,
  };
}

describe('autopilot-plan DAG validation', () => {
  test('validates a simple independent task set', () => {
    const tasks = [makeTask('a'), makeTask('b')];
    const result = validateTaskDAG(tasks);
    assert.strictEqual(result.ok, true);
  });

  test('detects self-dependency', () => {
    const tasks = [makeTask('a', ['a'])];
    const result = validateTaskDAG(tasks);
    assert.strictEqual(result.ok, false);
    assert.ok(result.reason?.includes('itself'));
    assert.strictEqual(result.missing_dependency, 'a');
  });

  test('detects missing dependency', () => {
    const tasks = [makeTask('a', ['missing'])];
    const result = validateTaskDAG(tasks);
    assert.strictEqual(result.ok, false);
    assert.ok(result.reason?.includes('unknown'));
    assert.strictEqual(result.missing_dependency, 'missing');
  });

  test('detects cycle', () => {
    const tasks = [makeTask('a', ['b']), makeTask('b', ['a'])];
    const result = validateTaskDAG(tasks);
    assert.strictEqual(result.ok, false);
    assert.ok(result.reason?.includes('cycle'));
    assert.ok(result.cycle?.includes('a'));
    assert.ok(result.cycle?.includes('b'));
  });

  test('topological sort orders dependencies first', () => {
    const tasks = [makeTask('b', ['a']), makeTask('a'), makeTask('c', ['b'])];
    const result = topologicalSortTasks(tasks);
    assert.deepStrictEqual(result.tasks.map((t) => t.id), ['a', 'b', 'c']);
    assert.deepStrictEqual(result.levels, [0, 1, 2]);
  });

  test('topological sort preserves original order for ties', () => {
    const tasks = [makeTask('x'), makeTask('y'), makeTask('z')];
    const result = topologicalSortTasks(tasks);
    assert.deepStrictEqual(result.tasks.map((t) => t.id), ['x', 'y', 'z']);
    assert.deepStrictEqual(result.levels, [0, 0, 0]);
  });

  test('topological sort throws on invalid DAG', () => {
    assert.throws(() => topologicalSortTasks([makeTask('a', ['a'])]), /Invalid task DAG/);
  });
});
