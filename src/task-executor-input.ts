import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { convertBlockChecks } from './block/block-task-runner.js';
import type { BlockDefinition, BlockTaskDefinition } from './block/block-types.js';
import type { DependencyEvidencePackage, Task, TaskExecutorInput } from './types.js';

/**
 * Build a single-task YAML/JSON debug artifact from a block task definition.
 * This is a read-only debug artifact; the canonical task configuration is now
 * passed to the child process via stdin as a TaskExecutorInput JSON object.
 */
export function buildSingleTaskYaml(
  block: BlockDefinition,
  task: BlockTaskDefinition
): string {
  const repoPath = resolve(block.repo_path);
  const taskObject = {
    tasks: [
      {
        id: task.task_id,
        title: task.title,
        repo_path: repoPath.replace(/\\/g, '/'),
        base_branch: block.base_branch,
        work_branch: block.work_branch,
        goal: task.goal,
        context_files: task.allowed_files.filter((file) => existsSync(resolve(repoPath, file))),
        checks:
          task.checks.length > 0
            ? convertBlockChecks(task.checks, repoPath)
            : [{ command: 'node', args: ['-e', 'process.exit(0)'] }],
        guardrails: {
          allow_modify: task.allowed_files,
          deny_modify: task.denied_files.length > 0 ? task.denied_files : ['.env', '.env.*', 'node_modules/**'],
          max_lines_changed: task.max_lines_changed,
          require_tests: false,
          auto_commit: false,
          auto_push: false,
          auto_merge: false,
        },
        ...(task.dependency_evidence !== undefined
          ? { dependency_evidence: task.dependency_evidence }
          : {}),
      },
    ],
  };
  return JSON.stringify(taskObject, null, 2);
}

/**
 * Build the typed TaskExecutorInput that is written to the child process stdin.
 * This is the source of truth for task execution in real-repo-run-ai.
 */
export function buildTaskExecutorInput(
  block: BlockDefinition,
  task: BlockTaskDefinition,
  options: {
    taskBaseSha: string;
    candidatePath: string;
    runId: string;
    attempt?: number;
  }
): TaskExecutorInput {
  const repoPath = resolve(block.repo_path);
  const taskObject: Task = {
    id: task.task_id,
    title: task.title,
    repo_path: repoPath.replace(/\\/g, '/'),
    base_branch: block.base_branch,
    work_branch: block.work_branch,
    goal: task.goal,
    context_files: task.allowed_files.filter((file) => existsSync(resolve(repoPath, file))),
    checks:
      task.checks.length > 0
        ? convertBlockChecks(task.checks, repoPath)
        : [{ command: 'node', args: ['-e', 'process.exit(0)'] }],
    guardrails: {
      allow_modify: task.allowed_files,
      deny_modify: task.denied_files.length > 0 ? task.denied_files : ['.env', '.env.*', 'node_modules/**'],
      max_lines_changed: task.max_lines_changed,
      require_tests: false,
      auto_commit: false,
      auto_push: false,
      auto_merge: false,
    },
    acceptance_criteria: task.acceptance_criteria,
    dependency_evidence: task.dependency_evidence,
  };

  return {
    task: taskObject,
    task_base_sha: options.taskBaseSha,
    candidate_path: options.candidatePath,
    run_id: options.runId,
    attempt: options.attempt,
  };
}

/**
 * Reconstruct a Task from the stdin TaskExecutorInput, ensuring the shape
 * matches what the rest of the pipeline expects. This is a thin helper so
 * callers can assert the input before using it.
 */
export function extractTaskFromExecutorInput(input: TaskExecutorInput): Task {
  return input.task;
}
