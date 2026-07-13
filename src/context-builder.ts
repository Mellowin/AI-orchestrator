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

  return {
    task_summary: `${task.id}: ${task.title}`,
    goal: task.goal,
    constraints: [
      allowedFilesConstraint,
      'If an allowed file does not exist yet, create it with full content.',
      'Do not modify files outside guardrails.allow_modify',
      'Do not modify files matching guardrails.deny_modify',
      'Do not push, merge, or touch main',
    ],
    files,
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
