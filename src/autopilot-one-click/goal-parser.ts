/**
 * Parse raw goal strings into safe run ids, slugs, and branch names.
 */

export function makeGoalSlug(goal: string): string {
  const normalized = goal
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const truncated = normalized.slice(0, 40);
  return truncated || 'goal';
}

export function makeRunId(goal: string): string {
  const now = new Date();
  const datePart =
    now.getFullYear().toString() +
    String(now.getMonth() + 1).padStart(2, '0') +
    String(now.getDate()).padStart(2, '0');
  const timePart =
    String(now.getHours()).padStart(2, '0') +
    String(now.getMinutes()).padStart(2, '0') +
    String(now.getSeconds()).padStart(2, '0');
  const slug = makeGoalSlug(goal).slice(0, 20);
  return `mission-${datePart}-${timePart}-${slug}`;
}

export function makeWorkBranch(runId: string, _goal: string, mode: 'fake' | 'github'): string {
  const safeRunId = runId.replace(/[^a-zA-Z0-9_-]/g, '-');
  return mode === 'fake' ? `autopilot-demo-${safeRunId}` : `autopilot-${safeRunId}`;
}

export function isPathTraversal(value: string): boolean {
  if (value.includes('..')) return true;
  if (value.includes('\\') || value.includes('/')) {
    // Allow forward/back slashes only when they look like a normal relative path,
    // not a traversal.
    const normalized = value.replace(/\\/g, '/');
    if (normalized.startsWith('../') || normalized.includes('/../') || normalized.endsWith('/..')) {
      return true;
    }
  }
  return false;
}

export function sanitizeRunId(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, '-').replace(/^-+|-+$/g, '');
}
