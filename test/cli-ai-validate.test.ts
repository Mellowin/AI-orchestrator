import { spawnSync } from 'node:child_process';
import { describe, test } from 'node:test';
import assert from 'node:assert';
import { existsSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

let counter = 0;

function createValidateEnv(): {
  taskId: string;
  cwd: string;
  runsDir: string;
  cleanup: () => void;
} {
  const id = `${Date.now()}-${counter++}`;
  const taskId = `validate-${id}`;
  const baseDir = join(process.cwd(), 'tmp', `validate-${id}`);
  const runsDir = join(baseDir, 'runs');
  mkdirSync(baseDir, { recursive: true });

  writeFileSync(join(baseDir, 'package.json'), '{}', 'utf-8');

  spawnSync('git', ['init'], { cwd: baseDir, encoding: 'utf-8', shell: false });
  spawnSync('git', ['add', '.'], { cwd: baseDir, encoding: 'utf-8', shell: false });
  spawnSync('git', ['commit', '-m', 'init', '--no-gpg-sign'], {
    cwd: baseDir,
    encoding: 'utf-8',
    shell: false,
  });
  spawnSync('git', ['branch', '-m', 'main'], { cwd: baseDir, encoding: 'utf-8', shell: false });

  const tasksYaml = `tasks:
  - id: ${taskId}
    title: "Validate test task"
    repo_path: "."
    base_branch: "main"
    work_branch: "ai/${taskId}"
    goal: "Test validate"
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

  return {
    taskId,
    cwd: baseDir,
    runsDir,
    cleanup: () => {
      rmSync(baseDir, { recursive: true, force: true });
    },
  };
}

function runAiValidate(taskId: string, cwd: string): { status: number; stdout: string; stderr: string } {
  const result = spawnSync(
    `npx tsx "${join(process.cwd(), 'src', 'cli.ts')}" ai-validate ${taskId}`,
    {
      cwd,
      env: process.env,
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

describe('cli ai-validate', () => {
  test('succeeds for valid ai-output.json', () => {
    const { taskId, cwd, runsDir, cleanup } = createValidateEnv();
    try {
      const runTaskDir = join(runsDir, taskId);
      mkdirSync(runTaskDir, { recursive: true });
      writeFileSync(
        join(runTaskDir, 'ai-output.json'),
        '{"mode":"file_update","files":[{"path":"src/main.ts","content":"x"}]}',
        'utf-8'
      );

      const result = runAiValidate(taskId, cwd);
      assert.strictEqual(result.status, 0, `Expected success, got stderr: ${result.stderr}`);
      assert(result.stdout.includes('[ai-validate] Valid AI output'), `Expected Valid AI output, got stdout: ${result.stdout}`);
      assert(result.stdout.includes('[ai-validate] Guardrails: ok'), `Expected Guardrails: ok, got stdout: ${result.stdout}`);
      assert(!existsSync(join(runTaskDir, 'state.json')), 'state.json should not exist');
      assert(!existsSync(join(runTaskDir, 'attempt-1')), 'attempt-1 should not exist');
    } finally {
      cleanup();
    }
  });

  test('fails when ai-output.json is missing', () => {
    const { taskId, cwd, runsDir, cleanup } = createValidateEnv();
    try {
      const runTaskDir = join(runsDir, taskId);
      if (existsSync(runTaskDir)) {
        rmSync(runTaskDir, { recursive: true });
      }

      const result = runAiValidate(taskId, cwd);
      assert.strictEqual(result.status, 1, `Expected failure, got stderr: ${result.stderr}`);
      assert(
        result.stderr.includes('ai-output.json not found. Run ai-generate first.'),
        `Expected missing file message, got stderr: ${result.stderr}`
      );
      assert(!existsSync(join(runTaskDir, 'state.json')), 'state.json should not exist');
      assert(!existsSync(join(runTaskDir, 'attempt-1')), 'attempt-1 should not exist');
    } finally {
      cleanup();
    }
  });

  test('fails guardrails for denied path', () => {
    const { taskId, cwd, runsDir, cleanup } = createValidateEnv();
    try {
      const runTaskDir = join(runsDir, taskId);
      mkdirSync(runTaskDir, { recursive: true });
      writeFileSync(
        join(runTaskDir, 'ai-output.json'),
        '{"mode":"file_update","files":[{"path":".env","content":"SECRET=1"}]}',
        'utf-8'
      );

      const result = runAiValidate(taskId, cwd);
      assert.strictEqual(result.status, 1, `Expected failure, got stderr: ${result.stderr}`);
      assert(
        result.stderr.includes('[ai-validate] Guardrails failed'),
        `Expected guardrails failed, got stderr: ${result.stderr}`
      );
      assert(!existsSync(join(runTaskDir, 'state.json')), 'state.json should not exist');
      assert(!existsSync(join(runTaskDir, 'attempt-1')), 'attempt-1 should not exist');
    } finally {
      cleanup();
    }
  });

  test('ai-validate succeeds for fenced json ai-output', () => {
    const { taskId, cwd, runsDir, cleanup } = createValidateEnv();
    try {
      const runTaskDir = join(runsDir, taskId);
      mkdirSync(runTaskDir, { recursive: true });
      writeFileSync(
        join(runTaskDir, 'ai-output.json'),
        '```json\n{"mode":"file_update","files":[{"path":"src/main.ts","content":"x"}]}\n```',
        'utf-8'
      );

      const result = runAiValidate(taskId, cwd);
      assert.strictEqual(result.status, 0, `Expected success, got stderr: ${result.stderr}`);
      assert(result.stdout.includes('[ai-validate] Valid AI output'), `Expected Valid AI output, got stdout: ${result.stdout}`);
      assert(result.stdout.includes('[ai-validate] Guardrails: ok'), `Expected Guardrails: ok, got stdout: ${result.stdout}`);
      assert(!existsSync(join(runTaskDir, 'state.json')), 'state.json should not exist');
      assert(!existsSync(join(runTaskDir, 'attempt-1')), 'attempt-1 should not exist');
    } finally {
      cleanup();
    }
  });

  test('ai-validate succeeds for empty files array', () => {
    const { taskId, cwd, runsDir, cleanup } = createValidateEnv();
    try {
      const runTaskDir = join(runsDir, taskId);
      mkdirSync(runTaskDir, { recursive: true });
      writeFileSync(
        join(runTaskDir, 'ai-output.json'),
        '{"mode":"file_update","files":[],"notes":"Cannot safely modify files because the request is unclear"}',
        'utf-8'
      );

      const result = runAiValidate(taskId, cwd);
      assert.strictEqual(result.status, 0, `Expected success, got stderr: ${result.stderr}`);
      assert(result.stdout.includes('[ai-validate] Files: 0'), `Expected Files: 0, got stdout: ${result.stdout}`);
      assert(result.stdout.includes('[ai-validate] No file changes proposed'), `Expected No file changes proposed, got stdout: ${result.stdout}`);
      assert(result.stdout.includes('[ai-validate] Notes:'), `Expected Notes, got stdout: ${result.stdout}`);
      assert(result.stdout.includes('[ai-validate] Guardrails: ok'), `Expected Guardrails: ok, got stdout: ${result.stdout}`);
      assert(!existsSync(join(runTaskDir, 'state.json')), 'state.json should not exist');
      assert(!existsSync(join(runTaskDir, 'attempt-1')), 'attempt-1 should not exist');
    } finally {
      cleanup();
    }
  });
});
