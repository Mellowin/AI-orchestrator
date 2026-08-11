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
  if (
    task.max_lines_changed !== undefined &&
    (typeof task.max_lines_changed !== 'number' || task.max_lines_changed <= 0 || !Number.isInteger(task.max_lines_changed))
  ) {
    issues.push({ field: `${prefix}.max_lines_changed`, message: 'Task max_lines_changed must be a positive integer when provided' });
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

// Known file extensions for repo-relative paths that may appear in a natural-language mission goal.
const LITERAL_PATH_EXTENSIONS = new Set([
  'cjs',
  'css',
  'go',
  'html',
  'java',
  'js',
  'json',
  'jsx',
  'kt',
  'lock',
  'md',
  'mjs',
  'ps1',
  'py',
  'rs',
  'scss',
  'sh',
  'test.ts',
  'toml',
  'ts',
  'tsx',
  'txt',
  'vue',
  'xml',
  'yaml',
  'yml',
]);

function normalizeFilePath(file: string): string {
  return file.replace(/\\/g, '/');
}

// Domain-like TLDs that should not be treated as repo-relative file paths.
const DOMAIN_TLDS = new Set([
  'ai',
  'app',
  'cloud',
  'co',
  'com',
  'dev',
  'github',
  'io',
  'net',
  'org',
]);

function hasKnownExtension(path: string): boolean {
  const lower = path.toLowerCase();
  // Support compound extensions such as foo.test.ts.
  for (const ext of LITERAL_PATH_EXTENSIONS) {
    if (lower.endsWith(`.${ext}`)) return true;
  }
  return false;
}

function looksLikeDomain(path: string): boolean {
  const match = /^[A-Za-z0-9_-]+\.([A-Za-z]+)\b/.exec(path);
  if (!match) return false;
  return DOMAIN_TLDS.has(match[1].toLowerCase());
}

/**
 * Extract repository-relative file paths explicitly named in the mission goal.
 *
 * This is intentionally conservative: it matches literal paths that look like
 * source/docs/config files and ignores URLs, CLI flags, and ordinary words.
 */
export function extractLiteralFilePaths(goal: string): string[] {
  const results: string[] = [];
  const seen = new Set<string>();
  // Match path-like tokens ending with a known extension. Supports both `/` and
  // `\` separators and allows a leading dot (e.g. .github/workflows/ci.yml).
  // The lookahead ensures trailing punctuation is not consumed into the path.
  const regex = /([A-Za-z0-9_.\\-]+(?:[\/\\][A-Za-z0-9_.\\-]+)*\.[A-Za-z0-9_]+)(?=[.,;:!?")\]\s]|$)/g;

  let match: RegExpExecArray | null;
  while ((match = regex.exec(goal)) !== null) {
    const candidate = normalizeFilePath(match[1]);

    if (candidate.includes('://')) continue;
    if (candidate.startsWith('/')) continue;
    if (candidate.startsWith('--')) continue;
    if (candidate.includes('..')) continue;
    if (looksLikeDomain(candidate)) continue;
    if (!hasKnownExtension(candidate)) continue;

    // Ignore standalone version strings such as v1.2.3.
    if (/^[A-Za-z0-9_.\\-]*\d+\.\d+\.\d+$/.test(candidate) && !candidate.includes('/')) continue;

    if (!seen.has(candidate)) {
      seen.add(candidate);
      results.push(candidate);
    }
  }
  return results;
}

/**
 * Validate that every explicit target path from the user goal is represented
 * in the plan by a task whose allowed_files contains that exact path.
 * Explicit operator targets are immutable requirements; the planner must not
 * rename, relocate, or substitute them.
 */
function validateExplicitTargetPaths(
  mission: AutopilotPlanMission,
  tasks: AutopilotPlanTask[],
  issues: PlanValidationIssue[]
): void {
  const targets = extractLiteralFilePaths(mission.goal);
  if (targets.length === 0) return;

  const taskAllowedPaths = new Set<string>();
  for (const task of tasks) {
    for (const pattern of task.allowed_files) {
      taskAllowedPaths.add(normalizeFilePath(pattern));
    }
  }

  for (const target of targets) {
    if (!taskAllowedPaths.has(target)) {
      issues.push({
        field: 'goal',
        message: `Missing explicit operator target: ${target}`,
      });
    }
  }
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

  validateExplicitTargetPaths(mission, plan.tasks, issues);

  return { ok: issues.length === 0, issues };
}
