import { resolve } from 'node:path';
import type { AutopilotPlanGeneratedPlan, AutopilotPlanMission, AutopilotPlanTask } from '../../autopilot-plan/types.js';
import { validateTaskDAG } from '../../autopilot-plan/dag.js';
import { matchesPattern } from '../../guardrails.js';
import { patternsOverlap, validateTaskScope } from '../../task-scope-validator.js';

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
  const scopeIssues = validateTaskScope(task, prefix);
  for (const issue of scopeIssues) {
    issues.push({ field: issue.field, message: issue.message });
  }
}

function buildReachability(tasks: AutopilotPlanTask[]): Map<string, Set<string>> {
  const reach = new Map<string, Set<string>>();
  for (const t of tasks) {
    reach.set(t.id, new Set());
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const t of tasks) {
      const deps = t.depends_on ?? [];
      const tReach = reach.get(t.id)!;
      for (const d of deps) {
        if (!reach.has(d)) continue;
        const dReach = reach.get(d)!;
        if (!tReach.has(d)) {
          tReach.add(d);
          changed = true;
        }
        for (const transitive of dReach) {
          if (!tReach.has(transitive)) {
            tReach.add(transitive);
            changed = true;
          }
        }
      }
    }
  }
  return reach;
}

function detectFileScopeOverlap(tasks: AutopilotPlanTask[]): PlanValidationIssue[] {
  const issues: PlanValidationIssue[] = [];
  const reachability = buildReachability(tasks);
  for (let i = 0; i < tasks.length; i += 1) {
    for (let j = i + 1; j < tasks.length; j += 1) {
      const a = tasks[i];
      const b = tasks[j];
      // Tasks that are ordered by the transitive dependency graph are serialized,
      // so they may intentionally touch the same files. Independent tasks or
      // siblings with a shared ancestor must not overlap.
      const ordered =
        reachability.get(a.id)!.has(b.id) || reachability.get(b.id)!.has(a.id);
      if (ordered) continue;

      const aPatterns = a.allowed_files.map((f) => f.replace(/\\/g, '/'));
      const bPatterns = b.allowed_files.map((f) => f.replace(/\\/g, '/'));

      const overlaps: string[] = [];
      for (const aPattern of aPatterns) {
        for (const bPattern of bPatterns) {
          if (patternsOverlap(aPattern, bPattern)) {
            overlaps.push(`${aPattern} / ${bPattern}`);
          }
        }
      }

      if (overlaps.length > 0) {
        issues.push({
          field: 'tasks',
          message: `Independent tasks ${a.id} and ${b.id} share allowed files or have overlapping scopes: ${overlaps.join('; ')}`,
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

function normalizeFilePath(file: string): string {
  return file.replace(/\\/g, '/');
}

function fileMatchesAnyPattern(file: string, patterns: string[]): boolean {
  const normalizedFile = normalizeFilePath(file);
  return patterns.some((pattern) => matchesPattern(normalizedFile, normalizeFilePath(pattern)));
}

function validateTaskFilesWithinMissionAllowlist(
  mission: AutopilotPlanMission,
  tasks: AutopilotPlanTask[],
  issues: PlanValidationIssue[]
): void {
  const missionAllowlist = mission.allowed_files;
  if (!missionAllowlist || missionAllowlist.length === 0) {
    return;
  }

  const normalizedMissionPatterns = missionAllowlist.map(normalizeFilePath);

  for (const task of tasks) {
    for (const file of task.allowed_files) {
      if (!fileMatchesAnyPattern(file, normalizedMissionPatterns)) {
        issues.push({
          field: `${task.id}.allowed_files`,
          message: `Task file ${JSON.stringify(file)} is outside the mission allowlist: ${missionAllowlist.join(', ')}`,
        });
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

  validateTaskFilesWithinMissionAllowlist(mission, plan.tasks, issues);

  return { ok: issues.length === 0, issues };
}
