import { readFileSync, existsSync, statSync } from 'node:fs';
import { resolve, join, isAbsolute, relative } from 'node:path';
import YAML from 'yaml';
import type { Task, Check, Guardrails, DependencyEvidencePackage } from './types.js';

const DEFAULT_DENY = ['.env', '.env.*', 'node_modules/**', '.git/**'];

export function loadTask(filePath: string, taskId: string): Task {
  if (!existsSync(filePath)) {
    throw new Error(`tasks.yaml not found: ${filePath}`);
  }

  const content = readFileSync(filePath, 'utf-8');
  const doc = YAML.parse(content);

  if (!isObject(doc) || !Array.isArray(doc.tasks)) {
    throw new Error('Invalid tasks.yaml: missing tasks array');
  }

  const raw = doc.tasks.find((t: unknown) => isObject(t) && t.id === taskId);
  if (!raw) {
    throw new Error(`Task "${taskId}" not found in ${filePath}`);
  }

  const task = parseTask(raw);
  validateTask(task);
  return task;
}

function isObject(val: unknown): val is Record<string, unknown> {
  return typeof val === 'object' && val !== null && !Array.isArray(val);
}

function expectString(
  raw: Record<string, unknown>,
  key: string,
  defaultValue?: string
): string {
  const val = raw[key];
  if (val === undefined && defaultValue !== undefined) return defaultValue;
  if (typeof val !== 'string') {
    throw new Error(`Expected "${key}" to be a string, got ${typeof val}`);
  }
  return val;
}

function expectStringArray(
  raw: Record<string, unknown>,
  key: string,
  defaultValue?: string[]
): string[] {
  const val = raw[key];
  if (val === undefined && defaultValue !== undefined) return defaultValue;
  if (!Array.isArray(val) || !val.every((v) => typeof v === 'string')) {
    throw new Error(`Expected "${key}" to be an array of strings`);
  }
  return val as string[];
}

function expectNumber(
  raw: Record<string, unknown>,
  key: string
): number {
  const val = raw[key];
  if (typeof val !== 'number') {
    throw new Error(`Expected "${key}" to be a number, got ${typeof val}`);
  }
  return val;
}

function expectBoolean(
  raw: Record<string, unknown>,
  key: string,
  defaultValue?: boolean
): boolean {
  const val = raw[key];
  if (val === undefined && defaultValue !== undefined) return defaultValue;
  if (typeof val !== 'boolean') {
    throw new Error(`Expected "${key}" to be a boolean, got ${typeof val}`);
  }
  return val;
}

function parseChecks(raw: unknown): Check[] {
  if (!Array.isArray(raw)) {
    throw new Error('Expected "checks" to be an array');
  }
  return raw.map((item, i) => {
    if (!isObject(item)) throw new Error(`Check[${i}] must be an object`);
    return {
      command: expectString(item, 'command'),
      args: expectStringArray(item, 'args'),
    };
  });
}

function expectDependencyEvidenceItem(
  raw: unknown,
  index: number
): import('./types.js').DependencyEvidenceItem {
  if (!isObject(raw)) {
    throw new Error(`Expected dependency_evidence.items[${index}] to be an object`);
  }
  return {
    task_id: expectString(raw, 'task_id'),
    task_status: expectString(raw, 'task_status'),
    accepted_commit_sha: raw.accepted_commit_sha === undefined ? undefined : expectString(raw, 'accepted_commit_sha'),
    fix_commit_sha: raw.fix_commit_sha === undefined ? undefined : expectString(raw, 'fix_commit_sha'),
    path: expectString(raw, 'path'),
    content_sha256: expectString(raw, 'content_sha256'),
    bytes: expectNumber(raw, 'bytes'),
    lines: expectNumber(raw, 'lines'),
    content: expectString(raw, 'content'),
    truncated: raw.truncated === undefined ? undefined : expectBoolean(raw, 'truncated'),
  };
}

