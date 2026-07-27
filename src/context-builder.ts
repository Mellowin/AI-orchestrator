import { existsSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import type { ContextPackage, Task } from './types.js';

export function buildContext(task: Task): ContextPackage {
  const repoPath = resolve(task.repo_path);
  const files = task.context_files.map((file) => {
    const filePath = resolveContextFile(file, repoPath);
    if (!existsSync(filePath)) {
      throw new Error(`context_file does not exist: ${file}`);
    }
    const stats = statSync(filePath);
    if (stats.isDirectory()) {
      throw new Error(`context_file is a directory: ${file}`);
    }
    const content = readFileSync(filePath, 'utf-8');
    return { path: file, content };
  });

  const allowedFiles = task.guardrails.allow_modify ?? [];
  const allowedFilesConstraint =
    allowedFiles.length > 0
      ? `Allowed files (you may create or modify): ${allowedFiles.join(', ')}`
      : 'No allowed files specified';

  const constraints = [
    allowedFilesConstraint,
    'If an allowed file does not exist yet, create it with full content.',
    'Do not modify files outside guardrails.allow_modify',
    'Do not modify files matching guardrails.deny_modify',
    'Do not push, merge, or touch main',
  ];

  if (task.guardrails.max_lines_changed !== undefined) {
    constraints.push(
      `HARD LIMIT: the total line delta for any single file must not exceed ${task.guardrails.max_lines_changed} lines. ` +
        'For a newly created file the limit applies to the full file length. ' +
        'If your proposed change would exceed this limit, reduce the scope or return empty files with a note.'
    );
  }

  return {
    task_summary: `${task.id}: ${task.title}`,
    goal: task.goal,
    constraints,
    files,
    max_lines_changed: task.guardrails.max_lines_changed,
  };
}

function resolveContextFile(file: string, repoPath: string): string {
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
