import { resolve } from 'node:path';
import type { AutopilotPlanGeneratedPlan, AutopilotPlanMission, AutopilotPlanTask } from '../../autopilot-plan/types.js';
import { validateTaskDAG } from '../../autopilot-plan/dag.js';

export interface PlanValidationIssue {
  field: string;
  message: string;
}

export interface PlanValidationResult {
  ok: boolean;
  issues: PlanValidationIssue[];
}

function isValidPathSegment(path: string): boolean {
  if (typeof path !== 'string' || path.length === 0) return false;
  if (path.startsWith('/') || path.includes('..') || /[<>|"?*\x00-\x1f]/.test(path)) {
    return false;
  }
  return true;
}

function validatePathSafety(path: string, context: string, issues: PlanValidationIssue[]): void {
  const normalized = path.replace(/\\/g, '/');
  if (normalized.startsWith('/')) {
    issues.push({ field: context, message: `${context} must be a relative path: ${path}` });
  }
  if (normalized.includes('..')) {
    issues.push({ field: context, message: `${context} must not contain parent traversal: ${path}` });
  }
  if (normalized === '.env' || normalized.startsWith('.env/')) {
    issues.push({ field: context, message: `${context} must not target .env: ${path}` });
  }
  if (normalized.startsWith('node_modules/') || normalized === 'node_modules') {
    issues.push({ field: context, message: `${context} must not target node_modules: ${path}` });
  }
}

function validateTask(task: AutopilotPlanTask, index: number, issues: PlanValidationIssue[]): void {
  const prefix = `tasks[${index}]`;

  if (!task.id || typeof task.id !== 'string' || task.id.length === 0) {
    issues.push({ field: `${prefix}.id`, message: 'Task id is required and must be a non-empty string' });
  }
  if (!task.title || typeof task.title !== 'string' || task.title.length === 0) {
    issues.push({ field: `${prefix}.title`, message: 'Task title is required and must be a non-empty string' });
  }
  if (!task.goal || typeof task.goal !== 'string' || task.goal.length === 0) {
    issues.push({ field: `${prefix}.goal`, message: 'Task goal is required and must be a non-empty string' });
  }
  if (!Array.isArray(task.allowed_files) || task.allowed_files.length === 0) {
    issues.push({ field: `${prefix}.allowed_files`, message: 'Task allowed_files must be a non-empty array' });
  } else {
    for (const file of task.allowed_files) {
      validatePathSafety(file, `${prefix}.allowed_files`, issues);
    }
  }
  if (task.denied_files) {
    for (const file of task.denied_files) {
      const normalized = file.replace(/\\/g, '/');
      if (normalized.startsWith('/') || normalized.includes('..') || /\x00/.test(normalized)) {
        issues.push({ field: `${prefix}.denied_files`, message: `Invalid denied file path: ${file}` });
      }
    }
  }
  if (!task.risk || !['low', 'medium', 'high'].includes(task.risk)) {
    issues.push({ field: `${prefix}.risk`, message: "Task risk must be 'low', 'medium', or 'high'" });
  }
  if (!task.checks && !task.tests) {
    issues.push({ field: `${prefix}.checks`, message: 'Task must define checks or legacy tests' });
  }
  if (task.checks !== undefined && !Array.isArray(task.checks)) {
    issues.push({ field: `${prefix}.checks`, message: 'Task checks must be an array of strings' });
  }
  if (task.tests !== undefined && !Array.isArray(task.tests)) {
    issues.push({ field: `${prefix}.tests`, message: 'Task tests must be an array of strings' });
  }
  if (!task.acceptance_criteria || !Array.isArray(task.acceptance_criteria) || task.acceptance_criteria.length === 0) {
    issues.push({ field: `${prefix}.acceptance_criteria`, message: 'Task acceptance_criteria is required and must be a non-empty array' });
  }
  if (!task.expected_result || typeof task.expected_result !== 'string' || task.expected_result.length === 0) {
    issues.push({ field: `${prefix}.expected_result`, message: 'Task expected_result is required and must be a non-empty string' });
  }
  if (task.max_lines_changed === undefined || typeof task.max_lines_changed !== 'number' || task.max_lines_changed <= 0 || !Number.isInteger(task.max_lines_changed)) {
    issues.push({ field: `${prefix}.max_lines_changed`, message: 'Task max_lines_changed is required and must be a positive integer' });
  }
}

function detectFileScopeOverlap(tasks: AutopilotPlanTask[]): PlanValidationIssue[] {
  const issues: PlanValidationIssue[] = [];
  for (let i = 0; i < tasks.length; i += 1) {
    for (let j = i + 1; j < tasks.length; j += 1) {
      const a = tasks[i];
      const b = tasks[j];
      const depsOverlap =
        a.depends_on?.includes(b.id) ||
        b.depends_on?.includes(a.id) ||
        (a.depends_on ?? []).some((d) => (b.depends_on ?? []).includes(d));
      if (depsOverlap) continue;

      const aFiles = new Set(a.allowed_files.map((f) => f.replace(/\\/g, '/')));
      const overlap = b.allowed_files.filter((f) => aFiles.has(f.replace(/\\/g, '/')));
      if (overlap.length > 0) {
        issues.push({
          field: 'tasks',
          message: `Independent tasks ${a.id} and ${b.id} share allowed files: ${overlap.join(', ')}`,
        });
      }
    }
  }
  return issues;
}

function inspectRepoFiles(
  mission: AutopilotPlanMission,
  tasks: AutopilotPlanTask[],
  issues: PlanValidationIssue[]
): void {
  const repoPath = resolve(mission.repo_path);
  for (const task of tasks) {
    for (const file of task.allowed_files) {
      const filePath = resolve(repoPath, file);
      if (!filePath.startsWith(repoPath)) {
        issues.push({ field: `${task.id}.allowed_files`, message: `Path escapes repo root: ${file}` });
      }
    }
  }
}

export function validateGeneratedPlan(
  plan: AutopilotPlanGeneratedPlan,
  mission: AutopilotPlanMission
): PlanValidationResult {
  const issues: PlanValidationIssue[] = [];

  if (!Array.isArray(plan.tasks) || plan.tasks.length === 0) {
    issues.push({ field: 'tasks', message: 'Plan must contain at least one task' });
  } else if (plan.tasks.length > 8) {
    issues.push({ field: 'tasks', message: 'Plan must contain at most 8 tasks' });
  }

  const ids = new Set<string>();
  plan.tasks.forEach((task, index) => {
    if (task.id) {
      if (ids.has(task.id)) {
        issues.push({ field: `tasks[${index}].id`, message: `Duplicate task id: ${task.id}` });
      }
      ids.add(task.id);
    }
    validateTask(task, index, issues);
  });

  const dag = validateTaskDAG(plan.tasks);
  if (!dag.ok) {
    issues.push({ field: 'tasks', message: dag.reason ?? 'Invalid dependency DAG' });
  }

  issues.push(...detectFileScopeOverlap(plan.tasks));

  inspectRepoFiles(mission, plan.tasks, issues);

  return { ok: issues.length === 0, issues };
}