function expectDependencyEvidencePackage(
  raw: unknown
): DependencyEvidencePackage | undefined {
  if (raw === undefined) {
    return undefined;
  }
  if (!isObject(raw)) {
    throw new Error('Expected "dependency_evidence" to be an object');
  }
  if (!Array.isArray(raw.items)) {
    throw new Error('Expected "dependency_evidence.items" to be an array');
  }
  return {
    items: raw.items.map((item, i) => expectDependencyEvidenceItem(item, i)),
    total_bytes: expectNumber(raw, 'total_bytes'),
    truncated: expectBoolean(raw, 'truncated', false),
    omitted_count: expectNumber(raw, 'omitted_count'),
  };
}

export function parseTaskObject(input: unknown): Task {
  if (!isObject(input)) {
    throw new Error('Expected task input to be an object');
  }
  return parseTask(input);
}

function parseGuardrails(raw: Record<string, unknown>): Guardrails {
  const allow_modify =
    raw.allow_modify === undefined
      ? undefined
      : expectStringArray(raw, 'allow_modify');
  const deny_modify = expectStringArray(raw, 'deny_modify', DEFAULT_DENY);
  const max_lines_changed =
    raw.max_lines_changed === undefined
      ? undefined
      : expectNumber(raw, 'max_lines_changed');
  const require_tests =
    raw.require_tests === undefined
      ? undefined
      : expectBoolean(raw, 'require_tests');
  const auto_commit = expectBoolean(raw, 'auto_commit', false);
  const auto_push = expectBoolean(raw, 'auto_push', false);
  const auto_merge = expectBoolean(raw, 'auto_merge', false);

  return {
    allow_modify,
    deny_modify,
    max_lines_changed,
    require_tests,
    auto_commit,
    auto_push,
    auto_merge,
  };
}

function parseTask(raw: Record<string, unknown>): Task {
  const acceptance_criteria =
    raw.acceptance_criteria === undefined
      ? undefined
      : expectStringArray(raw, 'acceptance_criteria');
  const dependency_evidence = expectDependencyEvidencePackage(raw.dependency_evidence);
  return {
    id: expectString(raw, 'id'),
    title: expectString(raw, 'title'),
    repo_path: expectString(raw, 'repo_path'),
    base_branch: expectString(raw, 'base_branch', 'main'),
    work_branch: expectString(raw, 'work_branch'),
    goal: expectString(raw, 'goal'),
    context_files: expectStringArray(raw, 'context_files'),
    checks: parseChecks(raw.checks),
    guardrails: parseGuardrails(expectObject(raw, 'guardrails')),
    acceptance_criteria,
    dependency_evidence,
  };
}

function expectObject(
  raw: Record<string, unknown>,
  key: string
): Record<string, unknown> {
  const val = raw[key];
  if (!isObject(val)) {
    throw new Error(`Expected "${key}" to be an object`);
  }
  return val;
}

function validateContextFilePath(file: string, repoPath: string): string {
  if (isAbsolute(file)) {
    throw new Error(`Absolute paths are not allowed in context_files: ${file}`);
  }
  if (file.includes('..')) {
    throw new Error(`Path traversal detected in context_files: ${file}`);
  }

  const resolvedFile = resolve(repoPath, file);
  const resolvedRepo = resolve(repoPath);
  const rel = relative(resolvedRepo, resolvedFile);

  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`context_file escapes repo_path: ${file}`);
  }

  return resolvedFile;
}

export function validateTask(task: Task): void {
  const resolvedRepo = resolve(task.repo_path);
  if (!existsSync(resolvedRepo)) {
    throw new Error(`repo_path does not exist: ${task.repo_path}`);
  }
  if (!statSync(resolvedRepo).isDirectory()) {
    throw new Error(`repo_path is not a directory: ${task.repo_path}`);
  }
  if (!existsSync(join(resolvedRepo, '.git'))) {
    throw new Error(`repo_path is not a git repository: ${task.repo_path}`);
  }

  for (const file of task.context_files) {
    const filePath = validateContextFilePath(file, resolvedRepo);
    if (!existsSync(filePath)) {
      throw new Error(`context_file does not exist: ${file}`);
    }
  }
}
