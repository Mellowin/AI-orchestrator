import { spawnSync } from 'node:child_process';
import { describe, test } from 'node:test';
import assert from 'node:assert';
import { existsSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

let counter = 0;

function createApplyEnv(): {
  taskId: string;
  cwd: string;
  runsDir: string;
  repoPath: string;
  cleanup: () => void;
} {
  const id = `${Date.now()}-${counter++}`;
  const taskId = `apply-${id}`;
  const baseDir = join(process.cwd(), 'tmp', `apply-${id}`);
  const runsDir = join(baseDir, 'runs');
  const repoPath = baseDir;
  mkdirSync(baseDir, { recursive: true });

  writeFileSync(join(repoPath, 'package.json'), '{"name":"original","version":"1.0.0"}\n', 'utf-8');
  writeFileSync(join(repoPath, '.gitignore'), 'runs/\norigin.git/\n', 'utf-8');

  const tasksYaml = `tasks:
  - id: ${taskId}
    title: "Apply test task"
    repo_path: "."
    base_branch: "main"
    work_branch: "ai/${taskId}"
    goal: "Test apply"
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
    runsDir,
    repoPath,
    cleanup: () => {
      rmSync(baseDir, { recursive: true, force: true });
    },
  };
}

function writeAiOutput(taskId: string, runsDir: string, content: string): void {
  const dir = join(runsDir, taskId);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(join(dir, 'ai-output.json'), content, 'utf-8');
}

function runAiApply(taskId: string, cwd: string): { status: number; stdout: string; stderr: string } {
  const result = spawnSync(
    `npx tsx "${join(process.cwd(), 'src', 'cli.ts')}" ai-apply ${taskId}`,
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

describe('cli ai-apply', () => {
  test('fails when ai-output.json is missing', () => {
    const { taskId, cwd, runsDir, repoPath, cleanup } = createApplyEnv();
    try {
      const runTaskDir = join(runsDir, taskId);
      if (existsSync(runTaskDir)) {
        rmSync(runTaskDir, { recursive: true });
      }

      const originalPackage = readFileSync(join(repoPath, 'package.json'), 'utf-8');
      const result = runAiApply(taskId, cwd);

      assert.strictEqual(result.status, 1, `Expected failure, got stderr: ${result.stderr}`);
      assert(
        result.stderr.includes('ai-output.json not found. Run ai-generate first.'),
        `Expected missing file message, got stderr: ${result.stderr}`
      );
      assert.strictEqual(readFileSync(join(repoPath, 'package.json'), 'utf-8'), originalPackage, 'package.json should not change');
      assert(!existsSync(join(runTaskDir, 'state.json')), 'state.json should not exist');
      assert(!existsSync(join(runTaskDir, 'attempt-1')), 'attempt-1 should not exist');
    } finally {
      cleanup();
    }
  });

  test('fails guardrails for denied path before apply', () => {
    const { taskId, cwd, runsDir, repoPath, cleanup } = createApplyEnv();
    try {
      writeAiOutput(
        taskId,
        runsDir,
        '{"mode":"file_update","files":[{"path":".env","content":"SECRET=1"}]}'
      );

      const originalPackage = readFileSync(join(repoPath, 'package.json'), 'utf-8');
      const result = runAiApply(taskId, cwd);

      assert.strictEqual(result.status, 1, `Expected failure, got stderr: ${result.stderr}`);
      assert(
        result.stderr.includes('[ai-apply] Guardrails failed'),
        `Expected guardrails failed, got stderr: ${result.stderr}`
      );
      assert(!existsSync(join(repoPath, '.env')), '.env should not be created');
      assert.strictEqual(readFileSync(join(repoPath, 'package.json'), 'utf-8'), originalPackage, 'package.json should not change');
      assert(!existsSync(join(runsDir, taskId, 'attempt-1')), 'attempt-1 should not exist');
    } finally {
      cleanup();
    }
  });

  test('succeeds for valid file_update', () => {
    const { taskId, cwd, runsDir, repoPath, cleanup } = createApplyEnv();
    try {
      writeAiOutput(
        taskId,
        runsDir,
        JSON.stringify({
          mode: 'file_update',
          files: [
            {
              path: 'package.json',
              content: '{ "name": "ai-apply-test", "version": "1.0.0" }\n',
            },
          ],
        })
      );

      const result = runAiApply(taskId, cwd);

      assert.strictEqual(result.status, 0, `Expected success, got stderr: ${result.stderr}`);
      assert(result.stdout.includes('[ai-apply] Success'), `Expected Success, got stdout: ${result.stdout}`);
      assert(
        readFileSync(join(repoPath, 'package.json'), 'utf-8').includes('"name": "ai-apply-test"'),
        'package.json should be updated'
      );
      assert(existsSync(join(runsDir, taskId, 'attempt-1')), 'attempt-1 should exist');
      assert(existsSync(join(runsDir, taskId, 'state.json')), 'state.json should exist');
    } finally {
      cleanup();
    }
  });

  test('ai-apply succeeds for fenced json file_update', () => {
    const { taskId, cwd, runsDir, repoPath, cleanup } = createApplyEnv();
    try {
      writeAiOutput(
        taskId,
        runsDir,
        '```json\n{"mode":"file_update","files":[{"path":"package.json","content":"{ \\"name\\": \\"ai-apply-fenced-test\\", \\"version\\": \\"1.0.0\\" }\\n"}]}\n```'
      );

      const result = runAiApply(taskId, cwd);

      assert.strictEqual(result.status, 0, `Expected success, got stderr: ${result.stderr}`);
      assert(result.stdout.includes('[ai-apply] Success'), `Expected Success, got stdout: ${result.stdout}`);
      assert(
        readFileSync(join(repoPath, 'package.json'), 'utf-8').includes('"name": "ai-apply-fenced-test"'),
        'package.json should be updated'
      );
      assert(existsSync(join(runsDir, taskId, 'attempt-1')), 'attempt-1 should exist');
      assert(existsSync(join(runsDir, taskId, 'state.json')), 'state.json should exist');
    } finally {
      cleanup();
    }
  });

  test('ai-apply no-ops for empty files array', () => {
    const { taskId, cwd, runsDir, repoPath, cleanup } = createApplyEnv();
    try {
      writeAiOutput(
        taskId,
        runsDir,
        '{"mode":"file_update","files":[],"notes":"Cannot safely modify files because the request is unclear"}'
      );

      const originalPackage = readFileSync(join(repoPath, 'package.json'), 'utf-8');
      const result = runAiApply(taskId, cwd);

      assert.strictEqual(result.status, 0, `Expected success, got stderr: ${result.stderr}`);
      assert(result.stdout.includes('[ai-apply] No file changes proposed'), `Expected No file changes proposed, got stdout: ${result.stdout}`);
      assert(result.stdout.includes('[ai-apply] Notes:'), `Expected Notes, got stdout: ${result.stdout}`);
      assert.strictEqual(readFileSync(join(repoPath, 'package.json'), 'utf-8'), originalPackage, 'package.json should not change');
      assert(!existsSync(join(runsDir, taskId, 'state.json')), 'state.json should not exist');
      assert(!existsSync(join(runsDir, taskId, 'attempt-1')), 'attempt-1 should not exist');
    } finally {
      cleanup();
    }
  });
});
