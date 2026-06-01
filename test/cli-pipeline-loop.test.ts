import { spawnSync } from 'node:child_process';
import { describe, test } from 'node:test';
import assert from 'node:assert';
import { existsSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

let counter = 0;

function createPipelineEnv(): {
  taskId: string;
  cwd: string;
  repoPath: string;
  cleanup: () => void;
} {
  const id = `${Date.now()}-${counter++}`;
  const taskId = `cli-pl-${id}`;
  const baseDir = join(process.cwd(), 'tmp', `cli-pl-${id}`);
  const repoPath = baseDir;
  mkdirSync(baseDir, { recursive: true });

  writeFileSync(join(repoPath, 'package.json'), '{"name":"original","version":"1.0.0"}\n', 'utf-8');
  writeFileSync(join(repoPath, '.gitignore'), 'runs/\norigin.git/\n', 'utf-8');

  const tasksYaml = `tasks:
  - id: ${taskId}
    title: "Pipeline loop CLI test"
    repo_path: "."
    base_branch: "main"
    work_branch: "ai/${taskId}"
    goal: "Test pipeline loop CLI"
    context_files:
      - "package.json"
    checks: []
    guardrails:
      deny_modify:
        - ".env"
        - ".env.*"
        - "node_modules/**"
        - ".git/**"
      max_lines_changed: 150
      require_tests: false
      auto_commit: false
      auto_push: false
      auto_merge: false
`;
  writeFileSync(join(baseDir, 'tasks.yaml'), tasksYaml, 'utf-8');

  spawnSync('git', ['init'], { cwd: repoPath, encoding: 'utf-8', shell: false });
  spawnSync('git', ['add', '.'], { cwd: repoPath, encoding: 'utf-8', shell: false });
  spawnSync('git', ['commit', '-m', 'init', '--no-gpg-sign'], {
    cwd: repoPath,
    encoding: 'utf-8',
    shell: false,
  });
  spawnSync('git', ['branch', '-m', 'main'], { cwd: repoPath, encoding: 'utf-8', shell: false });

  const originPath = join(baseDir, 'origin.git');
  spawnSync('git', ['init', '--bare', originPath], { encoding: 'utf-8', shell: false });
  spawnSync('git', ['remote', 'add', 'origin', originPath], {
    cwd: repoPath,
    encoding: 'utf-8',
    shell: false,
  });
  spawnSync('git', ['push', '-u', 'origin', 'main'], {
    cwd: repoPath,
    encoding: 'utf-8',
    shell: false,
  });

  return {
    taskId,
    cwd: baseDir,
    repoPath,
    cleanup: () => {
      rmSync(baseDir, { recursive: true, force: true });
      const runDir = join(process.cwd(), 'runs', taskId);
      if (existsSync(runDir)) {
        rmSync(runDir, { recursive: true, force: true });
      }
    },
  };
}

function runCli(
  args: string[],
  cwd: string,
  envOverrides: Record<string, string> = {}
): { status: number; stdout: string; stderr: string } {
  const env = { ...process.env };
  delete env.AI_PROVIDER;
  delete env.MOCK_AI_RESPONSE;
  delete env.MOCK_REVIEWER_RESPONSE;
  delete env.KIMI_API_KEY;
  delete env.KIMI_MODEL;
  delete env.KIMI_BASE_URL;
  delete env.OPENAI_API_KEY;
  delete env.MOCK_AI;
  Object.assign(env, envOverrides);

  const result = spawnSync(
    `npx tsx "${join(process.cwd(), 'src', 'cli.ts')}" ${args.join(' ')}`,
    {
      cwd,
      env,
      encoding: 'utf-8',
      shell: true,
      timeout: 15000,
    }
  );
  return {
    status: result.status ?? 1,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
  };
}

describe('cli pipeline-loop', () => {
  test('approve path with mock responses succeeds', () => {
    const { taskId, cwd, repoPath, cleanup } = createPipelineEnv();
    try {
      const coderOutput = JSON.stringify({
        mode: 'file_update',
        files: [{ path: 'src/hello.ts', content: "export const hello = 'world';\n" }],
      });
      const reviewerOutput = JSON.stringify({
        verdict: 'approve',
        critical_issues: [],
        requested_changes: [],
        summary_for_human: 'Looks good',
      });

      const result = runCli(['pipeline-loop', taskId], cwd, {
        MOCK_AI_RESPONSE: coderOutput,
        MOCK_REVIEWER_RESPONSE: reviewerOutput,
      });

      assert.strictEqual(result.status, 0, `Expected success, got stderr: ${result.stderr}`);
      assert(result.stdout.includes('[pipeline-loop] Success'), `Expected Success, got stdout: ${result.stdout}`);
      assert(result.stdout.includes('Review approved'), `Expected Review approved, got stdout: ${result.stdout}`);

      assert(
        existsSync(join(repoPath, 'src', 'hello.ts')),
        'hello.ts should exist after approved patch'
      );
    } finally {
      cleanup();
    }
  });

  test('needs_changes path with mock responses fails and rolls back', () => {
    const { taskId, cwd, repoPath, cleanup } = createPipelineEnv();
    try {
      const coderOutput = JSON.stringify({
        mode: 'file_update',
        files: [{ path: 'src/hello.ts', content: "export const hello = 'world';\n" }],
      });
      const reviewerOutput = JSON.stringify({
        verdict: 'needs_changes',
        critical_issues: ['Missing error handling'],
        requested_changes: ['Add try/catch around file writes'],
        summary_for_human: 'Needs fixes',
      });

      const result = runCli(['pipeline-loop', taskId], cwd, {
        MOCK_AI_RESPONSE: coderOutput,
        MOCK_REVIEWER_RESPONSE: reviewerOutput,
      });

      assert.strictEqual(result.status, 1, `Expected failure, got stdout: ${result.stdout}`);
      assert(result.stderr.includes('[pipeline-loop] Failed'), `Expected Failed, got stderr: ${result.stderr}`);
      assert(result.stderr.includes('Review requested changes'), `Expected Review requested changes, got stderr: ${result.stderr}`);
      assert(result.stderr.includes('Rollback completed'), `Expected Rollback completed, got stderr: ${result.stderr}`);

      assert(!existsSync(join(repoPath, 'src', 'hello.ts')), 'hello.ts should not exist after rollback');
    } finally {
      cleanup();
    }
  });

  test('missing MOCK_REVIEWER_RESPONSE fails clearly', () => {
    const { taskId, cwd, cleanup } = createPipelineEnv();
    try {
      const coderOutput = JSON.stringify({
        mode: 'file_update',
        files: [{ path: 'src/hello.ts', content: "export const hello = 'world';\n" }],
      });

      const result = runCli(['pipeline-loop', taskId], cwd, {
        MOCK_AI_RESPONSE: coderOutput,
      });

      assert.strictEqual(result.status, 1, `Expected failure, got stdout: ${result.stdout}`);
      assert(result.stderr.includes('MOCK_REVIEWER_RESPONSE'), `Expected MOCK_REVIEWER_RESPONSE error, got stderr: ${result.stderr}`);
    } finally {
      cleanup();
    }
  });
});
