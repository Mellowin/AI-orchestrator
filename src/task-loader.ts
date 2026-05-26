import { readFileSync, existsSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';
import YAML from 'yaml';
import type { Task, Check, Guardrails } from './types.js';

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
  const require_tests = expectBoolean(raw, 'require_tests', false);
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

function validateTask(task: Task): void {
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
    const filePath = join(resolvedRepo, file);
    if (!existsSync(filePath)) {
      throw new Error(`context_file does not exist: ${file}`);
    }
  }
}
