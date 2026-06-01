import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export function cleanTempTasksFile(tmpTasks: string): void {
  const dir = dirname(tmpTasks);
  if (existsSync(dir)) {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function createTempTasksFile(options: {
  prefix: string;
  taskId: string;
  repoPath?: string;
  allowModify?: string[];
  maxLinesChanged?: number;
}): string {
  const tmpBase = join(process.cwd(), 'tmp');
  if (!existsSync(tmpBase)) {
    mkdirSync(tmpBase);
  }
  const tmpDir = mkdtempSync(join(tmpBase, `${options.prefix}-`));
  const tmpTasks = join(tmpDir, 'tasks.yaml');
  const repoPath = options.repoPath ?? '.';
  const allowModify = options.allowModify ?? [];
  const maxLinesChanged = options.maxLinesChanged ?? 100;

  writeFileSync(
    tmpTasks,
    `tasks:
  - id: ${options.taskId}
    title: Test task
    description: test
    goal: Test goal
    repo_path: ${repoPath}
    base_branch: main
    work_branch: ai/${options.taskId}
    context_files: []
    guardrails:
      allow_modify: ${JSON.stringify(allowModify)}
      max_lines_changed: ${maxLinesChanged}
    checks:
      - command: echo
        args: ["ok"]
`,
    'utf-8'
  );
  return tmpTasks;
}
