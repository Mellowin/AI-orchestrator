/**
 * Count provider attempts from a real-block-run-ai state object.
 *
 * The canonical location is taskResults[].providerAttempts. Older states may
 * store the same data as provider_attempts (snake_case) or at the top level.
 */
export function countProviderAttempts(state: Record<string, unknown> | null): number {
  if (!state) return 0;

  let taskAttempts = 0;
  const taskResults = state.taskResults;
  if (Array.isArray(taskResults)) {
    for (const task of taskResults) {
      if (task && typeof task === 'object') {
        const taskObj = task as Record<string, unknown>;
        const camel = taskObj.providerAttempts;
        if (Array.isArray(camel)) {
          taskAttempts += camel.length;
        }
        const snake = taskObj.provider_attempts;
        if (Array.isArray(snake)) {
          taskAttempts += snake.length;
        }
      }
    }
  }

  if (taskAttempts > 0) {
    return taskAttempts;
  }

  // Fallback for older state layouts.
  const topLevel = state.provider_attempts;
  if (Array.isArray(topLevel)) {
    return topLevel.length;
  }
  return 0;
}
