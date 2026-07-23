import type { AutopilotPlanTask } from './types.js';

export interface DagValidationResult {
  ok: boolean;
  reason?: string;
  cycle?: string[];
  missing_dependency?: string;
}

export interface TopologicalSortResult {
  ok: true;
  tasks: AutopilotPlanTask[];
  levels: number[];
}

export function validateTaskDAG(tasks: AutopilotPlanTask[]): DagValidationResult {
  const taskIds = new Set(tasks.map((t) => t.id));

  for (const task of tasks) {
    if (task.depends_on) {
      for (const dep of task.depends_on) {
        if (dep === task.id) {
          return { ok: false, reason: `Task ${task.id} depends on itself`, missing_dependency: dep };
        }
        if (!taskIds.has(dep)) {
          return {
            ok: false,
            reason: `Task ${task.id} depends on unknown task ${dep}`,
            missing_dependency: dep,
          };
        }
      }
    }
  }

  // Kahn's algorithm to detect cycles.
  const inDegree = new Map<string, number>();
  const adj = new Map<string, string[]>();
  for (const task of tasks) {
    inDegree.set(task.id, 0);
    adj.set(task.id, []);
  }
  for (const task of tasks) {
    for (const dep of task.depends_on ?? []) {
      adj.get(dep)!.push(task.id);
      inDegree.set(task.id, (inDegree.get(task.id) ?? 0) + 1);
    }
  }

  const queue: string[] = [];
  for (const [id, degree] of inDegree) {
    if (degree === 0) queue.push(id);
  }

  let visited = 0;
  while (queue.length > 0) {
    const id = queue.shift()!;
    visited += 1;
    for (const next of adj.get(id) ?? []) {
      const nextDegree = (inDegree.get(next) ?? 0) - 1;
      inDegree.set(next, nextDegree);
      if (nextDegree === 0) queue.push(next);
    }
  }

  if (visited !== tasks.length) {
    const remaining = tasks.filter((t) => (inDegree.get(t.id) ?? 0) > 0).map((t) => t.id);
    return { ok: false, reason: `Dependency cycle detected among tasks: ${remaining.join(', ')}`, cycle: remaining };
  }

  return { ok: true };
}

export function topologicalSortTasks(tasks: AutopilotPlanTask[]): TopologicalSortResult {
  const validation = validateTaskDAG(tasks);
  if (!validation.ok) {
    throw new Error(`Invalid task DAG: ${validation.reason}`);
  }

  const taskById = new Map(tasks.map((t) => [t.id, t]));
  const inDegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const task of tasks) {
    inDegree.set(task.id, 0);
    dependents.set(task.id, []);
  }
  for (const task of tasks) {
    for (const dep of task.depends_on ?? []) {
      dependents.get(dep)!.push(task.id);
      inDegree.set(task.id, (inDegree.get(task.id) ?? 0) + 1);
    }
  }

  // Use a stable queue seeded by original order to make the sort deterministic.
  const queue: string[] = tasks.filter((t) => (inDegree.get(t.id) ?? 0) === 0).map((t) => t.id);
  const sorted: AutopilotPlanTask[] = [];
  const levelById = new Map<string, number>();
  for (const id of queue) {
    levelById.set(id, 0);
  }

  while (queue.length > 0) {
    const id = queue.shift()!;
    sorted.push(taskById.get(id)!);
    for (const next of dependents.get(id) ?? []) {
      const nextDegree = (inDegree.get(next) ?? 0) - 1;
      inDegree.set(next, nextDegree);
      const nextLevel = Math.max((levelById.get(next) ?? 0), (levelById.get(id) ?? 0) + 1);
      levelById.set(next, nextLevel);
      if (nextDegree === 0) queue.push(next);
    }
  }

  const levels = sorted.map((t) => levelById.get(t.id) ?? 0);
  return { ok: true, tasks: sorted, levels };
}
