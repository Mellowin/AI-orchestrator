import type { AutopilotPlanTask } from '../../autopilot-plan/types.js';
import { topologicalSortTasks, validateTaskDAG } from '../../autopilot-plan/dag.js';
import type { MultitaskMissionTaskState } from './types.js';

export type TaskExecutionDisposition = 'run' | 'skip_dependency_failed' | 'skip_already_finished';

export interface ScheduledTask {
  task: AutopilotPlanTask;
  disposition: TaskExecutionDisposition;
  state: MultitaskMissionTaskState;
}

export function buildInitialTaskStates(tasks: AutopilotPlanTask[]): MultitaskMissionTaskState[] {
  return tasks.map((t) => ({ task_id: t.id, status: 'pending' }));
}

export function getTaskById(tasks: AutopilotPlanTask[], id: string): AutopilotPlanTask | undefined {
  return tasks.find((t) => t.id === id);
}

export function getDescendants(tasks: AutopilotPlanTask[], taskId: string): Set<string> {
  const taskById = new Map(tasks.map((t) => [t.id, t]));
  const descendants = new Set<string>();
  const queue: string[] = [taskId];
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const [id, task] of taskById) {
      if (task.depends_on?.includes(current) && !descendants.has(id)) {
        descendants.add(id);
        queue.push(id);
      }
    }
  }
  return descendants;
}

export function getFailedOrBlockedTasks(states: MultitaskMissionTaskState[]): string[] {
  return states
    .filter((s) => s.status === 'failed' || s.status === 'blocked' || s.status === 'needs_human')
    .map((s) => s.task_id);
}

export function scheduleTasks(
  tasks: AutopilotPlanTask[],
  states: MultitaskMissionTaskState[]
): ScheduledTask[] {
  const validation = validateTaskDAG(tasks);
  if (!validation.ok) {
    throw new Error(`Invalid task DAG: ${validation.reason}`);
  }

  const sorted = topologicalSortTasks(tasks).tasks;
  const stateById = new Map(states.map((s) => [s.task_id, s]));
  const failedOrBlocked = new Set(getFailedOrBlockedTasks(states));

  const result: ScheduledTask[] = [];
  for (const task of sorted) {
    const state = stateById.get(task.id) ?? { task_id: task.id, status: 'pending' };

    if (state.status === 'accepted' || state.status === 'fixed_and_accepted') {
      result.push({ task, disposition: 'skip_already_finished', state });
      continue;
    }

    const failedDep = task.depends_on?.find((dep) => failedOrBlocked.has(dep));
    if (failedDep) {
      const skippedState: MultitaskMissionTaskState = {
        ...state,
        status: 'skipped',
        reason: `Dependency ${failedDep} failed, was blocked, or needs human`,
      };
      result.push({ task, disposition: 'skip_dependency_failed', state: skippedState });
      failedOrBlocked.add(task.id);
      continue;
    }

    result.push({ task, disposition: 'run', state });
  }

  return result;
}

export function filterRunnableTasks(
  tasks: AutopilotPlanTask[],
  states: MultitaskMissionTaskState[]
): AutopilotPlanTask[] {
  return scheduleTasks(tasks, states)
    .filter((s) => s.disposition === 'run' && s.state.status === 'pending')
    .map((s) => s.task);
}

export function allRequiredTasksAccepted(
  tasks: AutopilotPlanTask[],
  states: MultitaskMissionTaskState[]
): boolean {
  const accepted = new Set(states.filter((s) => s.status === 'accepted' || s.status === 'fixed_and_accepted').map((s) => s.task_id));
  return tasks.every((t) => accepted.has(t.id));
}
